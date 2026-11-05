import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDataRoot,CURRENT_INDEX_SCHEMA_VERSION,searchDocuments} from '../src/electron/ragIndex';
import {setKnowledgeDataRoot} from '../src/electron/rag/knowledgeStore';
import {prepareDocumentGraphSource,commitDocumentGraph,recallDocumentGraphCandidates,listDocumentsWithGraphProgress} from '../src/electron/rag/documentGraphService';
import {readSavedDocumentGraph,qualifiedGraphNodeId} from '../src/electron/rag/documentGraphStore';
import {readQaDocumentGraph} from '../src/electron/rag/qaDocumentGraphReader';
import {runDocumentGraphBatch,nextPipelineWindows,readPipelineWindows} from '../src/services/documentGraphPipeline';
import {parseReview,parseNodes,validateEntities} from '../src/services/documentGraphProtocol';
import {documentGraphWindows} from '../src/electron/rag/documentGraphWindows';
import {readRankedExpansionV4} from '../src/services/argumentContext/rankedExpansion';
import {readRankedExpansionV4 as experimentalRead} from './ap-ranked-expansion-v4';
import {pruneEmbeddingPacket} from '../src/services/argumentContext/embeddingPrune';
import {pruneEmbeddingPacket as experimentalPrune} from './ap-embedding-prune-v1';
import type {DocumentChunk,StructuredDocument} from '../src/types';
import type {DocumentGraphCommit} from '../src/services/documentGraphTypes';
import stage1 from '../src/workflows/documentGraphStage1';
import stage2 from '../src/workflows/documentGraphStage2';
import stage3 from '../src/workflows/documentGraphStage3';
import {DOCUMENT_GRAPH_TYPE_CONTRACT,documentGraphRuntimePrompts} from '../src/workflows/documentGraphRuntimePrompts';

// Real coordinator, host store, local ranking and QA reader. Model/embedding outputs are deterministic stubs.
// All files are temporary synthetic fixtures; no network and no production data.
for(const [prompt,file] of [[stage1,'ap-user-stage1-v2.3.txt'],[stage2,'ap-user-stage2-v2.7.txt'],[stage3,'ap-user-stage3-v2.txt']])
  assert.equal(prompt.replaceAll('\r\n','\n'),(await fs.readFile(`scripts/prompts/${file}`,'utf8')).replaceAll('\r\n','\n'),'frozen prompt rules unchanged');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'document-pipeline-')),dir=path.join(root,'rag-index');
await fs.mkdir(dir);setDataRoot(root);setKnowledgeDataRoot(root);
const save=(name:string,value:unknown)=>fs.writeFile(path.join(dir,name),JSON.stringify(value));
const texts=['实验甲分为两种情景。','情景甲观察到九次成功。','情景乙观察到两次成功。','因此两个情景的成功次数不同。','次数是成功事件的数量。','这两个情景显示干预可能影响结果。'];
const chunks:DocumentChunk[]=texts.map((content,i)=>({id:`c${i+1}`,docId:'synthetic',fileName:'合成资料.md',index:i,sectionPath:`实验/${i+1}`,content,embedding:[],schemaVersion:CURRENT_INDEX_SCHEMA_VERSION}));
await save('manifest.json',[{id:'synthetic',fileName:'合成资料.md',extension:'.md',indexable:true,status:'ready',indexSchemaVersion:CURRENT_INDEX_SCHEMA_VERSION}]);
await save('chunks-synthetic.json',chunks);await save('knowledge-settings.json',{enabled:true});
const vector=(text:string)=>Array.from({length:384},(_,i)=>Number(i===(text==='次数'?1:0)));
const embed=async(text:string)=>vector(text);
let calls=0,commits=0,failRelations=false,foreignCross=false;
const edge=(id:string,kind:string,from:string[],to:string)=>({id,kind,from,to,reason:'合成资料中明确承接的材料'});
const model=async(stage:string,_prompt:string,raw:unknown)=>{
  calls++;const input=raw as any;
  if(stage.startsWith('1/'))assert.equal(_prompt,documentGraphRuntimePrompts.nodes);
  if(stage.startsWith('2/')||stage.startsWith('3/'))assert(_prompt.includes(DOCUMENT_GRAPH_TYPE_CONTRACT),'actual request contains shared node type meanings');
  if(stage.startsWith('1/'))return JSON.stringify({nodes:input.windows.map((w:any,i:number)=>({id:`N${i+1}`,type:w.text.includes('因此')||w.text.includes('干预')?'推理':'事实陈述',source:[{window:w.id,quote:w.text}]}))});
  if(stage.startsWith('2/')){
    if(failRelations)throw new Error('simulated_transport_failure');
    return JSON.stringify(input.nodes.length>1?{coreClaims:[{nodeId:'N4',status:'argued',gaps:[]}],relations:[edge('R1','support',['N2','N3'],'N4'),edge('R2','explain',['N2','N3'],'N1')],unresolved:[]}:
      {coreClaims:[{nodeId:'N1',status:'incomplete',gaps:['缺前文情景']}],relations:[],unresolved:[{nodeId:'N1',kind:'missing_material',reason:'这两个情景在前文'}]});
  }
  if(stage.startsWith('3/')){
    assert.deepEqual(Object.keys(input.draft).sort(),['coreClaims','nodes','relations','unresolved']);
    return JSON.stringify({relations:input.draft.relations.length?[...input.draft.relations,{...input.draft.relations[0],id:'R_DUP'}]:[],
    decisions:input.reviewTasks.map((t:any)=>({taskId:t.id,relationIds:input.draft.relations.filter((r:any)=>r.to===t.nodeId||r.from.includes(t.nodeId)).map((r:any)=>r.id),reason:'核对本项用途'})),
    referenceResolutions:input.reviewTasks.filter((t:any)=>t.check==='reference_target').map((t:any)=>({taskId:t.id,targets:input.draft.nodes.length>1?['N2','N3']:[],reason:'本窗口内对象或输入外'})),
    unresolved:input.draft.nodes.length>1?[{nodeId:'N5',kind:'classification_note',reason:'正常事实不纳入核心主张'}]:input.reviewTasks.filter((t:any)=>t.check==='reference_target').map((t:any)=>({nodeId:t.nodeId,kind:'missing_material',reason:`${t.quote}在前文，本地缺口`})),});
  }
  if(stage.startsWith('4/'))return JSON.stringify({entities:input.nodes.length>1?[{id:'E1',name:'情景甲',mentions:[{fragmentId:'N2:F1',quote:'情景甲',occurrence:1,reference:false}]},{id:'E2',name:'情景乙',mentions:[{fragmentId:'N3:F1',quote:'情景乙',occurrence:1,reference:false}]}]:[],entityRelations:[]});
  if(stage.startsWith('5/'))return JSON.stringify({results:input.packets.map((p:any)=>({targetId:p.target.id,
    relations:[edge('R1','support',foreignCross?['non_candidate']:['G1:N2','G1:N3'],p.target.id)],unresolved:[]}))});
  throw new Error(stage);
};
const deps={prepare:prepareDocumentGraphSource,guard:async()=>{},call:model,
  recall:(input:DocumentGraphCommit,ids:string[])=>recallDocumentGraphCandidates(input,ids,embed),
  commit:async(input:DocumentGraphCommit)=>{commits++;return commitDocumentGraph(input,{embed});}};
const snapshot=await deps.prepare('synthetic');assert.equal(snapshot.windows?.length,6);assert.equal(nextPipelineWindows(snapshot).length,5);
const cache=new Map<string,string>();failRelations=true;
await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),/simulated_transport_failure/);
assert.equal(calls,2);assert.equal(commits,0);assert.equal(cache.size,1,'only successful validated node stage cached');
failRelations=false;const first=await runDocumentGraphBatch(snapshot,deps,()=>{},cache);
assert.equal(first.requests,3,'explicit retry reuses successful node stage, not failed response');assert.equal(first.done,5);assert.equal(commits,1);
assert.equal(first.normalizationAudit?.[0].entries[0].removedId,'R_DUP','normalization receipt survives to caller');
assert.equal(first.classificationNotes?.length,1,'classification note kept in receipt');
let saved=await readSavedDocumentGraph(dir,'synthetic',chunks);assert(saved);assert.equal(saved.entities?.length,2);assert.equal(saved.entities![0].embedding.length,384);
assert(!saved.unresolved.some(s=>s.includes('正常事实')),'classification note not persisted as unresolved material gap');
assert(saved.entities![0].mentions[0].source,'entity coordinate mapping survives host save/read');
assert.equal(saved.build?.completedWindowIds.length,5);
const frozen=JSON.stringify(saved);
const secondSource=await deps.prepare('synthetic');foreignCross=true;
await assert.rejects(()=>runDocumentGraphBatch(secondSource,deps,()=>{},cache),/校验未通过/);
assert.equal(JSON.stringify(await readSavedDocumentGraph(dir,'synthetic',chunks)),frozen,'bad cross-graph output cannot overwrite previous graph');
foreignCross=false;const second=await runDocumentGraphBatch(secondSource,deps,()=>{},cache);
assert.equal(second.requests,1,'retry only cross-graph stage');assert.equal(second.done,6);assert.equal(commits,2);
saved=await readSavedDocumentGraph(dir,'synthetic',chunks);assert(saved);assert.equal(saved.nodes.length,6);assert(saved.relations.some(r=>r.to==='G6:N1'&&r.from.includes('G1:N2')&&r.from.includes('G1:N3')));
assert.equal((await listDocumentsWithGraphProgress())[0].documentGraphProgress?.completedWindows,6);
const done=await runDocumentGraphBatch(await deps.prepare('synthetic'),deps);assert.equal(done.requests,0);assert.equal(done.completed,0);
const hits=await searchDocuments('情景甲',3,{mode:'entity'},{embed});assert(hits.some(h=>h.chunkId==='c2'&&h.documentGraphAnchors?.length),'native entity path enters grounded node');
const graph=await readQaDocumentGraph([{docId:'synthetic',nodeId:qualifiedGraphNodeId(saved,'G6:N1')}],'干预的依据',embed);
const support=graph.relations.find(r=>r.kind==='support'&&r.to.endsWith(':G6:N1'));assert(support);assert.equal(support.from.length,2);
assert(support.from.every(id=>graph.nodes.some(n=>n.nodeId===id)),'grouped evidence retained after embedding pruning');
assert(graph.nodes.some(n=>n.text===texts[1])&&graph.nodes.some(n=>n.text===texts[2]));

// Promoted readers must stay identical to the frozen experimental implementations.
const fixture={nodes:saved.nodes.map(n=>({id:n.id,type:n.type,text:n.text})),relations:saved.relations};
assert.deepEqual(readRankedExpansionV4(fixture,['G6:N1']),experimentalRead(fixture,['G6:N1']));
const prune={graph:fixture,queryVector:vector('依据'),nodeVectors:Object.fromEntries(saved.nodes.map(n=>[n.id,n.embedding])),seedIds:['G6:N1'],topK:3,mode:'seedAndStructureProtected' as const,referenceSourceHop:true};
assert.deepEqual(pruneEmbeddingPacket(prune),experimentalPrune(prune));

// Source planner actually uses headings, transition overlap, and exact source replay.
const sourceText='第一节\n\n实验条件已经说明。以下介绍适用范围。\n\n第二节\n\n只有条件B满足，结论才可能成立。';
const pieces=sourceText.split('\n\n');let offset=0;
const structured:StructuredDocument={schemaVersion:1,docId:'layout',normalizedText:sourceText,blocks:pieces.map((text,i)=>{const start=offset;offset+=text.length+2;return {id:`b${i}`,kind:i%2===0?'heading':'paragraph',sectionPath:i<2?'第一节':'第二节',textStart:start,textEnd:start+text.length,locator:{kind:'text',charStart:start,charEnd:start+text.length}};})};
const mapped=documentGraphWindows([{...chunks[0],docId:'layout',content:sourceText,textStart:0,textEnd:sourceText.length}],structured);
assert.equal(mapped.windows.length,2);const transition=sourceText.indexOf('以下介绍');
assert(mapped.windows.every(w=>w.parts.some(p=>p.start<=transition&&p.end>transition)),'transition carried on both sides');

// Readiness is not synonymous with budget failure: unpunctuated frontmatter is retained
// with visible diagnostics, while genuinely unsafe source windows must still stop.
function windowFixture(text:string):{source:StructuredDocument;chunks:DocumentChunk[]}{
  return {source:{schemaVersion:1,docId:'frontmatter',normalizedText:text,blocks:[{id:'b1',kind:'paragraph',sectionPath:'摘要',
    textStart:0,textEnd:text.length,locator:{kind:'text',charStart:0,charEnd:text.length}}]},
    chunks:[{...chunks[0],docId:'frontmatter',content:text,textStart:0,textEnd:text.length}]};
}
const front=windowFixture('作者甲\n\n某大学\n\n摘要：研究描述了两个情景。\n\n关键词：心理账户、时间价值');
const frontPlan=documentGraphWindows(front.chunks,front.source);
assert.equal(frontPlan.windows.length,1);
assert(frontPlan.limitations.some(s=>s.includes('unfinished_sentence')));
const frontRead=readPipelineWindows({docId:'frontmatter',sourceFingerprint:'',previousRevision:null,chunks:front.chunks,windows:frontPlan.windows},frontPlan.windows)[0].text;
assert(frontRead.includes('作者甲')&&frontRead.includes('研究描述了两个情景')&&frontRead.includes('心理账户、时间价值'),'warnings do not discard original text');
const unsafe=windowFixture('这是一个“没有闭合的引用。');
assert.throws(()=>documentGraphWindows(unsafe.chunks,unsafe.source),/unclosed_quote/);
const oversized=windowFixture('这是没有句末的长段落'.repeat(1500));
assert.throws(()=>documentGraphWindows(oversized.chunks,oversized.source),/无法安全准备/);

assert.throws(()=>parseNodes(JSON.stringify({nodes:[{id:'N1',type:'事实陈述',source:[{window:'W1',quote:'伪造'}]}]}),[{id:'W1',section:'',text:'原文。'}]),/原话/);
assert.throws(()=>validateEntities([{id:'E1',name:'实验甲',mentions:[{nodeId:'N1',quote:'该实验',reference:true}]}],[],new Map([['N1','该实验']])),/名称没有原文/);
assert.throws(()=>parseReview(JSON.stringify({relations:[],decisions:[{taskId:'T1',relationIds:[],reason:'已核对'}],referenceResolutions:[{taskId:'T1',targets:['N2'],reason:'回指'}],unresolved:[]}),
  [{id:'N1',type:'事实陈述',source:[]},{id:'N2',type:'事实陈述',source:[]}],[{id:'T1',nodeId:'N1',check:'reference_target',quote:'该实验'}]),/对应直接连线/);
await assert.rejects(()=>runDocumentGraphBatch(snapshot,{...deps,guard:async()=>{throw Error('revoked');}}),/revoked/);
console.log('PASS: real batch coordinator → frozen 3-stage prompts → grounded entities/vectors → cross-graph candidates → atomic commit → production entity retrieval → ranked expansion/pruning → QA context.');
console.log('PASS: stage resume, bad candidate rejection, reference-edge binding, source planning, grouped evidence, experimental algorithm parity.');
console.log(JSON.stringify({model:'deterministic fixture',embedding:'deterministic 384-D stub',cloudRequests:0,productionWrites:0,totalFixtureCalls:calls,commits}));
