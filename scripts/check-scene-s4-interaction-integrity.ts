import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import type {SceneSpec, SceneRunState} from '../src/types';
import type {DerivationNode, StepLegitResult} from '../src/types/sceneS4';
import {parseSceneSpec} from '../src/services/scene/sceneGenerator';
import {createRunState} from '../src/services/scene/sceneRuntime';
import {buildAnalyzeInput} from '../src/services/scene/computeAnalyze';
import {collectBranchPremises, legitFeedback} from '../src/services/scene/premiseChain';
import {updateNodeResult, checkS4Completion, refreshS4EngineMetrics} from '../src/services/scene/derivationRuntime';
import {s4GoalAssessment, s4GoalInputKey, isS4GoalAchieved} from '../src/services/scene/sceneS4Goal';
import {buildHelpInput, requestHelp} from '../src/services/scene/sceneHelp';
import {isSceneOutputTruncated} from '../src/services/scene/sceneOutputSafety';
import {isS4CanvasChangeAuthorized, s4AllowedNodeTypes} from '../src/services/scene/sceneS4Policy';
import {useDerivationStore} from '../src/modules/derivationCanvas/derivationStore';

globalThis.fetch = async () => assert.fail('S4 interaction integrity must remain offline');
const spec = parseSceneSpec(JSON.stringify({meta:{name:'合成互动完整性',goal:'求x+1的值'},task:'已知x=1，求x+1',
  metrics:[{id:'proof',name:'正确性',description:'引擎支路',source:'engine',type:'boolean',initial:false,target:true,s4Binding:'formula-correctness'}],
  compute:{type:'formula',operation:'derive',expected_formula:'PRIVATE_REFERENCE_7295',expected_steps:['PRIVATE_STEP_7295'],
    expected_steps_count:20,given:[{name:'前提',display:'x=1'}],symbols:[{name:'x',kind:'variable'}]},
  help:{base_help_count:4,max_help_count:4,penalty_per_help:.2},
}), 'S4');
const initial = createRunState(spec);
const conclusion: DerivationNode = {id:'done',type:'conclusion',position:{x:300,y:0},data:{label:'结论',latex:'x=x',status:'draft',frozen:false}};
const input: SceneRunState = {...initial,canvas:{...initial.canvas!,nodes:[...initial.canvas!.nodes,conclusion],
  edges:[{id:'input',source:initial.canvas!.nodes[0].id,target:'done',type:'derivation'}]}};
const verdict: StepLegitResult = {legit:'legit',code:'ok',proofBasis:'entailed'};
const verification = {formula_correct:true,dimension_check:true,verdictSource:'premise' as const,feedback:'synthetic',premiseVerdict:verdict};

// Execute production analyzer + production qualitative request with synthetic parser/engine/provider.
const source = ts.createSourceFile('compute.ts',readFileSync('src/services/scene/computeAnalyze.ts','utf8'),ts.ScriptTarget.ES2022,true);
function extract(name: string, env: Record<string,unknown>) {
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)!;
  assert.ok(declaration,name);
  const js=ts.transpileModule(declaration.getText(source).replace(/^export\s+/,'')+`\nreturn ${name};`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function(...Object.keys(env),js)(...Object.values(env));
}
let modelOutput: unknown, finishReason='stop', calls=0;
const qualitative=extract('requestQualitativeFeedback',{
  callLLM:async (request:any)=>{calls++;assert.equal(request.skipMemoryInjection,true);assert.equal(request.skipProfileInjection,true);
    assert.doesNotMatch(request.userInput,/PRIVATE_REFERENCE_7295|PRIVATE_STEP_7295/);
    return {content:JSON.stringify(modelOutput),diagnostics:{finishReason}};},
  buildAnalyzeInput,isSceneOutputTruncated,parseJsonLenient:JSON.parse,
});
let engineVerdict=verdict;
const analyze=extract('analyzeStep',{
  nodePermissionFailure:()=>undefined,resolveNodeExpression:async()=>({ok:true,expr:'x=x'}),
  collectBranchPremises,judgeStepLegitimacy:async()=>engineVerdict,legitFeedback,
  requestQualitativeFeedback:qualitative,s4GoalAssessment,
});
for (const status of ['not-achieved','unknown','achieved'] as const) {
  modelOutput={feedback:'只解释引擎结果',suggestions:[],goal_assessment:{status,reason:'synthetic coverage decision'}};
  const before=calls;
  const result=await analyze({spec,run:input,node:conclusion,sessionId:'offline'});
  assert.equal(calls-before,1,'reuse the original feedback request; no extra goal-model call');
  assert.equal(result.status,'pass');assert.equal(result.verification.formula_correct,true);
  assert.equal(result.verification.goalAssessment.status,status);
  const applied=updateNodeResult(input,'done',result.status,result.verification);
  assert.equal(checkS4Completion(spec,applied).status,status==='achieved'?'success':'running');
}
for (const raw of [undefined,{status:'achieved',reason:''},{status:true,reason:'fake'},{status:'invented',reason:'fake'}]) {
  modelOutput={feedback:'synthetic',goal_assessment:raw};
  const result=await analyze({spec,run:input,node:conclusion,sessionId:'offline'});
  assert.equal(result.status,'pass');assert.equal(result.verification.goalAssessment.status,'unknown');
  assert.equal(checkS4Completion(spec,updateNodeResult(input,'done','pass',result.verification)).status,'running');
}
finishReason='length';modelOutput={feedback:'truncated',goal_assessment:{status:'achieved',reason:'fake'}};
const truncated=await analyze({spec,run:input,node:conclusion,sessionId:'offline'});
assert.equal(truncated.verification.goalAssessment.status,'unknown');assert.notEqual(truncated.verification.feedback,'truncated');
finishReason='stop';engineVerdict={legit:'illegal',code:'not_derivable'};
const invalid=await analyze({spec,run:input,node:conclusion,sessionId:'offline'});
assert.equal(invalid.status,'fail');assert.equal(invalid.verification.formula_correct,false);assert.equal(invalid.verification.goalAssessment,undefined);
engineVerdict=verdict;
const covered=updateNodeResult(input,'done','pass',{...verification,goalAssessment:s4GoalAssessment(spec,input,'done',{status:'achieved',reason:'synthetic complete'})});
assert.equal(isS4GoalAchieved(spec,covered,'done'),true);
assert.equal(isS4GoalAchieved({...spec,task:'新任务'},covered,'done'),false);
const changed={...covered,canvas:{...covered.canvas!,nodes:covered.canvas!.nodes.map(node=>node.id==='done'?{...node,data:{...node.data,latex:'1=1'}}:node)}};
assert.equal(isS4GoalAchieved(spec,changed,'done'),false);assert.equal(checkS4Completion(spec,changed).status,'running');
assert.notEqual(s4GoalInputKey(spec,covered,'done'),s4GoalInputKey(spec,changed,'done'));

// No bare pass/LLM badge, missing ancestor or cyclic historical branch may feed execution.
const upstream: DerivationNode={...conclusion,id:'upstream',type:'formula',data:{...conclusion.data,status:'pass',verification:undefined}};
const downstream={...conclusion,id:'downstream',type:'formula' as const};
for (const v of [undefined,{...verification,verdictSource:'llm' as const},{...verification,formula_correct:false}]) {
  const canvas={...input.canvas!,nodes:[input.canvas!.nodes[0],{...upstream,data:{...upstream.data,verification:v}},downstream],
    edges:[{id:'a',source:input.canvas!.nodes[0].id,target:'upstream',type:'derivation' as const},{id:'b',source:'upstream',target:'downstream',type:'derivation' as const}]};
  const premises=collectBranchPremises(downstream,canvas,spec);
  assert.ok(premises.ignoredAncestorIds.includes('upstream'));assert.equal(premises.facts.includes('x=x'),false);
  assert.equal(refreshS4EngineMetrics(spec,{...input,canvas}).metrics[0].value,false);
}
const missing={...input.canvas!,nodes:[conclusion],edges:[{id:'missing',source:'missing',target:'done',type:'derivation' as const}]};
assert.ok(collectBranchPremises(conclusion,missing,spec).ignoredAncestorIds.includes('missing'));

// Editing/removing allowed ancestors may invalidate disabled old nodes, never edit their content or grant proof.
const oldChild: DerivationNode={...upstream,id:'old',type:'assumption',data:{...upstream.data,latex:'x>0',status:'frozen',frozen:true,verification}};
const old={...input.canvas!,nodes:[input.canvas!.nodes[0],{...upstream,data:{...upstream.data,verification}},oldChild],
  edges:[{id:'a',source:input.canvas!.nodes[0].id,target:'upstream',type:'derivation' as const},{id:'b',source:'upstream',target:'old',type:'derivation' as const}]};
const allowed=s4AllowedNodeTypes({...spec,capabilityIds:['given-node','formula-node','conclusion-node']});
useDerivationStore.getState().initCanvas(old);useDerivationStore.getState().updateNodeDraft('upstream',{latex:'x+1=2'});
const edited=useDerivationStore.getState().canvas;
assert.equal(isS4CanvasChangeAuthorized(old,edited,allowed),true);
assert.equal(edited.nodes.at(-1)!.data.status,'draft');assert.equal(edited.nodes.at(-1)!.data.verification,undefined);
for (const patch of [{latex:'x=999'},{note:'forged'},{verification},{frozen:true},{status:'pass'}]) {
  const forged={...edited,nodes:edited.nodes.map(node=>node.id==='old'?{...node,data:{...node.data,...patch}} as DerivationNode:node)};
  assert.equal(isS4CanvasChangeAuthorized(old,forged,allowed),false);
}
assert.equal(isS4CanvasChangeAuthorized(old,{...old,nodes:old.nodes.map(node=>node.id==='old'?{...node,data:{...node.data,status:'draft',frozen:false,verification:undefined}}:node)},allowed),false,'no unrelated invalidation allowance');
useDerivationStore.getState().initCanvas(old);useDerivationStore.getState().removeNode('upstream');
assert.equal(isS4CanvasChangeAuthorized(old,useDerivationStore.getState().canvas,allowed),true);

// Pure explanation is valid help, consumes exactly one existing quota, and is inherited by the next query.
let run=initial;
for (const query of ['只解释为什么，不要新公式','再举一个形象的例子']) {
  const result=await requestHelp({spec,run,currentNodeId:null,query,callLlm:async request=>{
    if(run.canvas!.helpUsed) {assert.match(request.userInput,/只解释为什么/);assert.match(request.userInput,/PRIOR_EXPLANATION_7295/);}
    return {content:JSON.stringify({latex:'',reason:'PRIOR_EXPLANATION_7295：合成比喻'})};
  }});
  assert.equal(result.ok,true);
  assert.equal(result.nextRun.canvas!.helpUsed,run.canvas!.helpUsed+1);assert.equal(result.help.latex,'');run=result.nextRun;
}
assert.equal(run.canvas!.independenceScore,.6);
const snapshot=JSON.stringify(run);
assert.equal((await requestHelp({spec,run,currentNodeId:null,query:'empty',callLlm:async()=>({content:'{}'})})).ok,false);
assert.equal(JSON.stringify(run),snapshot);
const long={...run,derivationEvents:[...(run.derivationEvents??[]),...Array.from({length:100},()=>({type:'help_request' as const,at:'',step:'old',helpLevel:1,query:'a'.repeat(10000)}))]};
const history=buildHelpInput({spec,run:long,currentNodeId:null,query:'CURRENT_QUERY_7295'});
assert.ok(history.length<18000);assert.match(history,/节选/);assert.match(history,/CURRENT_QUERY_7295/);
assert.equal(long.derivationEvents.at(-1)!.type,'help_request');
console.log('S4 interaction integrity passed: shared execution evidence, narrowly scoped historical invalidation, one-request goal coverage isolated from engine validity/reference answers, stale/unknown/truncated goal safety, pure explanation and bounded conversation continuity. Synthetic IO only.');
