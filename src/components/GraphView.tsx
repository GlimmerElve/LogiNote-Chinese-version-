import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type MiniMapNodeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  Filter,
  FolderTree,
  Layers3,
  Link2,
  Network,
  Route,
  Search,
  Settings2,
  Target,
  X,
} from 'lucide-react';
import type { GraphMode, NoteItem } from '../types';
import {
  buildKnowledgeGraphSlice,
  buildLearningPathSlice,
  buildProjectOverviewSlice,
  getChildProjects,
  getDirectProjectKnowledge,
  getExplicitKnowledgeNeighbors,
  getKnowledgeGraphStats,
  getKnowledgeProjectContexts,
  getMasteryBand,
  getMasteryLabel,
  getNoteMasteryBand,
  getProjectMetrics,
  getProjectSubtree,
  getRootProjects,
  type GraphDensity,
  type GraphRelationKind,
  type GraphSlice,
  type GraphVisualEdge,
  type GraphVisualNode,
  type MasteryBand,
} from '../services/knowledgeGraphModel';
import { KNOWLEDGE_MASTERY_FILTERS, masteryReadMode, knowledgeMasteryCaption, matchesKnowledgeMasteryFilter, summarizeKnowledgeMastery } from '../services/masteryReadModel';
import { KnowledgeMasteryStatus } from './KnowledgeMasteryStatus';
import { QuickCheckButton } from './quickCheck';

interface GraphViewProps {
  notes: NoteItem[];
  onSelectNoteByTitle: (title: string) => void;
  onOpenNote?: (noteId: string, projectContextId?: string | null) => void;
  onStartReview?: (note: NoteItem) => void;
}

interface KnowledgeGraphNodeData extends Record<string, unknown> {
  model: GraphVisualNode;
}

interface KnowledgeGraphEdgeData extends Record<string, unknown> {
  model: GraphVisualEdge;
  dimmed?: boolean;
}

type KnowledgeGraphFlowNode = Node<KnowledgeGraphNodeData, 'knowledgeGraphNode'>;
type KnowledgeGraphFlowEdge = Edge<KnowledgeGraphEdgeData, 'knowledgeGraphEdge'>;
type MasteryFilter = 'all' | MasteryBand;

const modeCopy: Record<GraphMode, { label: string; subtitle: string }> = {
  knowledge: { label: '知识关联', subtitle: '看见概念之间的直接关系与项目情境' },
  overview: { label: '项目概览', subtitle: '看见项目层级、范围与知识归属' },
  path: { label: '学习路径', subtitle: '按计划顺序查看阶段与薄弱知识检查点' },
};

const masteryCopy: Array<{ id: MasteryFilter; label: string }> = [
  { id: 'all', label: '全部状态' },
  { id: 'unrated', label: '未评估' },
  { id: 'weak', label: '待加强' },
  { id: 'developing', label: '学习中' },
  { id: 'solid', label: '基本掌握' },
  { id: 'mastered', label: '稳固掌握' },
];
const activeMasteryCopy: Array<{ id: MasteryFilter; label: string }> = masteryReadMode() === 'current'
  ? [{ id: 'all', label: '全部状态' }, ...KNOWLEDGE_MASTERY_FILTERS] : masteryCopy;

const densityCopy: Array<{ id: GraphDensity; label: string }> = [
  { id: 'sparse', label: '稀疏' },
  { id: 'balanced', label: '平衡' },
  { id: 'dense', label: '紧凑' },
];

const relationCopy: Array<{ id: GraphRelationKind; label: string }> = [
  { id: 'wiki', label: '直接链接' },
  { id: 'co_project', label: '同项目情境' },
  { id: 'hierarchy', label: '父子结构' },
  { id: 'membership', label: '项目归属' },
  { id: 'path', label: '计划顺序' },
];

const modeRelations: Record<GraphMode, GraphRelationKind[]> = {
  knowledge: ['wiki', 'co_project'],
  overview: ['hierarchy', 'membership'],
  path: ['path', 'membership'],
};

function stripMarkdown(content: string): string {
  return (content || '')
    .replace(/data:image\/[a-zA-Z+]+;base64,[^\s)]+/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => alias || target)
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function MasteryGauge({ value, compact = false }: { value?: number; compact?: boolean }) {
  const normalized = value == null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
  const circumference = 2 * Math.PI * 28;
  const offset = circumference * (1 - normalized / 100);
  return (
    <div className={`knowledge-graph-mastery-gauge mastery-${getMasteryBand(value)} ${compact ? 'is-compact' : ''}`} aria-label={value == null ? '掌握度未评估' : `掌握度 ${normalized}%`}>
      <svg viewBox="0 0 68 68" aria-hidden="true">
        <circle cx="34" cy="34" r="28" className="track" />
        <circle cx="34" cy="34" r="28" className="value" strokeDasharray={circumference} strokeDashoffset={offset} />
      </svg>
      <strong>{value == null ? '—' : `${normalized}%`}</strong>
    </div>
  );
}

function KnowledgeGraphNode({ data, selected }: NodeProps<KnowledgeGraphFlowNode>) {
  const { model } = data;
  const isKnowledge = model.kind === 'knowledge';
  const className = [
    'knowledge-graph-node',
    `is-${model.kind}`,
    model.communityId ? 'is-community' : '',
    model.communityId ? `tone-${model.tone || 0}` : '',
    `mastery-${model.masteryBand}`,
    selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');

  if (model.kind === 'region') {
    return (
      <div className={`${className} tone-${model.tone || 0}`} aria-label={`${model.title}，${model.subtitle || ''}`}>
        <span className="knowledge-graph-region-title">{model.displayTitle}</span>
        <small>{model.subtitle}</small>
      </div>
    );
  }

  return (
    <div className={className} title={model.title} role="button" tabIndex={0} aria-current={selected ? 'true' : undefined}
      aria-label={`${model.title}${model.subtitle ? `，${model.subtitle}` : ''}`}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}>
      <Handle id="target-top" type="target" position={Position.Top} className="knowledge-graph-handle is-top" />
      <Handle id="target-right" type="target" position={Position.Right} className="knowledge-graph-handle is-right" />
      <Handle id="target-bottom" type="target" position={Position.Bottom} className="knowledge-graph-handle is-bottom" />
      <Handle id="target-left" type="target" position={Position.Left} className="knowledge-graph-handle is-left" />
      <Handle id="source-top" type="source" position={Position.Top} className="knowledge-graph-handle is-top" />
      <Handle id="source-right" type="source" position={Position.Right} className="knowledge-graph-handle is-right" />
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="knowledge-graph-handle is-bottom" />
      <Handle id="source-left" type="source" position={Position.Left} className="knowledge-graph-handle is-left" />
      <span className="knowledge-graph-node-orbit" aria-hidden="true">
        <span className="knowledge-graph-node-core">
          {model.communityId ? <strong>{model.count}</strong> : model.kind === 'aggregate' ? <Layers3 /> : model.kind === 'project' ? <FolderTree /> : <span />}
        </span>
      </span>
      <span className="knowledge-graph-node-title">{model.displayTitle}</span>
      <span className="knowledge-graph-node-meta">
        {isKnowledge
          ? model.subtitle || '未评估'
          : model.subtitle || `${model.count || 0} 项`}
      </span>
    </div>
  );
}

function KnowledgeGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<KnowledgeGraphFlowEdge>) {
  const relation = data?.model.kind || 'wiki';
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.hypot(dx, dy);
  const directionVector = (position: Position) => {
    if (position === Position.Top) return { x: 0, y: -1 };
    if (position === Position.Right) return { x: 1, y: 0 };
    if (position === Position.Bottom) return { x: 0, y: 1 };
    return { x: -1, y: 0 };
  };
  const sourceDirection = directionVector(sourcePosition);
  const targetDirection = directionVector(targetPosition);
  const curveScale = relation === 'co_project' ? 0.26 : relation === 'path' ? 0.38 : 0.34;
  const controlDistance = Math.min(relation === 'path' ? 176 : 148, Math.max(42, distance * curveScale));
  const control1X = sourceX + sourceDirection.x * controlDistance;
  const control1Y = sourceY + sourceDirection.y * controlDistance;
  const control2X = targetX + targetDirection.x * controlDistance;
  const control2Y = targetY + targetDirection.y * controlDistance;
  const edgePath = `M ${sourceX},${sourceY} C ${control1X},${control1Y} ${control2X},${control2Y} ${targetX},${targetY}`;
  const labelX = (sourceX + 3 * control1X + 3 * control2X + targetX) / 8;
  const labelY = (sourceY + 3 * control1Y + 3 * control2Y + targetY) / 8;
  const stroke = relation === 'wiki' || relation === 'path' ? 'var(--ln-accent)' : 'var(--ln-text-faint)';
  const dashed = relation === 'co_project' || relation === 'membership';
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} className={`knowledge-graph-edge is-${relation}${data?.dimmed ? ' is-dimmed' : ''}`} style={{ stroke, strokeWidth: relation === 'path' ? 2.2 : relation === 'wiki' ? 1.9 : 1.35, strokeDasharray: dashed ? '7 6' : undefined, opacity: data?.dimmed ? 0.11 : relation === 'co_project' ? 0.58 : 0.82, transition: 'opacity 160ms ease, stroke-width 160ms ease' }} />
      {!data?.dimmed && !data?.model.directed && <circle cx={targetX} cy={targetY} r={2.6} className="knowledge-graph-edge-anchor is-target" />}
      {data?.model.label && !data.dimmed && (
        <EdgeLabelRenderer>
          <span className={`knowledge-graph-edge-label is-${relation}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{data.model.label}</span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { knowledgeGraphNode: KnowledgeGraphNode };
const edgeTypes = { knowledgeGraphEdge: KnowledgeGraphEdge };

function KnowledgeMiniMapNode({ id, x, y, width, height, color, strokeColor, strokeWidth, selected, onClick }: MiniMapNodeProps) {
  if (!color || color === 'transparent') return null;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radius = selected ? 28 : 22;
  return (
    <g onClick={onClick ? (event) => onClick(event, id) : undefined}>
      {selected && <circle cx={centerX} cy={centerY} r={radius + 9} fill="none" stroke="#2f5743" strokeWidth={3} opacity={0.34} />}
      <circle cx={centerX} cy={centerY} r={radius} fill={color} stroke={strokeColor} strokeWidth={strokeWidth} />
    </g>
  );
}

function relationHandles(source: GraphVisualNode, target: GraphVisualNode): Pick<KnowledgeGraphFlowEdge, 'sourceHandle' | 'targetHandle'> {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { sourceHandle: 'source-right', targetHandle: 'target-left' } : { sourceHandle: 'source-left', targetHandle: 'target-right' };
  }
  if (dy >= 0) {
    return dx < 0
      ? { sourceHandle: 'source-left', targetHandle: 'target-top' }
      : { sourceHandle: 'source-right', targetHandle: 'target-top' };
  }
  return dx < 0
    ? { sourceHandle: 'source-top', targetHandle: 'target-right' }
    : { sourceHandle: 'source-top', targetHandle: 'target-left' };
}

function toFlowElements(slice: GraphSlice, selectedGraphId: string | null, enabledRelations: Set<GraphRelationKind>, masteryFilter: MasteryFilter) {
  const selectedNoteId = slice.nodes.find((node) => node.id === selectedGraphId)?.noteId;
  const contentModels = slice.nodes.filter((node) => node.kind !== 'region' && (node.kind !== 'knowledge' || masteryFilter === 'all'
    || node.masteryView && KNOWLEDGE_MASTERY_FILTERS.some(filter => filter.id === masteryFilter)
      && matchesKnowledgeMasteryFilter(node.masteryView, masteryFilter as typeof KNOWLEDGE_MASTERY_FILTERS[number]['id'])
    || node.masteryBand === masteryFilter || node.noteId === selectedNoteId));
  const visibleKnowledgeIds = new Set(contentModels.filter((node) => node.kind === 'knowledge').map((node) => node.noteId));
  const regions = slice.nodes.filter((node) => node.kind === 'region' && (node.memberNoteIds || []).filter((id) => visibleKnowledgeIds.has(id)).length >= 2);
  const visibleModels = [...regions, ...contentModels];
  const visibleIds = new Set(visibleModels.map((node) => node.id));
  const byId = new Map(visibleModels.map((node) => [node.id, node]));
  const nodes: KnowledgeGraphFlowNode[] = visibleModels.map((model) => {
    const width = model.kind === 'region' ? model.width || 300 : model.kind === 'project' || model.kind === 'aggregate' ? 186 : 154;
    const height = model.kind === 'region' ? model.height || 220 : model.kind === 'project' || model.kind === 'aggregate' ? 124 : 112;
    return {
      id: model.id,
      type: 'knowledgeGraphNode',
      position: { x: model.x, y: model.y },
      data: { model },
      width,
      height,
      draggable: false,
      selectable: model.kind !== 'region',
      selected: model.kind !== 'region' && model.id === selectedGraphId,
      zIndex: model.kind === 'region' ? -10 : 1,
      style: { width, height },
    };
  });
  const edges: KnowledgeGraphFlowEdge[] = slice.edges
    .filter((model) => enabledRelations.has(model.kind) && visibleIds.has(model.source) && visibleIds.has(model.target))
    .map((model) => {
      const source = byId.get(model.source)!;
      const target = byId.get(model.target)!;
      return {
        id: model.id,
        type: 'knowledgeGraphEdge',
        source: model.source,
        target: model.target,
        data: { model, dimmed: Boolean(selectedGraphId && model.source !== selectedGraphId && model.target !== selectedGraphId) },
        ...relationHandles(source, target),
        markerEnd: model.directed ? { type: MarkerType.ArrowClosed, width: 19, height: 19, color: 'var(--ln-accent)' } : undefined,
        selectable: false,
      };
    });
  const filteredCount = slice.nodes.filter((node) => node.kind === 'knowledge' && !visibleKnowledgeIds.has(node.noteId)).length;
  return { nodes, edges, filteredCount };
}

function GraphInspector({ notes, mode, selectedModel, slice, onOpenNote, onStartReview, onSelectRelated }: {
  notes: NoteItem[];
  mode: GraphMode;
  selectedModel?: GraphVisualNode;
  slice: GraphSlice;
  onOpenNote: (note: NoteItem) => void;
  onStartReview?: (note: NoteItem) => void;
  onSelectRelated: (note: NoteItem) => void;
}) {
  const note = selectedModel?.noteId ? notes.find((item) => item.id === selectedModel.noteId) : undefined;
  if (!note) {
    const isDomainOverview = slice.nodes.some((node) => node.kind === 'aggregate') && !slice.nodes.some((node) => node.kind === 'knowledge');
    return (
      <aside className="knowledge-graph-inspector">
        <div className="knowledge-graph-inspector-empty-mark"><Network /></div>
        <span className="knowledge-graph-eyebrow">CURRENT VIEW</span>
        <h2>{selectedModel?.title || slice.title}</h2>
        <p>{selectedModel?.subtitle || slice.subtitle}</p>
        <div className="knowledge-graph-inspector-guide"><strong>如何浏览</strong><span>{mode === 'overview' ? '选择项目逐层查看下级项目与知识点；双击项目或知识节点打开对应笔记。' : mode === 'path' ? '在筛选中选择根项目，按路径查看学习阶段；双击项目或知识节点打开对应笔记。' : isDomainOverview ? '选择知识簇进入下一层；知识簇只是范围代理，不是项目节点。' : '选择知识点进入稳定邻域，项目范围由筛选控制；双击知识节点可直接打开笔记。'}</span></div>
      </aside>
    );
  }
  const isKnowledge = note.noteType === 'knowledge';
  const mastery = isKnowledge ? note.dsrState?.conceptMastery : getProjectMetrics(note.id, notes).averageMastery;
  const metrics = note.noteType === 'project' ? getProjectMetrics(note.id, notes) : undefined;
  const relatedKnowledge = isKnowledge ? getExplicitKnowledgeNeighbors(note.id, notes) : getDirectProjectKnowledge(note.id, notes);
  const projectContexts = isKnowledge ? getKnowledgeProjectContexts(note.id, notes) : getChildProjects(note.id, notes);
  const excerpt = stripMarkdown(note.content).slice(0, 210);
  return (
    <aside className="knowledge-graph-inspector">
      <div className="knowledge-graph-inspector-heading">
        <div><span className="knowledge-graph-eyebrow">{isKnowledge ? 'KNOWLEDGE NODE' : 'PROJECT NODE'}</span><h2>{note.title}</h2></div>
        <span className={`knowledge-graph-type-badge is-${note.noteType}`}>{isKnowledge ? '知识点' : '项目'}</span>
      </div>
      <div className="knowledge-graph-inspector-tags">{note.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}{note.tags.length === 0 && <span>未设置标签</span>}</div>
      {isKnowledge && masteryReadMode() === 'current' ? <KnowledgeMasteryStatus note={note} /> : <section className="knowledge-graph-mastery-card">
        <MasteryGauge value={mastery} />
        <div><span>{isKnowledge ? '历史概念评分' : '关联知识汇总'}</span><strong>{metrics?.masterySummary ? `已确认 ${metrics.masterySummary.confirmedCount} / ${metrics.knowledgeCount}` : getMasteryLabel(mastery)}</strong><small>{isKnowledge ? '历史评分，不换算为新状态' : '仅汇总项目关联知识点，不是项目自身评分'}</small></div>
      </section>}
      {isKnowledge ? (
        <section className="knowledge-graph-inspector-section"><h3>概念摘要</h3><p>{excerpt || '该知识点尚未填写概念定义。'}</p></section>
      ) : metrics && (
        <section className="knowledge-graph-project-stats"><div><strong>{metrics.projectCount}</strong><span>项目节点</span></div><div><strong>{metrics.knowledgeCount}</strong><span>关联知识</span></div><div><strong>{metrics.completion}%</strong><span>任务完成</span></div></section>
      )}
      <section className="knowledge-graph-inspector-section">
        <div className="knowledge-graph-section-title"><h3>{isKnowledge ? '直接知识关联' : '直接关联知识点'}</h3><span>{relatedKnowledge.length}</span></div>
        <div className="knowledge-graph-related-list">
          {relatedKnowledge.slice(0, 5).map((related) => (
            <button type="button" key={related.id} onClick={() => onSelectRelated(related)}><i className={`mastery-dot mastery-${getNoteMasteryBand(related)}`} /><span><strong>{related.title}</strong><small>{knowledgeMasteryCaption(related)}</small></span><ChevronRight /></button>
          ))}
          {relatedKnowledge.length === 0 && <p className="knowledge-graph-empty-line">暂无显式关联</p>}
        </div>
      </section>
      <section className="knowledge-graph-inspector-section">
        <div className="knowledge-graph-section-title"><h3>{isKnowledge ? '所在项目' : '下级项目'}</h3><span>{projectContexts.length}</span></div>
        <div className="knowledge-graph-context-list">{projectContexts.slice(0, 4).map((project) => <span key={project.id}><FolderTree />{project.title}</span>)}{projectContexts.length === 0 && <p className="knowledge-graph-empty-line">暂无项目上下文</p>}</div>
      </section>
      <div className="knowledge-graph-inspector-actions">
        {onStartReview && <button type="button" className="is-secondary" onClick={() => onStartReview(note)}><BookOpen />开始复习</button>}
        {isKnowledge && <QuickCheckButton noteId={note.id} source="knowledge-graph" />}
        <button type="button" className="is-primary" onClick={() => onOpenNote(note)}><ExternalLink />打开笔记</button>
      </div>
    </aside>
  );
}

export const GraphView: React.FC<GraphViewProps> = ({ notes, onSelectNoteByTitle, onOpenNote, onStartReview }) => {
  const roots = useMemo(() => getRootProjects(notes), [notes]);
  const stats = useMemo(() => getKnowledgeGraphStats(notes), [notes]);
  const defaultPathRoot = useMemo(() => [...roots].sort((a, b) => getProjectSubtree(b.id, notes).length - getProjectSubtree(a.id, notes).length)[0]?.id || null, [notes, roots]);
  const [mode, setMode] = useState<GraphMode>('knowledge');
  const [density, setDensity] = useState<GraphDensity>('balanced');
  const [masteryFilter, setMasteryFilter] = useState<MasteryFilter>('all');
  const [enabledRelations, setEnabledRelations] = useState<Set<GraphRelationKind>>(() => new Set(relationCopy.map((item) => item.id)));
  const [knowledgeScopeProjectId, setKnowledgeScopeProjectId] = useState<string | null>(null);
  const [orphanScope, setOrphanScope] = useState(false);
  const [knowledgeCommunityId, setKnowledgeCommunityId] = useState<string | null>(null);
  const [focusKnowledgeId, setFocusKnowledgeId] = useState<string | null>(null);
  const [projectScopeId, setProjectScopeId] = useState<string | null>(null);
  const [pathRootId, setPathRootId] = useState<string | null>(defaultPathRoot);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(true);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState('');
  const uiId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const pendingSearchFocus = useRef<number | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutButtonRef = useRef<HTMLButtonElement>(null);
  const liveNotes = useRef(notes);
  liveNotes.current = notes;

  useEffect(() => {
    if (!layoutOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof globalThis.Node && !layoutRef.current?.contains(event.target)) setLayoutOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [layoutOpen]);

  useEffect(() => { if (!pathRootId || !roots.some((root) => root.id === pathRootId)) setPathRootId(defaultPathRoot); }, [defaultPathRoot, pathRootId, roots]);

  const slice = useMemo(() => {
    if (mode === 'overview') return buildProjectOverviewSlice(notes, projectScopeId, density);
    if (mode === 'path') return buildLearningPathSlice(notes, pathRootId, density);
    return buildKnowledgeGraphSlice({ notes, scopeProjectId: knowledgeScopeProjectId, orphanScope, communityId: knowledgeCommunityId, focusKnowledgeId, density });
  }, [density, focusKnowledgeId, knowledgeCommunityId, knowledgeScopeProjectId, mode, notes, orphanScope, pathRootId, projectScopeId]);
  const effectiveSelectedGraphId = selectedGraphId || (mode === 'knowledge' ? slice.nodes.find((node) => node.kind === 'knowledge')?.id || null : null);
  const elements = useMemo(() => toFlowElements(slice, effectiveSelectedGraphId, enabledRelations, masteryFilter), [effectiveSelectedGraphId, enabledRelations, masteryFilter, slice]);
  const selectedModel = slice.nodes.find((node) => node.id === effectiveSelectedGraphId) || (selectedNoteId ? slice.nodes.find((node) => node.noteId === selectedNoteId) : undefined);
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return notes.filter((note) => note.title.toLowerCase().includes(query) || (note.aliases || []).some((alias) => alias.toLowerCase().includes(query))).slice(0, 7);
  }, [notes, searchQuery]);
  useEffect(() => {
    if (!searchOpen || pendingSearchFocus.current == null) return;
    const buttons = searchResultsRef.current?.querySelectorAll<HTMLButtonElement>('button');
    const index = pendingSearchFocus.current;
    pendingSearchFocus.current = null;
    buttons?.[index < 0 ? buttons.length - 1 : index]?.focus();
  }, [searchOpen, searchMatches]);
  const masteryCounts = useMemo(() => {
    const counts = Object.fromEntries([...masteryCopy, ...KNOWLEDGE_MASTERY_FILTERS].map(item => [item.id, 0])) as Record<MasteryBand, number>;
    if (masteryReadMode() === 'current') return { ...counts, ...summarizeKnowledgeMastery(notes).bands };
    notes.filter((note) => note.noteType === 'knowledge').forEach((note) => {
      counts[getNoteMasteryBand(note)] += 1;
    });
    return counts;
  }, [notes]);

  const chooseNote = useCallback((note: NoteItem, fromSearch = false) => {
    // Return focus before removing the selected search-result button.
    if (fromSearch) searchInputRef.current?.focus();
    pendingSearchFocus.current = null;
    setSelectedGraphId(null);
    setSelectedNoteId(note.id);
    setSearchOpen(false);
    if (note.noteType === 'knowledge') {
      if (mode === 'knowledge') { setFocusKnowledgeId(note.id); setKnowledgeCommunityId(null); setOrphanScope(false); }
      else if (mode === 'overview') {
        const project = getKnowledgeProjectContexts(note.id, notes)[0];
        if (project) setProjectScopeId(project.id);
        else { setMode('knowledge'); setFocusKnowledgeId(note.id); setKnowledgeScopeProjectId(null); setKnowledgeCommunityId(null); setOrphanScope(false); }
      }
      else if (mode === 'path') {
        const contexts = getKnowledgeProjectContexts(note.id, notes);
        const root = roots.find(candidate => getProjectSubtree(candidate.id, notes).some(project => contexts.some(context => context.id === project.id)));
        if (root) setPathRootId(root.id);
        else { setMode('knowledge'); setFocusKnowledgeId(note.id); setKnowledgeScopeProjectId(null); setKnowledgeCommunityId(null); setOrphanScope(false); }
      }
      return;
    }
    if (mode === 'knowledge') { setKnowledgeScopeProjectId(note.id); setKnowledgeCommunityId(null); setFocusKnowledgeId(null); setOrphanScope(false); }
    else if (mode === 'overview') setProjectScopeId(note.id);
    else {
      const root = getRootProjects(notes).find((candidate) => getProjectSubtree(candidate.id, notes).some((item) => item.id === note.id));
      if (root) setPathRootId(root.id);
    }
  }, [mode, notes, roots]);

  const openExistingNote = (target: NoteItem) => {
    const current = liveNotes.current.find((note) => note.id === target.id);
    if (!current) { setNavigationNotice('这篇笔记已移除，请重新选择'); return; }
    setNavigationNotice('');
    const scopeId = mode === 'knowledge' ? knowledgeScopeProjectId : mode === 'overview' ? projectScopeId : pathRootId;
    // A knowledge note may belong to several projects. Pass a scope only when it actually belongs there.
    const contextId = scopeId && getProjectSubtree(scopeId, liveNotes.current).some((project) => project.id === current.id
      || getDirectProjectKnowledge(project.id, liveNotes.current).some((note) => note.id === current.id))
      ? scopeId : null;
    if (onOpenNote) onOpenNote(current.id, contextId);
    else onSelectNoteByTitle(current.title);
  };
  const closeSearch = () => {
    pendingSearchFocus.current = null;
    searchInputRef.current?.focus();
    setSearchOpen(false);
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault(); event.stopPropagation(); closeSearch(); return;
    }
    if (event.target === searchInputRef.current) {
      if (event.key === 'Enter' && searchOpen && searchMatches[0]) {
        event.preventDefault(); chooseNote(searchMatches[0], true);
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && searchMatches.length) {
        event.preventDefault();
        const index = event.key === 'ArrowDown' ? 0 : searchMatches.length - 1;
        const button = searchResultsRef.current?.querySelectorAll<HTMLButtonElement>('button')[index];
        if (button) button.focus();
        else { pendingSearchFocus.current = index; setSearchOpen(true); }
      }
      return;
    }
    const buttons = Array.from(searchResultsRef.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const handleModeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus(); // Manual activation: Enter/Space uses the button's normal click.
  };

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: KnowledgeGraphFlowNode) => {
    const model = node.data.model;
    setSelectedGraphId(model.id);
    setSelectedNoteId(model.noteId || null);
    if (mode === 'knowledge') {
      if (model.communityId) { setKnowledgeCommunityId(model.communityId); setFocusKnowledgeId(null); }
      else if (model.aggregateKey === 'orphan') { setOrphanScope(true); setKnowledgeScopeProjectId(null); setKnowledgeCommunityId(null); setFocusKnowledgeId(null); }
      else if ((model.kind === 'aggregate' || model.kind === 'project') && model.scopeProjectId) { setKnowledgeScopeProjectId(model.scopeProjectId); setKnowledgeCommunityId(null); setOrphanScope(false); setFocusKnowledgeId(null); }
      else if (model.kind === 'knowledge' && model.noteId) setFocusKnowledgeId(model.noteId);
    } else if (mode === 'overview' && model.kind === 'project' && model.noteId) setProjectScopeId(model.noteId);
  }, [mode]);

  const handleBreadcrumb = (item: GraphSlice['breadcrumbs'][number]) => {
    setSelectedGraphId(null); setSelectedNoteId(null);
    if (mode === 'knowledge') {
      setFocusKnowledgeId(null);
      if (item.communityId) setKnowledgeCommunityId(item.communityId);
      else {
        setKnowledgeCommunityId(null);
        setOrphanScope(false);
        setKnowledgeScopeProjectId(item.reset ? null : item.scopeProjectId || null);
      }
    }
    else if (mode === 'overview') setProjectScopeId(item.reset ? null : item.scopeProjectId || null);
  };
  const selectRoot = (root: NoteItem) => {
    setSelectedGraphId(null); setSelectedNoteId(root.id);
    if (mode === 'knowledge') { setKnowledgeScopeProjectId(root.id); setKnowledgeCommunityId(null); setFocusKnowledgeId(null); setOrphanScope(false); }
    else if (mode === 'overview') setProjectScopeId(root.id);
    else setPathRootId(root.id);
  };
  const toggleRelation = (relation: GraphRelationKind) => {
    setEnabledRelations((current) => { const next = new Set(current); next.has(relation) ? next.delete(relation) : next.add(relation); return next; });
  };
  const viewKey = `${mode}:${knowledgeScopeProjectId || 'root'}:${orphanScope}:${knowledgeCommunityId || 'all'}:${focusKnowledgeId || 'none'}:${projectScopeId || 'root'}:${pathRootId || 'none'}:${density}:${masteryFilter}:${elements.nodes.map((node) => node.id).join('|')}`;

  return (
    <div className="knowledge-graph-page">
      <header className="knowledge-graph-header">
        <div className="knowledge-graph-heading"><span>KNOWLEDGE MAP</span><h1>知识图谱</h1><p>{modeCopy[mode].subtitle}</p></div>
        <div className="knowledge-graph-search-wrap" onKeyDown={handleSearchKeyDown}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) { pendingSearchFocus.current = null; setSearchOpen(false); } }}>
          <Search />
          <input ref={searchInputRef} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="搜索概念、项目或别名…" aria-label="搜索知识图谱" aria-controls={searchOpen && searchQuery.trim() ? `${uiId}-results` : undefined} />
          {searchQuery && <button type="button" onClick={() => { searchInputRef.current?.focus(); pendingSearchFocus.current = null; setSearchQuery(''); setSearchOpen(false); }} aria-label="清空搜索"><X /></button>}
          {searchOpen && searchQuery.trim() && (
            <div ref={searchResultsRef} id={`${uiId}-results`} className="knowledge-graph-search-results" role="group" aria-label="图谱搜索结果">
              {searchMatches.map((note) => <button type="button" key={note.id} onClick={() => chooseNote(note, true)}>{note.noteType === 'project' ? <FolderTree /> : <Network />}<span><strong>{note.title}</strong><small>{note.noteType === 'project' ? '项目' : knowledgeMasteryCaption(note)}</small></span></button>)}
              {searchMatches.length === 0 && <p role="status">没有匹配的知识或项目</p>}
            </div>
          )}
        </div>
        <div className="knowledge-graph-stats"><div><Network /><span><strong>{stats.knowledgeCount}</strong> 个知识节点</span></div><div><Link2 /><span><strong>{stats.explicitEdgeCount}</strong> 条直接关联</span></div><div><Layers3 /><span><strong>{stats.clusterCount}</strong> 个知识域</span></div></div>
        <div className="knowledge-graph-mode-row">
          <div className="knowledge-graph-mode-tabs" role="tablist" aria-label="知识图谱视图" onKeyDown={handleModeKeyDown}>
            <button type="button" role="tab" id={`${uiId}-knowledge`} aria-controls={`${uiId}-panel`} tabIndex={mode === 'knowledge' ? 0 : -1} aria-selected={mode === 'knowledge'} className={mode === 'knowledge' ? 'is-active' : ''} onClick={() => { setMode('knowledge'); setSelectedGraphId(null); setSelectedNoteId(null); }}><Network />知识关联</button>
            <button type="button" role="tab" id={`${uiId}-overview`} aria-controls={`${uiId}-panel`} tabIndex={mode === 'overview' ? 0 : -1} aria-selected={mode === 'overview'} className={mode === 'overview' ? 'is-active' : ''} onClick={() => { setMode('overview'); setSelectedGraphId(null); setSelectedNoteId(null); }}><FolderTree />项目概览</button>
            <button type="button" role="tab" id={`${uiId}-path`} aria-controls={`${uiId}-panel`} tabIndex={mode === 'path' ? 0 : -1} aria-selected={mode === 'path'} className={mode === 'path' ? 'is-active' : ''} onClick={() => { setMode('path'); setSelectedGraphId(null); setSelectedNoteId(null); }}><Route />学习路径</button>
          </div>
          <button type="button" aria-expanded={filtersVisible} aria-controls={filtersVisible ? `${uiId}-filters` : undefined} className={filtersVisible ? 'is-active' : ''} onClick={() => setFiltersVisible((value) => !value)}><Filter />筛选</button>
          <div ref={layoutRef} className="knowledge-graph-layout-trigger"
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setLayoutOpen(false); }}
            onKeyDown={(event) => { if (event.key === 'Escape' && layoutOpen && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); layoutButtonRef.current?.focus(); setLayoutOpen(false); } }}>
            <button ref={layoutButtonRef} type="button" aria-expanded={layoutOpen} aria-controls={layoutOpen ? `${uiId}-layout` : undefined} className={layoutOpen ? 'is-active' : ''} onClick={() => setLayoutOpen((value) => !value)}><Settings2 />布局设置</button>
            {layoutOpen && <div id={`${uiId}-layout`} role="group" aria-label="图谱密度" className="knowledge-graph-layout-popover"><strong>图谱密度</strong><div>{densityCopy.map((item) => <button type="button" key={item.id} aria-pressed={density === item.id} className={density === item.id ? 'is-active' : ''} onClick={() => setDensity(item.id)}>{item.label}</button>)}</div><small>密度只改变当前数据切片的节点上限，不会隐藏或删除原始笔记。</small></div>}
          </div>
        </div>
      </header>

      {navigationNotice && <p role="status" className="knowledge-graph-navigation-notice">{navigationNotice}</p>}
      <div id={`${uiId}-panel`} role="tabpanel" aria-labelledby={`${uiId}-${mode}`} className={`knowledge-graph-workspace ${filtersVisible ? '' : 'is-filter-hidden'}`}>
        {filtersVisible && (
          <aside id={`${uiId}-filters`} className="knowledge-graph-filter-panel">
            <section>
              <h2>图谱范围</h2>
              <button type="button" disabled={mode === 'path'} className={(mode === 'knowledge' && !knowledgeScopeProjectId && !orphanScope) || (mode === 'overview' && !projectScopeId) ? 'is-active' : ''} onClick={() => { setSelectedGraphId(null); setSelectedNoteId(null); if (mode === 'knowledge') { setKnowledgeScopeProjectId(null); setKnowledgeCommunityId(null); setOrphanScope(false); setFocusKnowledgeId(null); } if (mode === 'overview') setProjectScopeId(null); }}><span className="knowledge-graph-range-icon"><Target /></span><span><strong>{mode === 'path' ? '选择根项目' : mode === 'overview' ? '全部项目' : '全部知识'}</strong><small>{mode === 'path' ? `${roots.length} 条可用路径` : `${notes.length} 个对象`}</small></span></button>
              {roots.map((root) => {
                const metrics = getProjectMetrics(root.id, notes);
                const active = mode === 'knowledge' ? knowledgeScopeProjectId === root.id : mode === 'overview' ? projectScopeId === root.id : pathRootId === root.id;
                return <button type="button" key={root.id} className={active ? 'is-active' : ''} onClick={() => selectRoot(root)} title={root.title}><span className="knowledge-graph-range-icon"><FolderTree /></span><span><strong>{root.title}</strong><small>{metrics.knowledgeCount} 个知识点 · {metrics.projectCount} 个项目</small></span></button>;
              })}
            </section>
            <section><h2>关系类型</h2>{relationCopy.filter((item) => modeRelations[mode].includes(item.id)).map((item) => <label key={item.id}><input type="checkbox" checked={enabledRelations.has(item.id)} onChange={() => toggleRelation(item.id)} /><i className={`relation-swatch is-${item.id}`} /><span>{item.label}</span></label>)}</section>
            <section><h2>掌握状态</h2><div className="knowledge-graph-mastery-filters">{activeMasteryCopy.map((item) => <button type="button" key={item.id} className={masteryFilter === item.id ? 'is-active' : ''} onClick={() => setMasteryFilter(item.id)}>{item.id !== 'all' && <i className={`mastery-dot mastery-${item.id}`} />}<span>{item.label}</span><small>{item.id === 'all' ? stats.knowledgeCount : masteryCounts[item.id]}</small></button>)}</div></section>
          </aside>
        )}

        <section className="knowledge-graph-canvas-panel">
          <div className="knowledge-graph-canvas-head">
            <div><nav aria-label="图谱层级">{slice.breadcrumbs.map((item, index) => <React.Fragment key={`${item.id}-${index}`}>{index > 0 && <ChevronRight />}<button type="button" onClick={() => handleBreadcrumb(item)} disabled={!item.reset && !item.scopeProjectId && !item.communityId}>{item.label}</button></React.Fragment>)}</nav><h2>{slice.title}</h2><p>{slice.subtitle}</p></div>
            {slice.aggregatedCount != null && slice.aggregatedCount > 0
              ? <span className="knowledge-graph-hidden-count is-aggregated">已聚合 {slice.aggregatedCount} 个知识点</span>
              : (slice.hiddenCount + elements.filteredCount) > 0 && <span className="knowledge-graph-hidden-count">当前收起 {slice.hiddenCount + elements.filteredCount} 个节点</span>}
          </div>
          <div className="knowledge-graph-flow-wrap">
            {elements.nodes.length > 0 ? (
              <ReactFlow<KnowledgeGraphFlowNode, KnowledgeGraphFlowEdge>
                key={viewKey}
                nodes={elements.nodes}
                edges={elements.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={(_event, node) => { const note = node.data.model.noteId ? notes.find((item) => item.id === node.data.model.noteId) : undefined; if (note) openExistingNote(note); }}
                onPaneClick={() => setSelectedGraphId(null)}
                nodesDraggable={false}
                nodesFocusable={false}
                nodesConnectable={false}
                edgesReconnectable={false}
                fitView
                fitViewOptions={{ padding: 0.24, duration: 420, minZoom: 0.48, maxZoom: 1.25 }}
                minZoom={0.18}
                maxZoom={2.1}
                panOnDrag
                zoomOnScroll
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--ln-border-subtle)" />
                <Controls position="bottom-left" showInteractive={false} />
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  style={{ width: 138, height: 90 }}
                  bgColor="var(--ln-bg-elevated)"
                  nodeComponent={KnowledgeMiniMapNode}
                  nodeBorderRadius={999}
                  nodeStrokeWidth={4}
                  nodeStrokeColor={(node) => ((node.data as KnowledgeGraphNodeData).model.kind === 'region' ? 'transparent' : 'var(--ln-bg-elevated)')}
                  nodeColor={(node) => {
                    const model = (node.data as KnowledgeGraphNodeData).model;
                    if (model.kind === 'region') return 'transparent';
                    if (node.selected || model.kind !== 'knowledge' || model.masteryBand === 'mastered' || model.masteryBand === 'confirmed') return '#2f5743';
                    if (model.masteryBand === 'weak' || model.masteryBand === 'needs_review') return '#c98a3d';
                    if (model.masteryBand === 'unrated') return '#a0a9a2';
                    if (model.masteryBand === 'solid') return '#557a62';
                    return '#a2b9a8';
                  }}
                  maskColor="rgba(47, 87, 67, 0.09)"
                  maskStrokeColor="rgba(47, 87, 67, 0.48)"
                  maskStrokeWidth={2}
                  ariaLabel="知识图谱缩略导航"
                />
              </ReactFlow>
            ) : <div className="knowledge-graph-canvas-empty"><Network /><h3>当前筛选没有可显示节点</h3><p>尝试切换掌握状态或重新打开关系类型。</p></div>}
          </div>
          <footer className="knowledge-graph-legend">{activeMasteryCopy.filter(item => item.id !== 'all').map(item => <span key={item.id}><i className={`mastery-dot mastery-${item.id}`} />{item.label}</span>)}<em>{slice.nodes.some((node) => node.kind === 'aggregate') && !slice.nodes.some((node) => node.kind === 'knowledge') ? '单击知识簇进入下一层' : '双击知识点打开笔记'}</em></footer>
        </section>

        <GraphInspector notes={notes} mode={mode} selectedModel={selectedModel} slice={slice} onOpenNote={openExistingNote} onStartReview={onStartReview} onSelectRelated={chooseNote} />
      </div>
    </div>
  );
};
