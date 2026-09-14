/**
 * 画布内元素 ID 生成工具（从 argument-editor-standalone 迁移）
 *
 * 节点 id 形如 s1、s2…… 边 id 形如 e1、e2…… 均为画布内递增数字。
 * 删除后不复用（全局计数器）。
 */

let nodeCounter = 0;
let edgeCounter = 0;

/** 生成新节点 id（递增，不复用，统一 s 前缀） */
export function nextNodeId(): string {
  nodeCounter += 1;
  return `s${nodeCounter}`;
}

/** 生成新边 id（递增，不复用） */
export function nextEdgeId(): string {
  edgeCounter += 1;
  return `e${edgeCounter}`;
}

/**
 * 根据已有节点/边集合同步计数器（加载已保存文档时调用，
 * 确保之后新建的 id 不会与既有 id 冲突）。
 */
export function syncIdCounters(nodes: Array<{ id: string }>, edges: Array<{ id: string }>): void {
  let maxNode = 0;
  let maxEdge = 0;
  for (const n of nodes) {
    const m = /^[ns](\d+)$/.exec(n.id);
    if (m) maxNode = Math.max(maxNode, parseInt(m[1], 10));
  }
  for (const e of edges) {
    const m = /^e(\d+)$/.exec(e.id);
    if (m) maxEdge = Math.max(maxEdge, parseInt(m[1], 10));
  }
  nodeCounter = Math.max(nodeCounter, maxNode);
  edgeCounter = Math.max(edgeCounter, maxEdge);
}