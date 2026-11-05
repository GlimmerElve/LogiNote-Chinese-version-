/** Candidate reader: retain V3 scheduling; degrade ancestry, never a conjunction. */
import {readCoupledArgumentForQuery} from '../src/services/argumentContext/coupledArgumentQueryRead.ts';
import type {CoupledGraph,CoupledRelation} from '../src/services/argumentContext/coupledArgumentRead.ts';
export const RANKED_EXPANSION_POLICY_V4=Object.freeze({maxNodes:12,maxRelations:18,contextDepth:1,
 priority:'support ancestry, opposition with own direct basis, naming, factual source, matched entry context, derived context; seed rank within phase',
 distancePriority:false,wholeChainFirst:true,atomicGroupedEdges:true,partialAncestryExplicit:true,
 candidateSelectionUnchanged:true,semanticCertified:false,productionSelectorChanged:false});
export function readRankedExpansionV4(graph:CoupledGraph,seeds:string[],options:{maxNodes?:number;maxRelations?:number;referenceSourceHops?:number}={}){
 const maxNodes=options.maxNodes??12,maxRelations=options.maxRelations??18;
 if(!Number.isInteger(maxNodes)||!Number.isInteger(maxRelations)||maxNodes<seeds.length||maxNodes<1||maxRelations<1)throw new Error('ranked_invalid_budget');
 const envelope=readCoupledArgumentForQuery(graph,seeds,{maxNodes:Math.max(graph.nodes.length,1),maxRelations:Math.max(graph.relations.length,1),contextDepth:1,referenceSourceHops:options.referenceSourceHops??0});
 const byId=new Map(graph.nodes.map(n=>[n.id,n])),nodes=new Set(envelope.seedIds),edges=new Set<string>(),omissions=new Map<string,string>();
 const ordered=[...envelope.relations].sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));
 const incoming=(id:string)=>ordered.filter(r=>r.kind==='support'&&r.to===id&&byId.get(r.to)!.type!=='命名');
 const ownership=new Map(envelope.seedIds.map((id,rank)=>[id,rank]));
 const primaryBySeed=envelope.seedIds.map(id=>new Set([id]));
 const trace:Array<{relationId:string;seedId:string;seedRank:number;phase:string;decision:string;addedNodes:string[];packageRelations:string[];nodesUsed:number;relationsUsed:number}>=[];
 const addPackage=(rs:CoupledRelation[],rank:number,phase:string)=>{
  const all=[...new Map(rs.map(r=>[r.id,r])).values()],fresh=all.filter(r=>!edges.has(r.id));
  const missing=[...new Set(all.flatMap(r=>[...r.from,r.to]))].filter(id=>!nodes.has(id));
  if(!fresh.length)return true;
  if(nodes.size+missing.length>maxNodes||edges.size+fresh.length>maxRelations){
   for(const r of fresh)omissions.set(r.id,'budget');
   trace.push({relationId:rs[0].id,seedId:seeds[rank],seedRank:rank+1,phase,decision:'budget',addedNodes:[],packageRelations:fresh.map(r=>r.id),nodesUsed:nodes.size,relationsUsed:edges.size});return false;
  }
  for(const r of fresh){edges.add(r.id);omissions.delete(r.id);}for(const id of missing)nodes.add(id);
  for(const id of all.flatMap(r=>[...r.from,r.to]))ownership.set(id,Math.min(ownership.get(id)??Infinity,rank));
  trace.push({relationId:rs[0].id,seedId:seeds[rank],seedRank:rank+1,phase,decision:'admitted',addedNodes:missing,packageRelations:fresh.map(r=>r.id),nodesUsed:nodes.size,relationsUsed:edges.size});return true;
 };
 const withSupport=(r:CoupledRelation)=>{
  const pack=[r],visited=new Set<string>(),pending=[...r.from,r.to];
  for(let i=0;i<pending.length;i++){const id=pending[i];if(visited.has(id))continue;visited.add(id);for(const s of incoming(id)){pack.push(s);pending.push(...s.from);}}
  return pack;
 };
 const addWithSupport=(r:CoupledRelation,rank:number,phase:string)=>{
  const complete=withSupport(r);if(addPackage(complete,rank,phase))return true;
  // Keep the complete immediate edge. For a newly introduced counter/context
  // judgment, also retain all its available DIRECT support before admitting it.
  const unit=phase==='support'?[r]:[r,...[...r.from,r.to].flatMap(incoming)];
  if(!addPackage(unit,rank,phase+':partial_ancestry'))return false;
  const visited=new Set<string>();
  const deepen=(id:string)=>{if(visited.has(id))return;visited.add(id);
   for(const s of incoming(id))if(addPackage([s],rank,phase+':ancestry'))for(const p of s.from)deepen(p);
  };
  for(const id of [...r.from,r.to])deepen(id);
  return true;
 };
 // Keep logical-first, rank-ordered depth-first tracing. No nearest-hop queue.
 for(let rank=0;rank<seeds.length;rank++){
  const visited=new Set<string>(),pending=[seeds[rank]],primary=primaryBySeed[rank];
  for(let i=0;i<pending.length;i++){const id=pending[i];if(visited.has(id))continue;visited.add(id);
   for(const r of incoming(id))if(addWithSupport(r,rank,'support')){
    for(const s of withSupport(r).filter(e=>edges.has(e.id)))for(const n of [...s.from,s.to]){primary.add(n);pending.push(n);}
   }
  }
 }
 for(let rank=0;rank<seeds.length;rank++)for(const r of ordered)if(r.kind==='oppose'&&[...r.from,r.to].some(id=>primaryBySeed[rank].has(id)))addWithSupport(r,rank,'opposition');
 for(let rank=0;rank<seeds.length;rank++)for(const r of ordered)if(r.kind==='support'&&byId.get(r.to)!.type==='命名'&&[...r.from,r.to].some(id=>primaryBySeed[rank].has(id)))addWithSupport(r,rank,'naming');
 const frontier=new Set(nodes);
 const explainCandidates=ordered.filter(r=>r.kind==='explain'&&[...r.from,r.to].some(id=>frontier.has(id))).map(r=>({r,rank:Math.min(...[...r.from,r.to].filter(id=>frontier.has(id)).map(id=>ownership.get(id)??Infinity))})).sort((a,b)=>a.rank-b.rank||a.r.id.localeCompare(b.r.id,'en',{numeric:true}));
 const sourceCandidates=explainCandidates.filter(({r})=>frontier.has(r.to)&&['事实陈述','假设'].includes(byId.get(r.to)!.type)&&r.from.every(id=>byId.get(id)!.type==='事实陈述'));
 for(const {r,rank} of sourceCandidates)addWithSupport(r,rank,'factual_source');
 const seedRank=new Map(seeds.map((id,rank)=>[id,rank]));
 const contexts=explainCandidates.filter(({r})=>!edges.has(r.id)).map(item=>({...item,directRank:Math.min(...[...item.r.from,item.r.to].filter(id=>seedRank.has(id)).map(id=>seedRank.get(id)!))})).sort((a,b)=>
  Number(!Number.isFinite(a.directRank))-Number(!Number.isFinite(b.directRank))||
  (Number.isFinite(a.directRank)&&Number.isFinite(b.directRank)?a.directRank-b.directRank:a.rank-b.rank)||a.r.id.localeCompare(b.r.id,'en',{numeric:true}));
 for(const {r,rank,directRank} of contexts)addWithSupport(r,Number.isFinite(directRank)?directRank:rank,Number.isFinite(directRank)?'matched_entry_context':'derived_context');
 if(options.referenceSourceHops){
  const sourceFrontier=new Set([...nodes].filter(id=>byId.get(id)!.type==='事实陈述'));
  const candidates=ordered.filter(r=>r.kind==='explain'&&!edges.has(r.id)&&sourceFrontier.has(r.to)&&r.from.every(id=>byId.get(id)!.type==='事实陈述')).map(r=>({r,rank:ownership.get(r.to)??0})).sort((a,b)=>a.rank-b.rank||a.r.id.localeCompare(b.r.id,'en',{numeric:true}));
  for(const {r,rank} of candidates)addWithSupport(r,rank,'reference_source');
 }
 const supportGaps=graph.relations.filter(r=>r.kind==='support'&&nodes.has(r.to)&&!edges.has(r.id));
 for(const r of supportGaps)omissions.set(r.id,'budget');
 for(const r of graph.relations)if(r.kind==='explain'&&!edges.has(r.id)&&[...r.from,r.to].some(id=>nodes.has(id))&&!omissions.has(r.id))omissions.set(r.id,'context_depth');
 const truncatedSupport=[...new Set(supportGaps.map(r=>r.to))].map(nodeId=>({nodeId,missingRelationIds:supportGaps.filter(r=>r.to===nodeId).map(r=>r.id),reason:'budget' as const}));
 return {readerRevision:'ranked-expansion-v4-progressive-ancestry',seedIds:[...envelope.seedIds],nodeIds:graph.nodes.filter(n=>nodes.has(n.id)).map(n=>n.id),relations:graph.relations.filter(r=>edges.has(r.id)).map(r=>({...r,from:[...r.from]})),
  omissions:[...omissions].map(([relationId,reason])=>({relationId,reason})),admissionTrace:trace,supportTraceComplete:!supportGaps.length,truncatedSupport,
  contextWarnings:truncatedSupport.length?['上游依据因预算截断；只可按已显示材料回答，不得将局部路径表述为完整证明。']:[],
  envelopeNodeIds:envelope.nodeIds,envelopeRelationIds:envelope.relations.map(r=>r.id),
  edgesCreated:0,semanticCertified:false,explanationsAreEvidence:false,oppositionIsPositiveEvidence:false};
}
