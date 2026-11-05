/**
 * S4 推导画布 store（受控组件内部编辑态）
 *
 * 设计范式参考 `argumentCanvas/store/canvasStore.ts`，但完全独立（红线 R8）：
 * - 纯内存、无持久化：由受控组件 `DerivationCanvas` 持有，props 进 canvasState、onChange 出 canvasState
 * - 支持撤销/重做、节点增删改、连线增删（含环检测拦截）
 *
 * 关键约束：
 * 1. `addEdge` 必须先做环检测，成环则**拒绝写入**并返回 false（同时写入 toast 供 UI 提示）
 * 2. `updateNodePosition` / `setViewport` **不进历史栈**（拖拽/缩放产生高频变更）
 * 3. 画布上的 `helpUsed` / `maxHelp` / `independenceScore` / `matchedStepIndexes`
 *    由 derivationRuntime 维护，store 操作时**必须原样保留**
 */

import { create } from 'zustand';
import type {
  DerivationCanvasState,
  DerivationEdge,
  DerivationEdgeType,
  DerivationNode,
  DerivationNodeData,
  DerivationNodeType,
} from '../../types/sceneS4';
import { wouldCreateCycle, findDerivationCycle, type DerivationCycleInfo } from './utils/cycle';
import { collectDescendants } from './utils/branchGraph';
import { preservesSystemGivens } from './utils/givenIntegrity';
import { projectDerivationHistory } from './utils/historyProjection';

/** 历史栈最大深度 */
const MAX_HISTORY = 50;

/** 节点 id 计数器（模块级，initCanvas 时按已有节点同步） */
let nodeSeq = 0;
let edgeSeq = 0;

function nextNodeId(): string {
  nodeSeq += 1;
  return `dnode-${nodeSeq}`;
}

function nextEdgeId(): string {
  edgeSeq += 1;
  return `dedge-${edgeSeq}`;
}

/** 依据已有节点/边同步 id 计数器，避免新建时 id 冲突 */
function syncIdCounters(nodes: DerivationNode[], edges: DerivationEdge[]): void {
  let maxNode = 0;
  for (const n of nodes) {
    const m = /^dnode-(\d+)$/.exec(n.id);
    if (m) maxNode = Math.max(maxNode, Number(m[1]));
  }
  let maxEdge = 0;
  for (const e of edges) {
    const m = /^dedge-(\d+)$/.exec(e.id);
    if (m) maxEdge = Math.max(maxEdge, Number(m[1]));
  }
  nodeSeq = maxNode;
  edgeSeq = maxEdge;
}

/** 空画布初始态（与实施计划 §8.3 约定一致） */
export function emptyCanvasState(): DerivationCanvasState {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    helpUsed: 0,
    maxHelp: 0,
  independenceScore: 1,
};
}

/** 视口比较容差（浮点噪声容忍） */
const VIEWPORT_EPSILON = 1e-4;

/**
 * 稳定序列化：对象键排序后再拼接。
 *
 * 为什么不能直接用 JSON.stringify：不同代码路径构造同一个节点数据对象时，
 * 键的插入顺序可能不同（字面量 vs 展开），而 JSON.stringify 依赖键顺序，
 * 会产生「语义相同但字符串不同」的假不等，进而重新引入自激。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * 画布「结构指纹」：只由**实质内容**决定，刻意排除 viewport。
 *
 * 用途：作为受控灌入（props → store）的等价判据。
 *
 * 为什么排除 viewport：视口由画布自身维护（onMoveEnd 直接写 store），
 * 不需要从 props 反向灌入；排除它可避免「拖拽/缩放 → 回传父级 →
 * props 变化 → 重灌」这类回声。
 *
 * 覆盖范围：节点 id/类型/坐标/全部 data（含 verification 的建议与边界条件）、
 * 边的四要素、求助计数与独立性得分、已命中步骤下标。
 */
export function canvasStructureKey(c: DerivationCanvasState): string {
  return stableStringify({
    nodes: c.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
    edges: c.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type })),
    helpUsed: c.helpUsed,
    maxHelp: c.maxHelp,
    independenceScore: c.independenceScore,
  });
}

/**
 * 把某节点的所有后代重置为 `draft` 并清空 `verification`。
 *
 * ## 为什么需要（前提链架构的必然要求）
 * 前提链判定的语义是「本步能否由连线到的前置步骤推出」。一旦**上游公式变了**，
 * 之前基于旧内容得出的下游结论就不再成立 —— 若继续显示绿色「通过」，
 * 那是**假信号**：用户看到的是「已验证」，而实际上验的是另一份内容。
 *
 * ## 为什么只有「公式内容变化」才触发（用户确认的口径）
 * - ✅ 公式 latex 实质变化 → 触发（下游依赖的就是这个式子）
 * - ❌ 仅改备注 note → 不触发（注释不参与符号计算）
 * - ❌ 仅改 label / unitHint → 不触发（纯展示字段）
 * - ❌ 挪动位置 / 缩放视口 → 不触发（几何信息与推导无关）
 * - ❌ 冻结/解冻 → 不触发（锁定状态不改变内容）
 *
 * 这样用户微调写法、补注释、整理版面时，不会看到下游结论无谓地全部掉光。
 *
 * 冻结只锁定节点内容，不锁定证明依据。上游内容或连线变化时，冻结节点的
 * 旧验证同样失效，并自动解冻，避免保留“基于旧前提通过”的假信号。
 *
 * ## 为什么放在本模块而非 derivationRuntime
 * `invalidateDescendants` 是纯图操作（只依赖 `edges`），与 `branchGraph` /
 * `cycle` 同层。放在 store 内部可复用同模块的 `collectDescendants`，
 * 避免 `modules/` 层反向依赖 `services/` 层造成层次倒置。
 */
function invalidateDescendants(
  canvas: DerivationCanvasState,
  nodeId: string,
  includeSelf = false,
): DerivationCanvasState {
  const ids = new Set(collectDescendants(nodeId, canvas.edges ?? []));
  if (includeSelf) ids.add(nodeId);
  if (ids.size === 0) return canvas;

  let changed = false;
  const nodes = canvas.nodes.map((n) => {
    if (!ids.has(n.id) || n.type === 'given') return n;
    // 已经是 draft 且无验证结果 → 无需改动，避免制造无谓的新引用
    if (n.data.status === 'draft' && !n.data.verification) return n;
    changed = true;
    return {
      ...n,
      data: { ...n.data, status: 'draft' as const, frozen: false, verification: undefined },
    };
  });

  return changed ? { ...canvas, nodes } : canvas;
}

/** 各节点类型的默认标签 */
const DEFAULT_LABEL: Record<DerivationNodeType, string> = {
  given: '已知条件',
  formula: '推导步骤',
  conclusion: '结论',
  // 前提链架构新增：用户自建的假设前提（仅在该支路生效）
  assumption: '假设前提',
};

/** Mathematical edits invalidate the node itself too; remarks never stand in for a missing formula. */
function patchedNode(node: DerivationNode, patch: Partial<DerivationNodeData>): { node: DerivationNode; invalidate: boolean } {
  const data = { ...node.data, ...patch };
  const invalidate = ('latex' in patch && patch.latex !== node.data.latex)
    || (!data.latex?.trim() && Boolean(node.data.verification));
  return { node: { ...node, data: invalidate ? { ...data, status: 'draft', frozen: false, verification: undefined } : data }, invalidate };
}

interface DerivationStore {
  canvas: DerivationCanvasState;
  past: DerivationCanvasState[];
  future: DerivationCanvasState[];
  /** 环检测等被拒绝操作的提示（UI 显示后由 clearToast 清除） */
  toast: string | null;
  /** 当前画布已存在的环（加载历史画布时兜底检测） */
  cycleHighlight: DerivationCycleInfo | null;

  /** 从 props 灌入（受控组件入口） */
  initCanvas: (next: DerivationCanvasState) => void;
  /** 取当前状态（同步，供事件处理器直接读） */
  getCanvas: () => DerivationCanvasState;

  /* 节点操作 */
  addNode: (type: DerivationNodeType, opts?: Partial<DerivationNode>) => string;
  updateNode: (id: string, patch: Partial<DerivationNodeData>) => void;
  /**
   * 暂存草稿内容（失焦时调用）。
   *
   * 普通备注暂存不改验证状态；公式实质变化会使本节点及下游的旧验证失效。
   *
   * 为什么需要：
   * 1. 旧实现每击键都调 `updateNode`，每次 commit 都会 push 历史栈，
   *    导致 Ctrl+Z 需要按几十次才能退回上一步（历史被逐字符污染）；
   * 2. 未改公式的失焦、备注编辑和移动不应清除有效证明；数学内容改变才回到 draft。
   */
  updateNodeDraft: (id: string, patch: Partial<DerivationNodeData>) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;

  /* 连线操作 */
  addEdge: (source: string, target: string, type: DerivationEdgeType) => boolean;
  removeEdge: (id: string) => void;

  /* 视口 */
  setViewport: (v: { x: number; y: number; zoom: number }) => void;

  /* 撤销/重做 */
  undo: (allowed?: readonly DerivationNodeType[]) => boolean;
  redo: (allowed?: readonly DerivationNodeType[]) => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /* 冻结/解冻 */
  toggleFreeze: (id: string) => void;

  /* 提示 */
  clearToast: () => void;
}

export const useDerivationStore = create<DerivationStore>((set, get) => {
  /** 把当前 canvas 压入 past（上限 50）并清空 future */
  function commit(current: DerivationCanvasState): {
    past: DerivationCanvasState[];
    future: DerivationCanvasState[];
  } {
    const { past } = get();
    return { past: [...past, current].slice(-MAX_HISTORY), future: [] };
  }

  return {
    canvas: emptyCanvasState(),
    past: [],
    future: [],
    toast: null,
    cycleHighlight: null,

    initCanvas: (next) => {
      // id 计数同步是纯计算，必须先于幂等判断执行（否则首次灌入可能漏同步）
      syncIdCounters(next.nodes, next.edges);
      const merged: DerivationCanvasState = {
        ...emptyCanvasState(),
        ...next,
        nodes: Array.isArray(next.nodes) ? next.nodes : [],
        edges: Array.isArray(next.edges) ? next.edges : [],
      };

      /**
       * 幂等：结构与当前画布等价时直接返回，不写 store。
       *
       * 必要性（阶段六缺陷修复，见实施计划 §10.3.3）：
       * 受控画布存在 props / store 两个真相来源。若灌入时无条件写入新对象，
       * 会形成 init → 回传父级 → 父级 setState → props 变化 → 再 init 的自激环，
       * 最终触发 React「Maximum update depth exceeded」（生产构建报 error #185）。
       */
      if (canvasStructureKey(get().canvas) === canvasStructureKey(merged)) return;

      set({
        canvas: merged,
        past: [],
        future: [],
        toast: null,
        cycleHighlight: findDerivationCycle(
          merged.nodes.map((n) => n.id),
          merged.edges,
        ),
      });
    },

    getCanvas: () => get().canvas,

    /* ================= 节点操作 ================= */

    addNode: (type, opts) => {
      if (type === 'given') { set({ toast: '已知条件由系统提供，不能手动新增' }); return ''; }
      const { canvas } = get();
      const id = nextNodeId();
      const node: DerivationNode = {
        id,
        type,
        position: opts?.position ?? { x: 0, y: 0 },
        data: {
          label: opts?.data?.label ?? DEFAULT_LABEL[type],
          latex: opts?.data?.latex,
          mathJson: opts?.data?.mathJson,
          note: opts?.data?.note,
          status: opts?.data?.status ?? 'draft',
          verification: opts?.data?.verification,
          frozen: opts?.data?.frozen ?? false,
          unitHint: opts?.data?.unitHint,
        },
      };
      const nextCanvas: DerivationCanvasState = { ...canvas, nodes: [...canvas.nodes, node] };
      set({ canvas: nextCanvas, ...commit(canvas) });
      return id;
    },

    updateNode: (id, patch) => {
      const { canvas } = get();
      const node = canvas.nodes.find((n) => n.id === id);
      // 节点不存在或已冻结 → 静默忽略
      if (!node || node.type === 'given' || node.data.frozen) return;

      const updated = patchedNode(node, patch);
      const nodes = canvas.nodes.map((n) => n.id === id ? updated.node : n);
      /**
       * 公式内容变化 → 下游作废（与 updateNodeDraft 同口径）。
       *
       * 非 latex 的结构性变更（如系统回填 status / verification）**不作废** ——
       * 否则「刚通过验证」会立刻把自己的下游重置，形成死循环。
       */
      const nextCanvas: DerivationCanvasState = updated.invalidate
        ? invalidateDescendants({ ...canvas, nodes }, id)
        : { ...canvas, nodes };
      set({ canvas: nextCanvas, ...commit(canvas) });
    },

    updateNodeDraft: (id, patch) => {
      const { canvas } = get();
      const node = canvas.nodes.find((n) => n.id === id);
      if (!node || node.type === 'given' || node.data.frozen) return;

      // 内容未变则跳过：避免无谓的 store 写入 → 回传父级 → props 回灌的回声
      const current = node.data as unknown as Record<string, unknown>;
      const changed = Object.entries(patch).some(([k, v]) => current[k] !== v);
      if (!changed) return;

      const updated = patchedNode(node, patch);
      const nodes = canvas.nodes.map((n) => n.id === id ? updated.node : n);
      const drafted: DerivationCanvasState = { ...canvas, nodes };

      /**
       * 公式内容变化 → 下游作废（前提链架构）。
       *
       * ## 只认 `latex` 的实质变化
       * - 仅改 note（备注）/ label / unitHint → **不作废**（不参与符号计算）
       * - latex 未变（失焦重存同值）→ 不作废（上方 `changed` 判断已拦截）
       * - 挪动位置 / 冻结 → 走其他 action，本函数不涉及
       *
       * ## 为什么作废要进历史栈
       * 草稿本身不进栈（避免逐字符污染撤销历史），但**作废是结构性后果**：
       * 若不进栈，用户 Ctrl+Z 只能退回自己的输入，回不到「下游仍是已通过」的状态。
       *
       * ## 为什么写 toast
       * 下游节点会突然从绿色变成灰色，若不解释，用户会以为出了故障。
       */
      if (!updated.invalidate) {
        set({ canvas: drafted });
        return;
      }

      const invalidated = invalidateDescendants(drafted, id);
      // 统计实际被重置的后代数量（用于提示文案；未变化的节点不该计入）
      const affected = invalidated.nodes.reduce((acc, n) => {
        const before = drafted.nodes.find((o) => o.id === n.id);
        return acc + (before && before.data.status !== n.data.status ? 1 : 0);
      }, 0);

      if (affected > 0) {
        set({
          canvas: invalidated,
          ...commit(canvas),
          toast: `上游公式已修改，下游 ${affected} 个步骤需重新验证`,
        });
        return;
      }
      set({ canvas: drafted });
    },

    updateNodePosition: (id, position) => {
      // 拖拽高频，不进历史栈
      const { canvas } = get();
      const nodes = canvas.nodes.map((n) => (n.id === id ? { ...n, position } : n));
      set({ canvas: { ...canvas, nodes } });
    },

    removeNode: (id) => {
      const { canvas } = get();
      if (canvas.nodes.some(node => node.id === id && node.type === 'given')) {
        set({ toast: '系统已知条件不可删除，可移动节点或调整连线' }); return;
      }

      /**
       * **先**在删边之前收集后代并作废，**再**执行删除。
       *
       * 为什么顺序不能颠倒（关键）：`invalidateDescendants` 依赖 `edges` 做图遍历，
       * 而下一步就会把该节点的所有连线删掉 —— 那时图已断裂，追溯不到后代，
       * 下游会带着「基于已消失的前提」得出的结论继续显示绿色（假信号）。
       */
      const invalidated = invalidateDescendants(canvas, id);

      const nodes = invalidated.nodes.filter((n) => n.id !== id);
      // 同时移除该节点相关的所有连线
      const edges = invalidated.edges.filter((e) => e.source !== id && e.target !== id);
      const nextCanvas: DerivationCanvasState = { ...invalidated, nodes, edges };
      set({
        canvas: nextCanvas,
        ...commit(canvas),
        cycleHighlight: findDerivationCycle(
          nodes.map((n) => n.id),
          edges,
        ),
      });
    },

    /* ================= 连线操作 ================= */

    addEdge: (source, target, type) => {
      const { canvas } = get();
      const sourceNode = canvas.nodes.find((n) => n.id === source);
      const targetNode = canvas.nodes.find((n) => n.id === target);
      if (!sourceNode || !targetNode) {
        set({ toast: '连线节点不存在，已拒绝' });
        return false;
      }
      if (sourceNode.type === 'conclusion') {
        set({ toast: '结论节点是支路终点，不能作为其他步骤的前提' });
        return false;
      }
      if (targetNode.type === 'given') {
        set({ toast: '已知条件是支路起点，不能接收入线' });
        return false;
      }

      // ① 自环与环检测（S4 硬约束：推导图必须是 DAG）
      if (wouldCreateCycle(source, target, canvas.edges)) {
        set({ toast: '该连线会形成循环推导（A→B→A），已拒绝' });
        return false;
      }

      // ② 去重：同一对 source→target 不重复建同类型边
      const duplicated = canvas.edges.some(
        (e) => e.source === source && e.target === target && e.type === type,
      );
      if (duplicated) {
        set({ toast: '这两个节点之间已存在同类型连线' });
        return false;
      }

      const edge: DerivationEdge = { id: nextEdgeId(), source, target, type };
      const edges = [...canvas.edges, edge];
      const nextCanvas = invalidateDescendants({ ...canvas, edges }, target, true);
      set({ canvas: nextCanvas, ...commit(canvas), toast: null });
      return true;
    },

    removeEdge: (id) => {
      const { canvas } = get();
      const removed = canvas.edges.find((e) => e.id === id);
      if (!removed) return;
      const edges = canvas.edges.filter((e) => e.id !== id);
      const nextCanvas = invalidateDescendants({ ...canvas, edges }, removed.target, true);
      set({
        canvas: nextCanvas,
        ...commit(canvas),
        cycleHighlight: findDerivationCycle(
          canvas.nodes.map((n) => n.id),
          edges,
        ),
      });
    },

    /* ================= 视口 ================= */

    setViewport: (v) => {
      // 缩放/平移高频，不进历史栈
      const { canvas } = get();
      const cur = canvas.viewport ?? { x: 0, y: 0, zoom: 1 };
      /**
       * 幂等：视口未真正变化时不写 store。
       * onMoveEnd 会在同一位置重复回调，若每次都写新对象会制造无谓的回传回声。
       */
      if (
        Math.abs(cur.x - v.x) < VIEWPORT_EPSILON &&
        Math.abs(cur.y - v.y) < VIEWPORT_EPSILON &&
        Math.abs(cur.zoom - v.zoom) < VIEWPORT_EPSILON
      ) {
        return;
      }
      set({ canvas: { ...canvas, viewport: v } });
    },

    /* ================= 撤销/重做 ================= */

    undo: (allowed) => {
      const { past, canvas, future } = get();
      if (past.length === 0) return false;
      const prev = past[past.length - 1];
      if (!preservesSystemGivens(canvas, prev)) { set({ toast: '该历史操作会改变系统已知条件，已拒绝' }); return false; }
      set({
        canvas: projectDerivationHistory(canvas,prev,allowed ?? ['given','formula','conclusion','assumption']),
        past: past.slice(0, -1),
        future: [canvas, ...future].slice(0, MAX_HISTORY),
      });
      return true;
    },

    redo: (allowed) => {
      const { past, canvas, future } = get();
      if (future.length === 0) return false;
      const next = future[0];
      if (!preservesSystemGivens(canvas, next)) { set({ toast: '该历史操作会改变系统已知条件，已拒绝' }); return false; }
      set({
        canvas: projectDerivationHistory(canvas,next,allowed ?? ['given','formula','conclusion','assumption']),
        past: [...past, canvas].slice(-MAX_HISTORY),
        future: future.slice(1),
      });
      return true;
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    /* ================= 冻结 ================= */

    toggleFreeze: (id) => {
      const { canvas } = get();
      const node = canvas.nodes.find((n) => n.id === id);
      if (!node || node.type === 'given') return;
      // 冻结态在 draft 与 frozen 之间切换；解冻回到 draft
      const nextStatus: DerivationNodeData['status'] = node.data.frozen ? 'draft' : 'frozen';
      const nodes = canvas.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, frozen: !n.data.frozen, status: nextStatus } }
          : n,
      );
      const nextCanvas: DerivationCanvasState = { ...canvas, nodes };
      set({ canvas: nextCanvas, ...commit(canvas) });
    },

    clearToast: () => set({ toast: null }),
  };
});
