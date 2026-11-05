/**
 * S4 推导画布 —— 受控主组件
 *
 * 范式与 `argumentCanvas/ArgumentCanvas.tsx` 一致（props 进 canvasState、onChange 出 canvasState），
 * 但完全独立实现（红线 R8）。
 *
 * 职责：
 * 1. 领域 canvasState ↔ React Flow 的 nodes/edges 双向映射
 * 2. 向节点组件注入动作（提交 / 求助 / 编辑 / 暂存 / 删除 / 冻结）
 * 3. 工具栏增删节点；Delete 删除选中；Ctrl+Z/Y 撤销重做
 * 4. **在 onConnect 中拦截成环连接**（实施计划 K3 环检测的落点）
 *
 * 阶段七交互简化：
 * - **双击不再承担新建职责**：旧实现把「双击空白新建公式节点」挂在 ReactFlow 根容器上，
 *   而节点上的双击会冒泡到根容器，导致「双击节点想编辑」被误变成「新建节点」，
 *   节点自身请求的编辑态又被根容器的 setEditingNodeId(null) 覆盖。
 *   现在双击只做「点在空白处 → 退出编辑态」，新建统一走左上角工具栏。
 * - **连线类型收敛为单一「推导」**：移除右上角类型选择器。
 *   公式推导是单链分支结构，不同解法直接从同一节点引出即可。
 * - **失焦只暂存不验证**：见 MathField / onDraftSave。
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  type Connection,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Flag, Undo2, Redo2, AlertCircle, Sigma, Lightbulb } from 'lucide-react';
import type { DerivationCanvasState, DerivationNodeType } from '../../types/sceneS4';
import { useDerivationStore, emptyCanvasState, canvasStructureKey } from './derivationStore';
import { FormulaNode } from './components/FormulaNode';
import { GivenNode } from './components/GivenNode';
import { ConclusionNode } from './components/ConclusionNode';
import { AssumptionNode } from './components/AssumptionNode';
import { EdgeWithDeleteButton } from './components/EdgeWithDeleteButton';
import { NodeActionsContext, type NodeActions } from './components/NodeActionsContext';
import { hideVirtualKeyboard } from './utils/virtualKeyboard';
import { hasActiveDialog } from '../../components/useDialog';
import { isS4CanvasChangeAuthorized } from '../../services/scene/sceneS4Policy';
import {
  type DerivationFlowNode,
  type DerivationFlowEdge,
  EDGE_COLOR,
  EDGE_COLOR_HIGHLIGHT,
} from './nodeVisuals';
import './derivationCanvas.css';

const nodeTypes = {
  formula: FormulaNode,
  given: GivenNode,
  conclusion: ConclusionNode,
  // 前提链架构新增：用户自建的假设前提（紫色系，仅对该支路下游生效）
  assumption: AssumptionNode,
};

/**
 * 自定义边类型（阶段七：连线可删）。
 *
 * React Flow 默认边没有删除入口，而本画布显式设置 `deleteKeyCode={null}`
 * 关闭了内置删除，导致连错线后无从下手。
 * 改用自定义边，在标签旁提供「×」按钮（不依赖键盘，触屏同样可用）。
 */
const edgeTypes = {
  dcEdge: EdgeWithDeleteButton,
};

/** 领域节点 → React Flow 节点 */
function toFlowNode(
  n: DerivationCanvasState['nodes'][number],
  highlighted: boolean,
  selected = false,
): DerivationFlowNode {
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    selected,
    data: { nodeData: n.data, nodeType: n.type, highlighted },
  };
}

/**
 * 领域边 → React Flow 边。
 *
 * 连线类型已收敛为单一「推导」，故不再按类型取色或取标签。
 * 仅在用户显式填写 `label` 时显示文字（如「代入洛伦兹因子」），
 * 否则保持无标签的干净线条 —— 避免每条线都挂一个无信息量的「推导」二字。
 */
function toFlowEdge(
  e: DerivationCanvasState['edges'][number],
  highlighted: boolean,
  selected = false,
): DerivationFlowEdge {
  const color = highlighted ? EDGE_COLOR_HIGHLIGHT : EDGE_COLOR;
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    selected,
    type: 'dcEdge',
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: highlighted ? 2.5 : 1.6 },
    label: e.label || undefined,
    labelStyle: { fontSize: 10, fill: color },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.85 },
    data: { edgeType: e.type, highlighted },
  };
}

export interface DerivationCanvasProps {
  /** 受控画布状态 */
  canvasState: DerivationCanvasState;
  /** 画布状态变更回调 */
  onChange: (next: DerivationCanvasState) => void;
  /** 提交节点验证（阶段四接线到 analyzeStep） */
  onSubmitNode: (nodeId: string) => void;
  /** 请求求助（阶段四接线到 requestHelp） */
  onRequestHelp: (nodeId: string) => void;
  /** 只读（历史回放 / 反事实对比） */
  readOnly?: boolean;
  /** Explicit scene component boundary. Omission retains legacy canvas behavior. */
  allowedNodeTypes?: readonly DerivationNodeType[];
  /** 当前选中节点变化（供右侧节点属性面板展示，不改变画布数据协议） */
  onSelectNode?: (nodeId: string | null) => void;
}

export function DerivationCanvas({
  canvasState,
  onChange,
  onSubmitNode,
  onRequestHelp,
  readOnly = false,
  allowedNodeTypes = ['given', 'formula', 'conclusion', 'assumption'],
  onSelectNode,
}: DerivationCanvasProps) {
  const storeCanvas = useDerivationStore((s) => s.canvas);
  const toast = useDerivationStore((s) => s.toast);
  const cycleHighlight = useDerivationStore((s) => s.cycleHighlight);
  const initCanvas = useDerivationStore((s) => s.initCanvas);
  const clearToast = useDerivationStore((s) => s.clearToast);
  const canUndo = useDerivationStore((s) => s.past.length > 0);
  const canRedo = useDerivationStore((s) => s.future.length > 0);
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<DerivationFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DerivationFlowEdge>([]);

  /** 当前处于编辑态的节点 id（同一时刻只允许一个） */
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

  const selectedNodeIdsRef = useRef<Set<string>>(new Set());
  /** 当前选中的连线 id（Delete 删边用，阶段七缺陷修复） */
  const selectedEdgeIdsRef = useRef<Set<string>>(new Set());
  const lastEmittedRef = useRef<DerivationCanvasState | null>(null);
  const lastInitRef = useRef<string>('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const allowedTypesRef = useRef(allowedNodeTypes);
  allowedTypesRef.current = allowedNodeTypes;
  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;
  const canUseNode = (nodeId: string) => {
    const node = useDerivationStore.getState().canvas.nodes.find(item => item.id === nodeId);
    return Boolean(node && allowedTypesRef.current.includes(node.type));
  };
  const canEditNode = (nodeId: string) => canUseNode(nodeId)
    && useDerivationStore.getState().canvas.nodes.find(item => item.id === nodeId)?.type !== 'given';

  /* ============ 初始化：外部 canvasState 结构变化时灌入 store ============ */
  useEffect(() => {
    /**
     * 结构指纹守门（阶段六缺陷修复，见实施计划 §10.3.3）。
     *
     * 旧实现只用「节点数|边数」做指纹，这是自激环的一环：
     * 回传滞后一步会让计数在「有节点」与「空画布」之间来回交替，指纹永不相等，
     * 于是每次渲染都重新灌入 → 每次灌入都回传父级 → 父级 setState → props 变化
     * → 再次灌入，最终触发 React「Maximum update depth exceeded」（生产报 error #185）。
     * 改用与 store 内部一致的稳定结构指纹，做到「内容相同就不灌入」。
     */
    const key = canvasStructureKey(canvasState);
    if (lastInitRef.current === key) return;
    lastInitRef.current = key;
    initCanvas(canvasState);

    /**
     * 关键：把回传基线对齐到「刚灌入的 store 快照」。
     *
     * 灌入 effect 与回传 effect 在同一次提交中按声明顺序执行，回传 effect 闭包里
     * 的 storeCanvas 仍是灌入前的旧值。若不在此处对齐基线，就会把旧画布回传出去，
     * 与父级刚设置的画布来回覆盖，形成第二个自激环。
     */
    lastEmittedRef.current = useDerivationStore.getState().canvas;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasState]);

  /* ============ store → 视图 ============ */
  useEffect(() => {
    const hl = new Set(cycleHighlight?.nodeIds ?? []);
    setNodes(storeCanvas.nodes.map((n) => toFlowNode(n, hl.has(n.id), selectedNodeIdsRef.current.has(n.id))));
  }, [storeCanvas.nodes, cycleHighlight, setNodes]);

  useEffect(() => {
    const hl = new Set(cycleHighlight?.edgeIds ?? []);
    setEdges(storeCanvas.edges.map((e) => toFlowEdge(e, hl.has(e.id), selectedEdgeIdsRef.current.has(e.id))));
  }, [storeCanvas.edges, cycleHighlight, setEdges]);

  /* ============ store → 父组件（受控回传） ============ */
  useEffect(() => {
    // 读取「实时」store 快照，而非本渲染闭包里的 storeCanvas：
    // 灌入 effect 可能已在同一次提交中改写 store，闭包值会是过期的旧画布
    const live = useDerivationStore.getState().canvas;
    if (lastEmittedRef.current === live) return;
    // Covers undo/redo and any store mutation, not only toolbar buttons.
    if (!isS4CanvasChangeAuthorized(canvasStateRef.current, live, allowedTypesRef.current)) {
      initCanvas(canvasStateRef.current);
      lastEmittedRef.current = useDerivationStore.getState().canvas;
      return;
    }
    lastEmittedRef.current = live;
    onChangeRef.current(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCanvas]);

  /* ============ 提示自动消失 ============ */
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => clearToast(), 2600);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  /* ============ 虚拟键盘兜底（阶段七缺陷修复） ============ */
  /**
   * MathLive 的键盘面板挂在 document.body 上，**不随画布卸载而消失**。
   * 因此补两道兜底：
   * 1. 切为只读（运行结束 / 反事实对比）→ 收起
   * 2. 画布卸载（退出场景视图）→ 收起
   * 第 2 条是「退出画布页面键盘仍留在屏幕上」的根治点。
   */
  useEffect(() => {
    if (readOnly) hideVirtualKeyboard();
  }, [readOnly]);

  useEffect(() => () => hideVirtualKeyboard(), []);

  /* ============ 节点动作（注入给节点组件） ============ */
  const actions: NodeActions = {
    onSubmitNode: (nodeId) => {
      if (readOnly) return;
      // Host owns permission checks and pending state; a rejected submission must not change the node.
      onSubmitNode(nodeId);
    },
    onRequestHelp: (nodeId) => {
      if (readOnly) return;
      onRequestHelp(nodeId);
    },
    onRequestEdit: (nodeId) => {
      if (readOnly || !canEditNode(nodeId)) return;
      // 内嵌按钮不会触发 React Flow 的节点选择；键盘与双击编辑也应选中同一步。
      selectedNodeIdsRef.current = new Set([nodeId]);
      selectedEdgeIdsRef.current = new Set();
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
      onSelectNode?.(nodeId);
      setEditingNodeId(nodeId);
    },
    onDraftSave: (nodeId, latex) => {
      if (readOnly || !canEditNode(nodeId)) return;
      /**
       * 暂存：只落数据，不验证、不进历史栈。
       *
       * 同时把 status 退回 `draft`（阶段九决策 1①）：用户已改动了公式，
       * 上一次的「通过 / 有误」结论对新内容不再成立。若不回退，
       * 改完公式后节点仍显示绿色「通过」，视觉上像新公式已验证 —— 属于假信号。
       * 真正的判定仍只发生在点「提交」时。
       */
      useDerivationStore.getState().updateNodeDraft(nodeId, {
        latex,
        status: 'draft',
        verification: undefined,
      });
    },
    onNoteDraftSave: (nodeId, note) => {
      if (readOnly || !canEditNode(nodeId)) return;
      // 备注暂存：备注是解释性文本，不应改变节点验证状态
      useDerivationStore.getState().updateNodeDraft(nodeId, { note });
    },
    onCancelEdit: () => setEditingNodeId(null),
    onDeleteNode: (nodeId) => {
      if (readOnly) return;
      useDerivationStore.getState().removeNode(nodeId);
      setEditingNodeId((cur) => (cur === nodeId ? null : cur));
    },
    onDeleteEdge: (edgeId) => {
      if (readOnly) return;
      // 连线上的「×」按钮：直接删边，无需键盘
      useDerivationStore.getState().removeEdge(edgeId);
      selectedEdgeIdsRef.current.delete(edgeId);
    },
    onToggleFreeze: (nodeId) => {
      if (readOnly || !canEditNode(nodeId)) return;
      useDerivationStore.getState().toggleFreeze(nodeId);
      setEditingNodeId((cur) => (cur === nodeId ? null : cur));
    },
    editingNodeId,
    readOnly,
  };

  /* ============ 连线：环检测的拦截点 ============ */
  const handleConnect = useCallback(
    (conn: Connection) => {
      if (readOnly) return;
      if (!conn.source || !conn.target) return;
      if (!canUseNode(conn.source) || !canUseNode(conn.target)) return;
      // addEdge 内部会做 wouldCreateCycle 检测，成环则拒绝写入
      useDerivationStore.getState().addEdge(conn.source, conn.target, 'derivation');
    },
    [readOnly],
  );

  /* ============ 双击：仅退出编辑态（阶段七缺陷修复） ============ */
  /**
   * 旧实现把「双击新建公式节点」挂在 ReactFlow 根容器上，
   * 而节点上的双击会**冒泡**到根容器，于是「双击节点想编辑内容」
   * 被误变成「新建推导节点」，节点自身的编辑请求也被覆盖。
   *
   * 现在双击不再承担新建职责：
   * - 新建统一走左上角工具栏（公式 / 注释 / 结论）
   * - 双击节点内容由节点组件自身处理（进入编辑态）
   * - 双击画布只做「退出编辑态」这种无副作用动作
   */
  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (readOnly) return;
      /**
       * 必须判断事件目标：React Flow 的 onDoubleClick 绑在根容器上，
       * 节点内部的任何双击都会冒泡到这里。若不加判断，
       * 「双击节点内容进入编辑」会在同一次事件中被这里立刻清空，
       * 表现为「双击没反应、无法编辑」。
       *
       * 只有真正点在空白面板（.react-flow__pane）上才退出编辑态。
       */
      const target = event.target as HTMLElement | null;
      if (target && !target.classList.contains('react-flow__pane')) return;
      setEditingNodeId(null);
    },
    [readOnly],
  );

  const handleSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    selectedNodeIdsRef.current = new Set(params.nodes.map((n) => n.id));
    onSelectNode?.(params.nodes[0]?.id ?? null);
    // 旧实现只记节点、丢弃 params.edges，导致连线选中后 Delete 完全无效
    selectedEdgeIdsRef.current = new Set(params.edges.map((e) => e.id));
  }, [onSelectNode]);

  /* ============ 快捷键 ============ */
  useEffect(() => {
    if (readOnly) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || hasActiveDialog()) return;
      const target = e.target as HTMLElement | null;
      const inInput =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'MATH-FIELD' ||
          target.isContentEditable);
      if (inInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        useDerivationStore.getState().undo(allowedTypesRef.current);
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault();
        useDerivationStore.getState().redo(allowedTypesRef.current);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useDerivationStore.getState();
        // 优先删选中的连线（与 argumentCanvas 一致）；旧实现只删节点，连线因此删不掉
        const edgeIds = Array.from(selectedEdgeIdsRef.current);
        if (edgeIds.length > 0) {
          e.preventDefault();
          hideVirtualKeyboard();
          for (const id of edgeIds) store.removeEdge(id);
          selectedEdgeIdsRef.current = new Set();
          return;
        }
        const ids = Array.from(selectedNodeIdsRef.current);
        if (ids.length === 0) return;
        e.preventDefault();
        hideVirtualKeyboard();
        for (const id of ids) store.removeNode(id);
        selectedNodeIdsRef.current = new Set();
        setEditingNodeId(null);
        return;
      }
      if (e.key === 'Escape') {
        // Escape 同时收起虚拟键盘，避免键盘残留
        hideVirtualKeyboard();
        setEditingNodeId(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [readOnly]);

  /** 工具栏：手动加节点（不依赖双击，便于触屏与可发现性） */
  const toolbarAdd = useCallback(
    (type: DerivationNodeType) => {
      if (readOnly || !allowedTypesRef.current.includes(type)) return;
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const position = {
        x: center.x + (Math.random() - 0.5) * 80,
        y: center.y + (Math.random() - 0.5) * 60,
      };
      const id = useDerivationStore.getState().addNode(type, { position });
      if (!id) return;
      // 新建即进入编辑态，用户可直接开始书写（不再有独立的注释节点）
      setEditingNodeId(id);
    },
    [screenToFlowPosition, readOnly],
  );

  const isEmpty = storeCanvas.nodes.length === 0;

  return (
    <NodeActionsContext.Provider value={actions}>
      <div className="dc-canvas-wrap">
        {/* 左侧工具栏 */}
        {!readOnly && (
          <div className="dc-toolbar">
            <button type="button" className="dc-toolbar-btn" disabled={!allowedNodeTypes.includes('formula')} onClick={() => toolbarAdd('formula')}>
              <Plus size={12} />
              <Sigma size={12} />
              公式
            </button>
            <button type="button" className="dc-toolbar-btn" disabled={!allowedNodeTypes.includes('conclusion')} onClick={() => toolbarAdd('conclusion')}>
              <Flag size={12} />
              结论
            </button>
            <button
              type="button"
              className="dc-toolbar-btn dc-toolbar-btn-assumption"
              disabled={!allowedNodeTypes.includes('assumption')}
              onClick={() => toolbarAdd('assumption')}
              title="添加假设前提（仅对连线到的下游步骤生效）"
            >
              <Lightbulb size={12} />
              假设前提
            </button>
            {!allowedNodeTypes.includes('assumption') && (
              <span className="dc-toolbar-permission" role="status">本场景未启用假设前提</span>
            )}
            <button
              type="button"
              className="dc-toolbar-btn"
              onClick={() => useDerivationStore.getState().undo(allowedTypesRef.current)}
              disabled={!canUndo}
              title="撤销（Ctrl+Z）"
            >
              <Undo2 size={12} />
            </button>
            <button
              type="button"
              className="dc-toolbar-btn"
              onClick={() => useDerivationStore.getState().redo(allowedTypesRef.current)}
              disabled={!canRedo}
              title="重做（Ctrl+Y）"
            >
              <Redo2 size={12} />
            </button>
          </div>
        )}

        {/* 提示气泡（环检测拒绝等） */}
        {toast && (
          <div className="dc-toast" role="status">
            <AlertCircle size={13} />
            {toast}
          </div>
        )}

        {/* 空画布引导 */}
        {isEmpty && !readOnly && (
          <div className="dc-empty-hint">
            <strong>用左上角工具栏添加节点</strong>
            <span>双击节点进入编辑；失焦或按 Enter 只暂存，点节点下方「提交」才开始验证</span>
            <span>从节点边缘拖拽建立连线（推导方向），点连线上的 × 可删除</span>
            <span>每步可在节点内补一句「解释」（选填），会随公式一起交给 AI 理解</span>
          </div>
        )}

        <ReactFlow
          className="dc-canvas"
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onConnect={handleConnect}
          edgeTypes={edgeTypes}
          onSelectionChange={handleSelectionChange}
          onPaneClick={() => {
            setEditingNodeId(null);
            // 点空白即清空连线选中，避免 Delete 误删上一次选中的边
            selectedEdgeIdsRef.current = new Set();
          }}
          onDoubleClick={handlePaneDoubleClick}
          onNodeDragStop={(_e, node) => {
            useDerivationStore.getState().updateNodePosition(node.id, node.position);
          }}
          onMoveEnd={(_e, viewport) => {
            useDerivationStore.getState().setViewport({
              x: viewport.x,
              y: viewport.y,
              zoom: viewport.zoom,
            });
          }}
          defaultViewport={canvasState.viewport}
          fitView={canvasState.nodes.length > 0 && canvasState.viewport.zoom === 1}
          minZoom={0.25}
          maxZoom={2}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#dbe5de" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            style={{ width: 130, height: 90 }}
            nodeColor={(n) => {
              const nd = (n as DerivationFlowNode).data?.nodeData;
              if (!nd) return '#c7d6cb';
              if (nd.status === 'pass') return '#3F7A50';
              if (nd.status === 'fail') return '#B8574A';
              return '#c7d6cb';
            }}
          />
        </ReactFlow>
      </div>
    </NodeActionsContext.Provider>
  );
}

/** 对外导出空画布工厂（供 derivationRuntime / sceneRuntime 复用） */
export { emptyCanvasState };
