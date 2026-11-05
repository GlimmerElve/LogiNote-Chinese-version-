/** Read-only experimental projection. Never creates edges or writes an index. */
export interface CoupledNode {id:string;type:string}
export interface CoupledRelation {id:string;kind:string;from:string[];to:string}
export interface CoupledGraph {nodes:CoupledNode[];relations:CoupledRelation[]}
export interface CoupledReadOptions {supportDirection?:'incoming'|'both';contextDepth?:number;maxNodes?:number;maxRelations?:number}

export function readCoupledArgument(graph:CoupledGraph,seeds:string[],options:CoupledReadOptions={}){
 const byId=new Map(graph.nodes.map(n=>[n.id,n])),edgeIds=new Set<string>();
 if(byId.size!==graph.nodes.length)throw new Error('coupled_duplicate_node');
 for(const r of graph.relations){
  if(edgeIds.has(r.id)||!['support','oppose','explain'].includes(r.kind)||!r.from.length||new Set(r.from).size!==r.from.length||r.from.includes(r.to)||[...r.from,r.to].some(id=>!byId.has(id)))throw new Error('coupled_invalid_relation');
  edgeIds.add(r.id);
 }
 const direction=options.supportDirection??'incoming',depth=options.contextDepth??1,maxNodes=options.maxNodes??60,maxRelations=options.maxRelations??80;
 if(!['incoming','both'].includes(direction)||!Number.isInteger(depth)||depth<0||depth>5||!Number.isInteger(maxNodes)||maxNodes<1||!Number.isInteger(maxRelations)||maxRelations<1)throw new Error('coupled_invalid_budget');
 const seedIds=[...new Set(seeds)];if(!seedIds.length||seedIds.some(id=>!byId.has(id))||seedIds.length>maxNodes)throw new Error('coupled_invalid_seed');
 const selectedNodes=new Set(seedIds),selectedEdges=new Set<string>(),omissions=new Map<string,string>();
 const supportNodes=new Set(seedIds),supportEdges=new Set<string>(),oppositionEdges=new Set<string>(),namingEdges=new Set<string>(),contextEdges=new Set<string>();
 // Atomic grouped-edge admission: never return a conjunction with a missing premise.
 const add=(r:CoupledRelation)=>{
  if(selectedEdges.has(r.id))return true;
  const next=[...r.from,r.to].filter(id=>!selectedNodes.has(id));
  if(selectedEdges.size>=maxRelations||selectedNodes.size+next.length>maxNodes){omissions.set(r.id,'budget');return false;}
  selectedEdges.add(r.id);omissions.delete(r.id);for(const id of next)selectedNodes.add(id);return true;
 };
 let changed=true;
 while(changed){changed=false;for(const r of graph.relations){
  if(r.kind!=='support'||byId.get(r.to)!.type==='命名'||supportEdges.has(r.id))continue;
  if(!supportNodes.has(r.to)&&!(direction==='both'&&r.from.some(id=>supportNodes.has(id))))continue;
  if(!add(r))continue;
  supportEdges.add(r.id);for(const id of [...r.from,r.to]){if(!supportNodes.has(id))changed=true;supportNodes.add(id);}
 }}
 // Opposing sources are counterevidence, never promoted to positive inherited premises.
 for(const r of graph.relations)if(r.kind==='oppose'&&(supportNodes.has(r.to)||r.from.some(id=>supportNodes.has(id)))&&add(r))oppositionEdges.add(r.id);
 // Naming support identifies an object; it is not a proof of a substantive conclusion.
 for(const r of graph.relations)if(r.kind==='support'&&byId.get(r.to)!.type==='命名'&&(supportNodes.has(r.to)||r.from.some(id=>supportNodes.has(id)))&&add(r))namingEdges.add(r.id);
 const contextFrontier=new Set(selectedNodes);
 for(let step=0;step<depth;step++){
  const frontier=new Set(contextFrontier);contextFrontier.clear();
  for(const r of graph.relations){
   if(r.kind!=='explain'||contextEdges.has(r.id)||(!frontier.has(r.to)&&!r.from.some(id=>frontier.has(id))))continue;
   if(add(r)){contextEdges.add(r.id);for(const id of [...r.from,r.to])contextFrontier.add(id);}
  }
 }
 for(const r of graph.relations)if(r.kind==='explain'&&!contextEdges.has(r.id)&&[...r.from,r.to].some(id=>selectedNodes.has(id))&&!omissions.has(r.id))omissions.set(r.id,'context_depth');
 const packet=(ids:Set<string>)=>graph.relations.filter(r=>ids.has(r.id)).map(r=>({relationId:r.id,kind:r.kind,from:[...r.from],to:r.to}));
 return{seedIds,nodeIds:graph.nodes.filter(n=>selectedNodes.has(n.id)).map(n=>n.id),
  support:{nodeIds:graph.nodes.filter(n=>supportNodes.has(n.id)).map(n=>n.id),relations:packet(supportEdges)},
  opposition:packet(oppositionEdges),naming:packet(namingEdges),explanation:packet(contextEdges),
  omissions:[...omissions].map(([relationId,reason])=>({relationId,reason})),
  inheritedPremisesAreTraceOnly:true,explanationsAreEvidence:false,oppositionIsPositiveEvidence:false,
  edgesCreated:0,semanticCertified:false};
}
