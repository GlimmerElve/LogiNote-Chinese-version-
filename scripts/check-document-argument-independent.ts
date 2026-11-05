import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataRoot, getDocumentPreview, searchDocuments, writeStructuredDocumentFile } from '../src/electron/ragIndex';
import { setKnowledgeDataRoot } from '../src/electron/rag/knowledgeStore';
import { buildStructuredDocument } from '../src/electron/rag/structuredDocument';
import { chunkStructuredDocument } from '../src/electron/rag/chunking';
import { documentArgumentSourceBlocks } from '../src/electron/rag/documentArgumentV5Sources';
import { prepareDocumentArgumentV5, commitDocumentArgumentV5, readDocumentArgumentV5View } from '../src/electron/rag/documentArgumentV5Service';
import { runDocumentArgumentV5Batch } from '../src/services/documentArgumentV5Pipeline';
import { readQaDocumentGraph } from '../src/electron/rag/qaDocumentGraphReader';
import { qaGraphAnchorsFromHits } from '../src/services/agent/qaGraphEvidence';
import { readSavedArgumentDocumentChunk } from '../src/electron/rag/argumentSavedSourceReader';
import { readSavedDocumentArgumentV5 } from '../src/electron/rag/documentArgumentV5Store';
import { projectDocumentArgumentV5, qualifiedV5NodeId,documentArgumentV5TextChunks } from '../src/electron/rag/documentArgumentV5Retrieval';
import { canProcessDocumentArgument } from '../src/services/documentProcessingActions';
import { listDocumentsWithGraphProgress } from '../src/electron/rag/documentGraphService';
import type { UploadedDocument } from '../src/types';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'argument-independent-'));
const dir=path.join(root,'rag-index');
await fs.mkdir(dir);
try {
const vector=()=>Array.from({length:384},(_,i)=>Number(i===0));
const structured=buildStructuredDocument('independent',[
  {kind:'heading',text:'# 实验标题',locator:{kind:'pdf',page:1}},
  {kind:'paragraph',text:'实验设置甲乙两种条件。',locator:{kind:'pdf',page:1}},
  {kind:'caption',text:'表1 两组观察',locator:{kind:'pdf',page:1}},
  {kind:'table',text:'|条件|数值|\n|甲|9|\n|乙|2|',locator:{kind:'pdf',page:1,tableIndex:0}},
  {kind:'paragraph',text:'观察显示甲组高于乙组。因此两种条件产生不同结果。',locator:{kind:'pdf',page:1}},
]);
const metadata={id:'independent',fileName:'实验.pdf',extension:'.pdf',fileType:'pdf',indexable:true,
  status:'failed',parseStatus:'ready',needsReindex:true,chunkCount:0,error:'本地向量模型不可用'} as UploadedDocument;
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify([metadata]));
await fs.writeFile(path.join(dir,'knowledge-settings.json'),JSON.stringify({enabled:true}));
setDataRoot(root);setKnowledgeDataRoot(root);
await writeStructuredDocumentFile(structured);
assert(canProcessDocumentArgument(metadata),'原文解析完成即允许论证处理，不依赖正文向量状态');
const passage=chunkStructuredDocument(structured);
assert(!passage.some(c=>c.textStart<=structured.blocks[0].textStart&&c.textEnd>=structured.blocks[0].textEnd),
  '复现标题没有进入普通向量块的实际场景');
const snapshot=await prepareDocumentArgumentV5('independent');
assert(snapshot.windows.some(w=>w.text==='# 实验标题'));
assert.equal(snapshot.objects.filter(o=>o.kind==='table').length,1);
assert(snapshot.chunks.every(s=>s.id.startsWith('independent:block:')));
let calls=0;
await runDocumentArgumentV5Batch(snapshot,{
  prepare:prepareDocumentArgumentV5,guard:async()=>{},recall:async()=>[],
  commit:c=>commitDocumentArgumentV5(c,{embed:async()=>vector()}),
  call:async(_stage,_prompt,input:any)=>{
    calls++;
    assert(!JSON.stringify(input).includes('chunkId'),'模型仍收到原文窗口，未收到本地块边界');
    assert.deepEqual(Object.keys(input).sort(),['inherited_graph','text']);
    return JSON.stringify({nodes:[
      {id:'N1',role:'background',source:[{quote:'# 实验标题'}]},
      {id:'N2',role:'method',source:[{quote:'实验设置甲乙两种条件。'}]},
      {id:'N3',role:'premise',source:[{quote:'观察显示甲组高于乙组。'}]},
      {id:'N4',role:'claim',source:[{quote:'因此两种条件产生不同结果。'}]},
      {id:'N5',role:'background',source:[{quote:'实验背景介绍采用共同情景。'}]},
    ],arguments:[{id:'A1',claim:'N4',support:['N3'],oppose:[],status:'argued'}],relations:[
      {id:'R1',kind:'context',from:'N1',to:'N4',reason:'标题说明研究主题'},
      {id:'R2',kind:'method_for',from:'N2',to:'N3',reason:'两种条件直接产生观察'},
      {id:'R3',kind:'context',from:'N5',to:'N4',reason:'背景说明结论的语境'},
    ],unresolved:[]});
  },
});
assert.equal(calls,1);
const graph=await readDocumentArgumentV5View('independent');assert(graph.published&&graph.nodes.length===5);
assert.equal((await listDocumentsWithGraphProgress())[0].documentGraphProgress?.nodes,5);
const hits=await searchDocuments('实验标题',3,{mode:'argument'},{embed:async()=>vector()});
assert(hits.some(h=>h.chunkId===structured.blocks[0].id),'无普通索引时，直接返回原文段落引用');
const preview=await getDocumentPreview('independent',40,structured.blocks[0].id);
assert.equal(preview?.focusedChunkId,structured.blocks[0].id);
assert.equal(preview?.chunks[0].content,'# 实验标题');
assert.equal((await readSavedArgumentDocumentChunk(root,'independent',structured.blocks[0].id))?.content,'# 实验标题');
const packet=await readQaDocumentGraph(qaGraphAnchorsFromHits(hits));
assert(packet.nodes.length&&packet.relations.some(r=>r.kind==='method_for'));
const rewrittenEmbeddings:string[]=[];
const rewrittenPacket=await readQaDocumentGraph(qaGraphAnchorsFromHits(hits),'实验主题 共同情景',async query=>{
  rewrittenEmbeddings.push(query);return vector();
},{intentQuery:'什么是实验主题'});
assert.deepEqual(rewrittenEmbeddings,['实验主题 共同情景'],'only matching query is embedded locally');
assert.equal(rewrittenPacket.retrievalTrace?.intent,'definition','real saved-graph reader carries original intent into expansion');
await assert.rejects(()=>readQaDocumentGraph([],undefined,async()=>{throw Error('invalid intent must fail before inference');},{intentQuery:'长'.repeat(2001)}),/qa_graph_query_budget/);
const saved=await readSavedDocumentArgumentV5(dir,'independent',[]);assert(saved);
const sources=documentArgumentSourceBlocks(structured,'实验.pdf'),method=sources[1],split=6;
const unlocated=saved.nodes.find(n=>n.id==='N5')!;
assert.equal(unlocated.text,'实验背景介绍采用共同情景。');assert.deepEqual(unlocated.source,[]);
const nodeTextChunk=documentArgumentV5TextChunks([saved],sources)[0];
assert.equal(nodeTextChunk.content,unlocated.text);assert.equal(nodeTextChunk.textStart,undefined);
const fallbackHits=await searchDocuments('共同情景背景介绍',24,{mode:'argument'},{embed:async()=>vector()});
assert(fallbackHits.some(h=>h.chunkId===nodeTextChunk.id),'unlocated graph blocks must remain retrievable');
const fallbackPacket=await readQaDocumentGraph([{docId:'independent',nodeId:qualifiedV5NodeId(saved,'N5')}]);
assert(fallbackPacket.nodes.some(n=>n.text===unlocated.text));
assert(fallbackPacket.relations.some(r=>r.kind==='context'),'fallback node retains its complete relation');
assert.equal((await getDocumentPreview('independent',40,nodeTextChunk.id))?.focusedChunkId,nodeTextChunk.id);
assert.equal((await readSavedArgumentDocumentChunk(root,'independent',nodeTextChunk.id))?.content,unlocated.text);
const splitPassages=[{...method,id:'left-half',content:method.content.slice(0,split),textEnd:method.textStart!+split},
  {...method,id:'right-half',content:method.content.slice(split),textStart:method.textStart!+split}];
const splitPacket=projectDocumentArgumentV5([saved],splitPassages,[{docId:'independent',nodeId:qualifiedV5NodeId(saved,'N2')}],sources);
assert(splitPacket.nodes.every(n=>n.sourceParts?.map(p=>p.quote).join('\n')===n.text),
  '普通索引切开一段引文时，论证引用仍保持原文，不插入额外换行');
assert.equal(splitPacket.nodes.find(n=>n.role==='method')?.chunkId,method.id);
// Changing the passage split must not change graph sources or current progress.
const previousRevision=(await prepareDocumentArgumentV5('independent')).previousRevision;
await fs.writeFile(path.join(dir,'chunks-independent.json'),JSON.stringify([{...documentArgumentSourceBlocks(structured,'实验.pdf')[1],id:'different-passage'}]));
assert.equal((await prepareDocumentArgumentV5('independent')).previousRevision,previousRevision);
assert((await readDocumentArgumentV5View('independent')).published);
console.log('Independent argument RAG passed: unindexed title, failed body embeddings, original windows, save/resume, retrieval, citation preview and unchanged original coordinates.');
} finally {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('argument-independent-'));
  await fs.rm(root,{recursive:true,force:true});
}
