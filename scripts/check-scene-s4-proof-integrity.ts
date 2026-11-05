import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import type {DerivationNode} from '../src/types/sceneS4';
import {parseSceneSpec} from '../src/services/scene/sceneGenerator';
import {createRunState, resetForRerun} from '../src/services/scene/sceneRuntime';
import {refreshS4EngineMetrics, updateS4Metrics, computeFinalScore, applyS4Completion, checkS4Completion} from '../src/services/scene/derivationRuntime';
import {isS4CanvasChangeAuthorized, s4AllowedNodeTypes} from '../src/services/scene/sceneS4Policy';
import {preservesSystemGivens} from '../src/modules/derivationCanvas/utils/givenIntegrity';
import {useDerivationStore} from '../src/modules/derivationCanvas/derivationStore';
import {collectBranchPremises} from '../src/services/scene/premiseChain';
import {analyzeStep, analyzeAssumptionStep} from '../src/services/scene/computeAnalyze';
import {s4GoalAssessment} from '../src/services/scene/sceneS4Goal';

globalThis.fetch = async () => assert.fail('S4 proof regressions must stay offline');
const scene = parseSceneSpec(JSON.stringify({meta:{name:'合成证据完整性',subject:'数学',goal:'求解x'},task:'从x=1推出结论',
  metrics:[{id:'proof',name:'正确性',source:'engine',type:'boolean',initial:true,target:true,s4Binding:'formula-correctness'}],
  compute:{type:'formula',operation:'derive',expected_formula:'x=1',symbols:[{name:'x',kind:'variable'}],given:[{name:'前提',display:'x=1'}]},
}), 'S4');
const initial = createRunState(scene);
const pass = {formula_correct:true,dimension_check:true,verdictSource:'premise' as const,feedback:'synthetic verified'};
const step: DerivationNode = {id:'step',type:'formula',position:{x:200,y:0},data:{label:'步骤',latex:'x=1',status:'pass',frozen:false,verification:pass}};
const valid = {...initial,canvas:{...initial.canvas!,nodes:[...initial.canvas!.nodes,step],edges:[{id:'edge',source:initial.canvas!.nodes[0].id,target:step.id,type:'derivation' as const}]}};
const value = (run: typeof initial) => run.metrics.find(item=>item.metricId==='proof')?.value;
assert.equal(value(initial),false,'initial correctness must already reflect the empty proof graph');
assert.equal(value(refreshS4EngineMetrics(scene,initial)), false, 'configured initial=true is not proof');
assert.equal(value(updateS4Metrics(scene,valid,pass)), true);
const store = useDerivationStore;
store.getState().initCanvas(valid.canvas);
store.getState().updateNodeDraft('step',{latex:'x=999'});
assert.equal(store.getState().canvas.nodes[1].data.status,'draft');
assert.equal(store.getState().canvas.nodes[1].data.verification,undefined, 'store itself invalidates the edited node');
const edited = refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas});
assert.equal(value(edited),false); assert.equal(computeFinalScore(scene,edited),.1);
const final = applyS4Completion(scene,{...valid,canvas:store.getState().canvas},{userIntentEnd:true});
assert.equal(value(final),false); assert.equal(final.status,'failure'); assert.equal(final.finalScore,.1, 'stale true mirror cannot earn correctness credit');
store.getState().initCanvas(valid.canvas); store.getState().removeNode('step');
assert.equal(value(refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas})),false);
assert.equal(store.getState().undo(),true);
assert.equal(value(refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas})),true);
assert.equal(store.getState().redo(),true);
assert.equal(value(refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas})),false);
store.getState().initCanvas(valid.canvas); store.getState().updateNodeDraft('step',{note:'仅解释，不改变公式'});
assert.equal(store.getState().canvas.nodes[1].data.verification,pass);
assert.equal(value(refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas})),true);
store.getState().removeEdge('edge');
assert.equal(value(refreshS4EngineMetrics(scene,{...valid,canvas:store.getState().canvas})),false);

const bad = {...step,id:'bad',data:{...step.data,latex:'x=999',status:'fail' as const,verification:{...pass,formula_correct:false}}};
const sibling = {...valid,canvas:{...valid.canvas,nodes:[...valid.canvas.nodes,bad]}};
assert.equal(value(updateS4Metrics(scene,sibling,bad.data.verification)),true,'unrelated failed branch does not erase a valid one');
const child = {...step,id:'child'};
const staleChild = {...edited,canvas:{...edited.canvas!,nodes:[...edited.canvas!.nodes,child],edges:[...edited.canvas!.edges,{id:'child-edge',source:'step',target:'child',type:'derivation' as const}]}};
assert.equal(value(refreshS4EngineMetrics(scene,staleChild)),false,'a passed child cannot bypass an invalidated ancestor');
const cyclic = {...valid,canvas:{...valid.canvas,nodes:[step,child],edges:[{id:'a',source:'step',target:'child',type:'derivation' as const},{id:'b',source:'child',target:'step',type:'derivation' as const}]}};
assert.equal(value(refreshS4EngineMetrics(scene,cyclic)),false);
const noteOnly = {...step,data:{...step.data,latex:'',note:'x=1'}};
const old = {...valid,canvas:{...valid.canvas,nodes:[valid.canvas.nodes[0],noteOnly,child],edges:[...valid.canvas.edges,{id:'old-child',source:'step',target:'child',type:'derivation' as const}]}};
assert.equal(value(refreshS4EngineMetrics(scene,old)),false);
store.getState().initCanvas(old.canvas);store.getState().updateNodeDraft('step',{note:'x=999'});
assert.equal(store.getState().canvas.nodes[1].data.status,'draft');
assert.equal(store.getState().canvas.nodes[1].data.verification,undefined);
assert.equal(store.getState().canvas.nodes[2].data.status,'draft','cleanup also invalidates descendants of old note-only proof');
assert.ok(collectBranchPremises(child,old.canvas,scene).ignoredAncestorIds.includes('step'));

store.getState().initCanvas(valid.canvas);
const given = valid.canvas.nodes[0], before = JSON.stringify(given.data);
store.getState().toggleFreeze(given.id); store.getState().updateNode(given.id,{latex:'x=999'});
store.getState().updateNodeDraft(given.id,{note:'forged'});store.getState().removeNode(given.id);
assert.equal(JSON.stringify(store.getState().canvas.nodes[0].data),before);
assert.equal(store.getState().addNode('given'), '');
assert.equal(store.getState().canvas.nodes.length,2);
const removed = {...valid.canvas,nodes:[step],edges:[]};
assert.equal(preservesSystemGivens(valid.canvas,removed),false);
assert.equal(isS4CanvasChangeAuthorized(valid.canvas,removed,s4AllowedNodeTypes(scene)),false);
store.setState({past:[removed],future:[removed]});
assert.equal(store.getState().undo(),false);assert.equal(store.getState().redo(),false);
assert.equal(store.getState().canvas.nodes[0].id,given.id);
const moved = {...valid.canvas,nodes:valid.canvas.nodes.map(node=>node.id===given.id?{...node,position:{x:99,y:98},data:{...node.data}}:node)};
assert.equal(preservesSystemGivens(valid.canvas,moved),true,'givens remain movable');
assert.equal(isS4CanvasChangeAuthorized(valid.canvas,moved,s4AllowedNodeTypes(scene)),true);
const legacyGiven = {...given,data:{...given.data,frozen:false}};
store.getState().initCanvas({...valid.canvas,nodes:[legacyGiven,step]});store.getState().updateNodeDraft(given.id,{note:'forged'});store.getState().removeNode(given.id);
assert.equal(store.getState().canvas.nodes[0].data.note,legacyGiven.data.note,'given type is protected independently of historical frozen flags');

const source = ts.createSourceFile('compute.ts',readFileSync('src/services/scene/computeAnalyze.ts','utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='resolveNodeExpression')!;
const js=ts.transpileModule(declaration.getText(source).replace(/^export\s+/,'')+'\nreturn resolveNodeExpression;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let parses=0;const inputs:string[]=[];
const resolve = new Function('buildSessionSymbols','parseExpression',js)(()=>[],async(raw:string)=>{parses++;inputs.push(raw);return {ok:true,result:{sympyExpr:raw}};});
for(const type of ['formula','assumption','conclusion']) {
  const result = await resolve({...noteOnly,type},scene);
  assert.equal(result.ok,false);assert.match(result.error,/公式为空.*备注/);
  const node = {...noteOnly,type} as DerivationNode;
  const checked = await (type === 'assumption' ? analyzeAssumptionStep : analyzeStep)({spec:scene,run:{...valid,canvas:{...valid.canvas,nodes:[valid.canvas.nodes[0],node]}},node,sessionId:'synthetic-no-io'});
  assert.equal(checked.status,'warn');assert.equal(checked.verification.verdictSource,'none');
  assert.match(checked.verification.feedback,/公式为空.*备注/);
}
assert.equal(parses,0,'blank math is rejected before any engine or model IO');
assert.equal((await resolve({...step,data:{...step.data,note:'这是说明，不是公式'}},scene)).expr,'x=1');
assert.equal((await resolve({...given,data:{...given.data,latex:undefined,note:'x=1'}},scene)).expr,'x=1','old system-given fallback remains intact');
assert.deepEqual(inputs,['x=1','x=1']);
const s1 = {...scene,meta:{...scene.meta,sceneSkill:'S1' as const}};
assert.equal(refreshS4EngineMetrics(s1,valid),valid,'S4 reconciliation must not touch S1');

// Completion must not use a weaker status-only notion of proof than the metric panel.
const conclusion: DerivationNode = {...step,id:'done',type:'conclusion',data:{...step.data}};
const complete = {...valid,canvas:{...valid.canvas,nodes:[...valid.canvas.nodes,conclusion],edges:[...valid.canvas.edges,{id:'done-edge',source:'step',target:'done',type:'derivation' as const}]}};
assert.equal(checkS4Completion(scene,complete).status,'running','mathematical proof alone is not goal coverage');
conclusion.data.verification = {...pass,goalAssessment:s4GoalAssessment(scene,complete,'done',{status:'achieved',reason:'synthetic goal coverage'})};
assert.equal(checkS4Completion(scene,complete).status,'success');
for (const verdictSource of ['engine','premise'] as const) for (const status of ['pass','frozen'] as const) {
  const compatible = {...complete,canvas:{...complete.canvas,nodes:complete.canvas.nodes.map(node=>node.id==='done'?{...node,data:{...node.data,status,verification:{...node.data.verification!,verdictSource}}}:node)}};
  assert.equal(checkS4Completion(scene,compatible).status,'success','both supported engine verdicts and frozen verified conclusions remain valid');
}
const noMetrics = {...scene,metrics:[]};
for (const verification of [undefined,{...pass,formula_correct:false},{...pass,verdictSource:'none' as const}]) {
  const unproven = {...complete,canvas:{...complete.canvas,nodes:complete.canvas.nodes.map(node=>node.id==='done'?{...node,data:{...node.data,verification}}:node)}};
  assert.equal(checkS4Completion(noMetrics,unproven).status,'running','pass label alone cannot finish even without metrics');
  assert.equal(checkS4Completion(scene,unproven).status,'running','a separate valid formula cannot launder an unproven conclusion');
}
const looped = {...complete,canvas:{...complete.canvas,edges:[...complete.canvas.edges,{id:'loop',source:'step',target:'step',type:'derivation' as const}]}};
assert.equal(checkS4Completion(noMetrics,looped).status,'running');
const emptyGiven = {...complete,canvas:{...complete.canvas,nodes:complete.canvas.nodes.map(node=>node.type==='given'?{...node,data:{...node.data,entries:[{kind:'relation' as const,display:'unusable',symbolic:''}]}}:node)}};
assert.equal(checkS4Completion(noMetrics,emptyGiven).status,'running');
const disabled = {...scene,capabilityIds:['given-node','formula-node','step-submit','premise-validation'] as typeof scene.capabilityIds,metrics:[]};
assert.equal(checkS4Completion(disabled,complete).status,'running','disabled historical conclusion cannot finish');
const assumed = {...step,id:'assumed',type:'assumption' as const};
const disabledAncestor = {...complete,canvas:{...complete.canvas,nodes:[...complete.canvas.nodes,assumed],edges:[...complete.canvas.edges,{id:'assumed-edge',source:'assumed',target:'done',type:'derivation' as const}]}};
assert.equal(checkS4Completion({...disabled,capabilityIds:[...disabled.capabilityIds!,'conclusion-node']},disabledAncestor).status,'running');
assert.equal(checkS4Completion(noMetrics,{...complete,canvas:{...complete.canvas,nodes:[...complete.canvas.nodes,bad]}}).status,'success','unrelated failure must not block a complete branch');
const freshSpec = {...scene,metrics:[...scene.metrics,
  {id:'helps',name:'helps',description:'synthetic help count',source:'rule' as const,type:'count' as const,initial:99,target:1,s4Binding:'help-used' as const},
  {id:'independent',name:'independent',description:'synthetic independence',source:'rule' as const,type:'continuous' as const,initial:0,target:1,s4Binding:'independence-score' as const,range:[0,1] as [number,number]}]};
const fresh = createRunState(freshSpec,{metrics:{proof:{initial:true},helps:{initial:88},independent:{initial:0}}});
assert.deepEqual(fresh.metrics.map(item=>item.value),[false,0,1]);
const restarted = resetForRerun(freshSpec,{...fresh,status:'success',s4ReferenceUnlocked:true,endedByUser:true,turnCount:15,canvas:{...fresh.canvas!,helpUsed:2,independenceScore:.1}});
assert.notEqual(restarted.runId,fresh.runId);assert.equal(restarted.status,'running');assert.equal(restarted.turnCount,0);
assert.equal(restarted.s4ReferenceUnlocked,undefined);assert.equal(restarted.endedByUser,undefined);
assert.equal(restarted.canvas!.helpUsed,0);assert.equal(restarted.derivationEvents!.length,0);
assert.deepEqual(restarted.metrics.map(item=>item.value),[false,0,1]);
const dialogue = createRunState({...s1,compute:undefined,runtimeContract:undefined,behavior:undefined},{metrics:{proof:{initial:true}}});
assert.equal(value(dialogue),true,'S1 initial/override behavior remains unchanged');
assert.equal(dialogue.canvas,undefined);
console.log('S4 proof integrity passed: shared fail-closed metric/completion evidence, fresh-run/rerun isolation, live graph scoring, edit/delete/edge/undo/redo, immutable givens, blank formula vs note separation and legacy given compatibility. Offline synthetic IO only.');
