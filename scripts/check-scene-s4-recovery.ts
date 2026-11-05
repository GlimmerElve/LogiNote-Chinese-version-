import assert from 'node:assert/strict';
import type {DerivationNode} from '../src/types/sceneS4';
import {parseSceneSpec} from '../src/services/scene/sceneGenerator';
import {createRunState} from '../src/services/scene/sceneRuntime';
import {checkS4Completion, applyS4Completion, appendDerivationEvent, makeDerivationEvent, s4SubmissionCount} from '../src/services/scene/derivationRuntime';
import {canRetryS4Goal, s4GoalInputKey, s4GoalRetryCount, s4GoalAssessment} from '../src/services/scene/sceneS4Goal';
import {requestS4GoalCheck} from '../src/services/scene/sceneS4GoalCheck';
import {requestHelp,buildHelpInput} from '../src/services/scene/sceneHelp';
import {s4HelpInputKey} from '../src/services/scene/sceneS4HelpContext';
import {useDerivationStore} from '../src/modules/derivationCanvas/derivationStore';
import {isS4CanvasChangeAuthorized,s4AllowedNodeTypes} from '../src/services/scene/sceneS4Policy';

globalThis.fetch=async()=>assert.fail('S4 recovery checks must remain offline');
const spec=parseSceneSpec(JSON.stringify({meta:{name:'合成恢复测试',goal:'求出x'},task:'已知2*x=2，求x',
  metrics:[{id:'proof',name:'正确性',description:'当前支路',source:'engine',s4Binding:'formula-correctness',type:'boolean',initial:false,target:true}],
  completion:{mode:'signal',maxTurns:1},compute:{type:'formula',operation:'derive',expected_formula:'PRIVATE_REFERENCE_8329',
    given:[{name:'方程',display:'2*x=2'}],symbols:[{name:'x',kind:'variable'}],expected_steps_count:20},
  help:{base_help_count:3,max_help_count:3},
}), 'S4');
const fresh=createRunState(spec);
const receipt={formula_correct:true,dimension_check:true,verdictSource:'premise' as const,feedback:'数学验证结果必须保留'};
const conclusion:DerivationNode={id:'done',type:'conclusion',position:{x:300,y:0},data:{label:'结论',latex:'x=1',status:'pass',frozen:false,verification:receipt}};
let run={...fresh,turnCount:1,canvas:{...fresh.canvas!,nodes:[...fresh.canvas!.nodes,conclusion],edges:[{id:'edge',source:fresh.canvas!.nodes[0].id,target:'done',type:'derivation' as const}]}};
assert.equal(checkS4Completion(spec,run).status,'running','unknown goal at last valid math attempt is recoverable, not automatic failure');
assert.equal(applyS4Completion(spec,run).status,'running');assert.equal(canRetryS4Goal(spec,run,'done'),true);
let calls=0;
const checked=await requestS4GoalCheck({spec,run,nodeId:'done',callLlm:async request=>{
  calls++;assert.equal(request.skipMemoryInjection,true);assert.equal(request.skipProfileInjection,true);
  assert.equal(request.workflow,'scene-compute-analyze');assert.equal(request.maxTokensOverride,768);
  assert.doesNotMatch(request.userInput,/PRIVATE_REFERENCE_8329|expected_formula|expected_steps/);
  return {content:JSON.stringify({goal_assessment:{status:'achieved',reason:'合成：覆盖求x任务'}})};
}});
assert.equal(checked.ok,true);assert.equal(calls,1);
if(checked.ok) {
  const done={...run,canvas:{...run.canvas,nodes:run.canvas.nodes.map(node=>node.id==='done'?{...node,data:{...node.data,verification:{...receipt,goalAssessment:checked.assessment}}}:node)}};
  assert.equal(checkS4Completion(spec,done).status,'success');assert.equal(done.canvas.helpUsed,0);assert.equal(s4SubmissionCount(done),1);
}
for(let attempt=0;attempt<2;attempt++) {
  const before=run;
  const result=await requestS4GoalCheck({spec,run:before,nodeId:'done',callLlm:async()=>{calls++;return {content:'{}',diagnostics:{finishReason:'length'}};}});
  assert.equal(result.ok,false);
  run=appendDerivationEvent(run,makeDerivationEvent('goal_check_request',{nodeId:'done',inputKey:s4GoalInputKey(spec,run,'done')})) as typeof run;
  assert.equal(s4GoalRetryCount(spec,run,'done'),attempt+1);assert.equal(run.canvas.nodes[1].data.verification,receipt);
}
const beforeDenied=calls;
assert.equal(canRetryS4Goal(spec,run,'done'),false);
assert.equal((await requestS4GoalCheck({spec,run,nodeId:'done',callLlm:async()=>{calls++;return {content:'{}'};}})).ok,false);
assert.equal(calls,beforeDenied);assert.equal(checkS4Completion(spec,run).status,'running');
assert.equal(applyS4Completion(spec,run,{userIntentEnd:true}).status,'failure','user can always end an unresolved run');
assert.equal(s4SubmissionCount(run),1);assert.equal(run.canvas.helpUsed,0);
const notDone={...run,canvas:{...run.canvas,nodes:run.canvas.nodes.map(node=>node.id==='done'?{...node,data:{...node.data,verification:{...receipt,
  goalAssessment:s4GoalAssessment(spec,run,'done',{status:'not-achieved',reason:'只完成局部'})}}}:node)}};
assert.equal(checkS4Completion(spec,notDone).status,'failure','known incomplete task at the cap still fails normally');

const allowed=s4AllowedNodeTypes({...spec,capabilityIds:['given-node','formula-node','conclusion-node']});
const formula:DerivationNode={...conclusion,id:'step',type:'formula',data:{...conclusion.data}};
const disabled:DerivationNode={...conclusion,id:'disabled',type:'assumption',data:{...conclusion.data,latex:'x>0',frozen:true,status:'frozen'}};
const before={...fresh.canvas!,nodes:[fresh.canvas!.nodes[0],formula,disabled],edges:[{id:'a',source:fresh.canvas!.nodes[0].id,target:'step',type:'derivation' as const},{id:'b',source:'step',target:'disabled',type:'derivation' as const}]};
useDerivationStore.getState().initCanvas(before);useDerivationStore.getState().updateNodeDraft('step',{latex:'x=2'});
const edited=useDerivationStore.getState().canvas;
assert.equal(isS4CanvasChangeAuthorized(before,edited,allowed),true);
assert.equal(useDerivationStore.getState().undo(allowed),true);
const undone=useDerivationStore.getState().canvas;
assert.equal(undone.nodes[1].data.latex,'x=1');assert.equal(undone.nodes[2].data.status,'draft');assert.equal(undone.nodes[2].data.verification,undefined);
assert.equal(isS4CanvasChangeAuthorized(edited,undone,allowed),true);
assert.equal(useDerivationStore.getState().redo(allowed),true);
assert.equal(useDerivationStore.getState().canvas.nodes[1].data.latex,'x=2');
assert.equal(isS4CanvasChangeAuthorized(undone,useDerivationStore.getState().canvas,allowed),true);
useDerivationStore.setState(state=>({canvas:{...state.canvas,helpUsed:2,independenceScore:.8}}));
useDerivationStore.getState().undo(allowed);
assert.equal(useDerivationStore.getState().canvas.helpUsed,2);assert.equal(useDerivationStore.getState().canvas.independenceScore,.8);

const help=await requestHelp({spec,run:fresh,currentNodeId:fresh.canvas!.nodes[0].id,query:'提示',callLlm:async()=>({content:JSON.stringify({latex:'x=1',reason:'合成提示'})})});
assert.equal(help.ok,true);
if(help.ok) {
  const event=help.nextRun.derivationEvents!.find(event=>event.type==='help_response');
  assert.ok(event?.type==='help_response');assert.equal(event.nodeId,fresh.canvas!.nodes[0].id);
  assert.equal(event.inputKey,s4HelpInputKey(spec,fresh,event.nodeId!));
  assert.equal(event.inputKey,s4HelpInputKey(spec,help.nextRun,event.nodeId!), 'help accounting does not invalidate its own card');
  assert.match(buildHelpInput({spec,run:fresh,currentNodeId:event.nodeId!,query:'提示'}),new RegExp('当前节点ID：'+event.nodeId));
}
console.log('S4 recovery passed: capped valid math stays recoverable, two explicit goal-only retries with no submit/help debit, private-answer/engine isolation, authorized undo/redo without disabled proof/quota restoration, helper origin receipts. Synthetic IO only.');
