import type {DocumentChunk} from '../../types';
import type {SavedDocumentGraph} from '../../services/documentGraphTypes';
import {readRankedExpansionV4} from '../../services/argumentContext/rankedExpansion';
import {pruneEmbeddingPacket} from '../../services/argumentContext/embeddingPrune';
import {QA_GRAPH_LIMITS, type QaDocumentGraph, type QaGraphAnchor} from '../../services/agent/qaDocumentGraph';
import {qualifiedGraphNodeId} from './documentGraphStore';

/** No inferred links: grouped premises and cross-graph identities are preserved verbatim. */
export function projectSavedDocumentGraphs(graphs: SavedDocumentGraph[], chunks: DocumentChunk[], anchors: QaGraphAnchor[], queryVector?:number[]): QaDocumentGraph {
  const byChunk = new Map(chunks.map(c => [JSON.stringify([c.docId,c.id]),c]));
  const nodes = graphs.flatMap(g => g.nodes.map(n => {
    const getChunk = (id: string) => byChunk.get(JSON.stringify([g.docId,id]))!;
    const c = getChunk(n.source[0].chunkId);
    return {docId:g.docId, nodeId:qualifiedGraphNodeId(g,n.id), graphId:n.graphId, chunkId:c.id,
      sectionPath:c.sectionPath, fileName:c.fileName, type:n.type, text:n.text, quote:n.text,
      sourceParts:n.source.map(s => ({chunkId:s.chunkId, sectionPath:getChunk(s.chunkId).sectionPath,
        quote:getChunk(s.chunkId).content.slice(s.start,s.end)}))};
  }));
  const relations = graphs.flatMap(g => g.relations.map(r => ({...r, id:qualifiedGraphNodeId(g,r.id),
    from:r.from.map(id => qualifiedGraphNodeId(g,id)), to:qualifiedGraphNodeId(g,r.to)})));
  const seeds = [...new Set(anchors.filter(a => nodes.some(n => n.docId === a.docId && n.nodeId === a.nodeId)).map(a => a.nodeId))];
  const out: QaDocumentGraph = {revision:'qa-document-graph-v1', adapter:'source-bound-document-graph', nodes:[], relations:[],
    omissions:anchors.filter(a => !seeds.includes(a.nodeId)).map(a => ({id:a.nodeId, reason:'node_unavailable_or_source_changed'})),
    limitations:['关系来自已保存的抽取／复核结果；解释不是证明，有支持不代表已证实。预算截断会记录，不能视为全文没有依据。'], semanticCertified:false};
  if (!seeds.length) return out;
  const read = readRankedExpansionV4({nodes:nodes.map(n => ({id:n.nodeId,type:n.type})),relations}, seeds,
    {maxNodes:QA_GRAPH_LIMITS.nodes,maxRelations:QA_GRAPH_LIMITS.relations,referenceSourceHops:1});
  let selected=read.nodeIds, selectedRelations=read.relations;
  if(queryVector){
    const pruned=pruneEmbeddingPacket({graph:{nodes:nodes.filter(n=>selected.includes(n.nodeId)).map(n=>({id:n.nodeId,type:n.type,text:n.text})),relations:selectedRelations},
      queryVector,nodeVectors:Object.fromEntries(graphs.flatMap(g=>g.nodes.map(n=>[qualifiedGraphNodeId(g,n.id),n.embedding]))),seedIds:seeds,
      topK:3,mode:'seedAndStructureProtected',referenceSourceHop:true});
    selected=pruned.nodeIds;selectedRelations=pruned.relations;
    out.omissions.push(...pruned.deferredNodeIds.map(id=>({id,reason:'embedding_pruned_not_semantically_disproved'})));
  }
  // Apply the final character limit to an edge and its whole ancestry, not individual premises.
  const ids=new Set<string>();let chars=0;
  const add=(wanted:string[])=>{const fresh=[...new Set(wanted)].filter(id=>!ids.has(id));const size=fresh.reduce((s,id)=>s+nodes.find(n=>n.nodeId===id)!.text.length,0);
    if(chars+size>QA_GRAPH_LIMITS.characters)return false;fresh.forEach(id=>ids.add(id));chars+=size;return true;};
  for(const id of seeds)if(!add([id]))out.omissions.push({id,reason:'character_budget'});
  for(const r of selectedRelations){
    const pack=[r],seen=new Set<string>();
    for(let i=0;i<pack.length;i++)for(const id of [...pack[i].from,pack[i].to]){if(seen.has(id))continue;seen.add(id);
      pack.push(...selectedRelations.filter(s=>s.kind==='support'&&s.to===id&&!pack.includes(s)));}
    if(add(pack.flatMap(e=>[...e.from,e.to]))){for(const e of pack)if(!out.relations.some(s=>s.id===e.id))out.relations.push(relations.find(original=>original.id===e.id)!);}
    else out.omissions.push({id:r.id,reason:'character_budget_whole_premise_package'});
  }
  for(const id of selected)if(!ids.has(id)&&!add([id]))out.omissions.push({id,reason:'character_budget'});
  out.nodes=nodes.filter(n=>ids.has(n.nodeId));
  out.omissions.push(...read.omissions.map(o => ({id:o.relationId,reason:o.reason})));
  out.limitations.push(...read.contextWarnings);
  if(out.omissions.length>128){out.limitations.push(`另有 ${out.omissions.length-128} 项预算省略记录未展开；不能据此断言没有更多依据。`);out.omissions=out.omissions.slice(0,128);}
  return out;
}

export function combineDocumentGraphPackets(graphs: QaDocumentGraph[]): QaDocumentGraph {
  const out: QaDocumentGraph = {...graphs[0], nodes:[], relations:[], omissions:[], limitations:[...new Set(graphs.flatMap(g => g.limitations))],
    adapter:graphs.length > 1 ? 'mixed-document-graphs' : graphs[0].adapter};
  let chars=0; const ids=new Set<string>();
  for (const g of graphs) {
    out.omissions.push(...g.omissions);
    for (const n of g.nodes) {
      if (ids.has(n.nodeId)) continue;
      if (ids.size >= QA_GRAPH_LIMITS.nodes || chars+n.text.length > QA_GRAPH_LIMITS.characters) {out.omissions.push({id:n.nodeId,reason:'combined_budget'}); continue;}
      ids.add(n.nodeId); chars+=n.text.length; out.nodes.push(n);
    }
  }
  for (const g of graphs) for (const r of g.relations) {
    if (out.relations.length < QA_GRAPH_LIMITS.relations && [...r.from,r.to].every(id => ids.has(id))) out.relations.push(r);
    else out.omissions.push({id:r.id,reason:'combined_budget_or_endpoint'});
  }
  return out;
}
