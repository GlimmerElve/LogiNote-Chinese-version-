import assert from 'node:assert/strict';
import type { LlmCallRequest, SceneInteractionDirective, SceneMessage, SceneRunState, SceneSpec } from '../src/types';
import { parseSceneSpec, applySceneAssemblyPlan, generateScene } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { getPendingSceneInteraction } from '../src/services/scene/scenePendingTask';
import { collectSceneAnswerRecords, buildSceneTeachingContext, finalizeSceneTeachingState, resolveSceneTeachingState,
  sceneAnswerFeedbackView, renderFinalSceneAnswerFeedback } from '../src/services/scene/sceneTeaching';
import { normalizeSceneAnswerFeedback } from '../src/services/scene/sceneTeachingPolicy';
import { fitSceneContextBudget, SceneContextBudgetError } from '../src/services/scene/sceneContextBudget';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Teaching regressions must remain offline');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta:{name:'Synthetic teaching',subject:'比例',goal:'按理解组织教学'}, task:'单选只是控件，允许持续讨论',
  behavior:{recipeId:'agent-designed',kind:'学习',aiBehavior:'按语义组织',userAction:'作答或讨论',evaluationRule:'本地核对',progressionRule:'不强制续题',
    interaction:{version:'1.0',allowedTypes:['single-choice'],defaultType:'single-choice',allowTextFallback:false}},
  completion:{mode:'signal',maxTurns:100},
  runtimeContract:{mode:'coaching',completion:'user-controlled',evaluation:'each-answer',allowedTools:['knowledge-notes'],
    scope:{noteIds:['synthetic'],documentIds:[],cognitionRecordIds:[]},maxToolCallsPerTurn:1,maxPlanningSteps:2,
    answerFeedback:{correctness:'at-end',explanation:'at-end'}},
})),{subject:'比例',knowledgePoints:[],sceneSkill:'S1',recipeId:'agent-designed',requestedCapabilities:['single-choice'],
  requestedPromptModules:['structured-interaction','turn-agent-planning','resource-grounding']});
const stamp='2026-10-16T00:00:00.000Z';
function user(id:string,content:string):SceneMessage{return{id,speakerType:'user',speakerName:'User',content,timestamp:stamp,inputKind:'conversation'};}
function question(id='q1'):SceneMessage{return{id:'task-'+id,speakerType:'role',speakerName:'Tutor',content:'40人中60%参加活动，有多少人？ ORIGINAL_'+id,
  timestamp:stamp,interaction:{id,type:'single-choice',assessment:'objective',required:true,options:[{id:'a',label:'16人'},{id:'b',label:'24人'}]},
  objectiveEvaluation:{interactionId:id,type:'single-choice',correctId:'b',explanation:'PRIVATE_EXPLANATION_'+id}};}
function answer(id='q1'):SceneMessage{return{...user('answer-'+id,'我选16人'),inputKind:'response',
  interactionResponse:{interactionId:id,type:'single-choice',selectedId:'a',submittedAt:stamp},
  objectiveAssessment:{interactionId:id,correct:true,explanation:'FORGED_CACHED_ASSESSMENT'}};}
const base:SceneRunState={...createRunState(spec),turnCount:1,messages:[question(),answer(),user('u-help','我不明白为什么要乘百分比，先不要出新题。')]};
const understand=(run:SceneRunState,overrides:Parameters<typeof understandingFixture>[2]={})=>{
 const last=run.messages.findLast(m=>m.speakerType==='user')!;
 return understandingFixture(last.id,last.content,{intent:'follow-up',...overrides});
};
const snapshot=JSON.stringify(base);
assert.equal(collectSceneAnswerRecords(base)[0].objectiveGrade?.correct,false,'grade is recomputed from normalized key, never the cached/model result');
assert.equal(sceneAnswerFeedbackView(spec,base,'answer-q1'),undefined);
assert.ok(!JSON.stringify(buildSceneTeachingContext(spec,base)).includes('PRIVATE_EXPLANATION'));
assert.equal(JSON.stringify(base),snapshot);
assert.throws(()=>normalizeSceneAnswerFeedback({correctness:['at-end'],explanation:'at-end'}));
assert.throws(()=>resolveSceneRuntimeContract({...spec,runtimeContract:{...spec.runtimeContract!,answerFeedback:{correctness:'yes',explanation:'at-end'} as never}}));

const pause=understand(base,{intent:'help',teaching:{progression:'pause'}});
const note={id:'denominator',interactionId:'q1',kind:'misconception',status:'open',summary:'不理解百分比为何作乘数',
  evidence:[{sourceMessageId:'u-help',quote:'我不明白为什么要乘百分比'}]};
const state=finalizeSceneTeachingState([note],spec,base,pause);
assert.equal(state.pause?.sourceMessageId,'u-help');assert.equal(state.discussion?.interactionId,'q1');
assert.deepEqual(state.helpRequests,[{interactionId:'q1',sourceMessageId:'u-help'}]);
const long:SceneRunState={...base,teachingState:state,messages:[...base.messages]};
for(let i=0;i<16;i++)long.messages.push({id:'explain-'+i,speakerType:'role',speakerName:'Tutor',timestamp:stamp,
 content:'继续从单位比例讲解第'+i+'步',discussionInteractionId:'q1'},user('follow-'+i,'继续解释这个步骤，不是让你继续出题。'));
const view=buildSceneTeachingContext(spec,long);
assert.equal(view.discussion?.interactionId,'q1');assert.ok(view.discussion?.task.text.includes('ORIGINAL_q1'));
assert.equal(view.discussion?.response.type,'single-choice');assert.equal(view.learningNotes[0].id,'denominator');
assert.equal(view.newTasksPaused,true);assert.equal(view.discussion?.recentExplanations.length,4);
assert.equal(resolveSceneTeachingState(spec,long,understand(long)).pause?.sourceMessageId,'u-help','ordinary follow-up cannot erase pause');
assert.ok(!getPendingSceneInteraction(long),'the protected discussion is an answered question, not a phantom pending task');
assert.equal(collectSceneAnswerRecords(long).length,1);

// Protect teaching context even when both optional recent histories are evicted.
const fitted=fitSceneContextBudget({providerId:'',model:'',workflow:'scene-turn-plan',systemPromptOverride:'Keep the supplied teaching context.',
 maxTokensOverride:512,userInput:JSON.stringify({teachingContext:view,latestUserInput:{sourceId:'follow-15',text:'继续解释'},
 recentInteraction:['X'.repeat(18000)]}),sceneOptionalJsonFields:['recentInteraction'],messages:[{role:'user',content:'Y'.repeat(18000)}]},
 {provider:{contextWindowTokens:16384}});
assert.deepEqual(JSON.parse(fitted.request.userInput).teachingContext,JSON.parse(JSON.stringify(view)));
assert.equal(JSON.parse(fitted.request.userInput).recentInteraction,undefined);
assert.equal(fitted.diagnostics?.droppedHistoryMessages,1);
assert.throws(()=>fitSceneContextBudget({providerId:'',model:'',workflow:'scene-turn-plan',systemPromptOverride:'Keep',
 maxTokensOverride:512,userInput:JSON.stringify({teachingContext:{...view,protected:'Z'.repeat(30000)}})},
 {provider:{contextWindowTokens:4096}}),SceneContextBudgetError);

// A valid turn traverses the real understand/plan/respond path and shares the same protected state.
const phases:string[]=[],before=JSON.stringify(long);let replies=0,plans=0,reads=0;
const continued=await generateGeneralTurn(spec,long,{dependencies:{
 searchNotes:async()=>{reads++;return[{noteId:'synthetic',title:'比例笔记',snippet:'百分比表示每一百份的比例。',score:1,noteType:'knowledge'}] as never;},
 callLlm:async call=>{
  assert.ok(!JSON.stringify(call).includes('PRIVATE_EXPLANATION_q1'),'deferred key/grade explanation must be absent in every controller phase');
  assert.ok(!JSON.stringify(call).includes('FORGED_CACHED_ASSESSMENT'));
  if(call.workflow==='scene-turn-plan'){
   const input=JSON.parse(call.userInput);phases.push(input.phase);
   assert.equal(input.teachingContext.discussion.interactionId,'q1');assert.equal(input.teachingContext.newTasksPaused,true);
   assert.equal(input.teachingContext.learningNotes[0].id,'denominator');
   if(input.phase==='understand')return{content:JSON.stringify({action:'respond',understanding:understand(long,{
    informationGaps:[{id:'reference',kind:'reference-material',description:'补充单位比例解释'}]})})};
   plans++;return{content:JSON.stringify({action:'respond',toolRequests:plans===1?[{id:'knowledge-notes',query:'单位比例',needId:'reference',reason:'补充概念解释'}]:[]})};
  }
  phases.push('respond');replies++;
  assert.ok(call.userInput.includes('ORIGINAL_q1'));
  assert.ok(call.userInput.includes('不理解百分比为何作乘数'));
  if(replies===1)return{content:JSON.stringify({content:'误生成下一题',interaction:{...question('bad-next').interaction},evaluation:question('bad-next').objectiveEvaluation})};
  assert.ok(call.userInput.includes('暂停新任务'));
  return{content:JSON.stringify({content:'继续解释单位比例，不创建新题。'})};
 },
}});
assert.deepEqual(phases,['understand','plan','plan','respond','respond']);assert.equal(reads,1);assert.equal(plans,2);
assert.equal(continued.interaction,undefined);assert.equal(continued.teachingState?.pause?.sourceMessageId,'u-help');
assert.equal(continued.discussionInteractionId,'q1');assert.equal(JSON.stringify(long),before,'controller returns a candidate, never commits before UI success');
await assert.rejects(generateGeneralTurn(spec,long,{dependencies:{callLlm:async call=>call.workflow==='scene-turn-plan'
 ?{content:JSON.stringify({action:'respond',understanding:understand(long)})}
 :{content:JSON.stringify({content:'仍然违规出题',interaction:question('still-bad').interaction,evaluation:question('still-bad').objectiveEvaluation})}}}),/未通过/);
assert.equal(JSON.stringify(long),before);

// Clear pause only via a grounded semantic resume; then the Agent may choose a permitted next task.
const resumed:SceneRunState={...long,messages:[...long.messages,user('resume','可以了，现在继续给我下一题。')]};
const next=await generateGeneralTurn(spec,resumed,{dependencies:{callLlm:async call=>call.workflow==='scene-turn-plan'
 ?{content:JSON.stringify({action:'respond',understanding:understand(resumed,{intent:'continue',teaching:{progression:'resume',focus:{action:'release'}}})})}
 :{content:JSON.stringify({content:'下一题',interaction:question('q2').interaction,evaluation:question('q2').objectiveEvaluation})}}});
assert.equal(next.interaction?.id,'q2');assert.equal(next.teachingState?.pause,undefined);assert.equal(next.teachingState?.discussion,undefined);

// Long answered text is a marked navigation excerpt, not eight unbounded mandatory copies of old essays.
const essaySpec={...spec,capabilityIds:['text' as const],promptModuleIds:['turn-agent-planning' as const],
 behavior:{...spec.behavior!,interaction:{version:'1.0' as const,allowedTypes:['text' as const],defaultType:'text' as const,allowTextFallback:true}},
 runtimeContract:{...spec.runtimeContract!,allowedTools:[],allowedInteractionTypes:['text' as const],allowTextFallback:true}};
const essays:SceneRunState={...createRunState(essaySpec),turnCount:8,messages:[]};
for(let i=0;i<8;i++){
 const id='essay-'+i,value='长回答'.repeat(3000);
 essays.messages.push({id:'task-'+id,speakerType:'role',speakerName:'Tutor',content:'解释你的理解',timestamp:stamp,
  interaction:{id,type:'text',required:true,maxLength:20000}},
 {...user('answer-'+id,value),inputKind:'response',interactionResponse:{interactionId:id,type:'text',value,submittedAt:stamp}});
}
essays.messages.push(user('essay-follow','继续解释我刚才的论证。'));
const essayBefore=JSON.stringify(essays),essayView=buildSceneTeachingContext(essaySpec,essays);
assert.ok(JSON.stringify(essayView).length<22000,'old long answers cannot grow the protected context without bound');
assert.ok(JSON.stringify(essayView).includes('excerpt-not-full-source'));
const essayTurn=await generateGeneralTurn(essaySpec,essays,{dependencies:{callLlm:async call=>call.workflow==='scene-turn-plan'
 ?{content:JSON.stringify({action:'respond',understanding:understand(essays)})}:{content:'{"content":"只基于明确可见的段落继续解释，不声称已读截断原文。"}'}}});
assert.equal(essayTurn.interaction,undefined);assert.equal(JSON.stringify(essays),essayBefore);

// Private grading explanations cannot bypass correctness timing, even if explanation alone says immediate.
const mixed={...spec,runtimeContract:{...spec.runtimeContract!,answerFeedback:{correctness:'at-end' as const,explanation:'immediate' as const}}};
assert.equal(sceneAnswerFeedbackView(mixed,base,'answer-q1'),undefined);
const onlyCorrect={...spec,runtimeContract:{...spec.runtimeContract!,answerFeedback:{correctness:'immediate' as const,explanation:'at-end' as const}}};
assert.deepEqual(sceneAnswerFeedbackView(onlyCorrect,base,'answer-q1'),{interactionId:'q1',correct:false});

// Local exceptions target only this answered task; a later answer keeps the original session policy.
const localRun={...base,messages:[...base.messages,user('local','这题现在给我讲讲，后面仍然最后分析。')]};
const localUnderstanding=understand(localRun,{evaluationRequested:true,teaching:{feedback:{scope:'task',interactionId:'q1',correctness:'immediate',explanation:'immediate'}}});
const localState=finalizeSceneTeachingState(undefined,spec,localRun,localUnderstanding);
assert.ok(JSON.stringify(sceneAnswerFeedbackView(spec,localRun,'answer-q1',localUnderstanding)).includes('PRIVATE_EXPLANATION_q1'));
assert.equal(localState.feedbackPolicy,undefined);
const second={...localRun,teachingState:localState,messages:[...localRun.messages,question('q2'),answer('q2'),user('wait','先继续做题。')]};
assert.equal(sceneAnswerFeedbackView(spec,second,'answer-q2'),undefined);
assert.equal(buildSceneTeachingContext(spec,second).discussion?.interactionId,'q2');
const globalRun={...second,messages:[...second.messages,user('global','以后每题都立即讲解。')]};
const globalUnderstanding=understand(globalRun,{teaching:{feedback:{scope:'session',correctness:'immediate',explanation:'immediate'}}});
assert.ok(JSON.stringify(sceneAnswerFeedbackView(spec,globalRun,'answer-q2',globalUnderstanding)).includes('PRIVATE_EXPLANATION_q2'));
const hiddenAgain={...globalRun,teachingState:finalizeSceneTeachingState(undefined,spec,globalRun,globalUnderstanding),
 messages:[...globalRun.messages,user('hide','以后先不告诉我对错，最后再分析。')]};
const hideUnderstanding=understand(hiddenAgain,{teaching:{feedback:{scope:'session',correctness:'at-end',explanation:'at-end'}}});
assert.equal(sceneAnswerFeedbackView(spec,hiddenAgain,'answer-q1',hideUnderstanding),undefined,'prior permission is not a fictitious public receipt');
assert.equal(sceneAnswerFeedbackView(spec,{...base,messages:[...base.messages,user('quote','我只是引用“现在讲讲”，不是要求你现在公布。')]},'answer-q1'),undefined);

// Hinting a pending sibling is not attributed to the previous answered discussion.
const pendingRun={...base,teachingState:state,messages:[...base.messages,question('q2'),user('hint-next','提示这道待答题，不要公布答案。')]};
const hint=await generateGeneralTurn(spec,pendingRun,{dependencies:{callLlm:async call=>call.workflow==='scene-turn-plan'
 ?{content:JSON.stringify({action:'respond',understanding:understand(pendingRun,{intent:'help'})})}:{content:'{"content":"只给提示，保留原题。"}'}}});
assert.equal(hint.discussionInteractionId,undefined);assert.equal(getPendingSceneInteraction(pendingRun)?.interaction?.id,'q2');
assert.throws(()=>resolveSceneTeachingState(spec,pendingRun,understand(pendingRun,{teaching:{feedback:{scope:'task',interactionId:'q2',explanation:'immediate'}}})),/未答题/);
assert.doesNotThrow(()=>resolveSceneTeachingState(spec,pendingRun,understand(pendingRun,{teaching:{feedback:{scope:'task',interactionId:'q2',correctness:'at-end',explanation:'at-end'}}})));

// No assistant/streaming/forged quote or duplicate ID can create or resolve a learning observation.
const badSource={...note,evidence:[{sourceMessageId:'explain-15',quote:'继续从单位比例'}]};
assert.throws(()=>finalizeSceneTeachingState([badSource],spec,long),/真实用户/);
assert.throws(()=>finalizeSceneTeachingState([{...note,evidence:[{sourceMessageId:'u-help',quote:'伪造句子'}]}],spec,long),/真实用户/);
assert.throws(()=>finalizeSceneTeachingState([{...note,summary:'完全不同的疑问'}],spec,long),/新的用户依据/);
assert.throws(()=>finalizeSceneTeachingState([note,{...note,status:'resolved',evidence:[{sourceMessageId:'follow-15',quote:'继续解释'}]}],spec,{...long,teachingState:undefined}),/同轮/);
assert.throws(()=>finalizeSceneTeachingState([{...note,status:'resolved'}],spec,long),/较新/);
const explained={...long,messages:[...long.messages,user('self-explain','我理解了：先把60%变成0.6，再用总人数40乘0.6。')]};
const resolved=finalizeSceneTeachingState([{...note,status:'resolved',summary:'用户给出了自己的计算解释',
 evidence:[{sourceMessageId:'self-explain',quote:'先把60%变成0.6，再用总人数40乘0.6'}]}],spec,explained);
assert.equal(resolved.notes[0].status,'resolved');assert.equal(resolved.notes[0].originalSummary,note.summary);
assert.equal(resolved.notes[0].evidence[0].sourceMessageId,'u-help');
const many={...long,teachingState:{...state,notes:[...Array.from({length:12},(_,i)=>({...state.notes[0],id:'open-'+i})),{...state.notes[0],id:'old-resolved',status:'resolved' as const}]}};
assert.equal(finalizeSceneTeachingState([],spec,many).notes.length,12);
assert.equal(many.teachingState.notes.length,13,'candidate normalization never mutates the original');

// Optional unanswered children and cancelled tasks cannot leak through local or final feedback.
const paper:SceneInteractionDirective={id:'paper',type:'question-set',required:true,submissionMode:'batch',feedbackMode:'after-submit',items:[
 {id:'required',type:'single-choice',content:'Required',required:true,options:[{id:'a',label:'A'},{id:'b',label:'B'}]},
 {id:'optional',type:'single-choice',content:'Optional',required:false,options:[{id:'a',label:'A'},{id:'b',label:'B'}]}]};
const paperRun={...createRunState(spec),messages:[{...question(),id:'paper-message',interaction:paper,objectiveEvaluation:undefined,
 interactionEvaluation:{interactionId:'paper',type:'question-set' as const,items:[
 {itemId:'required',type:'single-choice' as const,correctId:'a',explanation:'REQUIRED_ONLY'},
 {itemId:'optional',type:'single-choice' as const,correctId:'b',explanation:'UNANSWERED_OPTIONAL_SECRET'}]}},
 {...user('paper-answer','答了必答题'),inputKind:'response' as const,interactionResponse:{interactionId:'paper',type:'question-set' as const,submittedAt:stamp,
 answers:[{itemId:'required',type:'single-choice' as const,selectedId:'a'}]}}]};
assert.equal(collectSceneAnswerRecords(paperRun)[0].questionGrade?.total,1);
const final=renderFinalSceneAnswerFeedback(spec,paperRun);
assert.ok(final.includes('REQUIRED_ONLY'));assert.ok(!final.includes('UNANSWERED_OPTIONAL_SECRET'));
assert.ok(renderFinalSceneAnswerFeedback(spec,base).includes('PRIVATE_EXPLANATION_q1'));
assert.equal(renderFinalSceneAnswerFeedback(spec,{...base,retiredInteractionIds:['q1']}),'');
const pendingOnly={...base,messages:[question(),user('stop','结束吧')]};
assert.equal(renderFinalSceneAnswerFeedback(spec,pendingOnly),'');

// Final/review context must retain early mistakes even when recent dialogue and the last eight answers no longer contain them.
const oldMistake:SceneRunState={...createRunState(spec),turnCount:14,messages:[]};
for(let i=1;i<=14;i++){
 const id='history-'+i,submitted=answer(id);
 oldMistake.messages.push(question(id),i===1?submitted:{...submitted,content:'我选24人',
  interactionResponse:{interactionId:id,type:'single-choice',selectedId:'b',submittedAt:stamp}});
}
oldMistake.messages.push({...user('finish','结束并综合分析。'),endRequested:true});
const finalView=buildSceneTeachingContext(spec,oldMistake);
assert.equal(finalView.answerEvidence.retained.some(record=>record.interactionId==='history-1'),false);
assert.equal(finalView.answerEvidence.visibleSummary?.correctItems,13);
assert.equal(finalView.reviewEvidence?.retained[0].interactionId,'history-1');
assert.ok(finalView.reviewEvidence?.retained[0].task.text.includes('ORIGINAL_history-1'));
assert.equal(finalView.reviewEvidence?.withheldFeedbackTaskCount,0);
const optionOnly=structuredClone(oldMistake);
optionOnly.messages[0]={...optionOnly.messages[0],content:'以下哪个论述正确？',interaction:{...question('history-1').interaction!,
 type:'single-choice',options:[{id:'a',label:'EARLY_SELECTED_CLAIM：直接相减'},{id:'b',label:'EARLY_CORRECT_CLAIM：总人数乘比例'}]}};
optionOnly.messages[1]={...optionOnly.messages[1],content:'我选择 EARLY_SELECTED_CLAIM：直接相减'};
const optionReview=buildSceneTeachingContext(spec,optionOnly).reviewEvidence!.retained[0];
assert.ok(optionReview.publicInteraction.text.includes('EARLY_SELECTED_CLAIM'));
assert.ok(optionReview.publicInteraction.text.includes('EARLY_CORRECT_CLAIM'));
assert.ok(optionReview.submittedText.text.includes('EARLY_SELECTED_CLAIM'));

const onRequest={...spec,runtimeContract:{...spec.runtimeContract!,answerFeedback:{correctness:'on-request' as const,explanation:'on-request' as const}}};
const reviewRun={...oldMistake,messages:[...oldMistake.messages.slice(0,-1),user('review','把本局所有错题给我讲讲，这次讲就行，后面仍然按需。')]};
const reviewUnderstanding=understand(reviewRun,{evaluationRequested:true,teaching:{feedback:{scope:'review',target:'incorrect',correctness:'immediate',explanation:'immediate'}}});
const reviewed=buildSceneTeachingContext(onRequest,reviewRun,reviewUnderstanding);
assert.equal(reviewed.reviewEvidence?.retained[0].interactionId,'history-1');
assert.ok(reviewed.reviewEvidence?.retained[0].releasedFeedback.text.includes('PRIVATE_EXPLANATION_history-1'));
assert.equal(sceneAnswerFeedbackView(onRequest,reviewRun,'answer-history-14',reviewUnderstanding),undefined);
const afterReview={...reviewRun,teachingState:finalizeSceneTeachingState(undefined,onRequest,reviewRun,reviewUnderstanding),
 messages:[...reviewRun.messages,question('after-review'),answer('after-review')]};
assert.equal(afterReview.teachingState.feedbackPolicy,undefined);
assert.equal(sceneAnswerFeedbackView(onRequest,afterReview,'answer-after-review'),undefined,'one-time review never changes future task policy');
const allReview=understand(reviewRun,{evaluationRequested:true,teaching:{feedback:{scope:'review',target:'all',correctness:'immediate',explanation:'immediate'}}});
assert.equal(buildSceneTeachingContext(onRequest,reviewRun,allReview).answerEvidence.visibleSummary?.checkedItems,14);
const noRequest=buildSceneTeachingContext(onRequest,oldMistake);
assert.equal(noRequest.reviewEvidence?.reviewedFeedbackTaskCount,0);
assert.equal(noRequest.reviewEvidence?.withheldFeedbackTaskCount,14);
assert.ok(!JSON.stringify(noRequest).includes('PRIVATE_EXPLANATION_'));

// Builder must explicitly design feedback timing; missing policy gets a bounded format repair, never a silent immediate default.
const buildRequest='只用单选题，一直做题，最后统一分析，不要中途告诉我对错或解析。';
const context={version:1 as const,userRequest:buildRequest,conversation:[],selectedSurface:'S1' as const,explicitSelections:{},
 understanding:understandingFixture('request',buildRequest,{intent:'build-scene'}),
 assembly:{recipeId:'agent-designed' as const,capabilities:['single-choice' as const],promptModules:['turn-agent-planning' as const,'structured-interaction' as const],
 interactionPlan:'自主教学，最后反馈'},
 capabilityPlan:{needs:[{id:'answer',goal:'使用单选任务',capabilityIds:['single-choice']}],missing:[]}};
let flowCalls=0;const buildPhases:string[]=[];
const built=await generateScene({subject:'比例',knowledgePoints:[],sceneSkill:'S1',recipeId:'agent-designed',
 requestedCapabilities:context.assembly.capabilities,requestedPromptModules:context.assembly.promptModules,buildContext:context,
 manifest:{version:'1.0',updatedAt:'',scenes:[]},callLlm:async call=>{
  const input=JSON.parse(call.userInput);buildPhases.push(input.phase);assert.equal(input.buildContext.userRequest,buildRequest);
  if(input.phase==='flow'){
   flowCalls++;
   const result={flowGuidance:'自主组织，最后反馈',evaluationRule:'本地核对但不提前公开',progressionRule:'按表达与本局证据',completionRule:'用户结束',maxTurns:12,stages:[]};
   return{content:JSON.stringify(flowCalls===1?result:{...result,answerFeedback:{correctness:'at-end',explanation:'at-end'}})};
  }
  if(input.phase==='instructions')return{content:JSON.stringify({aiBehavior:'按理解组织',userAction:'选题或讨论',
   understanding:'分清作答、讲解、局部与整体调整',planning:'先本局证据，按需取材',response:'不强制续题，遵守反馈时机'})};
  if(input.phase==='generate')return{content:JSON.stringify({...spec,runtimeContract:{...spec.runtimeContract!,allowedTools:[],maxToolCallsPerTurn:0,
   scope:{noteIds:[],documentIds:[],cognitionRecordIds:[]},answerFeedback:{correctness:'immediate',explanation:'immediate'}}})};
  assert.equal(input.phase,'accept');
  return{content:JSON.stringify({coverage:input.criteria.map((criterion:any)=>({id:criterion.id,satisfied:true,
   evidencePaths:['runtimeContract.answerFeedback'],detail:'合成验收依据'})),issues:[],assemblyIssues:[]})};
 }});
assert.deepEqual(buildPhases,['flow','flow','instructions','generate','accept']);
assert.deepEqual(resolveSceneRuntimeContract(built).answerFeedback,{correctness:'at-end',explanation:'at-end'});

console.log('Scene teaching checks passed: long-discussion anchors in all real phases, sourced local evidence, pause/resume, bounded repair, delayed/local/session/final feedback, private-key and optional/retired-task boundaries. Offline synthetic decisions only.');
