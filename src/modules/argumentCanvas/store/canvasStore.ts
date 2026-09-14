/**
 * 画布内存 store（从 argument-editor-standalone 的 docStore 完整迁移）
 *
 * 纯内存、无持久化：由受控组件 ArgumentCanvas 持有，props 进 ArgDoc、onChange 出 ArgDoc。
 * 完整保留编辑器全部操作能力：撤销/重做、剪贴板、批量删除。
 */

import { create } from 'zustand';
import type { ArgDoc, ArgNode, ArgEdge, RelationType, Point } from '../../../services/argumentDoc/types';
import { nextNodeId, nextEdgeId, syncIdCounters } from '../utils/id';
import { wouldCreateCycle, findSupportCycleWithEdges, type SupportCycleInfo } from '../utils/cycle';

/** 历史栈最大深度 */
const MAX_HISTORY = 50;
/** 连续文本输入合并窗口（毫秒） */
const TEXT_MERGE_WINDOW = 2000;

/** 剪贴板内容（模块级，会话内有效） */
interface ClipboardContent {
  nodes: ArgNode[];
  edges: ArgEdge[];
  center: Point;
}
let clipboard: ClipboardContent | null = null;

/** 最近一次提交元信息（用于文本编辑合并） */
let lastCommit: { kind: 'text-edit' | 'other'; ts: number } | null = null;

interface CanvasStore {
  doc: ArgDoc;
  past: ArgDoc[];
  future: ArgDoc[];
  cycleHighlight: SupportCycleInfo | null;

  initDoc: (doc: ArgDoc) => void;
  getDoc: () => ArgDoc;

  addNode: (mainType: ArgNode['mainType'], opts?: Partial<ArgNode>) => string;
  updateNode: (id: string, patch: Partial<ArgNode>) => void;
  updateNodePosition: (id: string, position: Point) => void;
  removeNode: (id: string) => void;
  removeNodes: (ids: string[]) => void;

  addEdge: (source: string, target: string, relation: RelationType) => boolean;
  removeEdge: (id: string) => void;
  removeEdges: (ids: string[]) => void;

  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;

  applyLayout: (positions: Record<string, Point>) => void;
  applyPositionMap: (positions: Record<string, Point>) => void;
  applyVulnerabilityPatch: (nodes: ArgNode[]) => void;

  copySelection: (ids: string[]) => void;
  pasteAt: (anchor: Point) => string[];
}

function stampedDoc(doc: ArgDoc): ArgDoc {
  return { ...doc, updated_at: new Date().toISOString() };
}

function detectCycle(doc: ArgDoc): SupportCycleInfo | null {
  return findSupportCycleWithEdges(
    doc.nodes.map((n) => n.id),
    doc.edges,
  );
}

/** 兼容旧档：type → mainType 迁移 */
function migrateLegacyNodes(doc: ArgDoc): ArgDoc {
  const nodes = doc.nodes.map((n) => {
    const legacy = (n as ArgNode & { type?: string }).type;
    if (legacy && !n.mainType) {
      return { ...n, mainType: legacy as ArgNode['mainType'] };
    }
    return n;
  });
  return { ...doc, nodes };
}

export const useCanvasStore = create<CanvasStore>((set, get) => {
  function commit(doc: ArgDoc, kind: 'text-edit' | 'other'): ArgDoc[] {
    const now = Date.now();
    const { past } = get();

    let newPast: ArgDoc[];
    if (
      kind === 'text-edit' &&
      lastCommit?.kind === 'text-edit' &&
      now - lastCommit.ts < TEXT_MERGE_WINDOW
    ) {
      newPast = past;
    } else {
      newPast = [...past, doc].slice(-MAX_HISTORY);
    }
    lastCommit = { kind, ts: now };
    return newPast;
  }

  return {
    doc: {
      doc_id: 'empty',
      title: '',
      created_at: '',
      updated_at: '',
      iteration: 1,
      status: 'draft',
      nodes: [],
      edges: [],
    },
    past: [],
    future: [],
    cycleHighlight: null,

    initDoc: (doc) => {
      const migrated = migrateLegacyNodes(doc);
      syncIdCounters(migrated.nodes, migrated.edges);
      lastCommit = null;
      set({ doc: migrated, past: [], future: [], cycleHighlight: detectCycle(migrated) });
    },

    getDoc: () => get().doc,

    addNode: (mainType, opts) => {
      const { doc } = get();
      const id = nextNodeId();
      const node: ArgNode = {
        id,
        mainType,
        text: opts?.text ?? '',
        position: opts?.position ?? { x: 0, y: 0 },
        status: opts?.status ?? 'ok',
        issue: opts?.issue ?? null,
        severity: opts?.severity ?? null,
        suggestion: opts?.suggestion ?? null,
        subTypes: opts?.subTypes,
        asrNote: opts?.asrNote,
        user_edited: opts?.user_edited ?? false,
        collapsed: opts?.collapsed ?? false,
      };
      const newDoc = stampedDoc({ ...doc, nodes: [...doc.nodes, node] });
      set({ doc: newDoc, past: commit(doc, 'other'), future: [] });
      return id;
    },

    updateNode: (id, patch) => {
      const { doc } = get();

      // 展开/收起：不进栈（只改 collapsed）
      if (patch.collapsed !== undefined && Object.keys(patch).length === 1) {
        const nodes = doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
        set({ doc: stampedDoc({ ...doc, nodes }) });
        return;
      }

      // 文本编辑：可合并
      const isTextEdit =
        patch.text !== undefined &&
        Object.keys(patch).every((k) => k === 'text' || k === 'user_edited' || k === 'status');
      const kind: 'text-edit' | 'other' = isTextEdit ? 'text-edit' : 'other';

      const nodes = doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
      const newDoc = stampedDoc({ ...doc, nodes });
      set({ doc: newDoc, past: commit(doc, kind), future: [] });
    },

    updateNodePosition: (id, position) => {
      const { doc } = get();
      const nodes = doc.nodes.map((n) => (n.id === id ? { ...n, position } : n));
      set({ doc: stampedDoc({ ...doc, nodes }) });
    },

    removeNode: (id) => {
      const { doc } = get();
      const nodes = doc.nodes.filter((n) => n.id !== id);
      const edges = doc.edges.filter((e) => e.source !== id && e.target !== id);
      const newDoc = stampedDoc({ ...doc, nodes, edges });
      set({
        doc: newDoc,
        past: commit(doc, 'other'),
        future: [],
        cycleHighlight: detectCycle(newDoc),
      });
    },

    removeNodes: (ids) => {
      const { doc } = get();
      const idSet = new Set(ids);
      const nodes = doc.nodes.filter((n) => !idSet.has(n.id));
      const edges = doc.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target));
      const newDoc = stampedDoc({ ...doc, nodes, edges });
      set({
        doc: newDoc,
        past: commit(doc, 'other'),
        future: [],
        cycleHighlight: detectCycle(newDoc),
      });
    },

    addEdge: (source, target, relation) => {
      const { doc } = get();
      if (source === target) return false;
      if (relation === 'support' && wouldCreateCycle(source, target, doc.edges)) return false;
      const exists = doc.edges.some(
        (e) => e.source === source && e.target === target && e.relation === relation,
      );
      if (exists) return false;

      const id = nextEdgeId();
      const edge: ArgEdge = { id, source, target, relation };
      const newDoc = stampedDoc({ ...doc, edges: [...doc.edges, edge] });
      set({ doc: newDoc, past: commit(doc, 'other'), future: [] });
      return true;
    },

    removeEdge: (id) => {
      const { doc } = get();
      const edges = doc.edges.filter((e) => e.id !== id);
      const newDoc = stampedDoc({ ...doc, edges });
      set({
        doc: newDoc,
        past: commit(doc, 'other'),
        future: [],
        cycleHighlight: detectCycle(newDoc),
      });
    },

    removeEdges: (ids) => {
      const { doc } = get();
      const idSet = new Set(ids);
      const edges = doc.edges.filter((e) => !idSet.has(e.id));
      const newDoc = stampedDoc({ ...doc, edges });
      set({
        doc: newDoc,
        past: commit(doc, 'other'),
        future: [],
        cycleHighlight: detectCycle(newDoc),
      });
    },

    undo: () => {
      const { doc, past, future } = get();
      if (past.length === 0) return false;
      const prev = past[past.length - 1];
      lastCommit = null;
      set({
        doc: prev,
        past: past.slice(0, -1),
        future: [...future, doc].slice(-MAX_HISTORY),
        cycleHighlight: detectCycle(prev),
      });
      return true;
    },

    redo: () => {
      const { doc, past, future } = get();
      if (future.length === 0) return false;
      const next = future[future.length - 1];
      lastCommit = null;
      set({
        doc: next,
        future: future.slice(0, -1),
        past: [...past, doc].slice(-MAX_HISTORY),
        cycleHighlight: detectCycle(next),
      });
      return true;
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    applyLayout: (positions) => {
      const { doc } = get();
      const nodes = doc.nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n,
      );
      set({ doc: stampedDoc({ ...doc, nodes }) });
    },

    applyPositionMap: (positions) => {
      const { doc } = get();
      const nodes = doc.nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n,
      );
      set({ doc: stampedDoc({ ...doc, nodes }) });
    },

    // 「再次提交」：只增量合并诊断字段，不动坐标/文本/撤销栈，
    // 与首次「整体 initDoc 重建」隔离，避免同 doc_id 跳过重灌导致结果不刷新。
    applyVulnerabilityPatch: (updatedNodes) => {
      const { doc } = get();
      const patchMap = new Map(updatedNodes.map((n) => [n.id, n] as const));
      const nodes = doc.nodes.map((n) => {
        const p = patchMap.get(n.id);
        if (!p) return n;
        return {
          ...n,
          status: p.status,
          issue: p.issue,
          severity: p.severity,
          suggestion: p.suggestion,
        };
      });
      set({ doc: stampedDoc({ ...doc, nodes }) });
    },

    copySelection: (ids) => {
      const { doc } = get();
      const idSet = new Set(ids);
      const nodes = doc.nodes.filter((n) => idSet.has(n.id));
      const edges = doc.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
      if (nodes.length === 0) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x);
        maxY = Math.max(maxY, n.position.y);
      }
      clipboard = {
        nodes,
        edges,
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      };
    },

    pasteAt: (anchor) => {
      if (!clipboard || clipboard.nodes.length === 0) return [];
      const { doc } = get();

      const dx = anchor.x - clipboard.center.x;
      const dy = anchor.y - clipboard.center.y;

      const idMap = new Map<string, string>();
      for (const n of clipboard.nodes) {
        idMap.set(n.id, nextNodeId());
      }

      const newNodes: ArgNode[] = clipboard.nodes.map((n) => ({
        ...n,
        id: idMap.get(n.id)!,
        status: 'ok',
        issue: null,
        user_edited: false,
        position: { x: n.position.x + dx, y: n.position.y + dy },
      }));

      const newEdges: ArgEdge[] = clipboard.edges
        .map((e) => ({
          id: nextEdgeId(),
          source: idMap.get(e.source)!,
          target: idMap.get(e.target)!,
          relation: e.relation,
        }))
        .filter((e) => e.source && e.target);

      const newDoc = stampedDoc({
        ...doc,
        nodes: [...doc.nodes, ...newNodes],
        edges: [...doc.edges, ...newEdges],
      });
      set({
        doc: newDoc,
        past: commit(doc, 'other'),
        future: [],
        cycleHighlight: detectCycle(newDoc),
      });
      return newNodes.map((n) => n.id);
    },
  };
});