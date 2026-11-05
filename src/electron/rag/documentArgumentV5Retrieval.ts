import type {DocumentChunk} from '../../types';
import type {SavedDocumentArgumentV5} from '../../services/documentArgumentV5Types';
import {QA_GRAPH_LIMITS,type QaDocumentGraph,type QaGraphAnchor} from '../../services/agent/qaDocumentGraph';
import {buildDf,bm25Score,tokenize,weightedFusion} from '../hybridSearch';
import {cosineSimilarity} from './embedding';
import {documentArgumentEffectiveNodes} from '../../services/documentArgumentRoleRevisions';
import {DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY, type DocumentRetrievalStrategy} from '../../services/agent/documentRetrievalPolicy';
import {expandLayeredDocumentGraph} from './documentArgumentV5Expansion';

export const qualifiedV5NodeId=(g:SavedDocumentArgumentV5,id:string)=>`dg5:${g.docId}:${g.revision}:${id}`;
export const isDocumentArgumentNodeTextSource=(docId:string,id:string)=>id.startsWith(`${docId}:argument:`);
/** Citations to saved graph blocks, without inventing page/character positions. */
export function documentArgumentV5TextChunks(graphs:SavedDocumentArgumentV5[],sources:DocumentChunk[]):DocumentChunk[]{
  return graphs.flatMap(g=>g.nodes.filter(n=>n.fallbackText!==undefined).map(n=>({
    id:`${g.docId}:argument:${g.revision}:${n.id}`,docId:g.docId,
    fileName:sources.find(s=>s.docId===g.docId)?.fileName||g.docId,index:Number(n.id.slice(1))-1,
    sectionPath:`论证图 · 第${n.batch}批 · ${n.id}`,content:n.text,embedding:n.embedding,
  })));
}
function nodeCitationParts(g:SavedDocumentArgumentV5,n:SavedDocumentArgumentV5['nodes'][number],sources:DocumentChunk[],passages:DocumentChunk[]){
  if(n.fallbackText!==undefined)return [{chunkId:`${g.docId}:argument:${g.revision}:${n.id}`,sectionPath:`论证图 · 第${n.batch}批 · ${n.id}`,quote:n.text}];
  return citationParts(g.docId,n.source,sources,passages);
}
/** Resolve a graph's immutable original quote to the current passage index only
 * at retrieval time. If a title/paragraph has no passage, cite its original ID. */
function citationParts(docId:string, source:SavedDocumentArgumentV5['nodes'][number]['source'],
  sources:DocumentChunk[], passages:DocumentChunk[]) {
  return source.flatMap(s=>{
    const original=sources.find(c=>c.docId===docId&&c.id===s.chunkId);
    if(!original)return [];
    if(passages.some(c=>c.docId===docId&&c.id===s.chunkId))return [{chunkId:original.id,sectionPath:original.sectionPath,quote:original.content.slice(s.start,s.end)}];
    if(original.textStart===undefined)return [{chunkId:original.id,sectionPath:original.sectionPath,quote:original.content.slice(s.start,s.end)}];
    const start=original.textStart+s.start,end=original.textStart+s.end,quote=original.content.slice(s.start,s.end);
    const passage=passages.find(c=>c.docId===docId&&c.textStart!==undefined&&c.textEnd!==undefined
      &&c.textStart<=start&&c.textEnd>=end&&c.content.slice(start-c.textStart,end-c.textStart)===quote);
    // Never split one original quote into citation parts: joining those parts
    // would insert newlines that do not exist in the node's source text.
    return [{chunkId:passage?.id||original.id,sectionPath:passage?.sectionPath||original.sectionPath,quote}];
  });
}
export function rankDocumentArgumentV5Entries(graphs:SavedDocumentArgumentV5[],query:string,vector:number[],entities:any[]=[],
  passages?:DocumentChunk[],sources:DocumentChunk[]=passages||[],options:{preserveHeads?:boolean;facetVectors?:number[][]}={}){
  const records=graphs.flatMap(g=>g.nodes.map(n=>({g,n,id:qualifiedV5NodeId(g,n.id)})));
  const texts=records.map(r=>r.n.text),df=buildDf(texts),tokens=tokenize(query);
  const avg=texts.reduce((s,t)=>s+Math.max(1,tokenize(t).length),0)/Math.max(1,texts.length);
  const candidates=records.map(r=>({...r,dense:Math.max(0,cosineSimilarity(vector,r.n.embedding)),sparse:bm25Score(tokens,r.n.text,df,records.length,avg)})).filter(r=>r.dense>=.25||r.sparse>0);
  const scores=weightedFusion(candidates.map(r=>({id:r.id,dense:r.dense,sparse:r.sparse})),.4);
  const denseOrder=[...candidates].sort((a,b)=>b.dense-a.dense),sparseOrder=[...candidates].sort((a,b)=>b.sparse-a.sparse);
  const facetOrders=(options.facetVectors||[]).map(v=>[...candidates].sort((a,b)=>cosineSimilarity(v,b.n.embedding)-cosineSimilarity(v,a.n.embedding)));
  const ranked=records.map(r=>{
    const entityScore=Math.max(0,...entities.filter(e=>e.docId===r.g.docId&&e.sourceFingerprint===r.g.sourceFingerprint).flatMap(e=>e.entities||[])
      .filter(e=>e.mentions?.some((m:any)=>m.source?.some((p:any)=>r.n.source.some(s=>s.chunkId===p.chunkId&&s.start<p.end&&s.end>p.start))))
      .map(e=>query.includes(e.name)?1:Math.max(0,cosineSimilarity(vector,e.embedding||[]))));
    const chunkIds=passages||r.n.fallbackText!==undefined?nodeCitationParts(r.g,r.n,sources,passages||[]).map(p=>p.chunkId):r.n.source.map(s=>s.chunkId);
    const denseRank=denseOrder.findIndex(c=>c.id===r.id)+1,sparseRank=sparseOrder.findIndex(c=>c.id===r.id)+1;
    return {docId:r.g.docId,nodeId:r.id,chunkIds:[...new Set(chunkIds)],score:scores.get(r.id)||0,entityScore:entityScore>=.45?entityScore:0,text:r.n.text,
      denseRank:denseRank||undefined,sparseRank:sparseRank||undefined,
      // Entity-only entries are not in facetOrders: absence is not a fictitious rank 0.
      facetRanks:facetOrders.map(order=>(order.findIndex(c=>c.id===r.id)+1)||undefined)};
  }).filter(r=>r.score>0||r.entityScore>0).sort((a,b)=>(b.score+b.entityScore)-(a.score+a.entityScore));
  if(options.preserveHeads===false)return ranked.slice(0,24);
  return ranked.filter((r,i)=>i<24||r.denseRank===1||r.sparseRank===1||r.facetRanks.includes(1));
}

/** Read the sole active graph without translating its roles or method/context edges. */
export function projectDocumentArgumentV5(graphs:SavedDocumentArgumentV5[],chunks:DocumentChunk[],anchors:QaGraphAnchor[],sources:DocumentChunk[]=chunks,
  options:{strategy?:DocumentRetrievalStrategy;query?:string;intentQuery?:string;vector?:number[]}={}):QaDocumentGraph{
  const byChunk=new Map([...chunks,...sources,...documentArgumentV5TextChunks(graphs,sources)].map(c=>[JSON.stringify([c.docId,c.id]),c]));
  const nodes=graphs.flatMap(g=>documentArgumentEffectiveNodes(g).map(n=>{
    const parts=nodeCitationParts(g,n,sources,chunks);
    const first=byChunk.get(JSON.stringify([g.docId,parts[0].chunkId]))!;
    return {docId:g.docId,nodeId:qualifiedV5NodeId(g,n.id),graphId:`B${n.batch}`,chunkId:first.id,fileName:first.fileName,sectionPath:first.sectionPath,
      type:n.role,role:n.role,text:n.text,quote:n.text,sourceParts:parts};
  }));
  const rawRelations=graphs.flatMap(g=>[
    ...g.arguments.flatMap(a=>[
      ...(a.support.length?[{id:qualifiedV5NodeId(g,`${a.id}:support`),kind:'support' as const,from:a.support.map(n=>qualifiedV5NodeId(g,n)),to:qualifiedV5NodeId(g,a.claim),reason:'原文主张的支持材料'}]:[]),
      ...a.oppose.map((n,i)=>({id:qualifiedV5NodeId(g,`${a.id}:oppose:${i}`),kind:'oppose' as const,from:[qualifiedV5NodeId(g,n)],to:qualifiedV5NodeId(g,a.claim),reason:'原文主张的反对材料'})),
    ]),
    ...g.relations.map(r=>({...r,id:qualifiedV5NodeId(g,r.id),from:[qualifiedV5NodeId(g,r.from)],to:qualifiedV5NodeId(g,r.to)})),
  ]);
  const available=new Set(nodes.map(n=>n.nodeId));
  // Keep the entire joint-premise edge or omit it from the executable packet.
  // Original dangling decisions remain stored; partial support is not invented.
  const unavailable=rawRelations.filter(r=>![...r.from,r.to].every(id=>available.has(id)));
  const relations=rawRelations.filter(r=>[...r.from,r.to].every(id=>available.has(id)))
    .map((r,i,all)=>all.some((other,j)=>j!==i&&other.id===r.id)?{...r,id:`${r.id}:projection:${i}`}:r);
  const seeds=[...new Set(anchors.filter(a=>nodes.some(n=>n.docId===a.docId&&n.nodeId===a.nodeId)).map(a=>a.nodeId))];
  const out:QaDocumentGraph={revision:'qa-document-graph-v1',adapter:'source-bound-document-graph-v5',nodes:[],relations:[],
    omissions:[...anchors.filter(a=>!seeds.includes(a.nodeId)).map(a=>({id:a.nodeId,reason:'node_unavailable_or_source_changed'})),
      ...unavailable.map(r=>({id:r.id,reason:'dangling_endpoint_recorded_not_executable'}))],
    limitations:['仅当前有效v5论证图。context是背景解释，method_for是方法来源，relates是直接关联；均非支持证据。预算省略不代表原文无依据。',
      '本地关系检查仅记录告警，图中可能保留角色冲突、自环或循环；这些是模型原始判断，不是已验证的证明，循环不得当成独立佐证。',
      ...graphs.flatMap(g=>g.unresolved.filter(u=>/^\[(?:本地|补链)告警\]/u.test(u.reason)).map(u=>`${g.docId}：${u.reason}`)).slice(0,12)],semanticCertified:false};
  const strategy=options.strategy||DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY;
  if(strategy==='layered'||strategy==='intent')return expandLayeredDocumentGraph(out,nodes,relations,seeds,{strategy,query:options.query,intentQuery:options.intentQuery,vector:options.vector,
    embeddings:new Map(graphs.flatMap(g=>g.nodes.map(n=>[qualifiedV5NodeId(g,n.id),n.embedding] as const)))});
  const kept=new Set<string>(),edges=new Set<string>();let chars=0;
  const add=(rs:typeof relations,extra:string[]=[])=>{
    const freshNodes=[...new Set([...extra,...rs.flatMap(r=>[...r.from,r.to])])].filter(id=>!kept.has(id));
    const freshEdges=[...new Map(rs.filter(r=>!edges.has(r.id)).map(r=>[r.id,r])).values()];
    const size=freshNodes.reduce((s,id)=>s+nodes.find(n=>n.nodeId===id)!.text.length,0);
    if(kept.size+freshNodes.length>QA_GRAPH_LIMITS.nodes||edges.size+freshEdges.length>QA_GRAPH_LIMITS.relations||chars+size>QA_GRAPH_LIMITS.characters){
      freshEdges.forEach(r=>out.omissions.push({id:r.id,reason:'whole_structure_package_budget'}));return false;
    }
    freshNodes.forEach(id=>kept.add(id));freshEdges.forEach(r=>edges.add(r.id));chars+=size;return true;
  };
  const supportPackage=(id:string)=>{
    const pack:typeof relations=[],seen=new Set<string>(),pending=[id];
    for(let i=0;i<pending.length;i++)if(!seen.has(pending[i])){const n=pending[i];seen.add(n);
      for(const r of relations.filter(r=>r.kind==='support'&&r.to===n)){if(!pack.includes(r))pack.push(r);pending.push(...r.from);}}
    return pack;
  };
  for(const seed of seeds)if(!add(supportPackage(seed),[seed]))add([],[seed]);
  for(const r of relations.filter(r=>['support','oppose'].includes(r.kind)&&[...r.from,r.to].some(id=>kept.has(id)))){
    add([r,...[...r.from,r.to].flatMap(supportPackage)]);
  }
  const frontier=new Set(kept);
  for(const kind of ['method_for','context','relates'])for(const r of relations.filter(r=>r.kind===kind&&[...r.from,r.to].some(id=>frontier.has(id))))add([r,...[...r.from,r.to].flatMap(supportPackage)]);
  out.nodes=nodes.filter(n=>kept.has(n.nodeId));out.relations=relations.filter(r=>edges.has(r.id));
  for(const id of seeds)if(!kept.has(id))out.omissions.push({id,reason:'seed_character_budget'});
  for(const r of relations)if(r.kind==='support'&&kept.has(r.to)&&!edges.has(r.id))out.omissions.push({id:r.id,reason:'upstream_support_omitted'});
  out.omissions=out.omissions.slice(0,128);return out;
}
