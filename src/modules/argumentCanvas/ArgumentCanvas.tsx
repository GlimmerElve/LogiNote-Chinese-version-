/**
 * 受控画布组件（loginote 版，完整迁移编辑器交互）
 *
 * props 进 ArgDoc、onChange 出 ArgDoc。内部用 zustand canvasStore 维护编辑态。
 * 完整支持：拖拽、连线、双击编辑、右键菜单（切换类型/删除）、快捷键（Tab/Shift+Tab/Ctrl+Enter/Delete/Ctrl+Z/Ctrl+Y/Ctrl+C/Ctrl+V）、问题气泡。
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  SelectionMode,
  type Connection,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ArgDoc, ArgNode, ArgEdge, ArgumentRole, RelationType } from '../../services/argumentDoc/types';
import { RELATION_LABELS } from '../../services/argumentDoc/types';
import { LEGACY_TYPE_FOR_ROLE, recommendedRelation } from '../../services/argumentDoc/editorModel';
import { isStructureCheckFresh } from '../../services/argumentDoc/structureReview';
import { hasActiveDialog } from '../../components/useDialog';
import { RelationDialog, type RelationDraft } from './components/RelationDialog';
import { useCanvasStore } from './store/canvasStore';
import { ArgumentNode, type ArgumentFlowNode } from './components/ArgumentNode';
import { RelationEdge, type ArgumentFlowEdge } from './components/RelationEdge';
import { IssueBubble } from './components/IssueBubble';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import './argumentCanvas.css';

const nodeTypes = { argumentNode: ArgumentNode };
const edgeTypes = { relationEdge: RelationEdge };

function toFlowNode(n: ArgNode, highlighted: boolean, selected = false, readOnly = false): ArgumentFlowNode {
  return { id: n.id, type: 'argumentNode', position: n.position, selected, data: { argNode: n, highlighted, readOnly } };
}

function toFlowEdge(e: ArgEdge, highlighted: boolean, selected = false): ArgumentFlowEdge {
  return { id: e.id, source: e.source, target: e.target, type: 'relationEdge', selected, markerEnd: { type: MarkerType.ArrowClosed }, data: { relation: e.relation, highlighted } };
}

interface ArgumentCanvasProps {
  doc: ArgDoc;
  onChange: (doc: ArgDoc) => void;
  readOnly?: boolean;
}

export function ArgumentCanvas({ doc, onChange, readOnly = false }: ArgumentCanvasProps) {
  const initDoc = useCanvasStore((s) => s.initDoc);
  const storeNodes = useCanvasStore((s) => s.doc.nodes);
  const storeEdges = useCanvasStore((s) => s.doc.edges);
  const cycleHighlight = useCanvasStore((s) => s.cycleHighlight);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const { screenToFlowPosition, setCenter, fitView } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<ArgumentFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ArgumentFlowEdge>([]);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const selectedNodeIdsRef = useRef<Set<string>>(new Set());
  const selectedEdgeIdsRef = useRef<string[]>([]);
  const nodesRef = useRef<ArgumentFlowNode[]>([]);
  const qualityTargetRef = useRef<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const canvasRootRef = useRef<HTMLDivElement>(null);
  nodesRef.current = nodes;

  const [issueBubble, setIssueBubble] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectionRelation, setConnectionRelation] = useState<RelationType>('support');
  const [rememberRelation, setRememberRelation] = useState(false);
  const [relationDraft, setRelationDraft] = useState<RelationDraft | null>(null);
  const [connectNotice, setConnectNotice] = useState('');
  const openEdge = useCallback((id: string) => {
    if (readOnly) return;
    const edge = useCanvasStore.getState().doc.edges.find(e => e.id === id);
    if (edge) setRelationDraft({ ...edge });
  }, [readOnly]);

  // 记录已灌入的 doc_id 与已回传的 doc 引用
  const lastDocIdRef = useRef<string | null>(null);
  const lastEmittedRef = useRef<ArgDoc | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void fitView({ padding: 0.2, duration: 0 }); });
    return () => cancelAnimationFrame(frame);
  }, [readOnly, fitView]);

  // 初始化
  useEffect(() => {
    if (lastDocIdRef.current === doc.doc_id) return;
    lastDocIdRef.current = doc.doc_id;
    initDoc(doc);
  }, [doc, initDoc]);

  // store → view nodes / edges
  useEffect(() => {
    const hlNodeIds = new Set(cycleHighlight?.nodeIds ?? []);
    setNodes(storeNodes.map((n) => toFlowNode(
      n,
      hlNodeIds.has(n.id),
      qualityTargetRef.current?.kind === 'node' && qualityTargetRef.current.id === n.id,
      readOnly,
    )));
  }, [storeNodes, cycleHighlight, setNodes, readOnly]);

  useEffect(() => {
    const hlEdgeIds = new Set(cycleHighlight?.edgeIds ?? []);
    setEdges(
      storeEdges.map((e) => {
        const fe = toFlowEdge(
          e,
          hlEdgeIds.has(e.id),
          qualityTargetRef.current?.kind === 'edge' && qualityTargetRef.current.id === e.id,
        );
        const current = useCanvasStore.getState().doc;
        const check = current.structureReview?.edges.find(item => item.id === e.id);
        fe.data = { ...fe.data!, onEdit: readOnly ? undefined : () => openEdge(e.id),
          reviewState: check ? isStructureCheckFresh(current, 'edge', check) ? check.state : 'uncertain'
            : current.structureReview?.pendingEdges?.includes(e.id) ? 'uncertain' : undefined };
        if (!fe.data?.highlighted && hoveredNodeId && e.source !== hoveredNodeId && e.target !== hoveredNodeId) {
          fe.style = { opacity: 0.15 };
        }
        return fe;
      }),
    );
  }, [storeEdges, storeNodes, hoveredNodeId, cycleHighlight, setEdges, readOnly, openEdge, doc.structureReview]);

  // 每次 store doc 变化 → 回传父组件
  const storeDoc = useCanvasStore((s) => s.doc);
  useEffect(() => {
    if (storeDoc.doc_id !== doc.doc_id || useCanvasStore.getState().doc !== storeDoc) return;
    if (lastEmittedRef.current === storeDoc) return;
    lastEmittedRef.current = storeDoc;
    onChangeRef.current(storeDoc);
  }, [storeDoc]);

  const handleSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    selectedNodeIdsRef.current = new Set(params.nodes.map((n) => n.id));
    selectedEdgeIdsRef.current = params.edges.map((e) => e.id);
    setSelectedId(params.nodes.length > 0 ? params.nodes[0].id : null);
    const target = qualityTargetRef.current;
    if (target) {
      const remainsSelected = target.kind === 'node'
        ? params.nodes.some((node) => node.id === target.id)
        : params.edges.some((edge) => edge.id === target.id);
      if (!remainsSelected) qualityTargetRef.current = null;
    }
  }, []);

  const handleConnect = useCallback((conn: Connection) => {
    if (readOnly || !conn.source || !conn.target) return;
    const state = useCanvasStore.getState();
    const relation = rememberRelation ? connectionRelation : recommendedRelation(
      state.doc.nodes.find(n => n.id === conn.source), state.doc.nodes.find(n => n.id === conn.target));
    setRelationDraft({ source: conn.source, target: conn.target, relation });
  }, [connectionRelation, rememberRelation, readOnly]);

  const handleNodeDragStop = useCallback((_event: unknown, _node: ArgumentFlowNode) => {
    if (readOnly) return;
    const selectedIds = selectedNodeIdsRef.current;
    const latestViewNodes = nodesRef.current;

    if (selectedIds.size > 1) {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of latestViewNodes) {
        if (selectedIds.has(n.id)) positions[n.id] = { x: n.position.x, y: n.position.y };
      }
      if (Object.keys(positions).length > 0) useCanvasStore.getState().applyPositionMap(positions);
      return;
    }

    const movedId = selectedIds.values().next().value as string | undefined;
    if (!movedId) return;
    const dragged = latestViewNodes.find((n) => n.id === movedId);
    if (!dragged) return;
    useCanvasStore.getState().updateNodePosition(movedId, dragged.position);
  }, [readOnly]);

  // 右键菜单
  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: ArgumentFlowNode) => {
    event.preventDefault();
    if (readOnly) return;
    setContextMenu({ x: event.clientX, y: event.clientY, nodeIds: [node.id] });
  }, [readOnly]);
  const handleSelectionContextMenu = useCallback((event: React.MouseEvent, selNodes: ArgumentFlowNode[]) => {
    event.preventDefault();
    if (readOnly) return;
    setContextMenu({ x: event.clientX, y: event.clientY, nodeIds: selNodes.map((n) => n.id) });
  }, [readOnly]);

  const handleChangeType = useCallback((id: string, type: ArgNode['mainType']) => {
    useCanvasStore.getState().updateNode(id, { mainType: type });
  }, []);
  const handleChangeRole = useCallback((id: string, role: ArgumentRole) => {
    useCanvasStore.getState().updateNode(id, { role, user_edited: true, status: 'edited' });
  }, []);
  const handleDeleteNodes = useCallback((ids: string[]) => {
    if (ids.length === 1) useCanvasStore.getState().removeNode(ids[0]);
    else if (ids.length > 1) useCanvasStore.getState().removeNodes(ids);
    selectedNodeIdsRef.current = new Set();
    setSelectedId(null);
  }, []);

  // 节点编辑 / 展开 / 问题 / 建议事件
  useEffect(() => {
    const handleEdit = (e: Event) => {
      if (readOnly) return;
      const detail = (e as CustomEvent).detail as { id: string; text: string };
      const node = useCanvasStore.getState().doc.nodes.find(n => n.id === detail.id);
      if (node?.text === detail.text) return;
      updateNode(detail.id, { text: detail.text, user_edited: true, status: 'edited' });
    };
    const handleToggle = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id: string };
      const current = useCanvasStore.getState().doc.nodes.find((n) => n.id === detail.id);
      if (current) updateNode(detail.id, { collapsed: !current.collapsed });
    };
    const handleIssueClick = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId: string; x: number; y: number };
      setIssueBubble({ nodeId: detail.nodeId, x: detail.x, y: detail.y });
    };
    const handleAccept = (e: Event) => {
      if (readOnly) return;
      const { id } = (e as CustomEvent).detail as { id: string };
      updateNode(id, { status: 'edited', user_edited: true });
    };
    const handleDiscard = (e: Event) => {
      if (readOnly) return;
      const { id } = (e as CustomEvent).detail as { id: string };
      useCanvasStore.getState().removeNode(id);
    };

    document.addEventListener('arg-node:edit', handleEdit);
    document.addEventListener('arg-node:toggle-collapse', handleToggle);
    document.addEventListener('arg-node:issue-click', handleIssueClick);
    document.addEventListener('arg-suggestion:accept', handleAccept);
    document.addEventListener('arg-suggestion:discard', handleDiscard);
    return () => {
      document.removeEventListener('arg-node:edit', handleEdit);
      document.removeEventListener('arg-node:toggle-collapse', handleToggle);
      document.removeEventListener('arg-node:issue-click', handleIssueClick);
      document.removeEventListener('arg-suggestion:accept', handleAccept);
      document.removeEventListener('arg-suggestion:discard', handleDiscard);
    };
  }, [updateNode, readOnly]);

  // 质量面板 → 画布定位。定位只改变视图选择和相机，不修改论证数据。
  useEffect(() => {
    const handleQualityLocate = (event: Event) => {
      const detail = (event as CustomEvent).detail as { kind?: 'node' | 'edge'; id?: string };
      if (!detail?.kind || !detail.id) return;
      const state = useCanvasStore.getState().doc;
      qualityTargetRef.current = { kind: detail.kind, id: detail.id };

      if (detail.kind === 'node') {
        const node = state.nodes.find((item) => item.id === detail.id);
        if (!node) return;
        selectedNodeIdsRef.current = new Set([node.id]);
        selectedEdgeIdsRef.current = [];
        setNodes((items) => items.map((item) => ({ ...item, selected: item.id === node.id })));
        setEdges((items) => items.map((item) => ({ ...item, selected: false })));
        void setCenter(node.position.x + 140, node.position.y + 70, { zoom: 1.15, duration: 350 });
        return;
      }

      const edge = state.edges.find((item) => item.id === detail.id);
      if (!edge) return;
      const source = state.nodes.find((item) => item.id === edge.source);
      const target = state.nodes.find((item) => item.id === edge.target);
      selectedNodeIdsRef.current = new Set();
      selectedEdgeIdsRef.current = [edge.id];
      setNodes((items) => items.map((item) => ({ ...item, selected: false })));
      setEdges((items) => items.map((item) => ({ ...item, selected: item.id === edge.id })));
      if (source && target) {
        void setCenter(
          (source.position.x + target.position.x) / 2 + 140,
          (source.position.y + target.position.y) / 2 + 70,
          { zoom: 1, duration: 350 },
        );
      }
    };
    document.addEventListener('argument-quality:locate', handleQualityLocate);
    return () => document.removeEventListener('argument-quality:locate', handleQualityLocate);
  }, [setCenter, setEdges, setNodes]);

  // 快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (readOnly || hasActiveDialog()) return;
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || !t || t.closest('[inert]') || !canvasRootRef.current?.contains(t)) return;
      if (t.closest('input, textarea, select, button, a, summary, [contenteditable], [role="menu"], [role="menuitem"]')) return;

      const state = useCanvasStore.getState();

      // Ctrl/Cmd + Z 撤销
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        state.undo();
        return;
      }
      // Ctrl/Cmd + Y 或 Shift+Z 重做
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        state.redo();
        return;
      }
      // Ctrl/Cmd + Enter 孤立节点
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const sel = selectedNodeIdsRef.current.values().next().value as string | undefined;
        const current = sel ? state.doc.nodes.find((n) => n.id === sel) : undefined;
        const role = current?.role ?? 'claim';
        state.addNode(LEGACY_TYPE_FOR_ROLE[role], { role, text: '', position: { x: 180, y: 180 }, status: 'edited' });
        return;
      }
      // Ctrl/Cmd + C 复制
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const ids = Array.from(selectedNodeIdsRef.current);
        if (ids.length > 0) {
          e.preventDefault();
          state.copySelection(ids);
        }
        return;
      }
      // Ctrl/Cmd + V 粘贴
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const screenPos = pointerRef.current;
        const flowPos = screenToFlowPosition(screenPos);
        state.pasteAt(flowPos);
        return;
      }
      // Tab / Shift+Tab 子节点
      if (e.key === 'Tab') {
        const sel = selectedNodeIdsRef.current.values().next().value as string | undefined;
        if (sel) {
          e.preventDefault();
          const current = state.doc.nodes.find((n) => n.id === sel);
          if (current) {
            const newId = state.addNode(LEGACY_TYPE_FOR_ROLE.premise, { role: 'premise', text: '', position: { x: current.position.x + 320, y: current.position.y + 140 }, status: 'edited' });
            setRelationDraft({ source: newId, target: sel, relation: e.shiftKey ? 'oppose' : 'support' });
          }
        }
        return;
      }
      // Delete
      if (e.key === 'Delete') {
        if (selectedEdgeIdsRef.current.length > 0) {
          e.preventDefault();
          state.removeEdges(selectedEdgeIdsRef.current);
          selectedEdgeIdsRef.current = [];
        } else {
          const sel = selectedNodeIdsRef.current.values().next().value as string | undefined;
          if (sel) {
            e.preventDefault();
            state.removeNode(sel);
            selectedNodeIdsRef.current = new Set();
            setSelectedId(null);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [screenToFlowPosition, readOnly]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const multiSelectKey = isMac ? 'Meta' : 'Control';
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  return (
    <div ref={canvasRootRef} inert={relationDraft ? true : undefined} tabIndex={0} role="region" aria-label={readOnly ? '论证图预览' : '论证画布'} className="argument-canvas-scope"
      style={{ flex: 1, width: '100%', height: '100%' }}
      onPointerDownCapture={(event) => {
        if (event.button === 0 && !(event.target as HTMLElement).closest('input, textarea, select, button, a, summary, [contenteditable], [role="menu"], [role="menuitem"]')) {
          canvasRootRef.current?.focus({ preventScroll: true });
        }
      }}
      onMouseMove={(e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}>
      {!readOnly && <div className="nodrag nopan" style={{ position: 'absolute', zIndex: 8, left: 12, top: 12, display: 'flex', gap: 6,
        alignItems: 'center', padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 8,
        background: 'var(--color-surface)', fontSize: 11 }}>
        <button type="button" onClick={() => setRelationDraft({ source: selectedId ?? '', target: '', relation: 'relates' })}>添加关系</button>
        <label><input type="checkbox" checked={rememberRelation} onChange={e => setRememberRelation(e.target.checked)} />记住关系类型</label>
        {rememberRelation && <select value={connectionRelation} onChange={(event) => setConnectionRelation(event.target.value as RelationType)}
          aria-label="选择新建连线类型" style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: 0 }}>
          {(Object.keys(RELATION_LABELS) as RelationType[]).map((relation) => <option key={relation} value={relation}>{RELATION_LABELS[relation]}</option>)}
        </select>}
        {connectNotice && <span role="status">{connectNotice}</span>}
      </div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeMouseEnter={(_e, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={() => setHoveredNodeId(null)}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionContextMenu={handleSelectionContextMenu}
        onSelectionChange={handleSelectionChange}
        onConnect={handleConnect}
        onEdgeClick={(_event, edge) => openEdge(edge.id)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.2}
        maxZoom={3}
        connectionRadius={50}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionOnDrag
        selectionKeyCode={null}
        selectionMode={SelectionMode.Full}
        multiSelectionKeyCode={multiSelectKey}
        panOnDrag={false}
        panActivationKeyCode="Space"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border-soft)" />
        <Controls position="top-right" showInteractive={false} />
      </ReactFlow>

      {!readOnly && contextMenu && (
        <ContextMenu
          state={contextMenu}
          onDeleteNodes={handleDeleteNodes}
          onChangeType={handleChangeType}
          onChangeRole={handleChangeRole}
          onClose={() => setContextMenu(null)}
        />
      )}

      {issueBubble && (() => {
        const n = useCanvasStore.getState().doc.nodes.find((nd) => nd.id === issueBubble.nodeId);
        if (!n) return null;
        return (
          <IssueBubble
            x={issueBubble.x}
            y={issueBubble.y}
            severity={n.severity}
            issue={n.issue ?? ''}
            suggestion={n.suggestion}
            onClose={() => setIssueBubble(null)}
          />
        );
      })()}
      {!readOnly && relationDraft && <RelationDialog doc={storeDoc} initial={relationDraft} onClose={() => {
        setRelationDraft(null);
        requestAnimationFrame(() => canvasRootRef.current?.focus({ preventScroll: true }));
      }}
        onConfirm={draft => {
          const state = useCanvasStore.getState();
          const saved = draft.id ? state.updateEdge(draft.id, draft) : state.addEdge(draft.source, draft.target, draft.relation, draft.reason);
          if (saved) { setConnectionRelation(draft.relation); setConnectNotice('关系已保存，可撤销。'); }
          return saved;
        }} onDelete={id => { useCanvasStore.getState().removeEdge(id); setConnectNotice('关系已删除，可撤销。'); }} />}
    </div>
  );
}
