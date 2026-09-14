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
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  SelectionMode,
  type Connection,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ArgDoc, ArgNode, ArgEdge, RelationType } from '../../services/argumentDoc/types';
import { useCanvasStore } from './store/canvasStore';
import { ArgumentNode, type ArgumentFlowNode } from './components/ArgumentNode';
import { RelationEdge, type ArgumentFlowEdge } from './components/RelationEdge';
import { IssueBubble } from './components/IssueBubble';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import './argumentCanvas.css';

const nodeTypes = { argumentNode: ArgumentNode };
const edgeTypes = { relationEdge: RelationEdge };

const FALLBACK_TYPE: ArgNode['mainType'] = '推理';

function toFlowNode(n: ArgNode, highlighted: boolean): ArgumentFlowNode {
  return { id: n.id, type: 'argumentNode', position: n.position, data: { argNode: n, highlighted } };
}

function toFlowEdge(e: ArgEdge, highlighted: boolean): ArgumentFlowEdge {
  return { id: e.id, source: e.source, target: e.target, type: 'relationEdge', markerEnd: { type: MarkerType.ArrowClosed }, data: { relation: e.relation, highlighted } };
}

interface ArgumentCanvasProps {
  doc: ArgDoc;
  onChange: (doc: ArgDoc) => void;
}

export function ArgumentCanvas({ doc, onChange }: ArgumentCanvasProps) {
  const initDoc = useCanvasStore((s) => s.initDoc);
  const storeNodes = useCanvasStore((s) => s.doc.nodes);
  const storeEdges = useCanvasStore((s) => s.doc.edges);
  const cycleHighlight = useCanvasStore((s) => s.cycleHighlight);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const applyPositionMap = useCanvasStore((s) => s.applyPositionMap);
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<ArgumentFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ArgumentFlowEdge>([]);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const connectAltRef = useRef(false);
  const selectedNodeIdsRef = useRef<Set<string>>(new Set());
  const selectedEdgeIdsRef = useRef<string[]>([]);
  const nodesRef = useRef<ArgumentFlowNode[]>([]);
  nodesRef.current = nodes;

  const [issueBubble, setIssueBubble] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 记录已灌入的 doc_id 与已回传的 doc 引用
  const lastDocIdRef = useRef<string | null>(null);
  const lastEmittedRef = useRef<ArgDoc | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 初始化
  useEffect(() => {
    if (lastDocIdRef.current === doc.doc_id) return;
    lastDocIdRef.current = doc.doc_id;
    initDoc(doc);
  }, [doc, initDoc]);

  // store → view nodes / edges
  useEffect(() => {
    const hlNodeIds = new Set(cycleHighlight?.nodeIds ?? []);
    setNodes(storeNodes.map((n) => toFlowNode(n, hlNodeIds.has(n.id))));
  }, [storeNodes, cycleHighlight, setNodes]);

  useEffect(() => {
    const hlEdgeIds = new Set(cycleHighlight?.edgeIds ?? []);
    setEdges(
      storeEdges.map((e) => {
        const fe = toFlowEdge(e, hlEdgeIds.has(e.id));
        if (!fe.data?.highlighted && hoveredNodeId && e.source !== hoveredNodeId && e.target !== hoveredNodeId) {
          fe.style = { opacity: 0.15 };
        }
        return fe;
      }),
    );
  }, [storeEdges, hoveredNodeId, cycleHighlight, setEdges]);

  // 每次 store doc 变化 → 回传父组件
  const storeDoc = useCanvasStore((s) => s.doc);
  useEffect(() => {
    if (storeDoc.doc_id === 'empty') return;
    if (lastEmittedRef.current === storeDoc) return;
    lastEmittedRef.current = storeDoc;
    onChangeRef.current(storeDoc);
  }, [storeDoc]);

  const handleSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    selectedNodeIdsRef.current = new Set(params.nodes.map((n) => n.id));
    selectedEdgeIdsRef.current = params.edges.map((e) => e.id);
    setSelectedId(params.nodes.length > 0 ? params.nodes[0].id : null);
  }, []);

  const handleConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    const relation: RelationType = connectAltRef.current ? 'oppose' : 'support';
    useCanvasStore.getState().addEdge(conn.source, conn.target, relation);
  }, []);

  const handleConnectStart = useCallback((event: MouseEvent | TouchEvent) => {
    connectAltRef.current = 'altKey' in event ? (event as MouseEvent).altKey : false;
  }, []);

  const handleNodeDragStop = useCallback((_event: unknown, _node: ArgumentFlowNode) => {
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
  }, []);

  // 右键菜单
  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: ArgumentFlowNode) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeIds: [node.id] });
  }, []);
  const handleSelectionContextMenu = useCallback((event: React.MouseEvent, selNodes: ArgumentFlowNode[]) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeIds: selNodes.map((n) => n.id) });
  }, []);

  const handleChangeType = useCallback((id: string, type: ArgNode['mainType']) => {
    useCanvasStore.getState().updateNode(id, { mainType: type });
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
      const detail = (e as CustomEvent).detail as { id: string; text: string };
      updateNode(detail.id, { text: detail.text, user_edited: true, status: 'edited', issue: null, severity: null, suggestion: null });
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
      const { id } = (e as CustomEvent).detail as { id: string };
      updateNode(id, { status: 'ok', suggestion: null });
    };
    const handleDiscard = (e: Event) => {
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
  }, [updateNode]);

  // 快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;

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
        const type = current?.mainType ?? FALLBACK_TYPE;
        state.addNode(type, { text: '', position: { x: 180, y: 180 }, status: 'isolated' });
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
            const type = current.mainType;
            const newId = state.addNode(type, { text: '', position: { x: current.position.x + 320, y: current.position.y + 140 }, status: 'ok' });
            state.addEdge(newId, sel, e.shiftKey ? 'oppose' : 'support');
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
  }, [screenToFlowPosition]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const multiSelectKey = isMac ? 'Meta' : 'Control';
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  return (
    <div className="argument-canvas-scope" style={{ flex: 1, width: '100%', height: '100%' }} onMouseMove={(e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}>
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
        onConnectStart={handleConnectStart}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.2}
        maxZoom={3}
        connectionRadius={50}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable
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
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
      </ReactFlow>

      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onDeleteNodes={handleDeleteNodes}
          onChangeType={handleChangeType}
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
    </div>
  );
}