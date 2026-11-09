import type { ArgDoc } from '../services/argumentDoc/types';
import { ALL_ARGUMENT_ROLES, ALL_ARGUMENT_TYPES, RELATION_LABELS } from '../services/argumentDoc/types';

/** Local editor projection only. Never accept client-written scores, admission,
 * source verification, immutable extraction or foreign document coordinates. */
export function progressiveGraphDraft(value: ArgDoc, original: ArgDoc, at: string): ArgDoc {
  if (!value || value.doc_id !== original.doc_id || typeof value.title !== 'string' || value.title.length > 1000
    || !Array.isArray(value.nodes) || value.nodes.length > 500 || !Array.isArray(value.edges) || value.edges.length > 2000
    || JSON.stringify(value).length > 1000000) throw Error('论证图草稿无效或超过保存范围');
  const ids = new Set<string>();
  const nodes = value.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 200 || ids.has(node.id)
      || typeof node.text !== 'string' || node.text.length > 20000 || !node.text.trim()
      || !ALL_ARGUMENT_TYPES.includes(node.mainType) || node.role !== undefined && !ALL_ARGUMENT_ROLES.includes(node.role)
      || !node.position || ![node.position.x, node.position.y].every(n => Number.isFinite(n) && Math.abs(n) <= 10000000))
      throw Error('论证节点的内容、角色或坐标无效');
    ids.add(node.id);
    const before = original.nodes.find(item => item.id === node.id);
    return { ...node, position: { x: node.position.x, y: node.position.y },
      status: 'edited' as const, user_edited: true, collapsed: Boolean(node.collapsed),
      issue: before?.issue ?? null, severity: before?.severity ?? null, suggestion: before?.suggestion ?? null,
      // Evidence verification cannot be invented by the canvas save payload.
      sources: before?.sources };
  });
  const edgeIds = new Set<string>();
  const edges = value.edges.map(edge => {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edge.id.length > 200 || edgeIds.has(edge.id)
      || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target
      || !Object.hasOwn(RELATION_LABELS, edge.relation)
      || edge.reason !== undefined && (typeof edge.reason !== 'string' || edge.reason.length > 2000))
      throw Error('论证关系无效、重复或存在断开的端点');
    edgeIds.add(edge.id);
    return { id: edge.id, source: edge.source, target: edge.target, relation: edge.relation,
      ...(edge.reason === undefined ? {} : { reason: edge.reason }) };
  });
  return { ...original, title: value.title, nodes, edges, updated_at: at, status: 'draft' };
}

export function progressiveGraphContent(doc: ArgDoc) {
  return JSON.stringify([doc.title, doc.nodes, doc.edges]);
}
