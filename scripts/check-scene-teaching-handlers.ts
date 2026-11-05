import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { SceneAnswerFeedbackPolicy, SceneInteractionResponse, SceneRunState, SceneSpec } from '../src/types';
import * as runtime from '../src/services/scene/sceneRuntime';
import * as interactions from '../src/services/scene/sceneInteraction';
import * as forms from '../src/services/scene/sceneInputForm';
import * as availability from '../src/services/scene/sceneInputAvailability';
import * as pending from '../src/services/scene/scenePendingTask';
import * as assessment from '../src/services/scene/sceneAssessment';
import * as contracts from '../src/services/scene/sceneRuntimeContract';
import { normalizeSceneInteractionResponseV2 } from '../src/services/scene/sceneInteractionV2Adapter';
import { collectSceneAnswerRecords, renderFinalSceneAnswerFeedback } from '../src/services/scene/sceneTeaching';

// Execute production handler ASTs, not copied business logic. No React mount or model request.
const file='src/components/SceneMode.tsx';
const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
type HandlerName='handleSend'|'handleEnd';
const handlerSources=new Map<HandlerName,string>();
function visit(node:ts.Node){
 if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&(node.name.text==='handleSend'||node.name.text==='handleEnd')){
  assert.ok(node.initializer&&ts.isArrowFunction(node.initializer));
  assert.ok(!handlerSources.has(node.name.text));
  handlerSources.set(node.name.text,node.initializer.getText(ast));
 }
 ts.forEachChild(node,visit);
}
visit(ast);assert.equal(handlerSources.size,2);
const compiled=new Map([...handlerSources].map(([name,expression])=>[name,ts.transpileModule('const handler = '+expression+';\nreturn handler;',
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText]));
const stamp='2026-10-16T00:00:00.000Z';
const paper={id:'paper',type:'question-set',required:true,submissionMode:'batch',feedbackMode:'after-submit',items:[
 {id:'one',type:'single-choice',content:'Synthetic choice',required:true,options:[{id:'a',label:'A'},{id:'b',label:'B'}]},
 {id:'two',type:'true-false',content:'Synthetic statement',required:true}]};
const key={interactionId:'paper',type:'question-set',items:[
 {itemId:'one',type:'single-choice',correctId:'b',explanation:'FINAL_ONLY_ONE'},
 {itemId:'two',type:'true-false',correctValue:true,explanation:'FINAL_ONLY_TWO'}]};
const answer={interactionId:'paper',type:'question-set',submittedAt:stamp,answers:[
 {itemId:'one',type:'single-choice',selectedId:'a'},{itemId:'two',type:'true-false',value:false}]} as SceneInteractionResponse;
function spec(answerFeedback:SceneAnswerFeedbackPolicy):SceneSpec{return{
 sceneId:'synthetic',capabilityRecipeId:'batch-assessment',capabilityIds:['question-set'],
 promptModuleIds:['structured-interaction','deterministic-assessment','turn-agent-planning'],
 meta:{name:'Synthetic',goal:'Agent controls teaching',sceneSkill:'S1',knowledgePoints:[]},
 role:{name:'Tutor',attributes:[]},userRole:'Learner',situation:'',task:'Answer and discuss',resources:[],rules:[],metrics:[],events:[],
 completion:{mode:'signal',maxTurns:8},
 behavior:{recipeId:'batch-assessment',kind:'Practice',aiBehavior:'Organize teaching',userAction:'Answer or discuss',
 evaluationRule:'Local checking',progressionRule:'Agent chooses',interaction:{version:'1.0',allowedTypes:['question-set'],defaultType:'question-set',allowTextFallback:false}},
 runtimeContract:{version:'1.0',mode:'assessment',initiator:'agent',allowedTools:[],allowedActions:['respond','clarify','evaluate','advance','summarize','finish'],
 allowedInteractionTypes:['question-set'],allowedQuestionItemTypes:['single-choice','true-false'],allowTextFallback:false,allowConversation:true,scope:{},
 evaluation:'each-answer',answerFeedback,completion:'user-controlled',maxToolCallsPerTurn:0,maxPlanningSteps:1,maxUserTasksPerTurn:2,flowGuidance:'Flexible'},
} as unknown as SceneSpec;}
function makeRun():SceneRunState{return{runId:'run',sceneId:'synthetic',sceneName:'Synthetic',status:'running',turnCount:0,metrics:[],events:[],startedAt:stamp,
 messages:[{id:'task',speakerType:'role',speakerName:'Tutor',content:'Complete the paper',timestamp:stamp,interaction:paper,interactionEvaluation:key}],
} as unknown as SceneRunState;}
function harness(scene:SceneSpec,initial=makeRun()){
 let run=structuredClone(initial),serial=0,error='',partial='';
 const pendingTurnRef:{current:unknown}={current:null},turnBusyRef={current:false};
 const streamCalls:Array<{spec:SceneSpec;run:SceneRunState;text:string}>=[];
 const snapshots:SceneRunState[]=[];
 async function invoke(name:HandlerName,...args:unknown[]){
  const env={...runtime,...interactions,...forms,...availability,...pending,...assessment,...contracts,normalizeSceneInteractionResponseV2,renderFinalSceneAnswerFeedback,
   spec:scene,run,pendingTurnRef,turnBusyRef,generateMessageId:()=>'message-'+(++serial),
   setRun:(value:SceneRunState)=>{run=value;snapshots.push(structuredClone(value));},
   setTurnError:(value:string)=>{error=value;},setPartialReply:(value:string)=>{partial=value;},
   streamTurn:async(spec:SceneSpec,value:SceneRunState,text:string)=>{streamCalls.push({spec,run:structuredClone(value),text});},
   applyS4Completion:()=>{throw Error('S1 must not use S4 completion');},
   makeEndMessage:(content:string)=>({id:'end-'+(++serial),speakerType:'system',speakerName:'System',content,timestamp:stamp})};
  const handler=new Function(...Object.keys(env),compiled.get(name)!)(...Object.values(env));
  await handler(...args);
 }
 return{invoke,streamCalls,snapshots,pendingTurnRef,turnBusyRef,get run(){return run;},get error(){return error;},get partial(){return partial;},
  failTurn(){pendingTurnRef.current={spec:scene,run,lastUserText:'failure'};error='Failed';partial='Unfinished';}};
}
const deferred:SceneAnswerFeedbackPolicy={correctness:'at-end',explanation:'at-end'};
const publicText=(run:SceneRunState)=>run.messages.map(message=>message.content).join('\n');
const submitted=harness(spec(deferred));
await submitted.invoke('handleSend','',answer);
assert.equal(submitted.streamCalls.length,1,'paper submission must enter the Agent');
assert.equal(submitted.run.status,'running');assert.equal(submitted.run.completionOutcome,undefined);
assert.equal(submitted.run.turnCount,1);assert.equal(submitted.run.messages.length,2);
assert.deepEqual(collectSceneAnswerRecords(submitted.run)[0].questionGrade,{correct:0,total:2,incorrectItemIds:['one','two']});
assert.ok(!publicText(submitted.run).includes('FINAL_ONLY'));
assert.ok(submitted.snapshots.every(snapshot=>snapshot.status==='running'&&snapshot.messages.length===2));
await submitted.invoke('handleSend','这题先讲讲，不要急着出下一题。',undefined,undefined,'conversation');
assert.equal(submitted.streamCalls.length,2);assert.equal(submitted.run.turnCount,1);
assert.equal(collectSceneAnswerRecords(submitted.run).length,1);
await submitted.invoke('handleEnd');
assert.equal(submitted.streamCalls.length,3);assert.equal(submitted.run.status,'running');
assert.equal(submitted.run.turnCount,1);assert.equal(submitted.run.messages.at(-1)?.endRequested,true);
assert.equal(submitted.run.messages.at(-1)?.inputKind,'conversation');
assert.ok(submitted.run.messages.at(-1)?.content.includes('不再出题'));
assert.ok(!publicText(submitted.run).includes('FINAL_ONLY'));

// Failed-turn ending is a deterministic escape, preserving local records and separate release flags.
for(const [policy,receiptExpected,explanationExpected]of[
 [deferred,true,true],
 [{correctness:'at-end',explanation:'on-request'},true,false],
 [{correctness:'on-request',explanation:'on-request'},false,false],
]as Array<[SceneAnswerFeedbackPolicy,boolean,boolean]>){
 const h=harness(spec(policy));await h.invoke('handleSend','',answer);h.failTurn();
 const calls=h.streamCalls.length;await h.invoke('handleEnd');
 assert.equal(h.streamCalls.length,calls);assert.notEqual(h.run.status,'running');assert.equal(h.run.completionOutcome,'stopped');
 assert.equal(h.run.turnCount,1);assert.equal(collectSceneAnswerRecords(h.run).length,1);
 assert.equal(h.pendingTurnRef.current,null);assert.equal(h.error,'');assert.equal(h.partial,'');
 const receipt=h.run.messages.find(message=>message.id==='answer-feedback:'+h.run.runId);
 assert.equal(Boolean(receipt),receiptExpected);assert.equal(publicText(h.run).includes('FINAL_ONLY'),explanationExpected);
 if(receipt)assert.ok(receipt.content.includes('0/2题正确'));
 const count=h.run.messages.length;await h.invoke('handleEnd');assert.equal(h.run.messages.length,count);
 assert.equal(h.run.messages.filter(message=>message.id==='answer-feedback:'+h.run.runId).length,receiptExpected?1:0);
}
const invalid=harness(spec(deferred));await invalid.invoke('handleSend','',{...answer,interactionId:'unknown'});
assert.equal(invalid.streamCalls.length,0);assert.equal(invalid.run.turnCount,0);
invalid.turnBusyRef.current=true;await invalid.invoke('handleEnd');assert.equal(invalid.run.messages.length,1);
console.log('Scene teaching handlers passed: production AST submission/end paths, deferred paper continuation, Agent summary handoff, failed-turn receipts and lifecycle guards. Not rendered GUI or browser E2E.');
