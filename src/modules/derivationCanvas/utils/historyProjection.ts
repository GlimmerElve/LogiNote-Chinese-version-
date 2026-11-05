import type { DerivationCanvasState, DerivationNodeType } from '../../../types/sceneS4';
import { wouldCreateCycle } from './cycle';

/** Undo/redo restores authorized math, not disabled proof receipts or independent help accounting. */
export function projectDerivationHistory(current: DerivationCanvasState, target: DerivationCanvasState, allowed: readonly DerivationNodeType[]): DerivationCanvasState {
  const before = new Map(current.nodes.map(node=>[node.id,node]));
  const nodes = target.nodes.flatMap(node=>{
    const old = before.get(node.id);
    if (old && (!allowed.includes(old.type) || !allowed.includes(node.type))) return [{...node,type:old.type,data:old.data}];
    return allowed.includes(node.type) ? [node] : [];
  });
  const byId = new Map(nodes.map(node=>[node.id,node]));
  const edges: DerivationCanvasState['edges'] = [];
  for (const edge of target.edges) {
    const source=byId.get(edge.source), destination=byId.get(edge.target);
    if (!source || !destination) continue;
    if (current.edges.some(old=>old.id===edge.id && old.source===edge.source && old.target===edge.target && old.type===edge.type)
      || (allowed.includes(source.type) && allowed.includes(destination.type) && source.type!=='conclusion'
        && destination.type!=='given' && !wouldCreateCycle(edge.source,edge.target,edges))) edges.push(edge);
  }
  return {...target,nodes,edges,helpUsed:current.helpUsed,maxHelp:current.maxHelp,independenceScore:current.independenceScore};
}
