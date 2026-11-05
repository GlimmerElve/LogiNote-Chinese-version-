import type {DocumentArgumentGraphView} from './documentArgumentV5Types';

export interface ArgumentPort {id:string;type:'source'|'target';side:'left'|'right';top:number}
/** View-only ports: every displayed branch owns an endpoint. Never change the
 * stored relation, in particular its joint-premise from array. */
export function routeDocumentArgumentGraph(graph:Pick<DocumentArgumentGraphView,'nodes'|'edges'>,positions:Map<string,{x:number;y:number}>) {
  const ports=new Map(graph.nodes.map(n=>[n.id,[] as ArgumentPort[]]));
  // Missing endpoints stay in the saved graph and diagnostics; there is no
  // position at which a renderer can draw their arrows. Never invent a node.
  const branches=graph.edges.flatMap((e,edgeIndex)=>e.from.flatMap((from,fromIndex)=>
    positions.has(from)&&positions.has(e.to)?[{id:`${e.id}:${edgeIndex}:${fromIndex}`,relationId:e.id,source:from,target:e.to,
      sourceHandle:`out:${edgeIndex}:${fromIndex}`,targetHandle:`in:${edgeIndex}:${fromIndex}`}]:[]));
  const ends=new Map<string,Array<ArgumentPort&{otherY:number}>>();
  for(const b of branches){
    const s=positions.get(b.source)!,t=positions.get(b.target)!;
    for(const [node,id,type,side,otherY] of [
      [b.source,b.sourceHandle,'source',t.x<s.x?'left':'right',t.y],
      [b.target,b.targetHandle,'target',s.x<t.x?'left':'right',s.y],
    ] as const){
      const key=JSON.stringify([node,side]);
      const list=ends.get(key)||[];list.push({id,type,side,top:0,otherY});ends.set(key,list);
    }
  }
  for(const [key,list] of ends){
    const [node]=JSON.parse(key) as string[];
    list.sort((a,b)=>a.otherY-b.otherY||a.id.localeCompare(b.id));
    list.forEach((p,i)=>ports.get(node)!.push({id:p.id,type:p.type,side:p.side,top:12+76*(i+1)/(list.length+1)}));
  }
  return {ports,branches};
}
