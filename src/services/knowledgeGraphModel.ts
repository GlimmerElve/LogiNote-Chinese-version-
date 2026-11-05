import type { NoteItem } from '../types';
import { resolveNoteByTitleOrAlias } from './noteResolver';
import { readKnowledgeMastery, knowledgeMasteryCaption, masteryReadMode, summarizeKnowledgeMastery,
  type KnowledgeMasteryBand, type KnowledgeMasteryView } from './masteryReadModel';

export type KnowledgeGraphMode = 'knowledge' | 'overview' | 'path';
export type GraphDensity = 'sparse' | 'balanced' | 'dense';
export type MasteryBand = 'unrated' | 'weak' | 'developing' | 'solid' | 'mastered' | KnowledgeMasteryBand;
export type GraphVisualKind = 'knowledge' | 'project' | 'aggregate' | 'region' | 'more';
export type GraphRelationKind = 'wiki' | 'hierarchy' | 'membership' | 'co_project' | 'path';

export interface GraphVisualNode {
  id: string;
  noteId?: string;
  scopeProjectId?: string;
  aggregateKey?: 'orphan';
  communityId?: string;
  kind: GraphVisualKind;
  title: string;
  displayTitle: string;
  subtitle?: string;
  mastery?: number;
  masteryBand: MasteryBand;
  masteryView?: KnowledgeMasteryView;
  count?: number;
  width?: number;
  height?: number;
  tone?: number;
  memberNoteIds?: string[];
  x: number;
  y: number;
}

export interface GraphVisualEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphRelationKind;
  label?: string;
  directed?: boolean;
}

export interface GraphBreadcrumb {
  id: string;
  label: string;
  scopeProjectId?: string;
  communityId?: string;
  reset?: boolean;
}

export interface GraphSlice {
  nodes: GraphVisualNode[];
  edges: GraphVisualEdge[];
  breadcrumbs: GraphBreadcrumb[];
  hiddenCount: number;
  aggregatedCount?: number;
  title: string;
  subtitle: string;
}

export interface KnowledgeCommunity {
  id: string;
  title: string;
  notes: NoteItem[];
  mastery?: number;
  explicitEdgeCount: number;
  isLoose: boolean;
}

export interface ProjectGraphMetrics {
  projectCount: number;
  knowledgeCount: number;
  taskCount: number;
  completedTaskCount: number;
  completion: number;
  averageMastery?: number;
  masterySummary?: ReturnType<typeof summarizeKnowledgeMastery>;
  weakCount: number;
  unratedCount: number;
  nearestDueDate?: string;
}

export interface KnowledgeGraphStats {
  knowledgeCount: number;
  explicitEdgeCount: number;
  rootProjectCount: number;
  clusterCount: number;
}

const DENSITY_LIMITS: Record<GraphDensity, { branch: number; direct: number; context: number; checkpoints: number }> = {
  sparse: { branch: 12, direct: 6, context: 3, checkpoints: 1 },
  balanced: { branch: 20, direct: 9, context: 5, checkpoints: 2 },
  dense: { branch: 32, direct: 12, context: 7, checkpoints: 3 },
};

const uniqueById = (notes: NoteItem[]): NoteItem[] => {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
};

const safeMastery = (note: NoteItem): number | undefined => {
  if (masteryReadMode() === 'current') return undefined;
  const value = note.dsrState?.conceptMastery;
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Number(value))) : undefined;
};

export function getNoteMasteryBand(note: NoteItem): MasteryBand {
  return masteryReadMode() === 'current' ? readKnowledgeMastery(note).band : getMasteryBand(safeMastery(note));
}

export function getMasteryBand(value?: number): MasteryBand {
  if (value == null) return 'unrated';
  if (value < 40) return 'weak';
  if (value < 70) return 'developing';
  if (value < 85) return 'solid';
  return 'mastered';
}

export function getMasteryLabel(value?: number): string {
  switch (getMasteryBand(value)) {
    case 'weak': return '待加强';
    case 'developing': return '学习中';
    case 'solid': return '基本掌握';
    case 'mastered': return '稳固掌握';
    default: return '未评估';
  }
}

export function shortGraphTitle(title: string, kind: 'project' | 'knowledge' = 'knowledge'): string {
  const normalized = (title || '未命名').trim().replace(/\s+/g, ' ');
  const head = kind === 'project' ? normalized.split(/[：:]/)[0].trim() : normalized;
  const withoutAction = kind === 'project'
    ? head.replace(/^(?:全面)?(?:学习|理解|掌握|熟悉|探索|研究|认识|完成|梳理|建立)/, '').trim()
    : head;
  const candidate = withoutAction || head || normalized;
  const limit = kind === 'project' ? 14 : 12;
  return candidate.length > limit ? `${candidate.slice(0, limit - 1)}…` : candidate;
}

export function getRootProjects(notes: NoteItem[]): NoteItem[] {
  const projects = notes.filter((note) => note.noteType === 'project');
  const ids = new Set(projects.map((note) => note.id));
  return projects.filter((note) => !note.parentId || !ids.has(note.parentId));
}

export function getChildProjects(projectId: string, notes: NoteItem[]): NoteItem[] {
  return notes.filter((note) => note.noteType === 'project' && note.parentId === projectId);
}

export function getProjectAncestors(projectId: string, notes: NoteItem[]): NoteItem[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const result: NoteItem[] = [];
  const seen = new Set<string>();
  let current = byId.get(projectId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

export function getProjectSubtree(projectId: string, notes: NoteItem[]): NoteItem[] {
  const result: NoteItem[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const project = notes.find((note) => note.id === id && note.noteType === 'project');
    if (!project) return;
    result.push(project);
    getChildProjects(id, notes).forEach((child) => walk(child.id));
  };
  walk(projectId);
  return result;
}

function knowledgeNotes(notes: NoteItem[]): NoteItem[] {
  return notes.filter((note) => note.noteType === 'knowledge');
}

function resolveKnowledgeTitles(titles: string[], notes: NoteItem[]): NoteItem[] {
  const knowledge = knowledgeNotes(notes);
  return uniqueById(titles
    .map((title) => resolveNoteByTitleOrAlias(title, knowledge))
    .filter((note): note is NoteItem => Boolean(note)));
}

export function getDirectProjectKnowledge(projectId: string, notes: NoteItem[]): NoteItem[] {
  const project = notes.find((note) => note.id === projectId && note.noteType === 'project');
  if (!project) return [];
  const linked = resolveKnowledgeTitles(project.links || [], notes);
  const legacy = notes.filter((note) => note.noteType === 'knowledge' && note.parentId === projectId);
  return uniqueById([...linked, ...legacy]);
}

export function getScopeKnowledge(projectId: string, notes: NoteItem[]): NoteItem[] {
  return uniqueById(getProjectSubtree(projectId, notes)
    .flatMap((project) => getDirectProjectKnowledge(project.id, notes)));
}

export function getKnowledgeProjectContexts(knowledgeId: string, notes: NoteItem[]): NoteItem[] {
  return notes.filter((note) => note.noteType === 'project' && getDirectProjectKnowledge(note.id, notes).some((item) => item.id === knowledgeId));
}

export function getExplicitKnowledgeNeighbors(knowledgeId: string, notes: NoteItem[]): NoteItem[] {
  const knowledge = knowledgeNotes(notes);
  const selected = knowledge.find((note) => note.id === knowledgeId);
  if (!selected) return [];
  const outgoing = resolveKnowledgeTitles(selected.links || [], notes);
  const incoming = knowledge.filter((candidate) => resolveKnowledgeTitles(candidate.links || [], notes).some((target) => target.id === selected.id));
  return uniqueById([...outgoing, ...incoming]).filter((note) => note.id !== knowledgeId);
}

function explicitDegree(note: NoteItem, notes: NoteItem[]): number {
  return getExplicitKnowledgeNeighbors(note.id, notes).length;
}

export function getProjectMetrics(projectId: string, notes: NoteItem[]): ProjectGraphMetrics {
  const projects = getProjectSubtree(projectId, notes);
  const knowledge = getScopeKnowledge(projectId, notes);
  const tasks = projects.flatMap((project) => project.dueDates || []);
  const completed = tasks.filter((task) => task.completed).length;
  const assessed = knowledge.map(safeMastery).filter((value): value is number => value != null);
  const masterySummary = masteryReadMode() === 'current' ? summarizeKnowledgeMastery(knowledge) : undefined;
  const pendingDates = tasks.filter((task) => !task.completed && task.dueDate).map((task) => task.dueDate).sort();
  return {
    projectCount: projects.length,
    knowledgeCount: knowledge.length,
    taskCount: tasks.length,
    completedTaskCount: completed,
    completion: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0,
    averageMastery: assessed.length > 0 ? Math.round(assessed.reduce((sum, value) => sum + value, 0) / assessed.length) : undefined,
    masterySummary,
    weakCount: masterySummary ? masterySummary.assessment.needsReview : assessed.filter((value) => value < 40).length,
    unratedCount: masterySummary ? masterySummary.assessment.unassessed : knowledge.length - assessed.length,
    nearestDueDate: pendingDates[0],
  };
}

export function getKnowledgeGraphStats(notes: NoteItem[]): KnowledgeGraphStats {
  const knowledge = knowledgeNotes(notes);
  const keys = new Set<string>();
  knowledge.forEach((source) => {
    resolveKnowledgeTitles(source.links || [], notes).forEach((target) => {
      if (source.id === target.id) return;
      const pair = [source.id, target.id].sort().join('|');
      keys.add(pair);
    });
  });
  const roots = getRootProjects(notes);
  const assigned = new Set(notes.filter((note) => note.noteType === 'project').flatMap((project) => getDirectProjectKnowledge(project.id, notes).map((item) => item.id)));
  return {
    knowledgeCount: knowledge.length,
    explicitEdgeCount: keys.size,
    rootProjectCount: roots.length,
    clusterCount: roots.length + (knowledge.some((note) => !assigned.has(note.id)) ? 1 : 0),
  };
}

function projectNode(project: NoteItem, notes: NoteItem[], x: number, y: number, kind: GraphVisualKind = 'project'): GraphVisualNode {
  const metrics = getProjectMetrics(project.id, notes);
  return {
    id: `${kind}:${project.id}`,
    noteId: project.id,
    scopeProjectId: project.id,
    kind,
    title: project.title,
    displayTitle: shortGraphTitle(project.title, 'project'),
    subtitle: metrics.masterySummary ? `${metrics.knowledgeCount} 个知识点 · 已确认 ${metrics.masterySummary.confirmedCount}`
      : `${metrics.knowledgeCount} 个知识点${metrics.averageMastery == null ? '' : ` · 历史平均 ${metrics.averageMastery}%`}`,
    mastery: metrics.averageMastery,
    masteryBand: getMasteryBand(metrics.averageMastery),
    count: metrics.knowledgeCount,
    x,
    y,
  };
}

function knowledgeDomainNode(project: NoteItem, notes: NoteItem[], x: number, y: number): GraphVisualNode {
  const metrics = getProjectMetrics(project.id, notes);
  return {
    id: `domain:${project.id}`,
    scopeProjectId: project.id,
    kind: 'aggregate',
    title: project.title,
    displayTitle: shortGraphTitle(project.title, 'project'),
    subtitle: `${metrics.knowledgeCount} 个知识点 · 聚合知识簇`,
    mastery: metrics.averageMastery,
    masteryBand: getMasteryBand(metrics.averageMastery),
    count: metrics.knowledgeCount,
    x,
    y,
  };
}

function knowledgeNode(note: NoteItem, x: number, y: number): GraphVisualNode {
  const mastery = safeMastery(note);
  const masteryView = masteryReadMode() === 'current' ? readKnowledgeMastery(note) : undefined;
  return {
    id: `knowledge:${note.id}`,
    noteId: note.id,
    kind: 'knowledge',
    title: note.title,
    displayTitle: shortGraphTitle(note.title),
    subtitle: knowledgeMasteryCaption(note),
    mastery,
    masteryView,
    masteryBand: getNoteMasteryBand(note),
    x,
    y,
  };
}

type CommunityPairWeight = { weight: number; explicit: number };

function graphPairKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`;
}

function stableGraphHash(values: string[]): string {
  let hash = 2166136261;
  values.slice().sort().forEach((value) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  });
  return (hash >>> 0).toString(36);
}

function averageKnowledgeMastery(items: NoteItem[]): number | undefined {
  const assessed = items.map(safeMastery).filter((value): value is number => value != null);
  if (assessed.length === 0) return undefined;
  return Math.round(assessed.reduce((sum, value) => sum + value, 0) / assessed.length);
}

function buildCommunityPairWeights(scopeKnowledge: NoteItem[], scopeProjects: NoteItem[], notes: NoteItem[]): Map<string, CommunityPairWeight> {
  const scopeIds = new Set(scopeKnowledge.map((note) => note.id));
  const weights = new Map<string, CommunityPairWeight>();
  const add = (leftId: string, rightId: string, weight: number, explicit = 0) => {
    if (leftId === rightId || !scopeIds.has(leftId) || !scopeIds.has(rightId)) return;
    const key = graphPairKey(leftId, rightId);
    const current = weights.get(key) || { weight: 0, explicit: 0 };
    weights.set(key, { weight: current.weight + weight, explicit: current.explicit + explicit });
  };

  const explicitSeen = new Set<string>();
  scopeKnowledge.forEach((source) => {
    resolveKnowledgeTitles(source.links || [], notes).forEach((target) => {
      if (!scopeIds.has(target.id)) return;
      const key = graphPairKey(source.id, target.id);
      if (explicitSeen.has(key)) return;
      explicitSeen.add(key);
      add(source.id, target.id, 4, 1);
    });
  });

  scopeProjects.forEach((project) => {
    const members = getDirectProjectKnowledge(project.id, notes).filter((note) => scopeIds.has(note.id));
    if (members.length < 2) return;
    const weakWeight = 0.85 / Math.max(1, Math.log2(members.length + 1));
    if (members.length <= 24) {
      for (let left = 0; left < members.length; left += 1) {
        for (let right = left + 1; right < members.length; right += 1) add(members[left].id, members[right].id, weakWeight);
      }
      return;
    }
    const hubs = [...members].sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes)).slice(0, 4);
    members.forEach((member) => hubs.forEach((hub) => add(member.id, hub.id, weakWeight * 0.72)));
  });
  return weights;
}

/**
 * 将一个根目录范围内的全部知识点划分为稳定的二级知识社区。
 * 显式知识链接权重最高；项目共现只用于补充弱连接。没有关系的知识点仍会进入“待建立关联”社区。
 */
export function buildKnowledgeCommunities(scopeKnowledge: NoteItem[], scopeProjects: NoteItem[], notes: NoteItem[]): KnowledgeCommunity[] {
  if (scopeKnowledge.length === 0) return [];
  const ordered = [...scopeKnowledge].sort((a, b) => a.id.localeCompare(b.id));
  const pairWeights = buildCommunityPairWeights(ordered, scopeProjects, notes);
  const targetCount = Math.max(2, Math.min(9, Math.ceil(ordered.length / 14)));
  const maxCommunitySize = Math.max(18, Math.ceil(ordered.length / 9));
  let working = ordered.map((note) => ({ notes: [note], isLoose: false }));

  while (working.length > targetCount) {
    const membership = new Map<string, number>();
    working.forEach((community, index) => community.notes.forEach((note) => membership.set(note.id, index)));
    const scores = new Map<string, CommunityPairWeight>();
    pairWeights.forEach((value, key) => {
      const [leftId, rightId] = key.split('|');
      const left = membership.get(leftId);
      const right = membership.get(rightId);
      if (left == null || right == null || left === right) return;
      const pair = left < right ? `${left}|${right}` : `${right}|${left}`;
      const current = scores.get(pair) || { weight: 0, explicit: 0 };
      scores.set(pair, { weight: current.weight + value.weight, explicit: current.explicit + value.explicit });
    });

    const candidates = [...scores.entries()]
      .map(([key, value]) => {
        const [left, right] = key.split('|').map(Number);
        const combinedSize = working[left].notes.length + working[right].notes.length;
        const normalized = value.weight / Math.sqrt(working[left].notes.length * working[right].notes.length);
        return { left, right, combinedSize, score: normalized + value.explicit * 0.018 };
      })
      .filter((candidate) => candidate.combinedSize <= maxCommunitySize)
      .sort((a, b) => b.score - a.score || a.combinedSize - b.combinedSize || a.left - b.left || a.right - b.right);

    let selected = candidates[0];
    let looseMerge = false;
    if (!selected) {
      const bySize = working
        .map((community, index) => ({ index, size: community.notes.length }))
        .sort((a, b) => a.size - b.size || a.index - b.index);
      outer: for (let left = 0; left < bySize.length; left += 1) {
        for (let right = left + 1; right < bySize.length; right += 1) {
          if (bySize[left].size + bySize[right].size <= maxCommunitySize) {
            selected = { left: bySize[left].index, right: bySize[right].index, combinedSize: bySize[left].size + bySize[right].size, score: 0 };
            looseMerge = true;
            break outer;
          }
        }
      }
    }
    if (!selected) break;

    const left = Math.min(selected.left, selected.right);
    const right = Math.max(selected.left, selected.right);
    const merged = {
      notes: [...working[left].notes, ...working[right].notes].sort((a, b) => a.id.localeCompare(b.id)),
      isLoose: looseMerge || working[left].isLoose || working[right].isLoose,
    };
    working = working.filter((_community, index) => index !== left && index !== right);
    working.push(merged);
  }

  const communities = working.map((community): KnowledgeCommunity => {
    const memberIds = new Set(community.notes.map((note) => note.id));
    let explicitEdgeCount = 0;
    pairWeights.forEach((value, key) => {
      if (value.explicit <= 0) return;
      const [leftId, rightId] = key.split('|');
      if (memberIds.has(leftId) && memberIds.has(rightId)) explicitEdgeCount += value.explicit;
    });
    const ranked = [...community.notes].sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes) || a.title.localeCompare(b.title));
    const anchors = ranked.slice(0, 2).map((note) => shortGraphTitle(note.title));
    const title = community.isLoose && explicitEdgeCount === 0
      ? `待建立关联 · ${anchors[0]}`
      : anchors.join(' · ');
    return {
      id: `community-${stableGraphHash(community.notes.map((note) => note.id))}`,
      title,
      notes: ranked,
      mastery: averageKnowledgeMastery(community.notes),
      explicitEdgeCount,
      isLoose: community.isLoose,
    };
  });
  return communities.sort((a, b) => b.notes.length - a.notes.length || b.explicitEdgeCount - a.explicitEdgeCount || a.title.localeCompare(b.title));
}

function knowledgeCommunityNode(community: KnowledgeCommunity, x: number, y: number, tone: number): GraphVisualNode {
  return {
    id: `community:${community.id}`,
    communityId: community.id,
    kind: 'aggregate',
    title: community.title,
    displayTitle: shortGraphTitle(community.title),
    subtitle: `${community.notes.length} 个知识点 · ${community.explicitEdgeCount} 条直接关联`,
    mastery: community.mastery,
    masteryBand: getMasteryBand(community.mastery),
    count: community.notes.length,
    tone,
    memberNoteIds: community.notes.map((note) => note.id),
    x,
    y,
  };
}

function knowledgeCommunityEdges(communities: KnowledgeCommunity[], notes: NoteItem[]): GraphVisualEdge[] {
  const membership = new Map<string, KnowledgeCommunity>();
  communities.forEach((community) => community.notes.forEach((note) => membership.set(note.id, community)));
  const crossCounts = new Map<string, { source: string; target: string; count: number }>();
  const seen = new Set<string>();
  communities.flatMap((community) => community.notes).forEach((source) => {
    resolveKnowledgeTitles(source.links || [], notes).forEach((target) => {
      const sourceCommunity = membership.get(source.id);
      const targetCommunity = membership.get(target.id);
      if (!sourceCommunity || !targetCommunity || sourceCommunity.id === targetCommunity.id) return;
      const notePair = graphPairKey(source.id, target.id);
      if (seen.has(notePair)) return;
      seen.add(notePair);
      const pair = graphPairKey(sourceCommunity.id, targetCommunity.id);
      const current = crossCounts.get(pair) || { source: sourceCommunity.id, target: targetCommunity.id, count: 0 };
      current.count += 1;
      crossCounts.set(pair, current);
    });
  });
  return [...crossCounts.values()]
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, Math.max(0, communities.length + 2))
    .map((item, index) => edge(
      `community-link:${item.source}:${item.target}`,
      `community:${item.source}`,
      `community:${item.target}`,
      'wiki',
      index < 3 ? `${item.count} 条关联` : undefined,
    ));
}

function layoutKnowledgeCommunityOverview(communities: KnowledgeCommunity[], notes: NoteItem[]): { nodes: GraphVisualNode[]; edges: GraphVisualEdge[] } {
  const edges = knowledgeCommunityEdges(communities, notes);
  const degree = new Map<string, number>();
  edges.forEach((item) => {
    degree.set(item.source, (degree.get(item.source) || 0) + 1);
    degree.set(item.target, (degree.get(item.target) || 0) + 1);
  });
  const ranked = [...communities].sort((a, b) => {
    const degreeDifference = (degree.get(`community:${b.id}`) || 0) - (degree.get(`community:${a.id}`) || 0);
    return degreeDifference || b.explicitEdgeCount - a.explicitEdgeCount || b.notes.length - a.notes.length || a.title.localeCompare(b.title);
  });
  if (ranked.length === 0) return { nodes: [], edges };
  if (ranked.length === 1) return { nodes: [knowledgeCommunityNode(ranked[0], 0, 0, 0)], edges };
  const ring = collisionSafeRingPositions(ranked.length - 1, {
    firstRadius: Math.max(330, (ranked.length - 1) * 42),
    ringGap: 240,
    minArc: 235,
    start: -Math.PI / 2,
  });
  return {
    nodes: [
      knowledgeCommunityNode(ranked[0], 0, 0, 0),
      ...ranked.slice(1).map((community, index) => knowledgeCommunityNode(community, ring.positions[index].x, ring.positions[index].y, (index + 1) % 3)),
    ],
    edges,
  };
}

function ringPositions(count: number, radius: number, centerX = 0, centerY = 0, start = -Math.PI / 2): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  if (count === 1) return [{ x: centerX, y: centerY + radius }];
  return Array.from({ length: count }, (_, index) => {
    const angle = start + (index / count) * Math.PI * 2;
    return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
  });
}

function collisionSafeRingPositions(
  count: number,
  options: { centerX?: number; centerY?: number; firstRadius?: number; ringGap?: number; minArc?: number; start?: number } = {},
): { positions: Array<{ x: number; y: number }>; outerRadius: number } {
  const centerX = options.centerX ?? 0;
  const centerY = options.centerY ?? 0;
  const firstRadius = options.firstRadius ?? 290;
  const ringGap = options.ringGap ?? 205;
  const minArc = options.minArc ?? 180;
  const start = options.start ?? -Math.PI / 2;
  const positions: Array<{ x: number; y: number }> = [];
  let remaining = count;
  let ringIndex = 0;
  while (remaining > 0) {
    const radius = firstRadius + ringIndex * ringGap;
    const capacity = Math.max(6, Math.floor((Math.PI * 2 * radius) / minArc));
    const take = Math.min(remaining, capacity);
    const stagger = ringIndex % 2 === 0 ? 0 : Math.PI / Math.max(1, take);
    positions.push(...ringPositions(take, radius, centerX, centerY, start + stagger));
    remaining -= take;
    ringIndex += 1;
  }
  return { positions, outerRadius: count > 0 ? firstRadius + (ringIndex - 1) * ringGap : 0 };
}

function projectRegionNodes(displayed: NoteItem[], nodes: GraphVisualNode[], projects: NoteItem[], notes: NoteItem[]): GraphVisualNode[] {
  const displayedIds = new Set(displayed.map((note) => note.id));
  const nodeByNoteId = new Map(nodes.filter((node) => node.noteId).map((node) => [node.noteId!, node]));
  const membershipCount = new Map<string, number>();
  projects.forEach((project) => {
    getDirectProjectKnowledge(project.id, notes).forEach((note) => {
      if (displayedIds.has(note.id)) membershipCount.set(note.id, (membershipCount.get(note.id) || 0) + 1);
    });
  });
  const deduped = new Map<string, { project: NoteItem; members: NoteItem[] }>();
  projects.forEach((project) => {
    const members = getDirectProjectKnowledge(project.id, notes)
      .filter((note) => displayedIds.has(note.id) && membershipCount.get(note.id) === 1);
    if (members.length < 2) return;
    const key = members.map((note) => note.id).sort().join('|');
    const existing = deduped.get(key);
    if (!existing || getProjectAncestors(project.id, notes).length > getProjectAncestors(existing.project.id, notes).length) {
      deduped.set(key, { project, members });
    }
  });
  return [...deduped.values()]
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 5)
    .map(({ project, members }, index) => {
      const memberNodes = members.map((note) => nodeByNoteId.get(note.id)).filter((node): node is GraphVisualNode => Boolean(node));
      const minX = Math.min(...memberNodes.map((node) => node.x));
      const maxX = Math.max(...memberNodes.map((node) => node.x));
      const minY = Math.min(...memberNodes.map((node) => node.y));
      const maxY = Math.max(...memberNodes.map((node) => node.y));
      const paddingX = 52;
      const paddingY = 58;
      return {
        id: `region:${project.id}`,
        kind: 'region' as const,
        title: project.title,
        displayTitle: shortGraphTitle(project.title, 'project'),
        subtitle: `${members.length} 个知识点共同出现`,
        masteryBand: 'unrated' as const,
        count: members.length,
        tone: index % 3,
        memberNoteIds: members.map((note) => note.id),
        x: minX - paddingX,
        y: minY - paddingY,
        width: Math.max(300, maxX - minX + 154 + paddingX * 2),
        height: Math.max(220, maxY - minY + 116 + paddingY * 2),
      };
    });
}

function clusteredKnowledgeNodes(displayed: NoteItem[], projects: NoteItem[], notes: NoteItem[]): GraphVisualNode[] {
  if (displayed.length === 0) return [];
  const displayedIds = new Set(displayed.map((note) => note.id));
  const memberships = new Map<string, NoteItem[]>();
  projects.forEach((project) => {
    getDirectProjectKnowledge(project.id, notes).forEach((note) => {
      if (!displayedIds.has(note.id)) return;
      const current = memberships.get(note.id) || [];
      if (!current.some((item) => item.id === project.id)) current.push(project);
      memberships.set(note.id, current);
    });
  });
  const shared = displayed
    .filter((note) => (memberships.get(note.id)?.length || 0) !== 1)
    .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes));
  const grouped = new Map<string, { project: NoteItem; notes: NoteItem[] }>();
  displayed.forEach((note) => {
    const memberProjects = memberships.get(note.id) || [];
    if (memberProjects.length !== 1) return;
    const project = memberProjects[0];
    const entry = grouped.get(project.id) || { project, notes: [] };
    entry.notes.push(note);
    grouped.set(project.id, entry);
  });
  const groups = [...grouped.values()].sort((a, b) => b.notes.length - a.notes.length);
  const compactCenters: Array<{ x: number; y: number }> = groups.length === 1
    ? [{ x: 380, y: 0 }]
    : groups.length === 2
      ? [{ x: -390, y: 30 }, { x: 390, y: 30 }]
      : groups.length === 3
        ? [{ x: -390, y: -235 }, { x: 390, y: -235 }, { x: 0, y: 355 }]
        : groups.length === 4
          ? [{ x: -390, y: -260 }, { x: 390, y: -260 }, { x: -390, y: 300 }, { x: 390, y: 300 }]
          : ringPositions(groups.length, 560, 0, 20, -Math.PI / 2);
  const nodes: GraphVisualNode[] = [];
  if (shared.length > 0) {
    nodes.push(knowledgeNode(shared[0], 0, 0));
    const sharedLayout = collisionSafeRingPositions(shared.length - 1, { firstRadius: 145, ringGap: 175, minArc: 165 });
    shared.slice(1).forEach((note, index) => nodes.push(knowledgeNode(note, sharedLayout.positions[index].x, sharedLayout.positions[index].y)));
  }
  groups.forEach((group, groupIndex) => {
    const center = compactCenters[groupIndex];
    const columns = group.notes.length <= 2 ? 1 : 2;
    const rows = Math.ceil(group.notes.length / columns);
    group.notes.forEach((note, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = center.x + (column - (columns - 1) / 2) * 170;
      const y = center.y + (row - (rows - 1) / 2) * 138;
      nodes.push(knowledgeNode(note, x, y));
    });
  });
  return nodes;
}

function radialCommunityKnowledgeNodes(displayed: NoteItem[], notes: NoteItem[]): GraphVisualNode[] {
  if (displayed.length === 0) return [];
  const ranked = [...displayed].sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes) || a.title.localeCompare(b.title));
  if (ranked.length === 1) return [knowledgeNode(ranked[0], 0, 0)];
  const displayedIds = new Set(ranked.map((note) => note.id));
  const adjacency = new Map(ranked.map((note) => [note.id, getExplicitKnowledgeNeighbors(note.id, notes)
    .filter((neighbor) => displayedIds.has(neighbor.id))
    .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes) || a.title.localeCompare(b.title))]));
  const visited = new Set<string>([ranked[0].id]);
  const orderedOuter: NoteItem[] = [];
  const walk = (note: NoteItem) => {
    if (visited.has(note.id)) return;
    visited.add(note.id);
    orderedOuter.push(note);
    (adjacency.get(note.id) || []).forEach(walk);
  };
  (adjacency.get(ranked[0].id) || []).forEach(walk);
  ranked.slice(1).forEach(walk);
  const outer = collisionSafeRingPositions(orderedOuter.length, {
    firstRadius: Math.min(390, Math.max(280, orderedOuter.length * 30)),
    ringGap: 225,
    minArc: 175,
    start: -Math.PI / 2 + 0.12,
  });
  return [
    knowledgeNode(ranked[0], 0, 0),
    ...orderedOuter.map((note, index) => knowledgeNode(note, outer.positions[index].x, outer.positions[index].y)),
  ];
}

function gridPositions(count: number, columnWidth = 240, rowHeight = 190, columns = 3): Array<{ x: number; y: number }> {
  const actualColumns = Math.max(1, Math.min(columns, count));
  return Array.from({ length: count }, (_, index) => ({
    x: (index % actualColumns) * columnWidth,
    y: Math.floor(index / actualColumns) * rowHeight,
  }));
}

function edge(id: string, source: string, target: string, kind: GraphRelationKind, label?: string, directed = false): GraphVisualEdge {
  return { id, source, target, kind, label, directed };
}

function wikiEdges(displayed: NoteItem[], notes: NoteItem[]): GraphVisualEdge[] {
  const displayedIds = new Set(displayed.map((note) => note.id));
  const seen = new Set<string>();
  const edges: GraphVisualEdge[] = [];
  displayed.forEach((source) => {
    resolveKnowledgeTitles(source.links || [], notes).forEach((target) => {
      if (!displayedIds.has(target.id) || source.id === target.id) return;
      const key = [source.id, target.id].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(edge(`wiki:${key}`, `knowledge:${source.id}`, `knowledge:${target.id}`, 'wiki', undefined, true));
    });
  });
  return edges;
}

function sparseWikiEdges(displayed: NoteItem[], notes: NoteItem[], extraEdges = 2, preferredHubId?: string): GraphVisualEdge[] {
  const all = wikiEdges(displayed, notes);
  if (all.length <= Math.max(0, displayed.length - 1) + extraEdges) return all;
  const byNode = new Map<string, GraphVisualEdge[]>();
  all.forEach((item) => {
    byNode.set(item.source, [...(byNode.get(item.source) || []), item]);
    byNode.set(item.target, [...(byNode.get(item.target) || []), item]);
  });
  const preferred = preferredHubId ? `knowledge:${preferredHubId}` : undefined;
  const start = preferred && byNode.has(preferred)
    ? preferred
    : [...byNode.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  if (!start) return [];
  const visited = new Set<string>([start]);
  const queue = [start];
  const chosen: GraphVisualEdge[] = [];
  const chosenIds = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidates = [...(byNode.get(current) || [])].sort((a, b) => {
      const aOther = a.source === current ? a.target : a.source;
      const bOther = b.source === current ? b.target : b.source;
      return (byNode.get(bOther)?.length || 0) - (byNode.get(aOther)?.length || 0);
    });
    candidates.forEach((item) => {
      const other = item.source === current ? item.target : item.source;
      if (visited.has(other)) return;
      visited.add(other);
      queue.push(other);
      chosen.push(item);
      chosenIds.add(item.id);
    });
  }
  all.forEach((item) => {
    if (chosen.length >= Math.max(0, displayed.length - 1) + extraEdges || chosenIds.has(item.id)) return;
    chosen.push(item);
    chosenIds.add(item.id);
  });
  return chosen;
}

function sparseProjectContextEdges(displayed: NoteItem[], projects: NoteItem[], notes: NoteItem[], existingEdges: GraphVisualEdge[]): GraphVisualEdge[] {
  const displayedIds = new Set(displayed.map((note) => note.id));
  const explicitlyConnected = new Set(existingEdges.flatMap((item) => [item.source.replace(/^knowledge:/, ''), item.target.replace(/^knowledge:/, '')]));
  const seen = new Set(existingEdges.map((item) => [item.source, item.target].sort().join('|')));
  const result: GraphVisualEdge[] = [];
  projects.forEach((project) => {
    const members = getDirectProjectKnowledge(project.id, notes)
      .filter((note) => displayedIds.has(note.id))
      .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes));
    if (members.length < 2) return;
    const hub = members[0];
    let labeled = false;
    let added = 0;
    members.slice(1).forEach((member) => {
      if (added >= 2 || (explicitlyConnected.has(member.id) && added > 0)) return;
      const source = `knowledge:${hub.id}`;
      const target = `knowledge:${member.id}`;
      const key = [source, target].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      result.push(edge(`co:${project.id}:${hub.id}:${member.id}`, source, target, 'co_project', labeled ? undefined : '同项目'));
      labeled = true;
      added += 1;
    });
  });
  return result;
}

function projectBreadcrumbs(projectId: string, notes: NoteItem[], resetLabel: string): GraphBreadcrumb[] {
  return [
    { id: 'reset', label: resetLabel, reset: true },
    ...getProjectAncestors(projectId, notes).map((project) => ({ id: project.id, label: shortGraphTitle(project.title, 'project'), scopeProjectId: project.id })),
  ];
}

export function buildKnowledgeGraphSlice(input: {
  notes: NoteItem[];
  scopeProjectId?: string | null;
  orphanScope?: boolean;
  communityId?: string | null;
  focusKnowledgeId?: string | null;
  density: GraphDensity;
}): GraphSlice {
  const { notes, scopeProjectId, orphanScope, communityId, focusKnowledgeId, density } = input;
  const limits = DENSITY_LIMITS[density];
  const extraEdges = density === 'dense' ? 2 : 0;
  const knowledge = knowledgeNotes(notes);

  if (focusKnowledgeId) {
    const selected = knowledge.find((note) => note.id === focusKnowledgeId);
    if (selected) {
      const direct = getExplicitKnowledgeNeighbors(selected.id, notes)
        .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes))
        .slice(0, limits.direct);
      const directIds = new Set(direct.map((note) => note.id));
      const contextPool = uniqueById(getKnowledgeProjectContexts(selected.id, notes)
        .flatMap((project) => getDirectProjectKnowledge(project.id, notes)))
        .filter((note) => note.id !== selected.id && !directIds.has(note.id));
      const context = contextPool.slice(0, limits.context);
      const directLayout = collisionSafeRingPositions(direct.length, { firstRadius: Math.max(210, direct.length * 28), ringGap: 190, minArc: 180 });
      const contextLayout = collisionSafeRingPositions(context.length, { firstRadius: Math.max(380, directLayout.outerRadius + 190), ringGap: 200, minArc: 190, start: -Math.PI / 2 + 0.32 });
      const nodes = [
        knowledgeNode(selected, 0, 0),
        ...direct.map((note, index) => knowledgeNode(note, directLayout.positions[index].x, directLayout.positions[index].y)),
        ...context.map((note, index) => knowledgeNode(note, contextLayout.positions[index].x, contextLayout.positions[index].y)),
      ];
      const regions = projectRegionNodes([selected, ...direct, ...context], nodes, getKnowledgeProjectContexts(selected.id, notes), notes);
      const displayed = [selected, ...direct];
      const edges = sparseWikiEdges(displayed, notes, extraEdges, selected.id);
      context.forEach((note, index) => {
        edges.push(edge(`co:${selected.id}:${note.id}`, `knowledge:${selected.id}`, `knowledge:${note.id}`, 'co_project', index === 0 ? '同项目' : undefined));
      });
      return {
        nodes: [...regions, ...nodes],
        edges,
        breadcrumbs: [
          { id: 'reset', label: '全部知识', reset: true },
          ...(scopeProjectId ? getProjectAncestors(scopeProjectId, notes).map((project) => ({ id: project.id, label: shortGraphTitle(project.title, 'project'), scopeProjectId: project.id })) : []),
          { id: selected.id, label: shortGraphTitle(selected.title) },
        ],
        hiddenCount: Math.max(0, getExplicitKnowledgeNeighbors(selected.id, notes).length - direct.length) + Math.max(0, contextPool.length - context.length),
        title: selected.title,
        subtitle: '稳定邻域 · 实线为直接链接，虚线为同项目情境',
      };
    }
  }

  const assigned = new Set(notes.filter((note) => note.noteType === 'project').flatMap((project) => getDirectProjectKnowledge(project.id, notes).map((item) => item.id)));
  if (orphanScope) {
    const candidates = knowledge
      .filter((note) => !assigned.has(note.id))
      .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes));
    const communities = buildKnowledgeCommunities(candidates, [], notes);
    if (candidates.length > limits.branch && !communityId) {
      const overview = layoutKnowledgeCommunityOverview(communities, notes);
      return {
        nodes: overview.nodes,
        edges: overview.edges,
        breadcrumbs: [{ id: 'reset', label: '全部知识', reset: true }, { id: 'orphan', label: '未归档知识' }],
        hiddenCount: 0,
        aggregatedCount: candidates.length,
        title: '未归档知识簇',
        subtitle: `${candidates.length} 个知识点已归入 ${communities.length} 个关系社区；选择社区后加载知识节点`,
      };
    }
    const selectedCommunity = communityId ? communities.find((community) => community.id === communityId) : undefined;
    const pool = selectedCommunity?.notes || candidates;
    const displayed = pool.slice(0, limits.branch);
    const positions = gridPositions(displayed.length, 220, 175, Math.min(5, Math.ceil(Math.sqrt(displayed.length))));
    const displayedNodes = selectedCommunity
      ? radialCommunityKnowledgeNodes(displayed, notes)
      : displayed.map((note, index) => knowledgeNode(note, positions[index].x, positions[index].y));
    return {
      nodes: displayedNodes,
      edges: sparseWikiEdges(displayed, notes, extraEdges),
      breadcrumbs: [
        { id: 'reset', label: '全部知识', reset: true },
        { id: 'orphan', label: '未归档知识' },
        ...(selectedCommunity ? [{ id: selectedCommunity.id, label: shortGraphTitle(selectedCommunity.title), communityId: selectedCommunity.id }] : []),
      ],
      hiddenCount: Math.max(0, pool.length - displayed.length),
      title: selectedCommunity?.title || '未归档知识',
      subtitle: selectedCommunity
        ? `${pool.length} 个知识点 · 按关系强度展示社区骨架`
        : '尚未被任何项目正文显式引用的知识点',
    };
  }

  if (!scopeProjectId) {
    const roots = getRootProjects(notes);
    const unassigned = knowledge.filter((note) => !assigned.has(note.id));
    const items = [
      ...roots.map((project) => ({ project, orphan: false })),
      ...(unassigned.length > 0 ? [{ project: null, orphan: true }] : []),
    ];
    const positions = gridPositions(items.length, 300, 230, Math.min(3, Math.ceil(Math.sqrt(items.length))));
    const nodes = items.map((item, index): GraphVisualNode => {
      if (item.project) return knowledgeDomainNode(item.project, notes, positions[index].x, positions[index].y);
      return {
        id: 'domain:orphan',
        aggregateKey: 'orphan',
        kind: 'aggregate',
        title: '未归档知识',
        displayTitle: '未归档知识',
        subtitle: `${unassigned.length} 个知识点`,
        masteryBand: 'unrated',
        count: unassigned.length,
        x: positions[index].x,
        y: positions[index].y,
      };
    });
    return {
      nodes,
      edges: [],
      breadcrumbs: [{ id: 'reset', label: '全部知识', reset: true }],
      hiddenCount: knowledge.length,
      title: '知识簇总览',
      subtitle: '根目录仅用于后台聚合，不作为图节点；选择知识簇后加载知识骨架',
    };
  }

  const project = notes.find((note) => note.id === scopeProjectId && note.noteType === 'project');
  if (!project) return buildKnowledgeGraphSlice({ notes, density });
  const scopeProjects = getProjectSubtree(project.id, notes);
  const scopeKnowledge = getScopeKnowledge(project.id, notes)
    .sort((a, b) => explicitDegree(b, notes) - explicitDegree(a, notes));
  const communities = buildKnowledgeCommunities(scopeKnowledge, scopeProjects, notes);
  if (scopeKnowledge.length > limits.branch && !communityId) {
    const overview = layoutKnowledgeCommunityOverview(communities, notes);
    return {
      nodes: overview.nodes,
      edges: overview.edges,
      breadcrumbs: projectBreadcrumbs(project.id, notes, '全部知识'),
      hiddenCount: 0,
      aggregatedCount: scopeKnowledge.length,
      title: project.title,
      subtitle: `${scopeKnowledge.length} 个知识点已归入 ${communities.length} 个关系社区；项目只参与后台聚合，不作为图节点`,
    };
  }
  const selectedCommunity = communityId ? communities.find((community) => community.id === communityId) : undefined;
  const communityKnowledge = selectedCommunity?.notes || scopeKnowledge;
  const displayedKnowledge = communityKnowledge.slice(0, limits.branch);
  const knowledgeNodes = selectedCommunity
    ? radialCommunityKnowledgeNodes(displayedKnowledge, notes)
    : clusteredKnowledgeNodes(displayedKnowledge, scopeProjects, notes);
  const directEdges = sparseWikiEdges(displayedKnowledge, notes, extraEdges);
  const regions = projectRegionNodes(displayedKnowledge, knowledgeNodes, scopeProjects, notes);
  const edges: GraphVisualEdge[] = [
    ...directEdges,
    ...sparseProjectContextEdges(displayedKnowledge, scopeProjects, notes, directEdges),
  ];
  return {
    nodes: [...regions, ...knowledgeNodes],
    edges,
    breadcrumbs: [
      ...projectBreadcrumbs(project.id, notes, '全部知识'),
      ...(selectedCommunity ? [{ id: selectedCommunity.id, label: shortGraphTitle(selectedCommunity.title), communityId: selectedCommunity.id }] : []),
    ],
    hiddenCount: Math.max(0, communityKnowledge.length - displayedKnowledge.length),
    title: selectedCommunity?.title || project.title,
    subtitle: selectedCommunity
      ? `${communityKnowledge.length} 个知识点 · 实线为知识链接，虚线为同项目共同出现`
      : `${scopeKnowledge.length} 个知识点 · 实线为知识链接，虚线为同项目共同出现`,
  };
}

export function buildProjectOverviewSlice(notes: NoteItem[], scopeProjectId: string | null | undefined, density: GraphDensity): GraphSlice {
  const limits = DENSITY_LIMITS[density];
  if (!scopeProjectId) {
    const roots = getRootProjects(notes);
    const positions = gridPositions(roots.length, 300, 220, Math.min(3, Math.ceil(Math.sqrt(roots.length))));
    return {
      nodes: roots.map((project, index) => projectNode(project, notes, positions[index].x, positions[index].y)),
      edges: [],
      breadcrumbs: [{ id: 'reset', label: '全部项目', reset: true }],
      hiddenCount: 0,
      title: '项目概览',
      subtitle: '先显示根项目，再逐层展开项目结构与直接知识点',
    };
  }

  const project = notes.find((note) => note.id === scopeProjectId && note.noteType === 'project');
  if (!project) return buildProjectOverviewSlice(notes, null, density);
  const children = getChildProjects(project.id, notes);
  const directKnowledge = getDirectProjectKnowledge(project.id, notes);
  const displayedKnowledge = directKnowledge.slice(0, limits.branch);
  const root = projectNode(project, notes, 0, 0);
  const childLayout = collisionSafeRingPositions(children.length, { firstRadius: 325, ringGap: 235, minArc: 225, start: -Math.PI / 2 + 0.2 });
  const knowledgeLayout = collisionSafeRingPositions(displayedKnowledge.length, { centerY: -20, firstRadius: Math.max(640, childLayout.outerRadius + 290), ringGap: 220, minArc: 190, start: Math.PI });
  const childNodes = children.map((child, index) => projectNode(child, notes, childLayout.positions[index].x, childLayout.positions[index].y));
  const kNodes = displayedKnowledge.map((note, index) => knowledgeNode(note, knowledgeLayout.positions[index].x, knowledgeLayout.positions[index].y));
  const edges = [
    ...childNodes.map((node) => edge(`hierarchy:${project.id}:${node.noteId}`, root.id, node.id, 'hierarchy')),
    ...kNodes.map((node) => edge(`membership:${project.id}:${node.noteId}`, root.id, node.id, 'membership')),
  ];
  return {
    nodes: [root, ...childNodes, ...kNodes],
    edges,
    breadcrumbs: projectBreadcrumbs(project.id, notes, '全部项目'),
    hiddenCount: Math.max(0, directKnowledge.length - displayedKnowledge.length),
    title: project.title,
    subtitle: `${children.length} 个子项目 · ${directKnowledge.length} 个直接知识点`,
  };
}

function earliestProjectDate(project: NoteItem, notes: NoteItem[]): string | undefined {
  return getProjectMetrics(project.id, notes).nearestDueDate;
}

export function buildLearningPathSlice(notes: NoteItem[], rootProjectId: string | null | undefined, density: GraphDensity): GraphSlice {
  const roots = getRootProjects(notes);
  const fallbackRoot = [...roots].sort((a, b) => getProjectSubtree(b.id, notes).length - getProjectSubtree(a.id, notes).length)[0];
  const root = notes.find((note) => note.id === rootProjectId && note.noteType === 'project') || fallbackRoot;
  if (!root) return { nodes: [], edges: [], breadcrumbs: [], hiddenCount: 0, title: '学习路径', subtitle: '暂无项目' };
  const originalIndex = new Map(notes.map((note, index) => [note.id, index]));
  const phases = getChildProjects(root.id, notes).sort((a, b) => {
    const aDate = earliestProjectDate(a, notes);
    const bDate = earliestProjectDate(b, notes);
    if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return (originalIndex.get(a.id) || 0) - (originalIndex.get(b.id) || 0);
  });
  const pathProjects = phases.length > 0 ? phases : [root];
  const gap = 310;
  const rootNode = projectNode(root, notes, 0, 40);
  const phaseNodes = pathProjects.map((project, index) => {
    const node = projectNode(project, notes, (index + 1) * gap, 40);
    const date = earliestProjectDate(project, notes);
    return { ...node, subtitle: date ? `计划至 ${date}` : '结构阶段 · 未设置日期' };
  });
  const nodes: GraphVisualNode[] = phases.length > 0 ? [rootNode, ...phaseNodes] : [rootNode];
  const edges: GraphVisualEdge[] = [];
  if (phases.length > 0) {
    phaseNodes.forEach((node, index) => {
      const source = index === 0 ? rootNode.id : phaseNodes[index - 1].id;
      edges.push(edge(`path:${source}:${node.id}`, source, node.id, 'path', index === 0 ? '开始' : undefined, true));
    });
  }

  const limit = DENSITY_LIMITS[density].checkpoints;
  let hiddenCount = 0;
  pathProjects.forEach((project, phaseIndex) => {
    const allKnowledge = getScopeKnowledge(project.id, notes)
      .sort((a, b) => masteryReadMode() === 'current'
        ? readKnowledgeMastery(b).reviewPriority - readKnowledgeMastery(a).reviewPriority
        : (safeMastery(a) ?? -1) - (safeMastery(b) ?? -1));
    const checkpoints = allKnowledge.slice(0, limit);
    hiddenCount += Math.max(0, allKnowledge.length - checkpoints.length);
    checkpoints.forEach((note, index) => {
      const phaseNode = phases.length > 0 ? phaseNodes[phaseIndex] : rootNode;
      const node = knowledgeNode(note, phaseNode.x + (index - (checkpoints.length - 1) / 2) * 150, 260 + (index % 2) * 120);
      node.subtitle = `${node.masteryView?.displayLabel || getMasteryLabel(node.mastery)} · 检查点`;
      nodes.push(node);
      edges.push(edge(`checkpoint:${project.id}:${note.id}`, phaseNode.id, node.id, 'membership', index === 0 ? '知识检查点' : undefined));
    });
  });
  const scheduled = pathProjects.filter((project) => earliestProjectDate(project, notes)).length;
  return {
    nodes,
    edges,
    breadcrumbs: [{ id: root.id, label: shortGraphTitle(root.title, 'project'), scopeProjectId: root.id }],
    hiddenCount,
    title: root.title,
    subtitle: scheduled === pathProjects.length ? '计划路径 · 按最近截止日期排序' : '混合路径 · 有日期按计划排序，其余保留结构顺序',
  };
}
