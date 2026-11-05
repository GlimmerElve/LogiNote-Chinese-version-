import type { ArgDoc, StructureCheck, StructureBaseline, StructureReviewMode } from './types';

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${(hash >>> 0).toString(16)}`;
}
const nodeKey = (n: ArgDoc['nodes'][number]) => fingerprint([n.id, n.role ?? null, n.role ? null : n.mainType, n.text]);
const edgeKey = (e: ArgDoc['edges'][number]) => fingerprint([e.id, e.source, e.target, e.relation, e.reason ?? '']);

export function captureStructureBaseline(doc: ArgDoc): StructureBaseline {
  return { nodes: doc.nodes.map(n => ({ id: n.id, key: nodeKey(n) })),
    edges: doc.edges.map(e => ({ id: e.id, key: edgeKey(e), source: e.source, target: e.target, relation: e.relation })) };
}

export interface StructureReviewPlan {
  mode: StructureReviewMode;
  graphKey: string;
  targets: { nodes: string[]; edges: string[] };
  deferred: { nodes: string[]; edges: string[] };
  context: { nodes: string[]; edges: string[] };
}

/** Local routing only; it does not decide whether any statement/edge is semantically correct. */
export function planStructureReview(doc: ArgDoc, mode: StructureReviewMode = 'changes', targetLimit = 16): StructureReviewPlan {
  const base = doc.structureReviewBase;
  const current = captureStructureBaseline(doc);
  const nodeIds = new Set(current.nodes.map(n => n.id)), edgeIds = new Set(current.edges.map(e => e.id));
  const targets: Array<{ kind: 'nodes' | 'edges'; id: string }> = [];
  const queued = new Set<string>();
  const add = (kind: 'nodes' | 'edges', id: string) => {
    if (!(kind === 'nodes' ? nodeIds : edgeIds).has(id) || queued.has(`${kind}:${id}`)) return;
    queued.add(`${kind}:${id}`); targets.push({ kind, id });
  };
  const affected = new Set<string>();
  const affect = (id: string) => { if (nodeIds.has(id)) { affected.add(id); add('nodes', id); } };
  if (mode === 'full' || !base) {
    current.nodes.forEach(n => add('nodes', n.id)); current.edges.forEach(e => add('edges', e.id));
  } else {
    const priorNodes = new Map(base.nodes.map(n => [n.id, n.key]));
    const priorEdges = new Map(base.edges.map(e => [e.id, e]));
    for (const node of current.nodes) if (priorNodes.get(node.id) !== node.key) affect(node.id);
    for (const edge of current.edges) if (priorEdges.get(edge.id)?.key !== edge.key) {
      add('edges', edge.id); affect(edge.source); affect(edge.target);
      const old = priorEdges.get(edge.id); if (old) { affect(old.source); affect(old.target); }
    }
    for (const old of base.edges) if (!edgeIds.has(old.id) || !nodeIds.has(old.source) || !nodeIds.has(old.target)) {
      affect(old.source); affect(old.target);
    }
    // A changed definition/method can affect the object it directly explains/produces.
    // One step only here; do not flood the whole graph through generic relates edges.
    const directSeeds = new Set(affected);
    for (const edge of [...base.edges, ...current.edges]) if (directSeeds.has(edge.source)
      && edge.relation !== 'support' && edge.relation !== 'oppose') affect(edge.target);
    doc.structureReview?.pendingNodes?.forEach(id => affect(id));
    doc.structureReview?.pendingEdges?.forEach(id => add('edges', id));
    // Trace affected conclusions, including the old endpoints of removed/reversed edges.
    const links = [...base.edges, ...current.edges].filter(e => e.relation === 'support' || e.relation === 'oppose');
    const queue = [...affected];
    for (let index = 0; index < queue.length; index++) for (const edge of links) {
      if (edge.source === queue[index] && nodeIds.has(edge.target) && !affected.has(edge.target)) {
        affect(edge.target); queue.push(edge.target);
      }
    }
    // Existing flags may need another check even when their text is unchanged.
    doc.nodes.filter(n => n.issue || n.status === 'edited').forEach(n => add('nodes', n.id));
    doc.structureReview?.nodes.filter(c => c.state !== 'clear').forEach(c => add('nodes', c.id));
    doc.structureReview?.edges.filter(c => c.state !== 'clear').forEach(c => add('edges', c.id));
    current.edges.filter(e => affected.has(e.source) || affected.has(e.target)).forEach(e => add('edges', e.id));
  }
  const limit = mode === 'full' ? targets.length : Math.max(1, Math.trunc(targetLimit));
  const selected = targets.slice(0, limit), deferred = targets.slice(limit);
  const result = { nodes: selected.filter(t => t.kind === 'nodes').map(t => t.id), edges: selected.filter(t => t.kind === 'edges').map(t => t.id) };
  const contextNodes = new Set(result.nodes), contextEdges = new Set(result.edges);
  for (const edge of doc.edges) if (result.nodes.includes(edge.source) || result.nodes.includes(edge.target) || contextEdges.has(edge.id)) {
    contextEdges.add(edge.id); contextNodes.add(edge.source); contextNodes.add(edge.target);
  }
  // Keep the evidence chain intact, but do not turn its context nodes into review targets.
  let added = true;
  while (added) {
    added = false;
    for (const edge of doc.edges) if ((edge.relation === 'support' || edge.relation === 'oppose') && contextNodes.has(edge.target)) {
      contextEdges.add(edge.id);
      if (!contextNodes.has(edge.source)) { contextNodes.add(edge.source); added = true; }
    }
  }
  const evidenceContext = new Set(contextNodes);
  for (const edge of doc.edges) if ((edge.relation === 'context' || edge.relation === 'method_for') && evidenceContext.has(edge.target)) {
    contextEdges.add(edge.id); contextNodes.add(edge.source);
  }
  return { mode, graphKey: structureGraphKey(doc), targets: result,
    deferred: { nodes: deferred.filter(t => t.kind === 'nodes').map(t => t.id), edges: deferred.filter(t => t.kind === 'edges').map(t => t.id) },
    context: { nodes: [...contextNodes], edges: [...contextEdges] } };
}

export function buildScopedStructureReviewInput(doc: ArgDoc, plan: StructureReviewPlan) {
  return {
    targets: plan.targets,
    nodes: doc.nodes.filter(n => plan.context.nodes.includes(n.id)).map(n => ({ id: n.id, role: n.role ?? null,
      ...(!n.role ? { legacyType: n.mainType } : {}), text: n.text })),
    edges: doc.edges.filter(e => plan.context.edges.includes(e.id)).map(e => ({ id: e.id, from: e.source, to: e.target, kind: e.relation, ...(e.reason ? { reason: e.reason } : {}) })),
    previousIssues: [
      ...doc.nodes.filter(n => plan.targets.nodes.includes(n.id) && n.issue).map(n => ({ kind: 'node', id: n.id, reason: n.issue })),
      ...(doc.structureReview?.edges ?? []).filter(e => plan.targets.edges.includes(e.id) && e.state === 'issue').map(e => ({ kind: 'edge', id: e.id, reason: e.reason })),
    ],
  };
}

export function structureTargetKey(doc: ArgDoc, kind: 'node' | 'edge', id: string): string {
  const target = kind === 'node' ? doc.nodes.find(n => n.id === id) : doc.edges.find(e => e.id === id);
  if (!target) return 'deleted';
  const edges = kind === 'node' ? doc.edges.filter(e => e.source === id || e.target === id) : [target as ArgDoc['edges'][number]];
  const neighbors = new Set(edges.flatMap(e => [e.source, e.target]));
  if (kind === 'node') neighbors.add(id);
  return fingerprint([doc.nodes.filter(n => neighbors.has(n.id)).map(nodeKey), edges.map(edgeKey)]);
}

export function isStructureCheckFresh(doc: ArgDoc, kind: 'node' | 'edge', check: StructureCheck): boolean {
  if (doc.structureReview?.graphKey !== structureGraphKey(doc)) return false;
  const pending = kind === 'node' ? doc.structureReview?.pendingNodes : doc.structureReview?.pendingEdges;
  if (pending?.includes(check.id)) return false;
  return check.targetKey ? check.targetKey === structureTargetKey(doc, kind, check.id)
    : doc.structureReview?.graphKey === structureGraphKey(doc);
}

/** Sparse reply: only explicitly checked, non-conflicting targets can clear their old flags. */
export function applyScopedStructureReview(doc: ArgDoc, raw: unknown, plan: StructureReviewPlan, now = new Date().toISOString()): ArgDoc {
  if (plan.graphKey !== structureGraphKey(doc)) throw new Error('结构重评版本不匹配');
  if (!raw || typeof raw !== 'object') throw new Error('结构重评不是有效 JSON');
  const value = raw as Record<string, unknown>;
  const checked = value.checked as { nodes?: unknown; edges?: unknown } | undefined;
  if (!checked || !Array.isArray(checked.nodes) || !Array.isArray(checked.edges) || !Array.isArray(value.issues) || !Array.isArray(value.uncertain)) throw new Error('结构重评缺少必要字段');
  const warnings: string[] = [];
  const accepted = (values: unknown[], allowed: string[]) => new Set(allowed.filter(id => values.filter(v => v === id).length === 1));
  const nodeSet = accepted(checked.nodes, plan.targets.nodes), edgeSet = accepted(checked.edges, plan.targets.edges);
  if (checked.nodes.some(id => typeof id !== 'string' || !plan.targets.nodes.includes(id)) || checked.edges.some(id => typeof id !== 'string' || !plan.targets.edges.includes(id))) warnings.push('范围外编号已忽略。');
  const findings = new Map<string, StructureCheck>();
  const seen = new Set<string>();
  for (const [state, values] of [['issue', value.issues], ['uncertain', value.uncertain]] as const) for (const rawItem of values as unknown[]) {
    if (!rawItem || typeof rawItem !== 'object') { nodeSet.clear(); edgeSet.clear(); warnings.push('无法定位的异常条目：本次不清除旧问题。'); continue; }
    const item = rawItem as Record<string, unknown>;
    const kind = item.kind, id = item.id;
    if ((kind !== 'node' && kind !== 'edge') || typeof id !== 'string') { nodeSet.clear(); edgeSet.clear(); warnings.push('无法定位的异常条目：本次不清除旧问题。'); continue; }
    const set = kind === 'node' ? nodeSet : edgeSet;
    if (!(kind === 'node' ? plan.targets.nodes : plan.targets.edges).includes(id)) { warnings.push('范围外诊断已忽略。'); continue; }
    const key = `${kind}:${id}`;
    const valid = typeof item.reason === 'string' && Boolean(item.reason.trim()) && (state !== 'issue'
      || (['low', 'medium', 'high'].includes(String(item.severity)) && typeof item.suggestion === 'string' && Boolean(item.suggestion.trim())));
    if (seen.has(key) || !valid) { set.delete(id); findings.delete(key); warnings.push(`${id}的诊断重复或不完整，旧标记保留。`); }
    else findings.set(key, { id, state, reason: (item.reason as string).trim().slice(0, 600),
      ...(state === 'issue' ? { severity: item.severity as StructureCheck['severity'], suggestion: (item.suggestion as string).trim().slice(0, 600) } : {}) });
    seen.add(key);
  }
  const make = (kind: 'node' | 'edge', ids: Set<string>): StructureCheck[] => [...ids].map(id => ({
    ...(findings.get(`${kind}:${id}`) ?? { id, state: 'clear' as const, reason: '本次检查未发现内部结构问题。' }),
    targetKey: structureTargetKey(doc, kind, id),
  }));
  const newNodes = make('node', nodeSet), newEdges = make('edge', edgeSet);
  const merge = (old: StructureCheck[] | undefined, next: StructureCheck[], ids: string[]) => {
    const map = new Map((old ?? []).filter(c => ids.includes(c.id)).map(c => [c.id, c]));
    next.forEach(c => map.set(c.id, c)); return [...map.values()];
  };
  const pendingNodes = [...new Set([...plan.deferred.nodes, ...plan.targets.nodes.filter(id => !nodeSet.has(id))])];
  const pendingEdges = [...new Set([...plan.deferred.edges, ...plan.targets.edges.filter(id => !edgeSet.has(id))])];
  if (pendingNodes.length || pendingEdges.length) warnings.push('仍有目标未检查；不会自动重试或自动补链。');
  const byNode = new Map(newNodes.map(c => [c.id, c]));
  return { ...doc, updated_at: now, iteration: (doc.iteration || 0) + 1, structureReviewBase: captureStructureBaseline(doc),
    structureReview: { version: 1, graphKey: plan.graphKey, reviewedAt: now, mode: plan.mode,
      nodes: merge(doc.structureReview?.nodes, newNodes, doc.nodes.map(n => n.id)), edges: merge(doc.structureReview?.edges, newEdges, doc.edges.map(e => e.id)),
      checkedNodes: [...nodeSet], checkedEdges: [...edgeSet], pendingNodes, pendingEdges, warnings: [...new Set(warnings)] },
    nodes: doc.nodes.map(n => {
      const check = byNode.get(n.id);
      if (!check || check.state === 'uncertain') return n;
      return check.state === 'clear' ? { ...n, status: 'ok', issue: null, severity: null, suggestion: null }
        : { ...n, status: check.severity === 'high' ? 'error' : 'warning', issue: check.reason,
          severity: check.severity === 'high' ? 5 : check.severity === 'medium' ? 3 : 1, suggestion: check.suggestion ?? null };
    }),
  };
}

/** Only semantic edits invalidate a structure review; dragging and opening cards do not. */
export function structureGraphKey(doc: ArgDoc): string {
  const text = JSON.stringify({
    nodes: doc.nodes.map(n => [n.id, n.role ?? null, n.role ? null : n.mainType, n.text]),
    edges: doc.edges.map(e => [e.id, e.source, e.target, e.relation, e.reason ?? '']),
  });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `structure-v1-${text.length}-${(hash >>> 0).toString(16)}`;
}

export function buildStructureReviewInput(doc: ArgDoc) {
  return {
    docId: doc.doc_id, graphKey: structureGraphKey(doc),
    nodes: doc.nodes.map(n => ({ id: n.id, role: n.role ?? null,
      ...(!n.role ? { legacyType: n.mainType } : {}), text: n.text })),
    edges: doc.edges.map(e => ({ id: e.id, from: e.source, to: e.target, kind: e.relation, reason: e.reason ?? '' })),
  };
}

function checks(raw: unknown, ids: string[]): StructureCheck[] {
  if (!Array.isArray(raw) || raw.length !== ids.length) throw new Error('结构重评未覆盖所有对象');
  const remaining = new Set(ids);
  const result: StructureCheck[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') throw new Error('无效结构诊断');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !remaining.delete(item.id)) throw new Error('结构诊断 ID 重复或不存在');
    if (item.state !== 'clear' && item.state !== 'issue' && item.state !== 'uncertain') throw new Error('缺少明确复核状态');
    if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('缺少诊断依据');
    if (item.state === 'issue' && (item.severity !== 'low' && item.severity !== 'medium' && item.severity !== 'high')) throw new Error('缺少问题严重度');
    if (item.state === 'issue' && (typeof item.suggestion !== 'string' || !item.suggestion.trim())) throw new Error('缺少修复建议');
    result.push({ id: item.id, state: item.state, reason: item.reason.trim().slice(0, 600),
      ...(item.state === 'issue' ? { severity: item.severity as StructureCheck['severity'], suggestion: (item.suggestion as string).trim().slice(0, 600) } : {}) });
  }
  return result;
}

/** Validate the whole reply before applying anything. Missing checks cannot silently clear old flags. */
export function applyStructureReview(doc: ArgDoc, raw: unknown, now = new Date().toISOString()): ArgDoc {
  if (!raw || typeof raw !== 'object') throw new Error('结构重评不是有效 JSON');
  const value = raw as Record<string, unknown>;
  const graphKey = structureGraphKey(doc);
  if (value.docId !== doc.doc_id || value.graphKey !== graphKey) throw new Error('结构重评版本不匹配');
  const nodeChecks = checks(value.nodes, doc.nodes.map(n => n.id));
  const edgeChecks = checks(value.edges, doc.edges.map(e => e.id));
  const byNode = new Map(nodeChecks.map(n => [n.id, n]));
  return { ...doc, updated_at: now, iteration: (doc.iteration || 0) + 1,
    structureReviewBase: captureStructureBaseline(doc),
    structureReview: { version: 1, graphKey, reviewedAt: now, nodes: nodeChecks, edges: edgeChecks },
    nodes: doc.nodes.map(node => {
      const check = byNode.get(node.id)!;
      if (check.state === 'uncertain') return node; // Keep previous diagnosis, show uncertainty in the review panel.
      if (check.state === 'clear') return { ...node, status: 'ok', issue: null, severity: null, suggestion: null };
      const severity = check.severity === 'high' ? 5 : check.severity === 'medium' ? 3 : 1;
      return { ...node, status: check.severity === 'high' ? 'error' : 'warning', issue: check.reason, severity, suggestion: check.suggestion ?? null };
    }),
  };
}
