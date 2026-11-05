import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDataRoot,writeStructuredDocumentFile} from '../src/electron/ragIndex';
import {setKnowledgeDataRoot} from '../src/electron/rag/knowledgeStore';
import {buildStructuredDocument} from '../src/electron/rag/structuredDocument';
import {prepareDocumentArgumentV5,commitDocumentArgumentV5,recallDocumentArgumentV5Bridges,readDocumentArgumentV5View,resetDocumentArgumentV5} from '../src/electron/rag/documentArgumentV5Service';
import {readSavedDocumentArgumentV5,validateDocumentArgumentV5Commit} from '../src/electron/rag/documentArgumentV5Store';
import {documentArgumentBridgePackets,runDocumentArgumentV5Batch} from '../src/services/documentArgumentV5Pipeline';
import {documentArgumentEffectiveRoles} from '../src/services/documentArgumentRoleRevisions';
import {parseDocumentArgumentV5Batch,selectDocumentArgumentV5Handoff,documentArgumentComponents} from '../src/services/documentArgumentV5Protocol';
import {documentArgumentReadingWindows} from '../src/services/documentArgumentReadingWindows';
import {DOCUMENT_ARGUMENT_V5_VERSION,DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,type DocumentArgumentV5Commit,type DocumentArgumentV5Snapshot} from '../src/services/documentArgumentV5Types';
import {documentArgumentSourceBlocks} from '../src/electron/rag/documentArgumentV5Sources';

// All disk writes are confined to a synthetic temporary data root; model/vector stubs only.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'argument-recovery-')),dir=path.join(root,'rag-index');
await fs.mkdir(dir);await fs.mkdir(path.join(root,'documents'));setDataRoot(root);setKnowledgeDataRoot(root);
const docId='synthetic-recovery',texts=['实验甲采用同一问卷测量，甲回答是的比例为30%，乙为60%。','根据实验甲的上述回答比例，可以判断两种情景的回答存在差异。'];
const structured=buildStructuredDocument(docId,texts.map((text,i)=>({text,kind:'paragraph' as const,locator:{kind:'text' as const,charStart:i,charEnd:i+1}})));
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify([{id:docId,fileName:'合成.txt',indexable:true,status:'ready'}]));
await fs.writeFile(path.join(dir,'knowledge-settings.json'),JSON.stringify({enabled:true}));
await writeStructuredDocumentFile(structured);
const original=await prepareDocumentArgumentV5(docId),embed=async()=>Array.from({length:384},(_,i)=>Number(i===0));
const base:DocumentArgumentV5Commit={docId,sourceFingerprint:original.sourceFingerprint,previousRevision:null,
  nodes:[{id:'N1',role:'background',batch:1,source:[],fallbackText:texts[0]}],arguments:[],relations:[],unresolved:[],tableBindings:[],
  build:{version:DOCUMENT_ARGUMENT_V5_VERSION,promptHash:original.promptHash,windowPlanFingerprint:original.windowPlanFingerprint,
    completedWindowIds:[original.windows[0].id],totalWindows:original.windows.length,batchCount:1,bridgeStatus:'pending',bridgeProtocol:DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,
    batches:[{batch:1,characters:texts[0].length,inheritedCharacters:0,requests:1,coverage:[]}]}};
await commitDocumentArgumentV5(base,{embed});
const before=await prepareDocumentArgumentV5(docId),raw=JSON.stringify({nodes:[{id:'N2',role:'claim',source:[{quote:texts[1]}]}],
  arguments:[{id:'A1',claim:'N2',support:['N1'],oppose:[],status:'argued'}],relations:[],unresolved:[]});
let extractCalls=0,bridgeCalls=0;
const checkpoint=await runDocumentArgumentV5Batch(before,{
  prepare:prepareDocumentArgumentV5,guard:async()=>{},commit:c=>commitDocumentArgumentV5(c,{embed}),recall:c=>recallDocumentArgumentV5Bridges(c,embed),
  call:async(stage)=>{if(stage==='extract'){extractCalls++;return raw;}bridgeCalls++;throw Error('synthetic bridge interruption');},
});
assert(checkpoint.warning);assert(await readSavedDocumentArgumentV5(dir,docId,[]));
const initialPublished=await prepareDocumentArgumentV5(docId);
assert(initialPublished.current!.arguments.some(a=>a.support.includes('N1')),'new extraction retains role-conflicting edges');
assert(!initialPublished.current!.pendingEdges?.length);
assert(initialPublished.current!.unresolved.some(u=>u.reason.includes('论据端点或角色')));
assert.equal(bridgeCalls,0,'quality warnings alone do not force new cloud requests');

// Legacy quarantined proposals remain recoverable; they no longer gate publication.
await resetDocumentArgumentV5(docId);await commitDocumentArgumentV5(base,{embed});
const legacySource=await prepareDocumentArgumentV5(docId);
const legacyDraft=parseDocumentArgumentV5Batch(raw,documentArgumentReadingWindows(before.windows.slice(1)),before.current!,
  selectDocumentArgumentV5Handoff(before.current!,before.chunks),2,'batch-text',true);
const legacyCommit:DocumentArgumentV5Commit={...legacySource.current!,
  nodes:[...base.nodes,...legacyDraft.nodes],arguments:legacyDraft.arguments,relations:legacyDraft.relations,
  unresolved:legacyDraft.unresolved,pendingEdges:legacyDraft.pendingEdges,previousRevision:legacySource.previousRevision,
  build:{...legacySource.current!.build,batchCount:2,completedWindowIds:original.windows.map(w=>w.id),
    batches:[...base.build.batches,{batch:2,characters:texts[1].length,inheritedCharacters:0,requests:1,coverage:[]}]}};
await commitDocumentArgumentV5(legacyCommit,{embed});
const legacySnapshot=await prepareDocumentArgumentV5(docId);
await runDocumentArgumentV5Batch(legacySnapshot,{
  prepare:prepareDocumentArgumentV5,guard:async()=>{},commit:c=>commitDocumentArgumentV5(c,{embed}),recall:c=>recallDocumentArgumentV5Bridges(c,embed),
  call:async()=>{bridgeCalls++;throw Error('synthetic bridge interruption');},
});
const checkpointSnapshot=await prepareDocumentArgumentV5(docId);
assert.equal(checkpointSnapshot.current?.pendingEdges?.length,1,'a role-conflicting initial edge must survive a failed bridge as a proposal');
assert.equal(checkpointSnapshot.current?.nodes.length,2);assert.equal(checkpointSnapshot.current?.relations.length,0);
assert((await readDocumentArgumentV5View(docId)).unresolved.some(u=>u.reason.includes('待复核关系')));
const result=await runDocumentArgumentV5Batch(checkpointSnapshot,{
  prepare:prepareDocumentArgumentV5,guard:async()=>{},commit:c=>commitDocumentArgumentV5(c,{embed}),recall:c=>recallDocumentArgumentV5Bridges(c,embed),
  call:async(stage,_prompt,input:any)=>{
    if(stage==='extract'){extractCalls++;return raw;}
    bridgeCalls++;assert(input.tasks.some(t=>t.proposedEdges?.length),'role conflicts must reach semantic review');
    return JSON.stringify({bridges:input.tasks.map(task=>({taskId:task.taskId,decision:'add',basis:'文本明确方法来源',
      roleRevisions:[{nodeId:'N1',from:'background',to:'premise',reason:'节点陈述观测比例，后文明确使用这些数据得出判断',
        nodeEvidence:{quote:texts[0],reason:'观测数据'},usageEvidence:{nodeId:'N2',quote:texts[1],reason:'明确依据上述回答比例得出判断'}}],
      additions:[{from:'N1',to:'N2',kind:'support',basis:'该观测比例为后文概括的实际依据'}]}))});
  },
});
assert.equal(extractCalls,1);assert.equal(bridgeCalls,2);assert.equal(result.components,1);assert.equal(result.warning,'');
const published=await readSavedDocumentArgumentV5(dir,docId,[]);assert(published);
assert.equal(published.nodes[0].role,'background');assert.equal(documentArgumentEffectiveRoles(published).get('N1'),'premise');
assert.equal(published.pendingEdges?.length,0);assert(published.arguments.some(a=>a.claim==='N2'&&a.support.includes('N1')));
assert(!published.unresolved.some(u=>u.reason.includes('角色修订未准入')),'overlapping identical role proposals are idempotent');
assert.equal((await readDocumentArgumentV5View(docId)).nodes[0].originalRole,'background');

// Strict audit callers remain strict. Production may quarantine only role conflicts.
const reading=documentArgumentReadingWindows(before.windows.slice(1)),handoff=selectDocumentArgumentV5Handoff(before.current!,before.chunks);
assert.throws(()=>parseDocumentArgumentV5Batch(raw,reading,before.current!,handoff,2,'batch-text'),/论据端点或角色/);
const deferred=parseDocumentArgumentV5Batch(raw,reading,before.current!,handoff,2,'batch-text',true);
assert.equal(deferred.pendingEdges?.length,1);assert.equal(deferred.relations.length,0);
const dangling=JSON.parse(raw);dangling.arguments[0].support=['N999'];
assert.throws(()=>parseDocumentArgumentV5Batch(JSON.stringify(dangling),reading,before.current!,handoff,2,'batch-text',true),/端点超出/);
const cyclic={nodes:[{id:'N2',role:'claim',source:[{quote:texts[1]}]},{id:'N3',role:'claim',source:[{quote:texts[1]}]}],arguments:[
  {id:'A1',claim:'N2',support:['N3'],oppose:[],status:'argued'},{id:'A2',claim:'N3',support:['N2'],oppose:[],status:'argued'}],relations:[],unresolved:[]};
assert.throws(()=>parseDocumentArgumentV5Batch(JSON.stringify(cyclic),reading,before.current!,handoff,2,'batch-text',true),/自证闭环/);

// Pipeline-only probes: no live source/data dependencies.
const graph={nodes:Array.from({length:6},(_,i)=>({id:`N${i+1}`,role:'background' as const,batch:1,source:[],fallbackText:`节点${i+1}。`})),arguments:[],relations:[],unresolved:[]};
const snapshot:DocumentArgumentV5Snapshot={...original,current:{...base,...graph,build:{...base.build,completedWindowIds:original.windows.map(w=>w.id)}}};
let captured:DocumentArgumentV5Commit;
const deps={prepare:async()=>snapshot,guard:async()=>{},commit:async(c:DocumentArgumentV5Commit)=>{captured=structuredClone(c);return{revision:'synthetic',nodes:c.nodes.length,relations:c.relations.length};}};
const connectedConflict:DocumentArgumentV5Snapshot={...checkpointSnapshot,current:{...checkpointSnapshot.current!,relations:[{id:'R0',kind:'relates',from:'N1',to:'N2',reason:'原有对象关联'}]}};
let connectedReviewCalls=0;
const connectedReview=await runDocumentArgumentV5Batch(connectedConflict,{...deps,prepare:async()=>connectedConflict,recall:async()=>[],
  call:async(_stage,_prompt,input:any)=>{connectedReviewCalls++;return JSON.stringify({bridges:input.tasks.map(t=>({taskId:t.taskId,decision:'no_link',additions:[],basis:'具体方法来源仍待核对'}))});}
});
assert.equal(connectedReviewCalls,1);assert(connectedReview.bridgePending);assert.equal(captured!.pendingEdges?.length,1);
assert.equal(captured!.build.bridgeStatus,'review_required','connected graphs still review quarantined role conflicts');
const tasks=graph.nodes.slice(1).map((n,i)=>({taskId:`C${i+1}`,component:[{id:n.id,role:n.role,text:n.fallbackText}],
  candidates:[{id:'N1',role:'background',text:'节点1。',distance:1,selection:'ordinal' as const}],existingEdges:[],round:1,exhaustive:true}));
let packets=0;
const partial=await runDocumentArgumentV5Batch(snapshot,{...deps,recall:async()=>tasks,call:async(_stage,_prompt,input:any)=>{
  if(++packets===2)return JSON.stringify({bridges:[]});
  return JSON.stringify({bridges:input.tasks.map(t=>({taskId:t.taskId,decision:'add',additions:[{from:t.component[0].id,to:'N1',kind:'relates',basis:'直接对象对应'}],basis:'对象对应'}))});
}});
assert(partial.warning);assert.equal(captured!.relations.length,4,'a later invalid packet must not discard four earlier validated edges');
assert.equal(captured!.build.bridgeStatus,'review_required');assert.equal(documentArgumentComponents(captured!).length,2);

const terminal=await runDocumentArgumentV5Batch(snapshot,{...deps,recall:async()=>[tasks[0]],call:async()=>JSON.stringify({bridges:[{
  taskId:'C1',decision:'no_link',additions:[],basis:'现有证据无法判断是否同一对象'}]})});
assert(terminal.bridgePending&&terminal.warning);assert.equal(captured!.build.bridgeStatus,'review_required');
snapshot.current=captured!;
const emptyRecall=await runDocumentArgumentV5Batch(snapshot,{...deps,recall:async()=>[],call:async()=>{throw Error('unexpected remote call');}});
assert(emptyRecall.bridgePending);assert.equal(captured!.build.bridgeStatus,'review_required','exhausted recall must never imply successful publication');
let manualCalls=0;
const manualRetry=await runDocumentArgumentV5Batch(snapshot,{...deps,
  recall:async(input)=>{assert(!input.build.bridgeReviews?.some(r=>r.decision==='unresolved'));return [tasks[0]];},
  call:async()=>{manualCalls++;return JSON.stringify({bridges:[{taskId:'C1',decision:'add',additions:[{from:'N2',to:'N1',kind:'relates',basis:'补充核对后确认对象对应'}],basis:'已重新核对'}]});}
},()=>{},new Map(),{retryReview:true});
assert.equal(manualCalls,1);assert.equal(captured!.relations.length,1);assert(manualRetry.bridgeProgress);

snapshot.current={...base,...graph,build:{...base.build,completedWindowIds:original.windows.map(w=>w.id)}};
const independent=await runDocumentArgumentV5Batch(snapshot,{...deps,recall:async()=>tasks,call:async(_stage,_prompt,input:any)=>JSON.stringify({bridges:input.tasks.map(t=>({
  taskId:t.taskId,decision:'independent',additions:[],basis:'该段为独立致谢对象，与所给实验论证无承接关系'}))})});
assert(!independent.bridgePending);assert.equal(captured!.build.bridgeStatus,'complete');assert.equal(captured!.relations.length,0,'independent units do not require fake edges');

const huge={...tasks[0],component:[{...tasks[0].component[0],text:'文'.repeat(30000)}]};
assert.throws(()=>documentArgumentBridgePackets([huge]),/单个任务超过/);
snapshot.current={...base,...graph,build:{...base.build,completedWindowIds:original.windows.map(w=>w.id)}};
let boundedCalls=0;
const bounded=await runDocumentArgumentV5Batch(snapshot,{...deps,recall:async()=>[huge,tasks[1]],call:async(_stage,_prompt,input:any)=>{
  boundedCalls++;assert(JSON.stringify(input).length<=24000);assert.equal(input.tasks.length,1);
  return JSON.stringify({bridges:[{taskId:'C2',decision:'add',additions:[{from:'N3',to:'N1',kind:'relates',basis:'直接对象对应'}],basis:'对象对应'}]});
}});
assert.equal(boundedCalls,1);assert(bounded.warning);assert.equal(captured!.relations.length,1,'an oversized task must not block other small tasks');
assert(captured!.build.bridgeReviews?.some(r=>r.decision==='unresolved'&&r.basis.includes('24000')));
const badComplete={...base,pendingEdges:[{id:'P1',batch:1,kind:'method_for' as const,from:'N1',to:'N1',reason:'非法自环'}],build:{...base.build,bridgeStatus:'complete' as const}};
assert.doesNotThrow(()=>validateDocumentArgumentV5Commit(badComplete,documentArgumentSourceBlocks(structured,'合成.txt')));
console.log('Recovery passed: new role conflicts retained with warnings; legacy proposal review remains compatible; semantic role repair; packet rollback guard; no-link vs independent; strict input budget; warning-only publication.');
console.log('Synthetic data only; cloud calls=0; production writes=0.');
