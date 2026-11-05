import assert from 'node:assert/strict';
import {retrievalQueryIntent,retrievalQueryFacets,selectRetrievalEntries,mergeRetrievalRoutes} from '../src/services/agent/documentRetrievalPolicy';
import {qaGraphAnchorsFromHits,attachQaDocumentGraph} from '../src/services/agent/qaGraphEvidence';
import {expandLayeredDocumentGraph} from '../src/electron/rag/documentArgumentV5Expansion';
import {rankDocumentArgumentV5Entries} from '../src/electron/rag/documentArgumentV5Retrieval';
import type {SavedDocumentArgumentV5} from '../src/services/documentArgumentV5Types';
import {QA_GRAPH_LIMITS,qaDocumentGraphForPrompt,type QaDocumentGraph} from '../src/services/agent/qaDocumentGraph';
import type {DocumentSearchResult} from '../src/types';

assert.equal(retrievalQueryIntent('内部目标和外部目标分别是什么？'),'definition');
assert.equal(retrievalQueryIntent('自主、胜任、关系各是什么意思？'),'definition');
assert.equal(retrievalQueryIntent('实体A和实体B是什么关系？'),'entity_relation');
assert.equal(retrievalQueryIntent('目标和幸福感的关系是什么？'),'entity_relation');
assert.equal(retrievalQueryIntent('有哪些不同观点和反驳？'),'opposition');
assert.equal(retrievalQueryIntent('Carver为什么这样认为？Sheldon等人怎样回应？'),'opposition');
assert.equal(retrievalQueryFacets('作者提出未来研究应怎样综合研究方法、深入探索心理机制并推进中国本土化研究？').length,3);
const candidates=Array.from({length:12},(_,i)=>({docId:'doc',nodeId:`n${i}`,score:1-i*.04,channels:['argument' as const],denseRank:i===11?1:i+2,sparseRank:i===10?1:i+2}));
const chosen=selectRetrievalEntries(candidates,8);
assert.equal(chosen.length,8);assert(chosen.some(c=>c.nodeId==='n11'));assert(chosen.some(c=>c.nodeId==='n10'));

// Entity-only nodes must never acquire a fictitious facet rank 0 and displace
// the actual facet head. This exercises both producer and entry selection.
const facetSources=Array.from({length:11},(_,i)=>({id:`c${i+1}`,docId:'doc-facet',fileName:'合成',index:i,sectionPath:'',content:'原文',embedding:[]}));
const facetGraph={docId:'doc-facet',revision:'r',sourceFingerprint:'s',nodes:facetSources.map((s,i)=>({
  id:`N${i+1}`,batch:1,role:'claim',source:[{chunkId:s.id,start:0,end:2}],
  text:i===0?'目标定义甲':i===10?'分面答案':'其他材料',embedding:i===0?[1,0]:i===10?[.3,.95]:[-.6,-.8],
}))} as SavedDocumentArgumentV5;
const facetEntities=[{docId:'doc-facet',sourceFingerprint:'s',entities:[{name:'甲',mentions:facetSources.slice(0,10).map(s=>({source:[{chunkId:s.id,start:0,end:2}]}))}]}];
const facetEntries=rankDocumentArgumentV5Entries([facetGraph],'目标定义甲',[1,0],facetEntities,facetSources,facetSources,{preserveHeads:true,facetVectors:[[0,1]]});
assert.equal(facetEntries.find(e=>e.nodeId.endsWith(':N2'))!.facetRanks[0],undefined);
assert.equal(facetEntries.find(e=>e.nodeId.endsWith(':N11'))!.facetRanks[0],1);
assert(selectRetrievalEntries(facetEntries.map(e=>({...e,score:e.score+e.entityScore,channels:['argument']})),8).some(e=>e.nodeId.endsWith(':N11')));
for(const invalid of [0,-1,NaN,Infinity,1.5,undefined,null]){
  const selected=selectRetrievalEntries([
    {docId:'doc',nodeId:'best',score:2,channels:['argument'],facetRanks:[2]},
    {docId:'doc',nodeId:'invalid',score:1,channels:['argument'],facetRanks:[invalid]},
    {docId:'doc',nodeId:'facet-head',score:.1,channels:['argument'],facetRanks:[1]},
  ],2);
  assert(selected.some(e=>e.nodeId==='facet-head'),'only positive integer facet ranks can claim a head slot');
}
const hit=(chunkId:string,score:number):DocumentSearchResult=>({docId:'doc',chunkId,score,fileName:'test',sectionPath:'',snippet:chunkId});
const routes=mergeRetrievalRoutes([hit('shared',1),hit('body',.9),hit('graph',.1)],['body'],['graph'],3,h=>h.chunkId);
assert(routes.some(h=>h.chunkId==='body'));assert(routes.some(h=>h.chunkId==='graph'));
const dual=mergeRetrievalRoutes([{...hit('a',1),matchKinds:['passage']},{...hit('b',.9),matchKinds:['argument']}],['a'],['b'],3,()=> 'same-quote');
assert.equal(dual.length,1);assert.deepEqual(dual[0].matchKinds,['passage','argument']);
assert.deepEqual(qaGraphAnchorsFromHits([{...hit('body',1),documentGraphAnchors:[{docId:'doc',nodeId:'unrelated'}],documentGraphEntryCandidates:chosen}]),chosen.map(({docId,nodeId})=>({docId,nodeId})));

const node=(id:string,role='claim'):QaDocumentGraph['nodes'][number]=>({docId:'doc',nodeId:id,chunkId:id,fileName:'t',sectionPath:'',type:role as 'claim',role:role as 'claim',text:id,quote:id});
const edge=(id:string,from:string[],to:string,kind:QaDocumentGraph['relations'][number]['kind']='support')=>({id,kind,from,to});
const run=(nodes:QaDocumentGraph['nodes'],edges:QaDocumentGraph['relations'],seeds:string[],query?:string)=>expandLayeredDocumentGraph({revision:'qa-document-graph-v1',adapter:'source-bound-document-graph-v5',nodes:[],relations:[],omissions:[],limitations:[],semanticCertified:false},nodes,edges,seeds,
  {strategy:query?'intent':'layered',query,embeddings:new Map()});
const seeds=Array.from({length:8},(_,i)=>`S${i}`);
assert.equal(run(seeds.map(s=>node(s)),[],seeds).nodes.length,8);
const large=Array.from({length:20},(_,i)=>`P${i}`);
const evicted=run([...seeds,...large].map(s=>node(s)),[edge('whole',large,'S0')],seeds);
assert.equal(evicted.nodes.length,24);assert.deepEqual(evicted.relations[0].from,large);
assert(evicted.omissions.some(o=>o.reason==='entry_evicted_for_higher_ranked_atomic_package'));
const oversized=Array.from({length:25},(_,i)=>`O${i}`);
const skipped=run([...seeds,...oversized].map(s=>node(s)),[edge('too-big',oversized,'S0')],seeds);
assert.equal(skipped.nodes.length,8);assert.equal(skipped.relations.length,0);
assert(skipped.omissions.some(o=>o.reason==='atomic_package_exceeds_hard_budget'));
const first=seeds.flatMap(s=>[`${s}a`,`${s}b`]);
const layered=run([...seeds,...first,'deep'].map(s=>node(s)),[...seeds.map(s=>edge(`proof-${s}`,[`${s}a`,`${s}b`],s)),edge('deeper',['deep'],'S0a')],seeds);
const admissions=layered.retrievalTrace!.events.filter(e=>e.reason==='atomic_package_admitted');
assert.equal(admissions.slice(0,8).filter(e=>e.depth===1).length,8,'all first layers are considered before deeper proof');
assert(!layered.retrievalTrace!.events.some(e=>e.reason==='entry_evicted_for_higher_ranked_atomic_package'&&e.depth!>1),
  'recursive ancestry cannot evict a protected entry');
const cycle=run(['a','b'].map(s=>node(s)),[edge('ab',['a'],'b'),edge('ba',['b'],'a')],['a']);
assert.equal(cycle.nodes.length,2);assert.equal(cycle.semanticCertified,false);
const method=run([node('M','method'),node('R1','premise'),node('R2','premise')],[edge('m1',['M'],'R1','method_for'),edge('m2',['M'],'R2','method_for')],['M']);
assert.equal(method.nodes.length,3);assert.equal(method.relations.length,2);

// Long joint-ground ancestry must not crowd out the direct method requested by
// the query. No ordinal-distance rule or new graph edge is introduced.
const ancestry=Array.from({length:26},(_,i)=>node(`N${i+1}`,i===0?'premise':'claim'));
const ancestryEdges=[edge('joint',['N1','N3'],'N2'),...Array.from({length:23},(_,i)=>edge(`up${i+3}`,[`N${i+4}`],`N${i+3}`)),edge('source',['N27'],'N1','method_for')];
const dataSources=run([...ancestry,node('N27','method')],ancestryEdges,['N1'],'这个数据怎么来的');
assert(dataSources.nodes.some(n=>n.nodeId==='N27'),'direct method survives the fixed 24-node budget');
assert(dataSources.relations.some(e=>e.id==='source'));
assert(dataSources.relations.some(e=>e.id==='joint'&&e.from.length===2),'joint grounds remain atomic');
assert(dataSources.nodes.length<=QA_GRAPH_LIMITS.nodes);
const sourceAdmission=dataSources.retrievalTrace!.events.findIndex(e=>e.id==='N1:method_for:N27'&&e.reason==='atomic_package_admitted');
assert(sourceAdmission>=0&&sourceAdmission<dataSources.retrievalTrace!.events.findIndex(e=>e.depth===2),'necessary source package precedes recursive evidence');

const definitionNodes=[...ancestry,node('D','background')],definitionEdges=[...ancestryEdges.filter(e=>e.id!=='source'),edge('definition',['D'],'N1','context')];
const definition=run(definitionNodes,definitionEdges,['N1'],'什么是目标概念');
assert(definition.nodes.some(n=>n.nodeId==='D'));
const rewritten=expandLayeredDocumentGraph({revision:'qa-document-graph-v1',adapter:'source-bound-document-graph-v5',nodes:[],relations:[],omissions:[],limitations:[],semanticCertified:false},
  definitionNodes,definitionEdges,['N1'],{strategy:'intent',query:'目标术语 实验测量',intentQuery:'什么是目标概念',vector:[0,1],embeddings:new Map()});
assert.equal(rewritten.retrievalTrace!.intent,'definition');assert(rewritten.nodes.some(n=>n.nodeId==='D'),'rewritten search retains original definition intent');
for(const graph of [evicted,skipped,layered,cycle,method,dataSources,definition,rewritten]) {
  assert(graph.nodes.length<=QA_GRAPH_LIMITS.nodes&&graph.relations.length<=QA_GRAPH_LIMITS.relations);
  assert(graph.relations.every(e=>[...e.from,e.to].every(id=>graph.nodes.some(n=>n.nodeId===id))));
  for(const walk of graph.retrievalTrace!.paths) {
    assert.equal(walk.nodeIds[0],walk.entryId);assert.equal(walk.nodeIds.at(-1),walk.nodeId);
    assert.equal(walk.depth,walk.relationIds.length);
    walk.relationIds.forEach((id,i)=>{const e=graph.relations.find(e=>e.id===id)!;assert(e);assert([...e.from,e.to].includes(walk.nodeIds[i])&&[...e.from,e.to].includes(walk.nodeIds[i+1]));});
  }
  assert(!('retrievalTrace' in qaDocumentGraphForPrompt(graph)!),'audit walks do not bloat LLM context');
}
const citationLimited=attachQaDocumentGraph({sources:Array.from({length:35},(_,i)=>({sourceId:`D${i+1}`,type:'document',entityId:'other',chunkId:`x${i}`})),sourceIds:[]} as any,cycle).documentGraph!;
assert.equal(citationLimited.nodes.length,1);
assert(citationLimited.retrievalTrace!.paths.every(p=>p.nodeIds.every(id=>citationLimited.nodes.some(n=>n.nodeId===id))),
  'citation clipping must not leave audit paths to removed nodes');
console.log('Retrieval policy passed: independent heads, dual-route de-duplication, intent boundary, atomic eviction/defer, layered ordering, cycles and real audit paths.');
