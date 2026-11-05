import type { DocumentArgumentGraphView } from './documentArgumentV5Types';

export const ARGUMENT_NODE_SIZE = { width: 240, height: 104 };

/** Display-only layout. All nodes and edges are preserved, including disconnected
 * material and navigation cycles. Batch number is provenance, not a layout axis. */
export function layoutDocumentArgumentGraph(graph: Pick<DocumentArgumentGraphView, 'nodes' | 'edges'>) {
  const ids = graph.nodes.map(n => n.id);
  const order = new Map(ids.map((id, i) => [id, i]));
  const outgoing = new Map(ids.map(id => [id, new Set<string>()]));
  const adjacent = new Map(ids.map(id => [id, new Set<string>()]));
  for (const edge of graph.edges) for (const from of edge.from) {
    if (!outgoing.has(from) || !outgoing.has(edge.to) || from === edge.to) continue;
    outgoing.get(from)!.add(edge.to);
    adjacent.get(from)!.add(edge.to); adjacent.get(edge.to)!.add(from);
  }
  const compare = (a: string, b: string) => order.get(a)! - order.get(b)!;
  // Collapse strongly connected components only for placement; retain every
  // original node/arrow in the returned view.
  let serial = 0;
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), groups: string[][] = [];
  const visit = (id: string) => {
    index.set(id, serial); low.set(id, serial++); stack.push(id); onStack.add(id);
    for (const to of outgoing.get(id)!) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const group: string[] = [];
    let item: string;
    do { item = stack.pop()!; onStack.delete(item); group.push(item); } while (item !== id);
    groups.push(group.sort(compare));
  };
  ids.forEach(id => { if (!index.has(id)) visit(id); });
  const groupOf = new Map(groups.flatMap((g, i) => g.map(id => [id, i] as const)));
  const next = groups.map(() => new Set<number>()), degree = groups.map(() => 0), rank = groups.map(() => 0);
  for (const [from, targets] of outgoing) for (const to of targets) {
    const a = groupOf.get(from)!, b = groupOf.get(to)!;
    if (a !== b && !next[a].has(b)) { next[a].add(b); degree[b]++; }
  }
  const queue = degree.flatMap((d, i) => d === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) for (const to of next[queue[i]]) {
    rank[to] = Math.max(rank[to], rank[queue[i]] + 1);
    if (--degree[to] === 0) queue.push(to);
  }
  const seen = new Set<string>(), components: string[][] = [];
  for (const id of ids) if (!seen.has(id)) {
    const component = [id]; seen.add(id);
    for (let i = 0; i < component.length; i++) for (const to of adjacent.get(component[i])!) {
      if (!seen.has(to)) { seen.add(to); component.push(to); }
    }
    components.push(component.sort(compare));
  }
  components.sort((a, b) => b.length - a.length || compare(a[0], b[0]));
  const positions = new Map<string, { x: number; y: number }>();
  let left = 0, top = 0, rowHeight = 0;
  for (const component of components) {
    const columns = new Map<number, string[]>();
    for (const id of component) {
      const r = rank[groupOf.get(id)!]; columns.set(r, [...(columns.get(r) || []), id]);
    }
    const columnIds = [...columns.keys()].sort((a, b) => a - b);
    // Alternate barycentric sweeps to reduce crossings between adjacent ranks.
    for (let sweep=0;sweep<6;sweep++) {
      const ranks=sweep%2?[...columnIds].reverse():columnIds;
      const slot=new Map([...columns.values()].flatMap(c=>c.map((id,i)=>[id,(i+.5)/c.length] as const)));
      for (const r of ranks) {
        const column=columns.get(r)!;
        const score=(id:string)=>{
          const neighbors=[...adjacent.get(id)!].filter(n=>sweep%2?rank[groupOf.get(n)!]>r:rank[groupOf.get(n)!]<r);
          return neighbors.length?neighbors.reduce((sum,n)=>sum+slot.get(n)!,0)/neighbors.length:slot.get(id)!;
        };
        column.sort((a,b)=>score(a)-score(b)||compare(a,b));
        column.forEach((id,i)=>slot.set(id,(i+.5)/column.length));
      }
    }
    const height = Math.max(...[...columns.values()].map(c => c.length)) * 180;
    const width = columnIds.length * 440;
    if (left && left + width > 1800) { top += rowHeight + 100; left = 0; rowHeight = 0; }
    for (const [r, column] of columns) column.forEach((id, i) => {
      positions.set(id, { x: left + columnIds.indexOf(r) * 440, y: top + (height - column.length * 180) / 2 + i * 180 });
    });
    left += width + 100; rowHeight = Math.max(rowHeight, height);
  }
  return { positions, componentCount: components.length };
}
