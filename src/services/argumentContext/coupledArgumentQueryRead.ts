import {readCoupledArgumentWithTraceClosure} from './coupledArgumentReadV2.ts';
import type {CoupledGraph,CoupledReadOptions,CoupledRelation} from './coupledArgumentRead.ts';

/** Query-aware read-only backfill. No node merging, semantic inference or graph writes. */
export function readCoupledArgumentForQuery(graph:CoupledGraph,seeds:string[],options:CoupledReadOptions & {referenceSourceHops?:number}={}) {
 const sourceHops=options.referenceSourceHops??0;
 if(!Number.isInteger(sourceHops)||sourceHops<0||sourceHops>1)throw new Error('query_read_invalid_source_hops');
 const base=readCoupledArgumentWithTraceClosure(graph,seeds,options),byId=new Map(graph.nodes.map(n=>[n.id,n]));
 const nodes=new Set(base.nodeIds),edges=new Set(base.relations.map(r=>r.id)),omissions=new Map(base.omissions.map(o=>[o.relationId,o.reason]));
 const maxNodes=options.maxNodes??60,maxRelations=options.maxRelations??80,sourceBackfill=new Set<string>();
 const add=(r:CoupledRelation)=>{
  if(edges.has(r.id))return true;
  const missing=[...r.from,r.to].filter(id=>!nodes.has(id));
  if(nodes.size+missing.length>maxNodes||edges.size>=maxRelations){omissions.set(r.id,'budget');return false;}
  edges.add(r.id);omissions.delete(r.id);for(const id of missing)nodes.add(id);return true;
 };
 if(sourceHops){
  // Only one EXTRA incoming source hop from already-read factual context.
  // Never a global second undirected hop; not a claim that coreference is solved.
  const frontier=new Set(base.nodeIds.filter(id=>byId.get(id)!.type==='事实陈述'));
  for(const r of graph.relations)if(r.kind==='explain'&&frontier.has(r.to)&&r.from.every(id=>byId.get(id)!.type==='事实陈述')&&!edges.has(r.id)&&add(r))sourceBackfill.add(r.id);
 }
 // New source nodes may themselves have actual support: retain that obligation
 // without promoting their premises into the original positive seed support.
 let changed=true;
 while(changed){changed=false;for(const r of graph.relations)if(r.kind==='support'&&byId.get(r.to)!.type!=='命名'&&nodes.has(r.to)&&!edges.has(r.id)&&add(r))changed=true;}
 const primary=new Set(base.support.nodeIds),auxEdges=new Set(base.auxiliarySupport.relations.map(r=>r.relationId)),auxNodes=new Set(base.auxiliarySupport.nodeIds);
 const traces=graph.nodes.filter(n=>nodes.has(n.id)&&!primary.has(n.id)&&graph.relations.some(r=>r.kind==='support'&&r.to===n.id&&n.type!=='命名')).map(anchor=>{
  const pending=[anchor.id],visited=new Set<string>(),ns=new Set([anchor.id]),rs=new Set<string>(),missing=new Set<string>();
  for(let i=0;i<pending.length;i++){
   const id=pending[i];if(visited.has(id))continue;visited.add(id);
   for(const r of graph.relations)if(r.kind==='support'&&r.to===id&&byId.get(id)!.type!=='命名'){
    if(!edges.has(r.id)){missing.add(r.id);continue;}
    rs.add(r.id);auxEdges.add(r.id);for(const n of [...r.from,r.to]){ns.add(n);auxNodes.add(n);}pending.push(...r.from);
   }
  }
  return {anchorNodeId:anchor.id,nodeIds:[...ns],relationIds:[...rs],missingRelationIds:[...missing],budgetComplete:!missing.size,positiveEvidenceForSeeds:false as const};
 });
 const packet=(ids:Set<string>)=>graph.relations.filter(r=>ids.has(r.id)).map(r=>({relationId:r.id,kind:r.kind,from:[...r.from],to:r.to}));
 const relations=graph.relations.filter(r=>edges.has(r.id)).map(r=>({...r,from:[...r.from]}));
 for(const r of graph.relations)if(r.kind==='explain'&&!edges.has(r.id)&&[...r.from,r.to].some(id=>nodes.has(id))&&!omissions.has(r.id))omissions.set(r.id,'context_depth');
 return {...base,readerRevision:'coupled-query-read-v3',nodeIds:graph.nodes.filter(n=>nodes.has(n.id)).map(n=>n.id),relations,
  explanation:packet(new Set([...base.explanation.map(r=>r.relationId),...sourceBackfill])),sourceBackfill:packet(sourceBackfill),
  auxiliarySupport:{nodeIds:graph.nodes.filter(n=>auxNodes.has(n.id)).map(n=>n.id),relations:packet(auxEdges),traces,positiveEvidenceForSeeds:false as const},
  supportTraceComplete:!graph.relations.some(r=>r.kind==='support'&&byId.get(r.to)!.type!=='命名'&&nodes.has(r.to)&&!edges.has(r.id)),
  omissions:[...omissions].map(([relationId,reason])=>({relationId,reason})),additionalExplanationHops:sourceHops,
  roles:{answerCandidates:[...seeds],primarySupport:[...base.support.nodeIds],counterevidence:base.opposition.map(r=>r.relationId),context:relations.filter(r=>r.kind==='explain').map(r=>r.id),auxiliaryPremisesArePositiveForSeeds:false},
  referenceResolutionCertified:false,edgesCreated:0,semanticCertified:false};
}
