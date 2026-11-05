import { ALL_ARGUMENT_ROLES, type FlowArgumentStructure } from './types';

const invalid = (): never => { throw new Error('复盘原始论证结构无效'); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const str = (v: unknown, max = 200, empty = false): string => typeof v === 'string' && v.length <= max && (empty || !!v.trim()) ? v : invalid();
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : invalid();
const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) invalid(); };

/** Allowlist only extraction data. Scores, model diagnoses and reference text never enter cognition. */
export function readFlowStructure(value: unknown): FlowArgumentStructure | undefined {
  if (value === undefined) return undefined;
  const input = obj(value);
  if (input.version !== 1) invalid();
  const nodes = list(input.nodes, 200).map(raw => {
    const n = obj(raw);
    if (!ALL_ARGUMENT_ROLES.includes(n.role as never)) invalid();
    return { id: str(n.id), role: n.role as FlowArgumentStructure['nodes'][number]['role'], text: str(n.text, 20000), rawQuote: str(n.rawQuote, 20000, true) };
  });
  unique(nodes.map(n => n.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const endpoint = (v: unknown) => { const id = str(v); if (!byId.has(id)) invalid(); return id; };
  const args = list(input.arguments, 100).map(raw => {
    const a = obj(raw), claim = endpoint(a.claim);
    if (!['argued', 'stated_only', 'incomplete'].includes(a.status as string)) invalid();
    const refs = (value: unknown) => list(value, 200).map(v => {
      const id = endpoint(v);
      if (id === claim) invalid();
      return id;
    });
    const support = refs(a.support), oppose = refs(a.oppose); unique(support); unique(oppose);
    if (support.some(id => oppose.includes(id))) invalid();
    return { id: str(a.id), claim, support, oppose, status: a.status as FlowArgumentStructure['arguments'][number]['status'] };
  });
  unique(args.map(a => a.id));
  const relations = list(input.relations, 200).map(raw => {
    const r = obj(raw), from = endpoint(r.from), to = endpoint(r.to);
    if (from === to || !['context', 'method_for', 'relates'].includes(r.kind as string)) invalid();
    return { id: str(r.id), kind: r.kind as FlowArgumentStructure['relations'][number]['kind'], from, to, reason: str(r.reason, 2000, true) };
  });
  unique(relations.map(r => r.id));
  const unresolved = list(input.unresolved, 100).map(raw => {
    const u = obj(raw); return { ...(u.nodeId === undefined ? {} : { nodeId: endpoint(u.nodeId) }), reason: str(u.reason, 4000) };
  });
  return { version: 1, nodes, arguments: args, relations, unresolved };
}

/** Canvas edges are a projection only: a support array is JOINT evidence, not separate sufficient proofs. */
export function projectFlowEdges(structure: FlowArgumentStructure) {
  const edges: Array<{ id: string; source: string; target: string; relation: 'support' | 'oppose' | 'context' | 'method_for' | 'relates'; reason?: string }> = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: typeof edges[number]['relation'], reason?: string) => {
    const key = JSON.stringify([source, target, relation]);
    if (source === target || seen.has(key)) return;
    seen.add(key); edges.push({ id: `e${edges.length + 1}`, source, target, relation, ...(reason ? { reason } : {}) });
  };
  for (const a of structure.arguments) { a.support.forEach(id => add(id, a.claim, 'support')); a.oppose.forEach(id => add(id, a.claim, 'oppose')); }
  structure.relations.forEach(r => add(r.from, r.to, r.kind, r.reason));
  return edges;
}

/** Ignore canvas coordinates/legacy labels, but never silently reuse an edited source graph. */
export function flowStructureMatches(structure: FlowArgumentStructure, graph: {
  nodes: Array<{ id: string; text: string; role?: string }>;
  edges: Array<{ source: string; target: string; relation: string; reason?: string }>;
}): boolean {
  const nodeKeys = (nodes: typeof graph.nodes) => nodes.map(n => JSON.stringify([n.id, n.role, n.text])).sort();
  const edgeKeys = (edges: typeof graph.edges) => edges.map(e => JSON.stringify([e.source, e.target, e.relation, e.reason || ''])).sort();
  return JSON.stringify(nodeKeys(structure.nodes)) === JSON.stringify(nodeKeys(graph.nodes))
    && JSON.stringify(edgeKeys(projectFlowEdges(structure))) === JSON.stringify(edgeKeys(graph.edges));
}

/** Exact-node read: original extraction is explicitly marked stale after any semantic graph edit. */
export function flowStructureForNode(graph: { flowStructure?: FlowArgumentStructure } & Parameters<typeof flowStructureMatches>[1], nodeId: string) {
  const source = graph.flowStructure;
  if (!source) return undefined;
  return { state: flowStructureMatches(source, graph) ? 'current' as const : 'source_only' as const,
    rawQuote: source.nodes.find(n => n.id === nodeId)?.rawQuote,
    arguments: source.arguments.filter(a => [a.claim, ...a.support, ...a.oppose].includes(nodeId)),
    unresolved: source.unresolved.filter(u => !u.nodeId || u.nodeId === nodeId),
    meaning: '原始复盘抽取，不是评分或事实核验；rawQuote 是抽取时片段，未在此另行核验；support 数组共同构成依据。source_only 仅供溯源，不能作为当前连线或修改后文本的引文。' };
}
