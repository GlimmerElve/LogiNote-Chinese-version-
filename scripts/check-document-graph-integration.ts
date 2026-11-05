import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDataRoot,CURRENT_INDEX_SCHEMA_VERSION,deleteDocumentSourceFiles,searchDocuments} from '../src/electron/ragIndex';
import {setKnowledgeDataRoot} from '../src/electron/rag/knowledgeStore';
import {prepareDocumentGraphSource,commitDocumentGraph} from '../src/electron/rag/documentGraphService';
import {readSavedDocumentGraph,qualifiedGraphNodeId,validateDocumentGraph} from '../src/electron/rag/documentGraphStore';
import {rankDocumentGraphEntries} from '../src/electron/rag/documentGraphRetrieval';
import {readQaDocumentGraph} from '../src/electron/rag/qaDocumentGraphReader';
import {projectSavedDocumentGraphs} from '../src/electron/rag/documentGraphProjection';
import {bindReviewedDocumentGraphs} from '../src/services/documentGraphBinding';
import {attachQaDocumentGraph,qaGraphAnchorsFromHits} from '../src/services/agent/qaGraphEvidence';
import {readQaDocumentGraphPacket,qaDocumentGraphForPrompt} from '../src/services/agent/qaDocumentGraph';
import {buildQaEvidenceResult} from '../src/services/agent/tools/qaTools';
import {createQaSupplementSession} from '../src/services/agent/qaSupplement';
import type {DocumentChunk} from '../src/types';

// Temporary synthetic index and deterministic embedding stub only. No user files, model or network.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'document-graph-integration-')), dir=path.join(root,'rag-index');
setDataRoot(root); setKnowledgeDataRoot(root); await fs.mkdir(dir); await fs.mkdir(path.join(root,'documents'));
const save=(name:string,data:unknown) => fs.writeFile(path.join(dir,name),JSON.stringify(data),'utf8');
const texts=['合成实验分为两组。第一组观察到九次成功。','第二组观察到两次成功。因此两组成功次数不同。','该差异说明干预可能影响结果。'];
const chunks: DocumentChunk[]=texts.map((content,i) => ({id:`c${i+1}`,docId:'doc1',fileName:'synthetic.md',index:i,
  sectionPath:`实验/${i+1}`,content,embedding:[],schemaVersion:CURRENT_INDEX_SCHEMA_VERSION}));
const doc={id:'doc1',fileName:'synthetic.md',extension:'.md',status:'ready',indexSchemaVersion:CURRENT_INDEX_SCHEMA_VERSION};
await save('manifest.json',[doc]); await save('chunks-doc1.json',chunks); await save('knowledge-settings.json',{enabled:true});
const snapshot=await prepareDocumentGraphSource('doc1');
const quote=(chunkId:string,quote:string) => ({window:chunkId,quote});
const input=bindReviewedDocumentGraphs(snapshot,[{
  graphId:'A',windows:chunks.slice(0,2).map(c => ({id:c.id,parts:[{chunkId:c.id,start:0,end:c.content.length}]})),
  nodes:[{id:'N1',type:'事实陈述',source:[quote('c1','合成实验分为两组。')]},
    {id:'N2',type:'事实陈述',source:[quote('c1','第一组观察到九次成功。')]},
    {id:'N3',type:'事实陈述',source:[quote('c2','第二组观察到两次成功。')]},
    {id:'N4',type:'推理',source:[quote('c2','因此两组成功次数不同。')]}],
  relations:[{id:'R1',kind:'explain',from:['N2','N3'],to:'N1',reason:'两组观察展开实验对象'},
    {id:'R2',kind:'support',from:['N2','N3'],to:'N4',reason:'两组观察共同支持差异概括'}],unresolved:[]
},{graphId:'B',windows:[{id:'c3',parts:[{chunkId:'c3',start:0,end:texts[2].length}]}],
  nodes:[{id:'N1',type:'推理',source:[quote('c3',texts[2])]}],relations:[],unresolved:[]}],
  [{id:'R1',kind:'support',from:[{graphId:'A',nodeId:'N4'}],to:{graphId:'B',nodeId:'N1'},reason:'差异概括被后文用作干预判断依据'}]);
assert.notEqual(input.nodes[0].id,input.nodes[4].id,'不同图中的N1不冲突');
const vector=(index=0) => Array.from({length:384},(_,i) => Number(i===index));
let embedCalls=0;
const embed=async(text:string) => {embedCalls++;assert(!text.includes('A:N'),'向量化只使用原文'); return vector(text.includes('干预')?1:0);};
const committed=await commitDocumentGraph(input,{embed});
assert.equal(embedCalls,5); assert.equal(committed.nodes,5); assert.equal(committed.relations,3);
const stored=await readSavedDocumentGraph(dir,'doc1',chunks); assert(stored);
assert.equal(stored.semanticCertified,false); assert.equal(stored.nodes[1].text,'第一组观察到九次成功。');
const entries=rankDocumentGraphEntries([stored],'干预为什么可能影响结果',vector(1));
assert.equal(entries[0].nodeId,qualifiedGraphNodeId(stored,'B:N1'));
const query='干预为什么可能影响结果';
const hits=await searchDocuments(query,1,{mode:'argument'},{embed:async()=>vector(1)});
assert.equal(hits.length,1); assert.equal(hits[0].chunkId,'c3');
assert.equal(hits[0].documentGraphAnchors?.[0].nodeId,entries[0].nodeId,'正式检索入口携带已保存的新图节点');
assert.deepEqual(await searchDocuments(query,3,{mode:'argument',allowedDocIds:['other']},{embed:async()=>vector(1)}),[],
  '资料范围约束不能被新版图检索绕过');
const auto=await searchDocuments(query,3,{mode:'auto'},{embed:async()=>vector(1)});
assert(auto.some(h => h.documentGraphAnchors?.length),'正文＋旧实体＋新版论证图融合后保留图入口');
const anchors=qaGraphAnchorsFromHits(hits), graph=await readQaDocumentGraph(anchors);
assert.equal(graph.adapter,'source-bound-document-graph');
assert.equal(graph.nodes.length,5,'从后文判断回读两组实验及实验来源');
assert.equal(graph.relations.filter(r => r.kind==='explain').length,1);
const cross=graph.relations.find(r => r.reason?.includes('后文')); assert(cross);
assert(cross.from[0].includes(':A:N4') && cross.to.includes(':B:N1'));
const grouped=graph.relations.find(r => r.kind==='support' && r.from.length===2); assert(grouped);
assert(grouped.from.every(id => graph.nodes.some(n => n.nodeId===id)),'共同前提不可丢端点');
const evidence=attachQaDocumentGraph(buildQaEvidenceResult({question:'干预为什么可能影响结果',requestedScope:'global',noteResults:[],documentResults:hits}),graph);
assert(readQaDocumentGraphPacket(evidence.documentGraph,new Set(evidence.sources.map(s => s.sourceId))));
assert.equal(evidence.sources.length,3,'扩展后的每个原文分块都有可追踪引用');
assert(!JSON.stringify(qaDocumentGraphForPrompt(evidence.documentGraph)).includes('"quote"'),'模型上下文原文不重复');
const collidingChunk={...chunks[0],docId:'other',content:'另一个资料中不应读取的内容。'};
assert.deepEqual(projectSavedDocumentGraphs([stored],[...chunks,collidingChunk],anchors).nodes.map(n => n.text),graph.nodes.map(n => n.text),
  '跨资料同名chunk不能覆盖已核对的原文');
const session=createQaSupplementSession(evidence,{search:async()=>{throw Error('本场景不应搜索');},
  readGraph:(anchors,query,intentQuery)=>readQaDocumentGraph(anchors,query,async()=>vector(),{intentQuery})});
const supplemental=await session.execute({mode:'expand',missingMaterial:'回读实验来源',anchors});
assert.equal(supplemental.supplement.status,'no_new_material');
assert.equal(supplemental.documentGraph?.relations.length,3);

// Multi-source nodes must retain every chunk citation, not only the first chunk.
const multi={...graph,nodes:[{...graph.nodes[0],text:'甲\n乙',quote:'甲\n乙',sourceParts:[
  {chunkId:'c1',sectionPath:'1',quote:'甲'},{chunkId:'c2',sectionPath:'2',quote:'乙'}]}],relations:[]};
const cited=attachQaDocumentGraph({...evidence,sources:[]},multi);
assert.equal(cited.sources.length,2);
assert(readQaDocumentGraphPacket(cited.documentGraph,new Set(cited.sources.map(s => s.sourceId))));

const file=path.join(dir,'argument-graph-doc1.json'), frozen=await fs.readFile(file,'utf8');
await assert.rejects(()=>commitDocumentGraph(input,{embed}),/revision_changed/);
assert.equal(await fs.readFile(file,'utf8'),frozen,'旧修订号不能覆盖当前图');
assert.throws(()=>validateDocumentGraph({...input,relations:[...input.relations,{id:'loop',kind:'support',from:['B:N1'],to:'A:N4',reason:'循环'}]},chunks),/cycle/);
assert.throws(()=>validateDocumentGraph({...input,relations:[{id:'bad',kind:'support',from:['A:N2'],to:'missing',reason:'错端点'}]},chunks),/invalid_relation/);
assert.throws(()=>bindReviewedDocumentGraphs(snapshot,[{graphId:'X',windows:[{id:'c1',parts:[{chunkId:'c1',start:0,end:texts[0].length}]}],
  nodes:[{id:'N1',type:'事实陈述',source:[quote('c1','这不是原文')]}],relations:[],unresolved:[]}]),/quote_missing/);
const fresh=await prepareDocumentGraphSource('doc1');
const updated={...input,previousRevision:fresh.previousRevision};
let revoked=false;
await assert.rejects(()=>commitDocumentGraph(updated,{assertEnvironment:()=>{if(revoked)throw Error('revoked');},
  embed:async()=>{revoked=true;return vector();}}),/revoked/);
assert.equal(await fs.readFile(file,'utf8'),frozen,'环境撤销不能提交');
await assert.rejects(()=>commitDocumentGraph(updated,{embed:async()=>[1,2]}),/invalid_embedding/);
assert.equal(await fs.readFile(file,'utf8'),frozen,'向量错误不能覆盖原图');
let changed=false;
await assert.rejects(()=>commitDocumentGraph(updated,{embed:async()=>{
  if (!changed) {changed=true; await save('chunks-doc1.json',[{...chunks[0],content:'正文已变更。'},...chunks.slice(1)]);}
  return vector();
}}),/source_changed/);
assert.equal(await fs.readFile(file,'utf8'),frozen,'向量化期间来源改变不能写入');
assert.equal((await readQaDocumentGraph(anchors)).nodes.length,0,'陈旧图不可用于答疑');
await save('chunks-doc1.json',chunks);
const concurrent=await Promise.allSettled([commitDocumentGraph(updated,{embed}),commitDocumentGraph(updated,{embed})]);
assert.equal(concurrent.filter(r => r.status==='fulfilled').length,1,'同修订号并发提交只能成功一次');
assert.equal(concurrent.filter(r => r.status==='rejected').length,1);
assert.equal((await readQaDocumentGraph(anchors)).nodes.length,0,'已返回的旧版本节点不能悄悄改指新版节点');
await save('knowledge-settings.json',{enabled:false});
assert.equal((await readQaDocumentGraph(anchors)).nodes.length,0,'暂停抽取不应使失效的旧版本引用重新生效');
await assert.rejects(()=>commitDocumentGraph(updated,{embed}),/disabled/);
await save('knowledge-settings.json',{enabled:true});
await save('manifest.json',[{...doc,indexSchemaVersion:0}]);
assert.equal((await readQaDocumentGraph(anchors)).nodes.length,0);
await save('manifest.json',[doc]);
// Delete only the synthetic document; the normal delete transaction removes its graph too.
await deleteDocumentSourceFiles('doc1');
await assert.rejects(()=>fs.stat(file),/ENOENT/);
console.log('Native document graph: quote binding → local embedding stub → persistence → entry ranking → cross-graph expansion → cited QA packet passed.');
console.log('Stale source/CAS/disabled/cycles/endpoints/delete guards passed. Synthetic temporary index only; cloud calls=0; production writes=0.');
