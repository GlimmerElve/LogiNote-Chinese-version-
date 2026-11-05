/** Offline context selection only. No semantic model, graph writes or gold-label input. */
const cosineSimilarity = (a:number[],b:number[]) => {let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?dot/Math.sqrt(aa*bb):0;};
import type {CoupledRelation} from './coupledArgumentRead.ts';

export interface PruneNode {id:string;type:string;text:string;source?:unknown}
export interface PruneGraph {nodes:PruneNode[];relations:CoupledRelation[]}
export type PruneMode='embeddingOnly'|'structureProtected'|'seedAndStructureProtected';
export const PRUNE_MODES:Record<PruneMode,string>={embeddingOnly:'仅向量截取',structureProtected:'向量＋结构保护',seedAndStructureProtected:'向量＋入口保留＋结构保护'};
export const PRUNE_POLICY=Object.freeze({topK:[3,5,8],explainDirection:'incoming',explainHops:1,referenceExtraFactualSourceHops:1,
 hardNodeCap:false,sharedNodeBonus:false,semanticIrrelevanceCertified:false,oppositionIsPositiveEvidence:false});

/** Input graph is the ALREADY retrieved packet, not the full source graph.
 * Top-k limits focus anchors only. Dependencies may exceed k; never cut a
 * conjunction to meet a budget. Explanation is context, not inherited proof.
 */
export function pruneEmbeddingPacket(input:{graph:PruneGraph;queryVector:number[];nodeVectors:Record<string,number[]>;
 seedIds:string[];topK:number;mode:PruneMode;referenceSourceHop?:boolean}){
 const {graph,queryVector,nodeVectors,mode,topK}=input;
 if(!Number.isInteger(topK)||topK<1||!Object.hasOwn(PRUNE_MODES,mode))throw new Error('invalid_prune_options');
 const byId=new Map(graph.nodes.map(n=>[n.id,n]));
 if(byId.size!==graph.nodes.length||new Set(graph.relations.map(r=>r.id)).size!==graph.relations.length)throw new Error('duplicate_graph_id');
 for(const r of graph.relations)if(!['support','oppose','explain'].includes(r.kind)||!r.from.length||new Set(r.from).size!==r.from.length||r.from.includes(r.to)||[...r.from,r.to].some(id=>!byId.has(id)))throw new Error('invalid_packet_relation');
 if(input.seedIds.some(id=>!byId.has(id)))throw new Error('unknown_packet_seed');
 if(!queryVector.length||!queryVector.every(Number.isFinite))throw new Error('invalid_query_vector');
 const ranking=graph.nodes.map(n=>{
  const v=nodeVectors[n.id];if(!v||v.length!==queryVector.length||!v.every(Number.isFinite))throw new Error('missing_or_invalid_node_vector');
  return {nodeId:n.id,score:cosineSimilarity(queryVector,v)};
 }).sort((a,b)=>b.score-a.score||a.nodeId.localeCompare(b.nodeId,undefined,{numeric:true}));
 const focusIds=ranking.slice(0,topK).map(n=>n.nodeId),keep=new Set(focusIds),reasons=new Map<string,string[]>();
 const note=(id:string,reason:string)=>{const old=reasons.get(id)||[];if(!old.includes(reason))reasons.set(id,[...old,reason]);};
 for(const id of focusIds)note(id,'embedding_focus');
 const protectedRelations=new Set<string>();
 const protect=(r:CoupledRelation,use:string)=>{
  protectedRelations.add(r.id);let changed=false;
  for(const id of [...r.from,r.to]){if(!keep.has(id)){keep.add(id);changed=true;}note(id,use+':'+r.id);}
  return changed;
 };
 const logicalClosure=()=>{
  let changed=true;while(changed){changed=false;
   for(const r of graph.relations){
    if(r.kind==='support'&&keep.has(r.to))changed=protect(r,byId.get(r.to)!.type==='命名'?'naming_object':'actual_support_ancestry')||changed;
    if(r.kind==='oppose'&&(keep.has(r.to)||r.from.some(id=>keep.has(id))))changed=protect(r,'counterevidence_not_positive_support')||changed;
   }
  }
 };
 if(mode!=='embeddingOnly'){
  if(mode==='seedAndStructureProtected')for(const id of input.seedIds){keep.add(id);note(id,'original_entry_conservative_guard');}
  logicalClosure();
  const frontier=new Set(keep);
  for(const r of graph.relations)if(r.kind==='explain'&&frontier.has(r.to))protect(r,'incoming_explanation_context');
  if(input.referenceSourceHop){
   const facts=new Set([...keep].filter(id=>!frontier.has(id)&&byId.get(id)!.type==='事实陈述'));
   for(const r of graph.relations)if(r.kind==='explain'&&facts.has(r.to)&&r.from.every(id=>byId.get(id)!.type==='事实陈述'))protect(r,'extra_reference_source_context');
  }
  // Newly retained context/counterjudgments still need their own actual premises.
  // Do not propagate explain/oppose as support and do not crawl forward support.
  logicalClosure();
 }
 const nodeIds=graph.nodes.filter(n=>keep.has(n.id)).map(n=>n.id);
 const relations=graph.relations.filter(r=>[...r.from,r.to].every(id=>keep.has(id))).map(r=>({...r,from:[...r.from]}));
 const deferredNodeIds=graph.nodes.filter(n=>!keep.has(n.id)).map(n=>n.id);
 return {mode,topK,focusIds,ranking,nodeIds,relations,deferredNodeIds,
  protection:nodeIds.map(nodeId=>({nodeId,reasons:reasons.get(nodeId)||[]})),protectedRelationIds:[...protectedRelations],
  removedRelationIds:graph.relations.filter(r=>!relations.some(x=>x.id===r.id)).map(r=>r.id),
  topKIsFocusBudgetNotFinalNodeCap:true,semanticCertified:false,edgesCreated:0,sourceDeleted:false,
  explanationsAreEvidence:false,oppositionIsPositiveEvidence:false,namingIsProofOfSubstantiveClaim:false};
}

