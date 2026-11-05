import assert from 'node:assert/strict';
import {documentArgumentBridgePackets,runDocumentArgumentV5Batch,type DocumentArgumentBridgeTask} from '../src/services/documentArgumentV5Pipeline';
import {documentArgumentEdgeSignature,documentArgumentUniqueEdges} from '../src/services/documentArgumentV5Protocol';
import {DOCUMENT_ARGUMENT_V5_VERSION,DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,type DocumentArgumentV5Snapshot,type DocumentArgumentV5Commit} from '../src/services/documentArgumentV5Types';
import {rebuildDocumentAndArguments} from '../src/services/documentRebuildCoordinator';
import type {UploadedDocument} from '../src/types';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// In-memory fixtures only; no API, vector runtime, production files or writes.
const base:DocumentArgumentV5Commit={docId:'synthetic-idempotent',sourceFingerprint:'source',previousRevision:null,
  nodes:[1,2,3,4].map(i=>({id:`N${i}`,role:'claim',batch:1,source:[],fallbackText:`节点${i}。`})),
  arguments:[{id:'A1',claim:'N1',support:['N2'],oppose:[],status:'argued'}],
  relations:[{id:'R1',kind:'relates',from:'N1',to:'N3',reason:'既有直接关联'}],unresolved:[],tableBindings:[],
  build:{version:DOCUMENT_ARGUMENT_V5_VERSION,promptHash:'prompt',windowPlanFingerprint:'plan',completedWindowIds:['W1'],totalWindows:1,batchCount:1,
    bridgeStatus:'pending',bridgeProtocol:DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,
    batches:[{batch:1,characters:4,inheritedCharacters:0,requests:1,coverage:[]}]}};
const snapshot=(current=structuredClone(base)):DocumentArgumentV5Snapshot=>({docId:base.docId,sourceFingerprint:'source',previousRevision:current.previousRevision,
  promptHash:'prompt',windowPlanFingerprint:'plan',chunks:[],objects:[],limitations:[],current,
  windows:[{id:'W1',section:'',text:'正文。',parts:[]}]});
const existing=documentArgumentUniqueEdges(base);
const task=(round=1,exhaustive=true):DocumentArgumentBridgeTask=>({taskId:'C1',component:[{id:'N4',role:'claim',text:'节点4。'}],
  candidates:[{id:`N${Math.min(round,3)}`,role:'claim',text:'候选。',distance:1,selection:'ordinal'}],
  existingEdges:existing,round,exhaustive});
const repeat=[{kind:'support',from:'N2',to:'N1',basis:'重复旧依据'},
  {kind:'relates',from:'N1',to:'N3',basis:'重复旧关联'}];
const response=(additions=repeat)=>JSON.stringify({bridges:[{taskId:'C1',decision:'add',roleRevisions:[],additions,basis:'模型重复输出旧关系'}]});
async function probe(additions=repeat,current=structuredClone(base),tasks=[task()]){
  const source=snapshot(current);let saved:DocumentArgumentV5Commit|undefined,calls=0;
  const result=await runDocumentArgumentV5Batch(source,{prepare:async()=>source,guard:async()=>{},recall:async()=>tasks,
    commit:async c=>{saved=structuredClone(c);return {revision:'saved',nodes:c.nodes.length,relations:c.relations.length};},
    call:async(_stage,_prompt,input:any)=>{calls++;assert(input.tasks.every(t=>new Set(t.existingEdges.map(documentArgumentEdgeSignature)).size===t.existingEdges.length));return response(additions);}});
  return {result,saved:saved!,calls};
}
const duplicates=await probe([...repeat,...repeat,...repeat]);
assert.equal(duplicates.calls,1);assert.equal(duplicates.result.bridgeProgress,false);
assert.equal(duplicates.saved.arguments.length,base.arguments.length);assert.equal(duplicates.saved.relations.length,base.relations.length);
assert.equal(duplicates.saved.unresolved.filter(u=>u.reason.includes('补链重复关系')).length,2,'repeated diagnostics are idempotent too');
assert.equal(duplicates.saved.build.bridgeStatus,'review_required');assert(duplicates.result.warning);
assert.deepEqual(duplicates.saved.nodes,base.nodes);assert.deepEqual(duplicates.saved.arguments,base.arguments);

// A unique arrow among candidates is not progress on the disconnected target.
const unrelated=await probe([{kind:'context',from:'N1',to:'N2',basis:'候选之间新增但没有触及N4'}]);
assert.equal(unrelated.saved.relations.length,2,'warning-only policy still preserves readable unrelated proposals');
assert.equal(unrelated.result.bridgeProgress,false);assert.equal(unrelated.saved.build.bridgeStatus,'review_required');
assert(unrelated.saved.unresolved.some(u=>u.reason.includes('超出局部候选')));

const repaired=await probe([{kind:'relates',from:'N4',to:'N1',basis:'明确对象回接'}]);
assert(repaired.result.bridgeProgress);assert.equal(repaired.result.components,1);assert.equal(repaired.saved.build.bridgeStatus,'complete');

// Replaying against a graph already polluted by duplicates must not increase it.
const polluted=structuredClone(base);
polluted.relations.push(...Array.from({length:400},(_,i)=>({...base.relations[0],id:`OLD${i}`})));
const pollutedTask={...task(),existingEdges:Array.from({length:1600},()=>existing[1])};
assert(JSON.stringify({tasks:[pollutedTask]}).length>24000);
const packets=documentArgumentBridgePackets([pollutedTask]);assert.equal(packets.length,1);
assert.equal(packets[0][0].existingEdges.length,1,'deduplicate context before applying request size limits');
const replay=await probe(repeat,polluted,[pollutedTask]);assert.equal(replay.calls,1);
assert.equal(replay.saved.relations.length,polluted.relations.length);assert.equal(replay.result.bridgeProgress,false);
assert.deepEqual(replay.saved.relations,polluted.relations,'historical graph is read-only, not destructively cleaned');

async function runLoop(stuckRound=false,decision:'add'|'no_link'='add'){
  let state=snapshot(),requests=0,turns=0;
  const doc={id:base.docId,status:'ready',indexable:true} as UploadedDocument;
  const result=await rebuildDocumentAndArguments(doc.id,{guard:async()=>{},retry:async()=>{throw Error('unexpected reindex');},
    list:async()=>[doc],subscribe:()=>()=>{},process:async()=>{
      turns++;assert(turns<=4,'automatic repetition must terminate');
      const source=structuredClone(state);
      const round=stuckRound?1:Math.max(0,...(source.current?.unresolved||[]).map(u=>Number(/局部补链第(\d+)轮未确定/u.exec(u.reason)?.[1]||0)))+1;
      const result=await runDocumentArgumentV5Batch(source,{prepare:async()=>state,guard:async()=>{},recall:async()=>[task(round,round>=3)],
        call:async()=>{requests++;return decision==='add'?response():JSON.stringify({bridges:[{taskId:'C1',decision:'no_link',additions:[],basis:`模型第${requests}次换一种措辞说无法确定`}]});},commit:async c=>{
          state={...state,current:structuredClone(c),previousRevision:`revision-${turns}`};return {revision:state.previousRevision!,nodes:c.nodes.length,relations:c.relations.length};
        }});
      return {...result,fileName:'合成资料.txt'};
    }},()=>{},undefined,{rebuildBody:false,resetGraph:false});
  assert.equal(result.requests,requests);assert.equal(state.current!.relations.length,base.relations.length);
  assert.equal(state.current!.arguments.length,base.arguments.length);
  return {requests,state};
}
const paged=await runLoop();assert.equal(paged.requests,3,'candidate pages advance once, then stop at exhaustion');
assert.equal(paged.state.current!.build.bridgeStatus,'review_required');
const stuck=await runLoop(true);assert.equal(stuck.requests,2,'an unchanged task page cannot pretend to advance indefinitely');
const wordingOnly=await runLoop(true,'no_link');assert.equal(wordingOnly.requests,2,'different basis wording is not candidate-page progress');
console.log('Bridge idempotency passed: duplicate support/navigation, deduplicated logs/context, target-aware unique progress, finite candidate pagination, unchanged-page stop, polluted-graph replay without rewriting history.');
console.log('In-memory synthetic tests only; cloud requests=0; production writes=0.');

// Optional read-only replay of an already saved real response. Frozen source
// nodes are copied to in-memory text blocks; the real store is never opened for writing.
const replayIndex=process.argv.indexOf('--replay');
if(replayIndex>=0){
  const graphPath=process.argv[replayIndex+1],receiptPath=process.argv[replayIndex+2];
  assert(graphPath&&receiptPath,'--replay requires graph and bridge-response paths');
  const originalBytes=await readFile(graphPath),saved=JSON.parse(originalBytes.toString('utf8'));
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  const model=JSON.parse(receipt.raw);
  assert.equal(model.bridges.length,1);
  const memory:DocumentArgumentV5Commit={...saved,nodes:saved.nodes.map((n:any)=>({id:n.id,role:n.role,batch:n.batch,source:[],fallbackText:n.text})),previousRevision:saved.revision};
  const source:DocumentArgumentV5Snapshot={docId:memory.docId,sourceFingerprint:memory.sourceFingerprint,previousRevision:memory.previousRevision,
    windowPlanFingerprint:memory.build.windowPlanFingerprint,promptHash:memory.build.promptHash,current:memory,chunks:[],objects:[],limitations:[],
    windows:memory.build.completedWindowIds.map(id=>({id,section:'',text:'',parts:[]}))};
  // This was the untouched ordinal target reported in the oversize review.
  const ids=new Set<string>(memory.build.bridgeReviews?.find(r=>r.basis.includes('24000'))?.nodeIds||[]);
  assert(ids.size>0);
  const component=memory.nodes.filter(n=>ids.has(n.id)).map(n=>({id:n.id,role:n.role,text:n.fallbackText!}));
  const candidates=memory.nodes.filter(n=>!ids.has(n.id)).slice(0,12).map(n=>({id:n.id,role:n.role,text:n.fallbackText!,distance:1,selection:'ordinal' as const}));
  const allowed=new Set([...ids,...candidates.map(n=>n.id)]);
  const replayTask:DocumentArgumentBridgeTask={taskId:model.bridges[0].taskId,component,candidates,round:1,exhaustive:true,
    existingEdges:documentArgumentUniqueEdges(memory).filter(e=>allowed.has(e.from)&&allowed.has(e.to))};
  let captured:DocumentArgumentV5Commit|undefined,requests=0,payloadCharacters=0;
  const replayed=await runDocumentArgumentV5Batch(source,{prepare:async()=>source,guard:async()=>{},recall:async()=>[replayTask],
    call:async(_stage,_prompt,input)=>{requests++;payloadCharacters=JSON.stringify(input).length;return receipt.raw;},
    commit:async c=>{captured=structuredClone(c);return {revision:'memory',nodes:c.nodes.length,relations:c.relations.length};},
  },()=>{},new Map(),{retryReview:true});
  assert.equal(requests,1);assert.equal(replayed.bridgeProgress,false);assert.equal(replayed.bridgeReviewRequired,true);
  assert.equal(captured!.arguments.length,memory.arguments.length);assert.equal(captured!.relations.length,memory.relations.length);
  assert.equal(createHash('sha256').update(await readFile(graphPath)).digest('hex'),createHash('sha256').update(originalBytes).digest('hex'));
  console.log(JSON.stringify({realReplay:'passed',nodes:memory.nodes.length,arrowsBefore:documentArgumentUniqueEdges(memory).length,
    argumentsUnchanged:memory.arguments.length,relationsUnchanged:memory.relations.length,payloadCharacters,
    bridgeProgress:replayed.bridgeProgress,cloudRequests:0,productionWrites:0}));
}
