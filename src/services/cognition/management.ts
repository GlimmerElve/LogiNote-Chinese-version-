import { latestCognition } from './core.ts';
import type { CognitionFile, CognitionStance, CognitionEdgeReference } from './types';
import type { CognitionReference } from './retrieval';
import type { ArgumentRole, ArgNode } from '../argumentDoc/types';

export type CognitionGraphFilter = 'all' | 'endorsed' | 'tentative' | 'isolated' | 'review';
export const COGNITION_GRAPH_FILTERS: Array<{ id: CognitionGraphFilter; label: string }> = [
  { id: 'all', label: '全部认知' }, { id: 'endorsed', label: '当前认同' }, { id: 'tentative', label: '暂定理解' },
  { id: 'isolated', label: '孤立节点' }, { id: 'review', label: '关系待复核' },
];
export interface ManagedCognitionNode extends CognitionReference {
  id: string; text: string; role?: ArgumentRole; mainType?: ArgNode['mainType']; stance: CognitionStance; needsReview: boolean;
  degree: number; at: string; title: string;
  conditions?: string[];
}
export interface ManagedCognitionEdge { id: string; source: string; target: string; relation: string; reason?: string; reference?: CognitionEdgeReference }
export interface ManagedCognitionGroup {
  id: string; title: string; recordId: string; branchId: string; at: string;
  nodes: ManagedCognitionNode[]; edges: ManagedCognitionEdge[];
}
export const cognitionNodeKey = (reference: Pick<CognitionReference, 'recordId' | 'branchId' | 'nodeId'>) => JSON.stringify([reference.recordId, reference.branchId, reference.nodeId]);

export const COGNITION_OVERVIEW_NODE_SIZE = { width: 236, height: 164 };

/** A stable, collision-free constellation, not a claim of semantic proximity.
 * Only positions are derived; node order, group membership and relations stay intact.
 * A bounded page (at most 80 groups) is packed once, without a live force simulation.
 */
export function cognitionOverviewPositions(groups: Array<{ id: string }>, viewport = { width: 960, height: 600 }) {
  const { width, height } = COGNITION_OVERVIEW_NODE_SIZE;
  const stepX = width + 44, stepY = height + 36;
  const ratio = Number.isFinite(viewport.width / viewport.height) && viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 1.6;
  const aspect = Math.max(.75, Math.min(1.7, ratio));
  const reach = Math.ceil(Math.sqrt(groups.length)) + 1;
  const slots: Array<{ x: number; y: number; radius: number }> = [];
  // Staggered rows form a compact oval cluster. Taking nearest slots avoids the
  // large holes and tiny text of an unconstrained spiral or a long column grid.
  for (let row = -reach; row <= reach; row++) for (let col = -reach; col <= reach; col++) {
    const x = (col + (Math.abs(row % 2) ? .5 : 0)) * stepX, y = row * stepY;
    slots.push({ x, y, radius: x * x / aspect + y * y * aspect });
  }
  slots.sort((a, b) => a.radius - b.radius || a.y - b.y || a.x - b.x);
  const points = slots.slice(0, groups.length);
  const centerX = points.length ? (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2 : 0;
  const centerY = points.length ? (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2 : 0;
  return new Map(groups.map((group, index) => [group.id, {
    x: Math.round(points[index].x - centerX - width / 2), y: Math.round(points[index].y - centerY - height / 2),
  }]));
}

/** A read-only topology of recorded understanding, not a semantic-completeness or mastery assessment. */
export function buildCognitionManagement(file: CognitionFile, options: { query?: string; filter?: CognitionGraphFilter } = {}) {
  const groups: ManagedCognitionGroup[] = [];
  const nodes = new Map<string, ManagedCognitionNode>(), edges: ManagedCognitionEdge[] = [];
  let endorsed = 0, tentative = 0, needsReview = 0, isolated = 0, brokenReferences = 0;
  for (const record of file.records) {
    if (record.withdrawn) continue;
    const revision = latestCognition(record);
    for (const branch of revision.branches) {
      for (const node of branch.graph.nodes) {
        const reference = { recordId: record.id, revisionId: revision.id, branchId: branch.id, nodeId: node.id };
        const stance = node.stance || branch.stance;
        const review = branch.reviewNeededNodeIds?.includes(node.id) || false;
        stance === 'endorsed' ? endorsed++ : tentative++; if (review) needsReview++;
        nodes.set(cognitionNodeKey(reference), { ...reference, id: cognitionNodeKey(reference), text: node.text, role: node.role,
          mainType: node.mainType, stance, needsReview: review, degree: 0, at: revision.at, title: branch.graph.title || '未命名理解', ...(node.conditions === undefined ? {} : { conditions: node.conditions }) });
      }
      for (const edge of branch.graph.edges) edges.push({ ...edge, id: JSON.stringify([record.id, branch.id, edge.id]),
        source: cognitionNodeKey({ recordId: record.id, branchId: branch.id, nodeId: edge.source }), target: cognitionNodeKey({ recordId: record.id, branchId: branch.id, nodeId: edge.target }),
        reference: { recordId: record.id, revisionId: revision.id, branchId: branch.id, edgeId: edge.id } });
    }
  }
  for (const link of file.links || []) edges.push({ ...link, id: `link:${link.id}`, source: cognitionNodeKey(link.source), target: cognitionNodeKey(link.target), reference: { linkId: link.id } });
  const adjacency = new Map([...nodes.keys()].map(id => [id, new Set<string>()]));
  const validEdges = edges.filter(edge => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) { brokenReferences++; return false; }
    if (edge.source !== edge.target) { adjacency.get(edge.source)!.add(edge.target); adjacency.get(edge.target)!.add(edge.source); }
    return true;
  });
  for (const node of nodes.values()) { node.degree = adjacency.get(node.id)!.size; if (!node.degree) isolated++; }
  const visited = new Set<string>();
  for (const first of nodes.keys()) {
    if (visited.has(first)) continue;
    const component = [first]; visited.add(first);
    for (let i = 0; i < component.length; i++) for (const next of adjacency.get(component[i])!) if (!visited.has(next)) { visited.add(next); component.push(next); }
    const ids = new Set(component), members = component.map(id => nodes.get(id)!), origin = members[0];
    const crossActivity = new Set(members.map(node => node.recordId)).size > 1;
    groups.push({ id: first, title: `${crossActivity ? '跨活动 · ' : ''}${origin.title}`, recordId: origin.recordId, branchId: origin.branchId, at: members.map(node => node.at).sort().at(-1)!, nodes: members,
      edges: validEdges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) });
  }
  const query = (options.query || '').trim().toLocaleLowerCase(), filter = options.filter || 'all';
  const matches = (node: ManagedCognitionNode) => filter === 'all' || (filter === 'endorsed' && node.stance === 'endorsed')
    || (filter === 'tentative' && node.stance === 'tentative') || (filter === 'isolated' && node.degree === 0) || (filter === 'review' && node.needsReview);
  const visible = groups.filter(group => group.nodes.some(matches) && (!query || group.title.toLocaleLowerCase().includes(query)
    || group.nodes.some(node => node.text.toLocaleLowerCase().includes(query))));
  return { revision: file.revision, groups: visible, brokenEdges: edges.filter(edge => !nodes.has(edge.source) || !nodes.has(edge.target)),
    summary: { records: file.records.filter(record => !record.withdrawn).length, nodes: endorsed + tentative, edges: validEdges.length,
      endorsed, tentative, isolated, needsReview, connectedGroups: groups.filter(group => group.nodes.length > 1).length,
      brokenReferences, matchedGroups: visible.length,
      interpretation: '连通不代表逻辑完整；孤立不代表错误；认同不等于客观正确或已掌握。' } };
}

/** Deterministic, cycle-safe layout. Disconnected components are never linked for visual convenience. */
export function cognitionGraphPositions(nodes: Array<{ id: string }>, edges: ManagedCognitionEdge[]) {
  const placed = new Map<string, { x: number; y: number }>();
  const degree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) if (degree.has(edge.source) && degree.has(edge.target) && edge.source !== edge.target) {
    degree.set(edge.target, degree.get(edge.target)! + 1); outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodes.filter(node => !degree.get(node.id)).map(node => ({ id: node.id, level: 0 }));
  const rows = new Map<number, number>();
  for (let i = 0; i < queue.length; i++) {
    const { id, level } = queue[i]; if (placed.has(id)) continue;
    const row = rows.get(level) || 0; rows.set(level, row + 1); placed.set(id, { x: level * 320, y: row * 160 });
    for (const next of outgoing.get(id)!) { degree.set(next, degree.get(next)! - 1); if (!degree.get(next)) queue.push({ id: next, level: level + 1 }); }
  }
  let remaining = 0;
  for (const node of nodes) if (!placed.has(node.id)) { const i = remaining++; placed.set(node.id, { x: i % 4 * 320, y: ((Math.max(0, ...rows.values())) + Math.floor(i / 4)) * 160 }); }
  return placed;
}
