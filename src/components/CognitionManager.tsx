import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, getViewportForBounds, useNodesInitialized, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Bot, ExternalLink, Network, RefreshCw, Search, MoreHorizontal, Pencil, Link, Trash2, Plus, X } from 'lucide-react';
import { CognitionCanvasMenu, type CognitionCanvasAction } from './CognitionCanvasMenu';
import { loadPersonalCognition, syncSavedRestatementsForCognition, subscribePersonalCognition } from '../services/cognition/store';
import { buildCognitionManagement, COGNITION_GRAPH_FILTERS, COGNITION_OVERVIEW_NODE_SIZE, cognitionGraphPositions, cognitionOverviewPositions, type CognitionGraphFilter, type ManagedCognitionNode, type ManagedCognitionGroup } from '../services/cognition/management';
import { COGNITION_RELATION_LABELS as RELATION_LABELS, type CognitionRelation as RelationType, type CognitionFile } from '../services/cognition/types';
import { latestCognition } from '../services/cognition/core';
import { cognitionRoleLabel } from '../services/cognition/roles';
import { CognitionFlowStructureDetails } from './CognitionFlowStructureDetails';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { CognitionEditForm } from './CognitionEditForm';
import { CognitionHistory } from './PersonalCognitionPanel';
import { useCognitionWrite } from './useCognitionWrite';
import { useDialog } from './useDialog';
import './PersonalCognition.css';
import './CognitionManager.css';
import { cognitionWindowApi } from '../services/cognition/managerWindow';
import { CognitionGraphEditDialog, type CognitionGraphEditIntent } from './CognitionGraphEditDialog';
import { CognitionAssistant, type CognitionAssistantFocus } from './CognitionAssistant';
import { cognitionCanvasLayoutKey, moveCognitionCanvasNodes, resetCognitionCanvasLayout, type CognitionCanvasLayouts, type CognitionCanvasPosition } from '../services/cognition/canvasLayout';

function ForgetDialog({ title, nodeCount, relationCount, busy, error, stale, onCancel, onConfirm }: { title: string; nodeCount: number; relationCount: number; busy: boolean; error: string; stale: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDivElement>(null); useDialog(true, ref, busy ? undefined : onCancel);
  return <div className="cm-scrim"><div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="cm-forget-title" className="cm-confirm cognition-ui">
    <h2 id="cm-forget-title">忘记“{title}”？</h2><p>将永久移除这份记录当前的 {nodeCount} 个认知块、{relationCount} 条相关关系（包括跨活动关联），以及该记录的全部分支和版本历史；其他记录的认知块不删除，也不删除来源笔记或复盘图。此操作不能在应用中撤销。</p>
    {stale && <p role="alert">记录已变化，请取消后重新核对。</p>}{error && <p role="alert" className="cognition-error">{error}</p>}
    <div className="cognition-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" disabled={busy || stale} onClick={onConfirm} className="cm-danger">{busy ? '正在移除…' : '确认忘记整份记录'}</button></div>
  </div></div>;
}

function EditUnderstandingDialog({ busy, onCancel, children }: { busy: boolean; onCancel: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(true, ref, () => { if (!busy && allowCognitionLeave(ref.current)) onCancel(); });
  return <div className="cm-scrim"><div ref={ref} className="cm-graph-dialog" role="dialog" aria-modal="true" aria-labelledby="cm-understanding-title">
    <div className="cm-dialog-heading"><h2 id="cm-understanding-title">编辑认知块</h2><button type="button" aria-label="关闭编辑" disabled={busy} onClick={() => { if (allowCognitionLeave(ref.current)) onCancel(); }}><X aria-hidden="true" /></button></div>
    {children}
  </div></div>;
}

/** Refit only after a real layout/size change, never on selection or draft edits. */
function FitCognitionViewport({ layoutKey }: { layoutKey: string }) {
  const initialized = useNodesInitialized(), { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const width = useStore(store => store.width), height = useStore(store => store.height);
  useEffect(() => {
    if (!initialized || !width || !height) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // This read-only graph has controlled nodes. Fit the viewport directly;
        // do not queue a node update merely to move the camera.
        const bounds = getNodesBounds(getNodes());
        void setViewport(getViewportForBounds(bounds, width, height, .1, 1, { left: '60px', right: '28px', y: '28px' }), { duration: 0 });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, layoutKey, getNodes, getNodesBounds, setViewport, width, height]);
  return null;
}

/** One local graph projection shared with Agent inquiry. Layout never writes associations. */
export function CognitionManager() {
  const api = cognitionWindowApi();
  const [file, setFile] = useState<CognitionFile | null>(null), [scope, setScope] = useState<string | undefined>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [syncWarning, setSyncWarning] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<CognitionGraphFilter>('all');
  const [groupId, setGroupId] = useState<string | null>(null), [nodeId, setNodeId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [page, setPage] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false), [assistantMounted, setAssistantMounted] = useState(false);
  const [assistantState, setAssistantState] = useState({ busy: false, pending: false });
  const [assistantFocus, setAssistantFocus] = useState<CognitionAssistantFocus>();
  const assistantStateRef = useRef(assistantState), manualBusy = useRef(false);
  const assistantActive = assistantState.busy || assistantState.pending;
  const onAssistantState = useCallback((state: { busy: boolean; pending: boolean }) => {
    assistantStateRef.current = state;
    setAssistantState(previous => previous.busy === state.busy && previous.pending === state.pending ? previous : state);
    cognitionWindowApi()?.cognitionManager?.setBusy(manualBusy.current || state.busy);
  }, []);
  const [draftTarget, setDraftTarget] = useState<{ group: ManagedCognitionGroup; node: ManagedCognitionNode } | null>(null);
  const [forget, setForget] = useState<{ id: string; revision: number; title: string; nodeCount: number; relationCount: number } | null>(null);
  const [graphEdit, setGraphEdit] = useState<CognitionGraphEditIntent | null>(null), [relationPage, setRelationPage] = useState(0), [groupPage, setGroupPage] = useState(0);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  const [canvasLayouts, setCanvasLayouts] = useState<CognitionCanvasLayouts>({});
  const [layoutReset, setLayoutReset] = useState(0);
  const canvasLayoutsRef = useRef(canvasLayouts); canvasLayoutsRef.current = canvasLayouts;
  const canvasDrag = useRef<{ key: string; previous?: Record<string, CognitionCanvasPosition>; cancelled?: boolean } | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number; kind: 'node' | 'edge' | 'pane' | 'group'; id?: string; origin: HTMLElement | SVGElement | null } | null>(null);
  useEffect(() => { setCanvasMenu(null); }, [file?.revision, scope, groupId, query, filter, page, groupPage, busy, assistantActive, editing, graphEdit, forget, assistantOpen]);
  const mapRef = useRef<HTMLElement>(null), [mapSize, setMapSize] = useState({ width: 960, height: 600 });
  useLayoutEffect(() => {
    if (!mapRef.current) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width <= 0 || height <= 0) return;
      const next = { width: Math.round(width), height: Math.max(230, Math.round(height) - 90) };
      setMapSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    }); observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, []);
  const generation = useRef(0), active = useRef(true), scopeRef = useRef<string | undefined>(undefined), writeLock = useRef(false);
  function reportBusy(value: boolean) { manualBusy.current = value; api?.cognitionManager?.setBusy(value || assistantStateRef.current.busy); if (active.current) setBusy(value); }
  function accept(next: CognitionFile) { generation.current++; setFile(next); setError(''); setLoading(false); }
  async function reload(sync = false) {
    if (writeLock.current) return;
    const token = ++generation.current; setLoading(true);
    try {
      const before = await api?.userState?.getAgentTaskScope?.();
      if (!active.current || token !== generation.current) return;
      if (scopeRef.current && before !== scopeRef.current) {
        setFile(null); setGroupId(null); setNodeId(null); setEditing(false); setDraftTarget(null); setForget(null); setGraphEdit(null);
        setNotice('资料库已变化，旧窗口内容已清除，请重新核对当前认知。');
      }
      const syncResult = sync ? await syncSavedRestatementsForCognition() : undefined;
      if (active.current && syncResult) setSyncWarning(syncResult.warning);
      const next = await loadPersonalCognition();
      const after = await api?.userState?.getAgentTaskScope?.();
      if (before !== after) throw new Error('读取期间资料库发生变化，请重新读取');
      if (!active.current || token !== generation.current) return;
      scopeRef.current = before; setScope(before); setFile(next); setError('');
    } catch (cause) { if (active.current && token === generation.current) setError(cause instanceof Error ? cause.message : '读取失败'); }
    finally { if (active.current && token === generation.current) setLoading(false); }
  }
  useEffect(() => {
    active.current = true; void reload(true);
    const off = subscribePersonalCognition(() => void reload());
    const focus = () => void reload(); window.addEventListener('focus', focus);
    return () => { active.current = false; generation.current++; off(); window.removeEventListener('focus', focus); };
  }, []);
  const removal = useCognitionWrite(next => { accept(next); setForget(null); setGroupId(null); setNodeId(null); setNotice('已忘记该记录，来源笔记未删除。'); }, { lock: writeLock, onBusyChange: reportBusy });
  const model = useMemo(() => file ? buildCognitionManagement(file) : null, [file]);
  const filtered = useMemo(() => file ? buildCognitionManagement(file, { query, filter }) : null, [file, query, filter]);
  const group = draftTarget?.group || model?.groups.find(item => item.id === groupId), selected = draftTarget?.node || group?.nodes.find(node => node.id === nodeId);
  const record = file?.records.find(record => record.id === (selected?.recordId || group?.recordId));
  const revision = record && latestCognition(record);
  const selectedGraph = revision?.branches.find(branch => branch.id === selected?.branchId)?.graph;
  const source = revision?.source;
  const expressionSource = record && [...record.revisions].reverse().map(item => item.source)
    .find(item => item.kind === 'restatement' || item.kind === 'review_answer');
  const sourceNote = record?.revisions.map(revision => revision.source).find(source => 'noteId' in source && source.noteId);
  const sourceNoteId = sourceNote && 'noteId' in sourceNote ? sourceNote.noteId : undefined;
  function chooseGroup(id: string | null) { if (busy || forget || graphEdit || !allowCognitionLeave()) return false; setEditing(false); setDraftTarget(null); setGroupId(id); setNodeId(null); setGroupPage(0); setRelationPage(0); return true; }
  function chooseNode(node: ManagedCognitionNode) { if (busy || forget || graphEdit || !allowCognitionLeave()) return; setEditing(false); setDraftTarget(null); setNodeId(node.id); setGroupPage(Math.floor((group?.nodes.findIndex(n => n.id === node.id) || 0) / 120)); setRelationPage(0); }
  function startGraphEdit(intent: CognitionGraphEditIntent) { if (busy || assistantActive || forget || graphEdit || !allowCognitionLeave()) return; setEditing(false); setDraftTarget(null); setGraphEdit(intent); }
  function editNode(node: ManagedCognitionNode) {
    if (busy || assistantActive || forget || graphEdit || editing || !allowCognitionLeave()) return;
    const owner = model?.groups.find(item => item.nodes.some(n => n.id === node.id));
    if (!owner) return;
    setGroupId(owner.id); setNodeId(node.id); setDraftTarget({ group: owner, node }); setEditing(true);
  }
  function discussNode(node: ManagedCognitionNode) {
    if (busy || assistantActive || editing || forget || graphEdit || !allowCognitionLeave()) return;
    setAssistantFocus({ id: crypto.randomUUID(), reference: { recordId: node.recordId, revisionId: node.revisionId, branchId: node.branchId, nodeId: node.nodeId } });
    setAssistantMounted(true); setAssistantOpen(true);
  }
  function openCanvasMenu(event: Pick<React.MouseEvent, 'preventDefault' | 'stopPropagation' | 'currentTarget' | 'clientX' | 'clientY'> | MouseEvent, kind: 'node' | 'edge' | 'pane' | 'group', id?: string) {
    event.preventDefault(); event.stopPropagation();
    if (busy || editing || forget || graphEdit) return;
    if (kind === 'node') { setNodeId(id!); setRelationPage(0); }
    const origin = event.currentTarget instanceof HTMLElement || event.currentTarget instanceof SVGElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCanvasMenu({ x: event.clientX, y: event.clientY, kind, id, origin });
  }
  function activateNode(id: string) { const node = group?.nodes.find(item => item.id === id); if (node) chooseNode(node); else if (!group) chooseGroup(id); }
  function keyboardActivate(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target instanceof Element && event.target.closest('button')) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopPropagation();
      if (busy || editing || forget || graphEdit) return;
      const origin = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node, .react-flow__edge')!;
      const bounds = origin.getBoundingClientRect();
      if (group && origin.classList.contains('react-flow__node')) { setNodeId(id); setRelationPage(0); }
      setCanvasMenu({ kind: origin.classList.contains('react-flow__edge') ? 'edge' : group ? 'node' : 'group', id, x: bounds.left + 24, y: bounds.top + 24, origin }); return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if ((event.target as Element).closest('.react-flow__edge')) {
      event.preventDefault(); event.stopPropagation();
      const origin = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__edge')!, bounds = origin.getBoundingClientRect();
      if (!busy && !editing && !forget && !graphEdit) setCanvasMenu({ kind: 'edge', id, x: bounds.left + 24, y: bounds.top + 24, origin }); return;
    }
    event.preventDefault(); event.stopPropagation(); activateNode(id);
  }
  const pageSize = 80, pageCount = Math.max(1, Math.ceil((filtered?.groups.length || 0) / pageSize)), currentPage = Math.min(page, pageCount - 1);
  const overview = filtered?.groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize) || [];
  const groupPages = Math.max(1, Math.ceil((group?.nodes.length || 0) / 120)), currentGroupPage = Math.min(groupPage, groupPages - 1);
  const visibleNodes = group?.nodes.slice(currentGroupPage * 120, (currentGroupPage + 1) * 120) || [];
  const ids = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = group?.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 240) || [];
  const positions = cognitionGraphPositions(visibleNodes, visibleEdges);
  const overviewPositions = useMemo(() => cognitionOverviewPositions(overview, mapSize), [filtered, currentPage, mapSize]);
  const canvasKey = cognitionCanvasLayoutKey(scope, group?.id);
  const canMoveNodes = !!file && !loading && !busy && !assistantActive && !editing && !forget && !graphEdit && !canvasMenu;
  const layoutContext = useRef({ key: canvasKey, enabled: canMoveNodes });
  layoutContext.current = { key: canvasKey, enabled: canMoveNodes };
  useEffect(() => {
    const drag = canvasDrag.current;
    if (!drag || drag.cancelled || canMoveNodes && drag.key === canvasKey) return;
    drag.cancelled = true;
    setCanvasLayouts(previous => drag.previous ? { ...previous, [drag.key]: drag.previous } : resetCognitionCanvasLayout(previous, drag.key));
  }, [canMoveNodes, canvasKey]);
  const selectedEdges = selected ? group?.edges.filter(edge => edge.source === selected.id || edge.target === selected.id) || [] : [];
  const relationPages = Math.max(1, Math.ceil(selectedEdges.length / 30)), currentRelationPage = Math.min(relationPage, relationPages - 1);
  useEffect(() => { setRelationPage(previous => Math.min(previous, relationPages - 1)); }, [relationPages]);
  const nodes: Node[] = group ? visibleNodes.map(node => ({ id: node.id, position: canvasLayouts[canvasKey]?.[node.id] || positions.get(node.id)!,
    ariaRole: 'group',
    sourcePosition: Position.Right, targetPosition: Position.Left,
    selected: node.id === nodeId, className: `cm-node ${node.needsReview ? 'needs-review' : ''} ${node.stance === 'tentative' ? 'tentative' : ''}`,
    ariaLabel: `${node.stance === 'endorsed' ? '当前认同' : '暂定理解'}，${node.text}`,
    data: { label: <><span className="cm-node-kind">{cognitionRoleLabel(node)}{node.needsReview ? ' · 待复核' : ''}</span><button type="button" className="cm-node-more nodrag nopan" aria-label="认知块操作" aria-haspopup="menu" disabled={busy || editing || !!forget || !!graphEdit} onDoubleClick={event => event.stopPropagation()} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); openCanvasMenu(event, 'node', node.id); setCanvasMenu(value => value && { ...value, x: bounds.right, y: bounds.bottom }); }}><MoreHorizontal aria-hidden="true" /></button><strong>{node.text}</strong><span className="cm-node-foot">{node.stance === 'endorsed' ? '当前认同' : '暂定理解'}{node.degree ? ` · ${node.degree} 个相邻节点` : ' · 孤立节点'}</span></> } }))
    : overview.map(item => ({ id: item.id, ariaRole: 'button', position: canvasLayouts[canvasKey]?.[item.id] || overviewPositions.get(item.id)!, style: COGNITION_OVERVIEW_NODE_SIZE,
      className: 'cm-node cm-group',
      ariaLabel: `${item.title}，${item.nodes.length} 个节点，${item.edges.length} 条关系，展开认知群`,
      data: { label: <><span className="cm-node-kind">{item.nodes.length > 1 ? '关联认知群' : '孤立节点'}</span><strong>{item.title}</strong>
        <span className="cm-node-excerpt">{item.nodes.find(node => node.role === 'claim')?.text || item.nodes[0].text}</span>
        <span className="cm-node-foot">{item.nodes.length} 个节点 · {item.edges.length} 条关系</span></> } }));
  const edges: Edge[] = visibleEdges.map(edge => ({ ...edge, type: 'smoothstep', focusable: true, interactionWidth: 24, label: RELATION_LABELS[edge.relation as RelationType],
    markerEnd: { type: MarkerType.ArrowClosed }, className: `cm-edge ${edge.relation}`, style: { strokeDasharray: ['context', 'method_for', 'relates'].includes(edge.relation) ? '5 4' : undefined },
    ariaLabel: `${RELATION_LABELS[edge.relation as RelationType]}，${edge.reason || ''}` }));
  // Camera refits follow automatic topology/size changes, never hand dragging.
  const layoutKey = JSON.stringify([canvasKey, layoutReset, mapSize, nodes.map(node => [node.id, (group ? positions : overviewPositions).get(node.id), measurements[node.id]])]);
  const flowNodes = nodes.map(node => ({ ...node, measured: measurements[node.id] }));
  const menuNode = canvasMenu?.kind === 'node' ? model?.groups.flatMap(item => item.nodes).find(node => node.id === canvasMenu.id) : undefined;
  const menuEdge = canvasMenu?.kind === 'edge' ? group?.edges.find(edge => edge.id === canvasMenu.id) : undefined;
  const writeDisabled = busy || assistantActive || loading || !file;
  const menuActions: CognitionCanvasAction[] = menuNode ? [
    { label: '更新这项理解', icon: <Pencil />, disabled: writeDisabled, run: () => editNode(menuNode) },
    { label: '建立关联', icon: <Link />, disabled: writeDisabled, run: () => startGraphEdit({ action: 'add_relation', node: menuNode }) },
    { label: '与认知助手讨论', icon: <Bot />, disabled: writeDisabled, run: () => discussNode(menuNode) },
    { label: '删除这个认知块…', icon: <Trash2 />, danger: true, disabled: writeDisabled, run: () => startGraphEdit({ action: 'delete_node', node: menuNode }) },
  ] : menuEdge ? [
    { label: '编辑关系', icon: <Pencil />, disabled: writeDisabled, run: () => startGraphEdit({ action: 'update_relation', edge: menuEdge }) },
    { label: '删除关系', icon: <Trash2 />, danger: true, disabled: writeDisabled, run: () => startGraphEdit({ action: 'delete_relation', edge: menuEdge }) },
  ] : canvasMenu?.kind === 'group' ? [{ label: '展开认知群', icon: <Network />, run: () => { chooseGroup(canvasMenu.id!); } }]
    : canvasMenu?.kind === 'pane' ? [{ label: '新增认知块', icon: <Plus />, disabled: writeDisabled, run: () => startGraphEdit({ action: 'add_node' }) }] : [];
  return <main className={`cm-shell cognition-ui${assistantOpen ? ' cm-assistant-open' : ''}`}>
    <header className="cm-header"><div><span className="cm-eyebrow">PERSONAL COGNITION · PRIVATE</span><h1><Network aria-hidden="true" />我的认知图谱</h1><p>我相信什么，如何形成关联，又有哪些理解正在变化。</p></div>
      <div className="cognition-actions"><button type="button" aria-expanded={assistantOpen} onClick={() => {
        if (!assistantOpen && !allowCognitionLeave()) return;
        setAssistantMounted(true); setAssistantOpen(value => !value);
      }}><Bot aria-hidden="true" />{assistantOpen ? '返回图谱' : `认知助手${assistantState.busy ? ' · 处理中' : assistantState.pending ? ' · 待确认' : ''}`}</button>
        <button type="button" disabled={loading || busy || assistantActive || !file} onClick={() => startGraphEdit({ action: 'add_node' })}>新增认知块</button><button type="button" disabled={loading || busy} onClick={() => void reload(true)}><RefreshCw aria-hidden="true" />重新读取</button></div></header>
    <div className="cm-toolbar"><label className="cm-search"><Search aria-hidden="true" /><span className="sr-only">搜索认知原话或主题</span><input maxLength={200} disabled={busy || !!forget} value={query} onChange={event => { if (chooseGroup(null)) { setQuery(event.target.value); setPage(0); } }} placeholder="搜索原话或主题" /></label>
      <div className="cm-filters" aria-label="认知筛选">{COGNITION_GRAPH_FILTERS.map(item => <button type="button" key={item.id} disabled={busy || !!forget} aria-pressed={filter === item.id} onClick={() => { if (chooseGroup(null)) { setFilter(item.id); setPage(0); } }}>{item.label}</button>)}</div></div>
    <div className="cm-status" role={error ? 'alert' : 'status'}>{error ? `读取失败，已显示的内容可能不是最新：${error}` : loading ? '正在读取当前认知…' : [syncWarning, notice || '仅展示已记录的个人理解，不代表客观事实或已经掌握。'].filter(Boolean).join(' ')}</div>
    <div className={`cm-workspace${assistantOpen ? ' has-assistant' : ''}`}><div className="cm-body"><section ref={mapRef} className={`cm-map${canMoveNodes ? ' is-layout-editable' : ''}`} aria-label="个人认知关系图" onKeyDownCapture={event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node, .react-flow__edge') : null;
      const id = target?.dataset.id || target?.getAttribute('data-id');
      if (id) keyboardActivate(event, id);
    }}>
      <div className="cm-map-heading">{group ? <button type="button" disabled={busy} onClick={() => chooseGroup(null)}><ArrowLeft aria-hidden="true" />返回认知概览</button> : <span>按已保存的连接聚合，不自动补造关系</span>}
        <span>{group ? `${group.nodes.length} 个节点 · ${group.edges.length} 条关系` : `${filtered?.groups.length || 0} 个认知群`}</span>
        <button type="button" className="cm-layout-reset" disabled={!canMoveNodes || !Object.keys(canvasLayouts[canvasKey] || {}).length} onClick={() => { setCanvasLayouts(previous => resetCognitionCanvasLayout(previous, canvasKey)); setLayoutReset(value => value + 1); }}><RefreshCw aria-hidden="true" />恢复自动布局</button>
        {!group && !!model?.brokenEdges.length && <details className="cm-broken"><summary>失效引用（{model.brokenEdges.length}）</summary><div><p>来源节点已撤回或被替换。</p>{model.brokenEdges.map(edge => <div className="cm-relation" key={edge.id}><span>{RELATION_LABELS[edge.relation as RelationType]} · {edge.reason || '未填写说明'}</span><button type="button" disabled={writeDisabled} onClick={() => startGraphEdit({ action: 'update_relation', edge })}>重新指定节点</button><button type="button" disabled={writeDisabled} onClick={() => startGraphEdit({ action: 'delete_relation', edge })}>移除失效关系</button></div>)}</div></details>}</div>
      <p className="cm-map-hint">{group ? '拖动节点拉开连线 · 双击节点编辑 · 右键节点或连线操作' : '拖动认知群整理位置 · 点击展开'} · 布局仅在本窗口保留</p>
      {!!group && (group.nodes.length > 120 || group.edges.length > 240) && <p role="status" className="cm-bound">画布第 {currentGroupPage + 1}/{groupPages} 页，每页至多 120 个节点、240 条页内关系；跨页关系可在节点详情分页查看，不代表断链。</p>}
      {nodes.length ? <ReactFlow key={`${canvasKey}:${group ? currentGroupPage : `${currentPage}-${filter}-${query}`}`} nodes={flowNodes} edges={group ? edges : []} fitView fitViewOptions={{ minZoom: .1, maxZoom: 1, padding: .14 }} minZoom={.1} maxZoom={1.8}
        nodesDraggable={canMoveNodes} nodesConnectable={false} edgesReconnectable={false} autoPanOnNodeFocus={false} deleteKeyCode={null} proOptions={{ hideAttribution: true }}
        onNodeDragStart={() => {
          if (!layoutContext.current.enabled || layoutContext.current.key !== canvasKey) return;
          setCanvasMenu(null);
          canvasDrag.current = { key: canvasKey, previous: canvasLayoutsRef.current[canvasKey] };
        }}
        onNodeDragStop={() => { canvasDrag.current = null; }}
        onNodesChange={changes => {
          // Position changes are a separate, session-only layout. They never
          // enter cognition writes, relationship edits or version history.
          if (layoutContext.current.enabled && layoutContext.current.key === canvasKey && !canvasDrag.current?.cancelled) {
            const moves = changes.flatMap(change => change.type === 'position' && change.position
              && (change.dragging !== false || canvasDrag.current) ? [{ id: change.id, position: change.position }] : []);
            if (moves.length) setCanvasLayouts(previous => moveCognitionCanvasNodes(previous, canvasKey, moves, new Set(nodes.map(node => node.id))));
          }
          const dimensions = changes.filter(change => change.type === 'dimensions' && change.dimensions);
          if (!dimensions.length) return;
          setMeasurements(previous => {
            const next: typeof previous = {}; let changed = false;
            for (const node of nodes) if (previous[node.id]) next[node.id] = previous[node.id];
            for (const change of dimensions) if (change.type === 'dimensions' && change.dimensions) {
              if (previous[change.id]?.width !== change.dimensions.width || previous[change.id]?.height !== change.dimensions.height) changed = true;
              next[change.id] = change.dimensions;
            }
            return changed || Object.keys(next).length !== Object.keys(previous).length ? next : previous;
          });
        }}
        zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => { setCanvasMenu(null); activateNode(node.id); }}
        onNodeDoubleClick={(_event, node) => { const target = group?.nodes.find(item => item.id === node.id); if (target) editNode(target); }}
        onNodeContextMenu={(event, node) => openCanvasMenu(event, group ? 'node' : 'group', node.id)}
        onEdgeClick={(event, edge) => openCanvasMenu(event, 'edge', edge.id)}
        onEdgeContextMenu={(event, edge) => openCanvasMenu(event, 'edge', edge.id)}
        onPaneContextMenu={event => openCanvasMenu(event, 'pane')}
        onPaneClick={() => setCanvasMenu(null)} onMoveStart={event => { if (event) setCanvasMenu(null); }}>
        <FitCognitionViewport layoutKey={layoutKey} /><Background gap={24} size={1} /><Controls showInteractive={false} />
      </ReactFlow> : <div className="cm-empty"><Network aria-hidden="true" /><h2>{loading ? '正在读取' : model?.summary.nodes ? '没有匹配的认知' : error || syncWarning ? '暂无可展示的认知' : '从一次自己的表达开始'}</h2>
        <p>{error || syncWarning ? '部分记录未能读取或同步，请重新读取后再核对。' : model?.summary.nodes ? '试试更短的关键词，或切回全部认知。' : '保存复述或结束复习后，你的理解及复盘中的关系会显示在这里。'}</p></div>}
      {!group && pageCount > 1 && <div className="cm-pagination"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
      {group && groupPages > 1 && <div className="cm-pagination"><button type="button" disabled={!currentGroupPage || busy} onClick={() => { if (allowCognitionLeave()) setGroupPage(currentGroupPage - 1); }}>上一组节点</button><span>{currentGroupPage + 1} / {groupPages}</span><button type="button" disabled={currentGroupPage + 1 >= groupPages || busy} onClick={() => { if (allowCognitionLeave()) setGroupPage(currentGroupPage + 1); }}>下一组节点</button></div>}
      <footer className="cm-legend">实线：支持／反对 · 虚线：限制／例外／背景／方法／相关。限制或例外不等于完全反对；连通不等于逻辑完整。</footer>
    </section><aside className="cm-detail" aria-label="认知详情">
      {!group ? <><span className="cm-eyebrow">当前认知</span><h2>理解如何相连</h2><div className="cm-metrics">{model && [['当前认同', model.summary.endorsed], ['暂定理解', model.summary.tentative], ['关联认知群', model.summary.connectedGroups], ['孤立节点', model.summary.isolated], ['关系待复核', model.summary.needsReview]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <p>选择一个认知群查看其中的主张、前提与关系；再选择节点查看原话、来源和变化。</p><p className="cm-muted">这里呈现你在学习时接受的理解，不另行推断“已经内化”的心理状态，也不改变掌握度分数。关系待复核不等于已判定逻辑断链；跨活动只显示你明确建立的连接。</p>
        </>
        : <><span className="cm-eyebrow">{selected ? '认知节点' : '关联认知群'}</span><h2>{selected?.title || group.title}</h2><p className="cm-muted">记录于 {new Date(selected?.at || group.at).toLocaleString('zh-CN')}</p>
          {!selected && <p>选择画布上的节点，查看你具体认同了什么，以及与它相连的前提。</p>}
          {selected && <><div className="cm-belief"><span>{selected.stance === 'endorsed' ? '当前认同' : '暂定理解'}{selected.needsReview ? ' · 关系待复核' : ''}</span><p>{selected.text}</p>{!!selected.conditions?.length && <details><summary>已记录条件（{selected.conditions.length}）</summary><ul>{selected.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul></details>}</div>
            <h3>已记录的关系（{selectedEdges.length}）</h3>{selectedEdges.slice(currentRelationPage * 30, (currentRelationPage + 1) * 30).map(edge => {
              const neighbor = group.nodes.find(node => node.id === (edge.source === selected.id ? edge.target : edge.source))!;
              return <div key={edge.id} data-edge-id={edge.id} className="cm-relation"><button type="button" disabled={busy} onClick={() => chooseNode(neighbor)}><span>{edge.target === selected.id ? '←' : '→'} {RELATION_LABELS[edge.relation as RelationType]}</span><strong>{neighbor.text}</strong></button>{edge.reason && <details><summary>关系说明</summary><p>{edge.reason}</p></details>}</div>;
            })}{relationPages > 1 && <div className="cognition-actions"><button type="button" disabled={!currentRelationPage || busy} onClick={() => setRelationPage(currentRelationPage - 1)}>上一页关系</button><span>{currentRelationPage + 1}/{relationPages}</span><button type="button" disabled={currentRelationPage + 1 >= relationPages || busy} onClick={() => setRelationPage(currentRelationPage + 1)}>下一页关系</button></div>}{selected.degree === 0 && <p className="cm-muted">没有已记录的连接；这不是逻辑错误或认知缺陷判定。</p>}</>}
          <details className="cm-provenance"><summary>来源与原始表达</summary><p>{source?.kind === 'restatement' ? `学习复述 · ${source.sessionId}` : source?.kind === 'review_answer' ? `复习回答 · ${source.observation.activityId}` : source?.kind === 'manual_revision' ? '在认知库中主动更新' : '从论证编辑器主动保存'}</p>
            {expressionSource?.kind === 'restatement' && expressionSource.originalText && <p className="cm-raw">{expressionSource.originalText}</p>}{expressionSource?.kind === 'review_answer' && <><p>提问：{expressionSource.observation.question}</p><p className="cm-raw">{expressionSource.observation.answer}</p><p>提示程度：{expressionSource.observation.hintLevel ?? '未记录'}</p></>}
            {sourceNoteId && api?.argument?.openNote && <button type="button" disabled={busy} onClick={() => void api.argument?.openNote(sourceNoteId).catch(() => setError('来源笔记打开失败'))}><ExternalLink aria-hidden="true" />打开来源笔记</button>}</details>
          {selected && selectedGraph && <CognitionFlowStructureDetails graph={selectedGraph} nodeId={selected.nodeId} />}
          {record && <CognitionHistory revisions={record.revisions} />}
          {!!file?.linkHistory?.length && <details><summary>跨活动关系变更记录</summary>{file.linkHistory.filter(row => [row.before, row.after].some(link => link && [link.source.recordId, link.target.recordId].includes(record?.id || ''))).map(row => <p key={row.id}>{new Date(row.at).toLocaleString('zh-CN')} · {row.before ? '移除旧关联' : '建立关联'} · {row.reason}{row.meaning && ` · 意图解释：${row.meaning.interpretation}`}</p>)}</details>}
          <details className="cm-record-management"><summary>记录管理</summary><button type="button" className="cm-forget cm-danger" disabled={busy || assistantActive || editing} onClick={() => { if (file && record) { const branches = latestCognition(record).branches; removal.clearError(); setForget({ id: record.id, revision: file.revision, title: branches[0].graph.title || '未命名认知', nodeCount: branches.reduce((n, branch) => n + branch.graph.nodes.length, 0), relationCount: branches.reduce((n, branch) => n + branch.graph.edges.length, 0) + (file.links || []).filter(link => link.source.recordId === record.id || link.target.recordId === record.id).length }); } }}>忘记整份认知记录…</button></details></>}
    </aside></div>
    {assistantMounted && file && <CognitionAssistant key={scope || 'browser'} open={assistantOpen} blocked={busy || editing || !!graphEdit || !!forget}
      focusRequest={assistantFocus} onClose={() => setAssistantOpen(false)} onStateChange={onAssistantState} />}
    </div>
    {canvasMenu && menuActions.length > 0 && <CognitionCanvasMenu {...canvasMenu} label={canvasMenu.kind === 'node' ? '认知块操作' : canvasMenu.kind === 'edge' ? '关系操作' : '画布操作'} actions={menuActions} onClose={() => setCanvasMenu(null)} />}
    {editing && selected && file && <EditUnderstandingDialog busy={busy} onCancel={() => { if (!busy) { setEditing(false); setDraftTarget(null); } }}>
      <CognitionEditForm key={selected.id} file={file} storageScopeId={scope} recordId={selected.recordId} initialTarget={{ branchId: selected.branchId, nodeId: selected.nodeId }} writeLock={writeLock} onBusyChange={reportBusy}
        onCancel={() => { if (!busy) { setEditing(false); setDraftTarget(null); } }} onSaved={next => { accept(next); setEditing(false); setDraftTarget(null); setNotice('理解已更新，旧版本仍保留。'); }} />
    </EditUnderstandingDialog>}
    {forget && <ForgetDialog title={forget.title} nodeCount={forget.nodeCount} relationCount={forget.relationCount} busy={busy} error={removal.error} stale={forget.revision !== file?.revision} onCancel={() => setForget(null)} onConfirm={() => void removal.write({ kind: 'forget', recordId: forget.id, confirmed: true, expectedRevision: forget.revision, ...(scope ? { storageScopeId: scope } : {}) })} />}
    {graphEdit && file && <CognitionGraphEditDialog file={file} intent={graphEdit} storageScopeId={scope} writeLock={writeLock} onBusyChange={reportBusy} onCancel={() => setGraphEdit(null)} onSaved={next => { accept(next); setGraphEdit(null); setGroupId(null); setNodeId(null); setNotice('认知图谱已更新，旧版本仍保留。'); }} />}
  </main>;
}
