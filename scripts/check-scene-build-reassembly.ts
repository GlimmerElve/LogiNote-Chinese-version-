import assert from 'node:assert/strict';
import type { LlmCallRequest, SceneCapabilityId, ScenePromptModuleId } from '../src/types';
import { generateScene, parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { captureSceneBuildAuthority, assertSceneBuildAuthority, SceneBuildAuthorityError } from '../src/services/scene/sceneBuildAuthority';
import { probeSceneBuildProtocol } from '../src/services/scene/sceneBuildProtocolProbes';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { SceneSetupError } from '../src/services/scene/sceneSetupStage';
import type { SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import { understandingFixture } from './scene-semantic-fixture';
import { resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { bindSceneProjectMaterials } from '../src/services/scene/sceneKnowledgePoints';
globalThis.fetch = async () => assert.fail('Reassembly checks must remain offline');
const request = '逐题单选，允许提示和调整难度，不要角色或事件。';
const understood = understandingFixture('request', request, { intent:'build-scene',userGoal:'Practice cases',requirements:['Single choice','One task'],exclusions:['Role','Events'] });
const capabilities:SceneCapabilityId[]=['single-choice'];
const modules:ScenePromptModuleId[]=['turn-agent-planning','resource-grounding','structured-interaction'];
const capabilityPlan={needs:[{id:'answer',goal:'Choose',capabilityIds:['single-choice']},{id:'material',goal:'Ground',capabilityIds:['tool:knowledge-notes']}],missing:[]};
const context:SceneBuildContext={version:1,userRequest:request,conversation:[],selectedSurface:'S1',explicitSelections:{capabilities},understanding:understood,capabilityPlan,
 materialEvidence:{policy:'retrieved-reference-not-fact-verified',callCount:0,results:[]},
 assembly:{recipeId:'agent-designed',capabilities,promptModules:modules,interactionPlan:'One choice, preserve task'}};
const runtime={mode:'coaching',initiator:'agent',allowedTools:['knowledge-notes'],allowedInteractionTypes:['single-choice'],
 scope:{noteIds:['n1'],documentIds:[],cognitionRecordIds:[]},evaluation:'each-answer',completion:'objective',allowConversation:true,maxToolCallsPerTurn:2,maxPlanningSteps:2,maxUserTasksPerTurn:1};
const raw={meta:{name:'Synthetic',subject:'Physics',goal:'Practice cases'},task:'Practice',
 behavior:{recipeId:'agent-designed',kind:'Practice',aiBehavior:'Ask',userAction:'Choose',evaluationRule:'Check',progressionRule:'Adapt',
 interaction:{version:'1.0',allowedTypes:['single-choice'],defaultType:'single-choice',allowTextFallback:false}},runtimeContract:runtime};
const opts={subject:'Physics',knowledgePoints:[],sceneSkill:'S1' as const,recipeId:'agent-designed' as const,requestedCapabilities:capabilities,requestedPromptModules:modules,buildContext:context,
 manifest:{version:'1.0',updatedAt:'',scenes:[]}};
const flow={answerFeedback:{correctness:'immediate',explanation:'immediate'},flowGuidance:'Keep pending',evaluationRule:'Local checking',progressionRule:'Understand user',completionRule:'User end is stopped',maxTurns:12,stages:[]};
const instructions={aiBehavior:'One question',userAction:'Answer or discuss',understanding:'Separate answers and control requests',planning:'Only authorized evidence',response:'Hint preserves question'};
type Mode='good'|'repeat'|'unchanged'|'tools'|'scope'|'shared';
function model(mode:Mode){
 const phases:string[]=[],seen:any[]=[];let reviews=0;
 const caller=async(call:LlmCallRequest)=>{
  const input=JSON.parse(call.userInput);phases.push(input.phase);seen.push(input);
  assert.equal(input.buildContext.userRequest,request);assert.deepEqual(input.buildContext.understanding,understood);
  assert.deepEqual(input.buildContext.materialEvidence,context.materialEvidence);
  const result=(v:unknown)=>({content:JSON.stringify(v)});
  if(input.phase==='flow')return result(flow);
  if(input.phase==='instructions')return result(instructions);
  if(input.phase==='generate')return result(raw);
  if(input.phase==='assemble')return result({recipeId:mode==='unchanged'?'agent-designed':'guided-practice',requestedCapabilities:capabilities,
    requestedPromptModules:mode==='unchanged'?modules:[...modules,'adaptive-progression'],interactionPlan:mode==='unchanged'?context.assembly!.interactionPlan:'Keep task; adapt next question',
    rationale:'Behavior change within original authority',capabilityPlan});
  if(input.phase==='repair')return result({patch:mode==='tools'?{runtimeContract:{...input.scene.runtimeContract,allowedTools:['knowledge-notes','documents']}}
    :mode==='scope'?{runtimeContract:{...input.scene.runtimeContract,scope:{...input.scene.runtimeContract.scope,noteIds:undefined}}}:{task:'Clarify feedback behavior'}});
  assert.equal(input.phase,'accept');reviews++;
  assert.equal(input.priorArtifacts.localProtocolProbes.passed,true);assert.equal(input.priorArtifacts.localProtocolProbes.semanticAccuracyEvaluated,false);
  assert.equal(input.priorArtifacts.localProtocolProbes.actualToolCalls,0);
  const assembly=(['good','repeat','unchanged'].includes(mode)&&(reviews===1||mode==='repeat'))||(mode==='shared'&&reviews===2);
  const field=(['tools','scope'].includes(mode)&&reviews===1)||(mode==='shared'&&(reviews===1||reviews===3));
  const failed=assembly?'experience':'goal';
  return result({coverage:input.criteria.map((c:any)=>({id:c.id,satisfied:!((assembly||field)&&c.id===failed),evidencePaths:['task'],detail:'Synthetic evidence'})),
   issues:field?[{criterionId:failed,target:['tools','scope'].includes(mode)?'runtimeContract':'task',instruction:'Fix only this field'}]:[],
   assemblyIssues:assembly?[{criterionId:failed,instruction:'Reassemble adaptive behavior within original choice and evidence rights'}]:[]});
 };return{caller,phases,seen};
}
const good=model('good'),built=await generateScene({...opts,callLlm:good.caller});
assert.deepEqual(good.phases,['flow','instructions','generate','accept','assemble','flow','instructions','generate','accept']);
assert.equal(built.capabilityRecipeId,'guided-practice');assert.ok(built.promptModuleIds?.includes('adaptive-progression'));
assert.deepEqual(resolveSceneRuntimeContract(built).allowedTools,['knowledge-notes']);
const reviews=good.seen.filter(i=>i.phase==='accept');assert.equal(reviews[0].scene.sceneId,reviews[1].scene.sceneId);
assert.deepEqual(reviews[0].authoritySummary,reviews[1].authoritySummary);
for(const [mode,code]of [['repeat','reassembly-budget-exhausted'],['unchanged','unchanged-reassembly'],['tools','scene-authority-expansion'],['scope','scene-authority-expansion'],['shared','semantic-rejected']]as const){
 const broken=model(mode);await assert.rejects(generateScene({...opts,callLlm:broken.caller}),e=>e instanceof SceneSetupError&&e.code===code);
 assert.ok(broken.phases.filter(p=>p==='assemble').length<=1);if(mode==='shared')assert.equal(broken.phases.filter(p=>p==='repair').length,1);
}
const base=applySceneAssemblyPlan(parseSceneSpec(JSON.stringify(raw)),opts),authority=captureSceneBuildAuthority(base,context);
assert.doesNotThrow(()=>assertSceneBuildAuthority(base,authority));
for(const runtimeContract of [{...base.runtimeContract!,allowedTools:['knowledge-notes','documents'] as any},
 {...base.runtimeContract!,scope:{...base.runtimeContract!.scope,noteIds:undefined}},
 {...base.runtimeContract!,scope:{...base.runtimeContract!.scope,noteIds:['n1','outside']}},
 {...base.runtimeContract!,maxToolCallsPerTurn:3}]){
 assert.throws(()=>assertSceneBuildAuthority({...base,runtimeContract},authority),SceneBuildAuthorityError);
}
assert.throws(()=>assertSceneBuildAuthority({...base,promptModuleIds:[...modules,'adaptive-progression']},captureSceneBuildAuthority(base,{...context,explicitSelections:{promptModules:modules}})),SceneBuildAuthorityError);
assert.doesNotThrow(()=>assertSceneBuildAuthority(base,captureSceneBuildAuthority({...base,runtimeContract:{...base.runtimeContract!,allowConversation:false}},context)), 'accepted user permission is independent of a mistaken draft denial');
const report=probeSceneBuildProtocol(base);assert.equal(report.passed,true);assert.equal(report.semanticAccuracyEvaluated,false);assert.equal(report.actualToolCalls,0);
for(const id of ['authorized-task','private-answer-key','pending-task','hint-keeps-task','harder-keeps-task','correction-keeps-task','validated-cancel','original-answer','local-grading','answer-resolves-task','summary-user-end'])assert.equal(report.cases.find(c=>c.id===id)?.status,'passed',id);
console.log('Scene reassembly passed: frozen authority, one bounded assembly revisit, shared field repair, original goal/evidence inheritance and honest local protocol probes. Synthetic model decisions only.');

const narrowed = bindSceneProjectMaterials(base, { scope: { projectId: 'project', noteIds: ['n1', 'n2'], documentIds: [] },
  summary: { candidateCount: 2, usableCount: 2, emptyCount: 0 } });
assert.deepEqual(resolveSceneRuntimeContract(narrowed).scope.noteIds, ['n1'], 'project binding cannot undo accepted narrower scope');
const s4Assembly = resolveSceneAssembly({ sceneSkill: 'S4', recipeId: 'guided-derivation' });
const s4 = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({ meta: { name: 'Math', subject: 'Math', goal: 'Derive' }, task: 'Derive' }), 'S4'),
  { subject: 'Math', knowledgePoints: [], sceneSkill: 'S4', recipeId: 'guided-derivation',
    requestedCapabilities: s4Assembly.enabledCapabilities, requestedPromptModules: s4Assembly.enabledPromptModules });
assert.doesNotThrow(() => assertSceneBuildAuthority(s4, captureSceneBuildAuthority(s4,
  { ...context, selectedSurface: 'S4', assembly: { recipeId: 'guided-derivation', capabilities: s4Assembly.enabledCapabilities, promptModules: s4Assembly.enabledPromptModules, interactionPlan: 'Canvas' }, explicitSelections: { capabilities: s4Assembly.enabledCapabilities } })), 'S4 canvas controls need not install text');
const limitedPaper = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({ meta: { name: 'Paper', subject: 'Math', goal: 'Test' }, task: 'Test',
  behavior: { ...raw.behavior, interaction: { version: '1.0', allowedTypes: ['question-set'], defaultType: 'question-set', allowTextFallback: false } },
  runtimeContract: { mode: 'assessment', allowedInteractionTypes: ['question-set'], maxUserTasksPerTurn: 1 } })),
  { subject: 'Math', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['question-set'], requestedPromptModules: ['structured-interaction', 'turn-agent-planning'] });
const invalidPaper = probeSceneBuildProtocol(limitedPaper);
assert.equal(invalidPaper.passed, false); assert.equal(invalidPaper.cases.find(c => c.id === 'task-count-within-contract')?.status, 'failed');
