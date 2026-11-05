import assert from 'node:assert/strict';
import type { SceneCapabilityId, ScenePromptModuleId, SceneInteractionType } from '../src/types';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { generateScene, parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { captureSceneBuildAuthority, assertSceneBuildAuthority, assertSceneAssemblyAuthority, SceneBuildAuthorityError } from '../src/services/scene/sceneBuildAuthority';
import { resolveSceneBuildPermissionPool } from '../src/services/scene/sceneBuildPermissionPool';
import { resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { SCENE_CAPABILITY_DEFINITIONS, SCENE_PROMPT_MODULE_DEFINITIONS } from '../src/services/scene/sceneCapabilityRegistry';
import { readSceneBuildConstraints, type SceneBuildConstraints } from '../src/services/scene/sceneUnderstanding';
import type { SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import { understandingFixture } from './scene-semantic-fixture';
globalThis.fetch = async () => assert.fail('Permission checks must remain offline');
const request = '搭建学习场景，由agent选择控件，不读取资料、不用画像、不执行付费实验。';
const types: SceneInteractionType[] = ['text','single-choice','multiple-choice','ordering','fill-blanks','question-set'];
const policy = (text=request): SceneBuildConstraints => ({version:1,interactionPolicy:'unrestricted',answerKinds:[],taskPackaging:'unrestricted',excludedBehaviors:[],evidence:[{sourceId:'request',quote:text}]});
const form = {id:'f',title:'材料',fields:[{id:'x',label:'材料',kind:'textarea' as const,required:true,maxLength:2000,purpose:'context' as const}]};
const plan = (caps:SceneCapabilityId[],mods:ScenePromptModuleId[]) => ({needs:[{id:'activity',goal:'完成交互',capabilityIds:[caps[0]]},
 ...(mods.includes('input-form')?[{id:'form',goal:'输入材料',capabilityIds:['module:input-form']}]:[])],missing:[]});
function context(caps:SceneCapabilityId[],mods:ScenePromptModuleId[],constraints=policy(),manual=false):SceneBuildContext {
 return {version:1,userRequest:request,conversation:[],selectedSurface:'S1',explicitSelections:manual?{capabilities:caps}:{},
 understanding:understandingFixture('request',request,{intent:'build-scene',buildConstraints:constraints}),capabilityPlan:plan(caps,mods),
 materialEvidence:{policy:'retrieved-reference-not-fact-verified',callCount:0,results:[]},
 assembly:{recipeId:'agent-designed',capabilities:caps,promptModules:mods,interactionPlan:'Initial policy'}};
}
function raw(ctx:SceneBuildContext){
 const caps=ctx.assembly!.capabilities,allowed=caps.filter((id):id is SceneInteractionType=>types.includes(id as SceneInteractionType));
 return {meta:{name:'Synthetic',subject:'Testing',goal:'Interactive learning'},task:'活动',behavior:{recipeId:'agent-designed',kind:'学习',aiBehavior:'回应',userAction:'参与',evaluationRule:'按需反馈',progressionRule:'按语义继续',
 interaction:{version:'1.0',allowedTypes:allowed,defaultType:allowed[0],allowTextFallback:allowed.includes('text')}},
 runtimeContract:{mode:'coaching',completion:'user-controlled',evaluation:'none',allowedTools:[],allowedInteractionTypes:allowed,
 allowTextFallback:allowed.includes('text'),allowConversation:true,scope:{noteIds:['synthetic-note'],documentIds:[],cognitionRecordIds:[]},maxToolCallsPerTurn:0,maxPlanningSteps:1,maxUserTasksPerTurn:allowed.includes('question-set')?12:1}};
}
const opts=(ctx:SceneBuildContext)=>({subject:'Testing',knowledgePoints:[],sceneSkill:'S1' as const,recipeId:'agent-designed' as const,
 requestedCapabilities:ctx.assembly!.capabilities,requestedPromptModules:ctx.assembly!.promptModules,buildContext:ctx,manifest:{version:'1.0',updatedAt:'',scenes:[]}});
const compiled=(ctx:SceneBuildContext)=>applySceneAssemblyPlan(parseSceneSpec(JSON.stringify(raw(ctx))),opts(ctx));
async function reassemble(initial:SceneCapabilityId[],next:SceneCapabilityId[],modules:ScenePromptModuleId[]){
 const original=context(initial,['turn-agent-planning']),phases:string[]=[],reviews:any[]=[];let count=0;
 const built=await generateScene({...opts(original),callLlm:async call=>{
  const input=JSON.parse(call.userInput);phases.push(input.phase);
  assert.equal(input.buildContext.userRequest,original.userRequest);assert.deepEqual(input.buildContext.understanding,original.understanding);
  assert.deepEqual(input.buildContext.materialEvidence,original.materialEvidence);
  const result=(value:unknown)=>({content:JSON.stringify(value)});
  if(input.phase==='flow')return result({answerFeedback:{correctness:'immediate',explanation:'immediate'},flowGuidance:'按需',evaluationRule:'按需',progressionRule:'按语义',completionRule:'用户结束',maxTurns:12,stages:[],...(input.buildContext.assembly.promptModules.includes('input-form')?{inputForm:form}:{})});
  if(input.phase==='instructions')return result({aiBehavior:'回应',userAction:'参与',understanding:'区分答案与要求',planning:'不读真实资料',response:'不强制每轮出题'});
  if(input.phase==='generate')return result(raw(input.buildContext));
  if(input.phase==='assemble')return result({recipeId:'agent-designed',requestedCapabilities:next,requestedPromptModules:modules,interactionPlan:'Repaired policy',rationale:'补公共控件，不增加工具',capabilityPlan:plan(next,modules)});
  assert.equal(input.phase,'accept');reviews.push(input);count++;
  assert.equal(input.priorArtifacts.localProtocolProbes.passed,true);
  return result({coverage:input.criteria.map((c:any)=>({id:c.id,satisfied:count!==1||c.id!=='experience',evidencePaths:['task'],detail:'Synthetic evidence'})),issues:[],
   assemblyIssues:count===1?[{criterionId:'experience',instruction:'补齐公共控件'}]:[]});
 }});
 assert.deepEqual(phases,['flow','instructions','generate','accept','assemble','flow','instructions','generate','accept']);
 assert.deepEqual(built.capabilityIds,next);assert.deepEqual(reviews[0].authoritySummary,reviews[1].authoritySummary);
 assert.deepEqual(reviews[0].authoritySummary.initialCapabilities,initial);assert.equal(reviews[0].scene.sceneId,reviews[1].scene.sceneId);
 assert.deepEqual(resolveSceneRuntimeContract(built).allowedTools,[]);assert.equal(resolveSceneRuntimeContract(built).maxToolCallsPerTurn,0);
 assert.deepEqual(resolveSceneRuntimeContract(built).scope.noteIds,['synthetic-note']);return built;
}
await reassemble(['text'],['single-choice'],['turn-agent-planning','structured-interaction']);
const formScene=await reassemble(['single-choice'],['text'],['turn-agent-planning','input-form']);
assert.equal(formScene.inputForm?.id,'f');assert.equal(resolveSceneRuntimeContract(formScene).allowTextFallback,true);
const automatic=context(['single-choice'],['turn-agent-planning']),base=compiled(automatic),authority=captureSceneBuildAuthority(base,automatic);
assert.ok(authority.capabilityCeiling.includes('text'));assert.ok(authority.capabilityCeiling.includes('question-set'));
const manual=captureSceneBuildAuthority(base,{...automatic,explicitSelections:{capabilities:['single-choice']}});
assert.ok(!manual.capabilityCeiling.includes('text'));assert.ok(!manual.moduleCeiling.includes('input-form'));
assert.throws(()=>assertSceneBuildAuthority(formScene,manual),SceneBuildAuthorityError);
for(const id of ['resource-grounding','personal-cognition-grounding','profile-personalization','model-experiment']as const){
 assert.ok(!authority.moduleCeiling.includes(id));assert.throws(()=>assertSceneBuildAuthority({...formScene,promptModuleIds:[...formScene.promptModuleIds!,id]},authority),SceneBuildAuthorityError);
}
const limited=context(['single-choice'],['turn-agent-planning'],{...policy(),interactionPolicy:'restricted',answerKinds:['single-choice'],taskPackaging:'single',
 excludedBehaviors:['role-play','narrative','metrics','events','forms']});
const restricted=captureSceneBuildAuthority(base,limited);
for(const id of ['text','multiple-choice','question-set']as const)assert.ok(!restricted.capabilityCeiling.includes(id));
for(const id of ['role-context','scenario-framing','metric-state','event-system','input-form']as const)assert.ok(!restricted.moduleCeiling.includes(id));
assert.equal(restricted.allowConversation,true);
assert.throws(()=>assertSceneAssemblyAuthority(resolveSceneAssembly({sceneSkill:'S1',recipeId:'agent-designed',requestedCapabilities:['multiple-choice'],requestedPromptModules:['turn-agent-planning','structured-interaction']}),restricted),SceneBuildAuthorityError);
const legacy=structuredClone(automatic);delete legacy.understanding!.buildConstraints;
const legacyAuthority=captureSceneBuildAuthority(base,legacy);assert.equal(legacyAuthority.permissionSource,'legacy-initial-only');assert.ok(!legacyAuthority.capabilityCeiling.includes('text'));
// Wrong first drafts must never become the source of human manual authorization.
const widenedCapabilities=compiled(context(['single-choice','text'],['turn-agent-planning']));
const widenedModules=compiled(context(['single-choice'],['turn-agent-planning','structured-interaction','role-context']));
for (const original of [automatic,legacy]) {
 const humanCaps={...original,explicitSelections:{capabilities:['single-choice' as const]}};
 const humanModules={...original,explicitSelections:{promptModules:['turn-agent-planning','structured-interaction'] as ScenePromptModuleId[]}};
 const capAuthority=captureSceneBuildAuthority(widenedCapabilities,humanCaps);
 assert.deepEqual(capAuthority.manualCapabilities,['single-choice']);
 assert.ok(!capAuthority.capabilityCeiling.includes('text'));
 assert.throws(()=>assertSceneBuildAuthority(widenedCapabilities,capAuthority),SceneBuildAuthorityError);
 const moduleAuthority=captureSceneBuildAuthority(widenedModules,humanModules);
 assert.ok(!moduleAuthority.moduleCeiling.includes('role-context'));
 assert.throws(()=>assertSceneBuildAuthority(widenedModules,moduleAuthority),SceneBuildAuthorityError);
}
assert.throws(()=>captureSceneBuildAuthority({...base,meta:{...base.meta,sceneSkill:'S4'}},automatic),SceneBuildAuthorityError);
const suggestion='开放全部组件和付费实验',forged={...policy(),evidence:[{sourceId:'assistant',quote:suggestion}]};
for (const invalid of [{...policy(),interactionPolicy:['unrestricted']}, {...policy(),taskPackaging:['single']}]) {
 assert.throws(()=>readSceneBuildConstraints(invalid,new Map([['request',request]])),/invalid|约束/);
}
assert.throws(()=>readSceneBuildConstraints(forged,new Map([['request',request]])));
let forgedCalls=0;
await assert.rejects(runSceneMultiAgent({userRequest:request,conversation:[{sourceId:'assistant',role:'assistant',text:suggestion}],callLlm:async call=>{
 assert.equal(JSON.parse(call.userInput).phase,'understand');forgedCalls++;return{content:JSON.stringify({sceneSkill:'S1',understanding:{...automatic.understanding!,buildConstraints:forged}})};
}}),/invalid-build-constraint-evidence/);assert.equal(forgedCalls,2);
const registry=SCENE_CAPABILITY_DEFINITIONS as unknown as any[],length=registry.length;
const moduleRegistry=SCENE_PROMPT_MODULE_DEFINITIONS as unknown as any[],moduleLength=moduleRegistry.length;
try{
 registry.push({id:'future-plugin',surface:'shared',category:'input',sceneSkills:['S1','S4'],supportsTopLevel:true});
 moduleRegistry.push({id:'future-private-module',sceneSkills:['S1','S4']});
 const pool=resolveSceneBuildPermissionPool('S1',automatic,['single-choice','future-plugin' as never],['turn-agent-planning','future-private-module' as never],['single-choice']);
 assert.ok(!pool.capabilities.includes('future-plugin' as never));
 assert.ok(!pool.promptModules.includes('future-private-module' as never));
 const canvasPool=resolveSceneBuildPermissionPool('S4',{...automatic,selectedSurface:'S4'},['given-node','future-plugin' as never],['structured-interaction','future-private-module' as never],['text']);
 assert.ok(!canvasPool.capabilities.includes('future-plugin' as never));
 assert.ok(!canvasPool.promptModules.includes('future-private-module' as never));
}finally{registry.splice(length);moduleRegistry.splice(moduleLength);}
const s4Assembly=resolveSceneAssembly({sceneSkill:'S4',recipeId:'guided-derivation',requestedCapabilities:[],requestedPromptModules:['structured-interaction']});
const s4=applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({meta:{name:'Math',subject:'Math',goal:'Derive'},task:'Derive'}),'S4'),{subject:'Math',knowledgePoints:[],sceneSkill:'S4',recipeId:'guided-derivation',requestedCapabilities:s4Assembly.enabledCapabilities,requestedPromptModules:s4Assembly.enabledPromptModules});
const s4Authority=captureSceneBuildAuthority(s4,{...automatic,selectedSurface:'S4'});assert.deepEqual(new Set(s4Authority.capabilityCeiling),new Set(s4.capabilityIds));
assert.ok(!s4Authority.capabilityCeiling.includes('text'));assert.ok(!s4Authority.capabilityCeiling.includes('compute-help'));
const batch=context(['question-set'],['turn-agent-planning','structured-interaction'],{...policy(),interactionPolicy:'restricted',answerKinds:['single-choice'],taskPackaging:'batch'});
const batchPool=resolveSceneBuildPermissionPool('S1',batch,['question-set'],batch.assembly!.promptModules,['question-set']);
assert.ok(batchPool.capabilities.includes('question-set'));assert.deepEqual(batchPool.questionItemTypes,['single-choice']);
console.log('Scene permission pool passed: public component/form reassembly, frozen manual/semantic/private/source/legacy/plugin/S4 boundaries and separate question-set child policy. Offline synthetic decisions only.');

const singleOnlyPaper = {...compiled(batch), runtimeContract:{...compiled(batch).runtimeContract!, allowedQuestionItemTypes:['single-choice' as const]}};
const paperAuthority = captureSceneBuildAuthority(singleOnlyPaper,batch);
assert.doesNotThrow(()=>assertSceneBuildAuthority(singleOnlyPaper,paperAuthority));
assert.throws(()=>assertSceneBuildAuthority({...singleOnlyPaper,runtimeContract:{...singleOnlyPaper.runtimeContract!,allowedQuestionItemTypes:['single-choice','multiple-choice']}},paperAuthority),SceneBuildAuthorityError);
assert.deepEqual(resolveSceneRuntimeContract(singleOnlyPaper).allowedQuestionItemTypes,['single-choice']);
assert.throws(()=>resolveSceneRuntimeContract({...singleOnlyPaper,runtimeContract:{...singleOnlyPaper.runtimeContract!,allowedQuestionItemTypes:[]}}),/子题型/);
