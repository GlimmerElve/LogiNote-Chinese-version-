import {bindReviewedDocumentGraphs,type ReviewedLocalDocumentGraph} from './documentGraphBinding';
import {entityReadingView,type EntityReadingFragment} from './documentGraphEntityReading';
import type {DocumentGraphSourceSnapshot,DocumentGraphNode} from './documentGraphTypes';

/** Preserve original quote boundaries, while allowing storage-chunk seams inside one quote.
 * Coordinates address the exact host replay, not a rewritten copy or model text. */
export function boundEntityReading(snapshot:DocumentGraphSourceSnapshot,graph:ReviewedLocalDocumentGraph,boundNodes:DocumentGraphNode[]){
  const fragments:EntityReadingFragment[]=[],texts=new Map<string,string>();
  for(const node of graph.nodes){
    const bound=boundNodes.find(n=>n.id===`${graph.graphId}:${node.id}`);
    if(!bound)throw new Error('entity_bound_node_missing');
    const parts=bound.source.map(p=>snapshot.chunks.find(c=>c.id===p.chunkId)!.content.slice(p.start,p.end));
    const starts:number[]=[];let offset=0;for(const part of parts){starts.push(offset);offset+=part.length+1;}
    texts.set(node.id,parts.join('\n'));let fragmentIndex=0;
    for(const source of node.source){
      const single=bindReviewedDocumentGraphs(snapshot,[{...graph,nodes:[{...node,source:[source]}],relations:[],unresolved:[]}]).nodes[0];
      const indices=single.source.map(p=>bound.source.findIndex(b=>b.chunkId===p.chunkId&&b.start===p.start&&b.end===p.end));
      if(indices.some(i=>i<0))throw new Error('entity_bound_part_missing');
      // Deduplicated/overlapping sources need not stay consecutive in host replay.
      // Split those runs instead of fabricating continuity.
      const runs:number[][]=[];
      for(const i of indices){const last=runs.at(-1);if(last&&last.at(-1)===i-1)last.push(i);else runs.push([i]);}
      for(const run of runs){const raw=run.map(i=>parts[i]).join('\n');
        fragments.push({id:`${node.id}:F${++fragmentIndex}`,nodeId:node.id,raw,nodeStart:starts[run[0]],...entityReadingView(raw)});
      }
    }
  }
  return {fragments,texts};
}
