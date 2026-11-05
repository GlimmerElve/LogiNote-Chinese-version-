/**
 * 支路图遍历工具（前提链架构新增）。
 *
 * 为什么需要：前提链判定的核心是「**由连线决定前提**」——
 *   - 判定某节点时，沿**入边**反向追溯所有祖先（有连线才有推导关系）
 *   - 修改某节点时，沿**出边**正向传播作废（下游需重新验证）
 *
 * 两者方向相反，是本模块区分两个函数的原因，不可混用。
 *
 * 图为 DAG（`derivationStore.addEdge` 已拦截成环），故遍历必然终止；
 * 仍加 visited 集合防御历史数据中可能存在的环。
 */

import type { DerivationEdge } from '../../../types/sceneS4';

/**
 * 反向追溯：沿入边一路向上，返回所有祖先节点 id（不含自身）。
 *
 * 语义（用户确认）：**没有连线就不相关**。即使某节点在画布上位于本节点附近，
 * 只要中间没有连线，它就不能作为本步的前提。
 *
 * 顺序为 BFS 层序（近祖先在前），便于诊断输出。
 */
export function collectAncestors(nodeId: string, edges: DerivationEdge[]): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const e of edges || []) {
    if (!e?.source || !e?.target) continue;
    const list = parentsOf.get(e.target);
    if (list) list.push(e.source);
    else parentsOf.set(e.target, [e.source]);
  }

  const visited = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  const out: string[] = [];

  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const p of parentsOf.get(cur) || []) {
      if (visited.has(p)) continue;   // 防环（历史数据兜底）
      visited.add(p);
      out.push(p);
      queue.push(p);
    }
  }
  return out;
}

/**
 * 正向传播：沿出边一路向下，返回所有后代节点 id（不含自身）。
 *
 * 用途：修改上游节点后，把所有下游节点重置为 draft —— 前提变了，
 * 原先的验证结论就不再成立，必须重新走一遍判定。
 */
export function collectDescendants(nodeId: string, edges: DerivationEdge[]): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges || []) {
    if (!e?.source || !e?.target) continue;
    const list = childrenOf.get(e.source);
    if (list) list.push(e.target);
    else childrenOf.set(e.source, [e.target]);
  }

  const visited = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  const out: string[] = [];

  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const c of childrenOf.get(cur) || []) {
      if (visited.has(c)) continue;
      visited.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * 直接父节点（只走一层，不递归）。
 *
 * 用途：诊断提示（如「本步直接引用了哪几步」），以及多父汇合时的冲突定位。
 */
export function directParents(nodeId: string, edges: DerivationEdge[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of edges || []) {
    if (e?.target !== nodeId || !e?.source) continue;
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    out.push(e.source);
  }
  return out;
}

/**
 * 拓扑意义上的「无祖先节点」（可作为推导链起点）。
 *
 * 用途：UI 可将这些节点标记为「起点」，帮助用户理解哪些是题目前提。
 */
export function isRootNode(nodeId: string, edges: DerivationEdge[]): boolean {
  return directParents(nodeId, edges).length === 0;
}