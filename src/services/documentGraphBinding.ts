import type {DocumentGraphCommit, DocumentGraphNode, DocumentGraphRelation, DocumentGraphSource, DocumentGraphSourceSnapshot} from './documentGraphTypes';

export interface ReviewedLocalDocumentGraph {
  graphId: string;
  /** Local planner provides coordinate spans, not a second rewritten copy of the document. */
  windows: Array<{id: string; parts: DocumentGraphSource[]}>;
  nodes: Array<{id: string; type: DocumentGraphNode['type']; source: Array<{window:string;quote:string}>}>;
  relations: DocumentGraphRelation[];
  unresolved: string[];
}
export interface ReviewedCrossGraphRelation {
  id: string; kind: DocumentGraphRelation['kind']; reason: string;
  from: Array<{graphId:string;nodeId:string}>; to: {graphId:string;nodeId:string};
}
const scoped = (graphId: string, id: string) => `${graphId}:${id}`;

/** Replays model quotes into existing-source coordinates. No model text or graph ID enters embeddings. */
export function bindReviewedDocumentGraphs(snapshot: DocumentGraphSourceSnapshot, graphs: ReviewedLocalDocumentGraph[],
  cross: ReviewedCrossGraphRelation[] = []): DocumentGraphCommit {
  const chunks=new Map(snapshot.chunks.map(c => [c.id,c]));
  const graphIds=new Set<string>(), nodeIds=new Set<string>();
  const nodes: DocumentGraphNode[]=[], relations: DocumentGraphRelation[]=[], unresolved: string[]=[];
  for (const g of graphs) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(g.graphId) || graphIds.has(g.graphId)) throw new Error('document_graph_duplicate_graph');
    graphIds.add(g.graphId);
    const windows=new Map(g.windows.map(w => {
      let offset=0;
      const ranges=w.parts.map((p,i) => {
        const c=chunks.get(p.chunkId);
        if (!c || !Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start<0 || p.end<=p.start || p.end>c.content.length)
          throw new Error('document_graph_window_source');
        if (i) offset++;
        const text=c.content.slice(p.start,p.end), start=offset; offset+=text.length;
        return {p,text,start,end:offset};
      });
      if (!ranges.length) throw new Error('document_graph_window_source');
      return [w.id,{text:ranges.map(p => p.text).join('\n'),ranges}] as const;
    }));
    if (windows.size!==g.windows.length) throw new Error('document_graph_duplicate_window');
    for (const n of g.nodes) {
      const id=scoped(g.graphId,n.id);
      if (!/^[A-Za-z0-9_-]{1,60}$/u.test(n.id) || nodeIds.has(id)) throw new Error('document_graph_duplicate_node');
      nodeIds.add(id);
      const source: DocumentGraphSource[]=[];
      for (const s of n.source) {
        const w=windows.get(s.window), start=w?.text.indexOf(s.quote) ?? -1;
        if (!w || !s.quote.trim() || start<0 || w.text.indexOf(s.quote,start+1)>=0) throw new Error('document_graph_quote_missing_or_ambiguous');
        const end=start+s.quote.length;
        for (const r of w.ranges) {
          const lo=Math.max(start,r.start), hi=Math.min(end,r.end);
          if (hi>lo) source.push({chunkId:r.p.chunkId,start:r.p.start+lo-r.start,end:r.p.start+hi-r.start});
        }
      }
      // Overlap windows can repeat a source coordinate. Retain it once, without semantic merging.
      const unique=source.filter((s,i) => source.findIndex(t => t.chunkId===s.chunkId && t.start===s.start && t.end===s.end)===i);
      nodes.push({id,graphId:g.graphId,type:n.type,source:unique});
    }
    for (const r of g.relations) relations.push({...r,id:scoped(g.graphId,r.id),
      from:r.from.map(id => scoped(g.graphId,id)),to:scoped(g.graphId,r.to)});
    unresolved.push(...g.unresolved.map(s => `${g.graphId}: ${s}`.slice(0,600)));
  }
  for (const r of cross) {
    const ids=[...r.from,r.to];
    if (r.from.some(n => n.graphId===r.to.graphId) || ids.some(n => !nodeIds.has(scoped(n.graphId,n.nodeId))))
      throw new Error('document_graph_invalid_cross_endpoint');
    relations.push({id:`cross:${r.id}`,kind:r.kind,reason:r.reason,
      from:r.from.map(n => scoped(n.graphId,n.nodeId)),to:scoped(r.to.graphId,r.to.nodeId)});
  }
  return {docId:snapshot.docId,sourceFingerprint:snapshot.sourceFingerprint,previousRevision:snapshot.previousRevision,
    nodes,relations,unresolved};
}
