import {readCoupledArgument,type CoupledGraph,type CoupledReadOptions,type CoupledRelation} from './coupledArgumentRead.ts';

/**
 * Read every admitted judgment's own support ancestry, without promoting a
 * counterclaim/context judgment (or its premises) to positive evidence for seeds.
 * The frozen V1 reader remains the baseline for old experiment hashes.
 */
export function readCoupledArgumentWithTraceClosure(graph:CoupledGraph,seeds:string[],options:CoupledReadOptions={}){
 const base=readCoupledArgument(graph,seeds,options);
 const maxNodes=options.maxNodes??60,maxRelations=options.maxRelations??80;
 const byId=new Map(graph.nodes.map(n=>[n.id,n]));
 const primaryNodes=new Set(base.support.nodeIds);
 const selectedNodes=new Set(base.nodeIds);
 const selectedEdges=new Set([...base.support.relations,...base.opposition,...base.naming,...base.explanation].map(e=>e.relationId));
 const omissions=new Map(base.omissions.map(o=>[o.relationId,o.reason]));
 const incoming=new Map<string,CoupledRelation[]>();
 for(const r of graph.relations){
  if(r.kind!=='support'||byId.get(r.to)!.type==='命名')continue;
  incoming.set(r.to,[...(incoming.get(r.to)||[]),r]);
 }
 // Only actual incoming support edges create a reading obligation. No type-based
 // invented premise, outgoing crawl, new oppose edge or extra explanation hop.
 const anchors=base.nodeIds.filter(id=>!primaryNodes.has(id)&&incoming.has(id));
 const auxiliaryEdges=new Set<string>(),auxiliaryNodes=new Set<string>();
 const traces:Array<{anchorNodeId:string;nodeIds:string[];relationIds:string[];missingRelationIds:string[];budgetComplete:boolean;positiveEvidenceForSeeds:false}>=[];
 const add=(r:CoupledRelation)=>{
  if(selectedEdges.has(r.id))return true;
  const missing=[...r.from,r.to].filter(id=>!selectedNodes.has(id));
  if(selectedEdges.size>=maxRelations||selectedNodes.size+missing.length>maxNodes){omissions.set(r.id,'budget');return false;}
  selectedEdges.add(r.id);omissions.delete(r.id);for(const id of missing)selectedNodes.add(id);return true;
 };
 for(const anchor of anchors){
  const visited=new Set<string>(),pending=[anchor],traceNodes=new Set([anchor]),traceEdges=new Set<string>(),missingEdges=new Set<string>();
  for(let i=0;i<pending.length;i++){
   const target=pending[i];if(visited.has(target))continue;visited.add(target);
   for(const r of incoming.get(target)||[]){
    // Grouped support is atomic: either all premises are read or the whole edge
    // is explicitly omitted. Already-admitted endpoints cost no node budget.
    if(!add(r)){missingEdges.add(r.id);continue;}
    missingEdges.delete(r.id);traceEdges.add(r.id);auxiliaryEdges.add(r.id);
    for(const id of [...r.from,r.to]){traceNodes.add(id);auxiliaryNodes.add(id);}
    for(const id of r.from)if(!visited.has(id))pending.push(id);
   }
  }
  traces.push({anchorNodeId:anchor,nodeIds:graph.nodes.filter(n=>traceNodes.has(n.id)).map(n=>n.id),relationIds:graph.relations.filter(r=>traceEdges.has(r.id)).map(r=>r.id),missingRelationIds:[...missingEdges],budgetComplete:!missingEdges.size,positiveEvidenceForSeeds:false});
 }
 // A shared edge may have been admitted by another trace; reconcile every trace
 // with the final packet instead of leaving a stale missing-edge warning.
 for(const trace of traces){
  const visited=new Set<string>(),pending=[trace.anchorNodeId],nodes=new Set([trace.anchorNodeId]),edges=new Set<string>(),missing=new Set<string>();
  for(let i=0;i<pending.length;i++){
   const target=pending[i];if(visited.has(target))continue;visited.add(target);
   for(const r of incoming.get(target)||[]){
    if(!selectedEdges.has(r.id)){missing.add(r.id);continue;}
    edges.add(r.id);auxiliaryEdges.add(r.id);for(const id of [...r.from,r.to]){nodes.add(id);auxiliaryNodes.add(id);}
    for(const id of r.from)if(!visited.has(id))pending.push(id);
   }
  }
  trace.nodeIds=graph.nodes.filter(n=>nodes.has(n.id)).map(n=>n.id);
  trace.relationIds=graph.relations.filter(r=>edges.has(r.id)).map(r=>r.id);
  trace.missingRelationIds=[...missing];trace.budgetComplete=!missing.size;
 }
 for(const r of graph.relations)if(r.kind==='explain'&&!selectedEdges.has(r.id)&&[...r.from,r.to].some(id=>selectedNodes.has(id))&&!omissions.has(r.id))omissions.set(r.id,'context_depth');
 const packet=(ids:Set<string>)=>graph.relations.filter(r=>ids.has(r.id)).map(r=>({relationId:r.id,kind:r.kind,from:[...r.from],to:r.to}));
 return{...base,readerRevision:'coupled-support-trace-v2',nodeIds:graph.nodes.filter(n=>selectedNodes.has(n.id)).map(n=>n.id),
  auxiliarySupport:{nodeIds:graph.nodes.filter(n=>auxiliaryNodes.has(n.id)).map(n=>n.id),relations:packet(auxiliaryEdges),traces,positiveEvidenceForSeeds:false as const},
  relations:graph.relations.filter(r=>selectedEdges.has(r.id)).map(r=>({...r,from:[...r.from]})),
  omissions:[...omissions].map(([relationId,reason])=>({relationId,reason})),
  supportTraceComplete:traces.every(t=>t.budgetComplete)&&!graph.relations.some(r=>r.kind==='support'&&byId.get(r.to)!.type!=='命名'&&selectedNodes.has(r.to)&&!selectedEdges.has(r.id)),
  primarySupportUnchanged:true,additionalExplanationHops:0,edgesCreated:0,semanticCertified:false};
}
