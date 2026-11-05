import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setDataRoot,searchDocuments} from '../src/electron/ragIndex';
import {setKnowledgeDataRoot} from '../src/electron/rag/knowledgeStore';
import {setModelsDir,generateEmbedding} from '../src/electron/rag/embedding';
import {readQaDocumentGraph} from '../src/electron/rag/qaDocumentGraphReader';
import {qaGraphAnchorsFromHits,attachQaDocumentGraph} from '../src/services/agent/qaGraphEvidence';
import {readQaDocumentGraphPacket,QA_GRAPH_LIMITS} from '../src/services/agent/qaDocumentGraph';
import {classifyDocumentQueryIntent,classifyDocumentQueryIntentLegacy} from '../src/electron/rag/knowledgeRetrieval';
import {retrievalQueryFacets,type DocumentRetrievalStrategy} from '../src/services/agent/documentRetrievalPolicy';

if(!process.argv.includes('--local-readonly'))throw Error('Use --local-readonly; no cloud requests or production writes.');
const root='D:/新建文件夹/Storagetest',dir=path.join(root,'rag-index'),out=path.resolve(process.argv.find(arg=>arg.startsWith('--out-dir='))?.slice('--out-dir='.length)||'.ui-preview/retrieval-policy-20261014');
const frozen=JSON.parse(await fs.readFile('.ui-preview/goal-content-retrieval-20261014/results.json','utf8'));
const hash=(s:Buffer)=>createHash('sha256').update(s).digest('hex');
for(const item of frozen.sourceHashes)assert.equal(hash(await fs.readFile(path.join(dir,item.file))),item.sha,'Frozen graph/source/vectors changed. Do not retune against a new graph.');
const before=await fs.readFile(path.join(dir,`argument-graph-v5-${frozen.docId}.json`));
setDataRoot(root);setKnowledgeDataRoot(root);setModelsDir(path.resolve('models'));
const vectors=new Map<string,number[]>();
const embed=async(text:string)=>{let v=vectors.get(text);if(!v){v=await generateEmbedding(text);vectors.set(text,v);}return v;};
const short=(id:string)=>id.split(':').at(-1)!;
const rows=[];
const strategies:DocumentRetrievalStrategy[]=['legacy','direct','layered','intent'];
console.log('Frozen local embedding + graph + questions. Budgets 8 / 24 / 36 / 12000. Cloud requests: 0.');
for(const q of frozen.questions) {
  const stages=[];
  for(const strategy of strategies) {
    const modes=[];
    for(const mode of ['argument','auto'] as const) {
      const hits=await searchDocuments(q.question,3,{mode,allowedDocIds:[frozen.docId]},{embed,retrievalStrategy:strategy});
      const anchors=qaGraphAnchorsFromHits(hits),packet=await readQaDocumentGraph(anchors,q.question,embed,{retrievalStrategy:strategy});
      const evidence:any={sources:hits.map((h,i)=>({sourceId:`D${i+1}`,type:'document',entityId:h.docId,chunkId:h.chunkId,title:h.fileName,sectionPath:h.sectionPath,snippet:h.snippet,score:h.score})),sourceIds:[]};
      const attached=attachQaDocumentGraph(evidence,packet),final=attached.documentGraph!;
      const ids=final.nodes.map(n=>short(n.nodeId));
      const accepted=!!readQaDocumentGraphPacket(final,new Set(attached.sources.map(s=>s.sourceId)));
      assert(accepted);assert(anchors.length<=8&&final.nodes.length<=24&&final.relations.length<=36);
      const missing=q.required.filter((id:string)=>!ids.includes(id));
      if(strategy==='legacy')assert.deepEqual(missing,q.modes.find((m:any)=>m.mode===mode).final.missing,'Baseline does not reproduce frozen misses.');
      modes.push({mode,seeds:anchors.map(a=>short(a.nodeId)),nodes:ids,missing,
        evidenceHit:q.evidence.filter((id:string)=>ids.includes(id)),characters:final.nodes.reduce((s,n)=>s+n.text.length,0),
        keptSeeds:anchors.filter(a=>final.nodes.some(n=>n.nodeId===a.nodeId)).length,
        edges:final.relations.map(r=>({id:short(r.id),kind:r.kind,from:r.from.map(short),to:short(r.to)})),
        hits:hits.map(h=>({chunkId:h.chunkId,score:h.score,kinds:h.matchKinds,independent:h.documentGraphEntryCandidates?.map(e=>({id:short(e.nodeId),score:e.score,channels:e.channels}))})),
        omissions:final.omissions,trace:final.retrievalTrace,accepted});
    }
    stages.push({strategy,intent:strategy==='intent'?classifyDocumentQueryIntent(q.question):classifyDocumentQueryIntentLegacy(q.question),
      facets:strategy==='intent'?retrievalQueryFacets(q.question):[],modes});
  }
  rows.push({id:q.id,question:q.question,category:q.category,required:q.required,evidence:q.evidence,negative:q.negative,risk:q.risk,stages});
  if(!process.argv.includes('--quiet'))console.log(JSON.stringify({id:q.id,stages:stages.map(s=>({strategy:s.strategy,intent:s.intent,modes:s.modes.map(m=>({mode:m.mode,missing:m.missing,nodes:m.nodes.length,keptSeeds:m.keptSeeds}))}))}));
}
for(const item of frozen.sourceHashes)assert.equal(hash(await fs.readFile(path.join(dir,item.file))),item.sha,'Production changed during evaluation.');
assert.deepEqual(await fs.readFile(path.join(dir,`argument-graph-v5-${frozen.docId}.json`)),before);
const normal=rows.filter(q=>!q.negative&&!q.risk);
const summary=strategies.map(strategy=>({strategy,modes:['argument','auto'].map(mode=>{
  const ms=normal.map(q=>q.stages.find(s=>s.strategy===strategy)!.modes.find(m=>m.mode===mode)!);
  return {mode,complete:ms.filter(m=>!m.missing.length).length,total:normal.length,averageNodes:ms.reduce((s,m)=>s+m.nodes.length,0)/ms.length,
    auxiliaryEvidenceHits:ms.reduce((s,m)=>s+m.evidenceHit.length,0),auxiliaryEvidenceTotal:normal.reduce((s,q)=>s+q.evidence.length,0),
    averageCharacters:ms.reduce((s,m)=>s+m.characters,0)/ms.length,keptEntryRatio:ms.reduce((s,m)=>s+m.keptSeeds,0)/ms.reduce((s,m)=>s+m.seeds.length,0),validPackets:ms.filter(m=>m.accepted).length};
})}));
const auxiliaryRegressions=normal.flatMap(q=>q.stages[0].modes.flatMap(old=>old.evidenceHit
  .filter((id:string)=>!q.stages[3].modes.find(m=>m.mode===old.mode)!.evidenceHit.includes(id))
  .map((id:string)=>({question:q.id,mode:old.mode,nodeId:id}))));
assert.deepEqual(auxiliaryRegressions,[],'Do not accept primary coverage by silently losing old auxiliary evidence.');
const report={createdAt:new Date().toISOString(),docId:frozen.docId,revision:frozen.revision,sourceHashes:frozen.sourceHashes,summary,questions:rows,
  auxiliaryRegressions,
  budgets:{...QA_GRAPH_LIMITS,entryChunks:3,citationSources:36},productionUnchanged:true,cloudRequests:0,notes:[
    'Each stage is one strategy change group: independent entries; layered atomic expansion; intent + facets. Not individual-parameter attribution.',
    'Manual required-node coverage, not blind generalization or LLM answer correctness. Negative results are neighbors, not an answerability judgment.',
    'Fixed 24 nodes; user-authorized whole-package eviction of lower-ranked entries. Oversized indivisible packages are deferred and logged.',
  ]};
await fs.mkdir(out,{recursive:true});
const stamp=report.createdAt.replace(/[:.]/g,'-');
await fs.writeFile(path.join(out,`results-${stamp}.json`),JSON.stringify(report,null,2));
await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
const esc=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels={legacy:'原策略',direct:'①入口直通',layered:'②分层原子包',intent:'③意图与分支'};
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>检索策略三步对照</title><style>body{max-width:1200px;margin:36px auto;padding:0 24px;font:15px/1.7 system-ui;color:#253b2e;background:#f6f5f0}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border-bottom:1px solid #c9d2c7;text-align:left;padding:9px}small{color:#5d6a61}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}h1{font-size:24px}.warn{color:#9b5037}</style><h1>冻结图谱 · 检索策略三步对照</h1><p>8入口 / 24节点 / 36关系 / 12000字符，正文入口最多3个。原子包可淘汰低优先级入口；生产图和向量未改，云端请求0次。</p><small>目标内容效应及其心理机制 · ${esc(report.createdAt)}。指标为预设目标块覆盖，不是LLM回答正确率。</small><table><tr><th>策略</th><th>论证路完整覆盖</th><th>自动路完整覆盖</th><th>自动路平均节点</th><th>自动路入口保留率</th></tr>${summary.map(s=>`<tr><td>${labels[s.strategy]}</td><td>${s.modes[0].complete}/8</td><td>${s.modes[1].complete}/8</td><td>${s.modes[1].averageNodes.toFixed(1)}</td><td>${(s.modes[1].keptEntryRatio*100).toFixed(1)}%</td></tr>`).join('')}</table><p class="warn">同一已知题集的开发对照，不是独立泛化验证。负例仍需回答层判断是否有依据，不能把近邻返回当成可回答。</p>${rows.map(q=>`<details><summary>${esc(q.id+' · '+q.question)}</summary><p>必需块：${esc(q.required.join('、')||'资料外负例')}</p><table><tr><th>策略</th><th>意图</th><th>论证路缺失</th><th>自动路缺失</th><th>自动路入口</th></tr>${q.stages.map(s=>`<tr><td>${labels[s.strategy]}</td><td>${esc(s.intent)}</td><td>${esc(s.modes[0].missing.join('、')||'无')}</td><td>${esc(s.modes[1].missing.join('、')||'无')}</td><td>${esc(s.modes[1].seeds.join('、'))}</td></tr>`).join('')}</table><details><summary>节点、关系、召回路径与预算事件</summary><pre>${esc(JSON.stringify(q.stages,null,2))}</pre></details></details>`).join('')}<p><a href="results.json">完整JSON</a></p></html>`;
await fs.writeFile(path.join(out,'index.html'),html);
console.log(JSON.stringify({summary,output:out,productionUnchanged:true,cloudRequests:0},null,2));
