/**
 * S4 推导画布 —— 环检测工具
 *
 * 与 `argumentCanvas/utils/cycle.ts` 独立（不跨模块 import，避免耦合，遵守红线 R8）。
 *
 * S4 语义（阶段七简化）：
 * - 连线类型已收敛为单一「推导」，**所有连线都参与环检测**
 * - 理由：公式推导是单链分支结构，任何回边都意味着循环论证（A 用 B 推、B 又用 A 推）
 * - 此前 `compare`（并列对比）曾豁免环检测，该类型已随连线类型收敛一并移除
 *
 * 推导图必须是 DAG（有向无环图），否则会出现循环论证。
 */

/** 边的最小结构（只要求环检测需要的字段） */
interface CycleEdgeLike {
  id?: string;
  source: string;
  target: string;
  type?: string;
}

/**
 * 判断该边是否参与环检测。
 *
 * 当前恒为 true —— 所有连线都参与。保留此函数是为了让环检测的两个入口
 * （`wouldCreateCycle` / `findDerivationCycle`）共享同一判据；
 * 未来若再引入「并列关系」类连线，只需改这一处。
 */
function participatesInCycle(_edge: CycleEdgeLike): boolean {
  return true;
}

/**
 * 判断新增一条边 source→target 后是否会成环。
 *
 * 算法：从 target 出发做 DFS，若能走回 source，则加上这条边会成环。
 *
 * @returns true 表示会成环（应拒绝该连接）
 */
export function wouldCreateCycle(
  source: string,
  target: string,
  edges: CycleEdgeLike[],
): boolean {
  // 自环直接禁止
  if (source === target) return true;

  // 邻接表（只含参与环检测的边）
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!participatesInCycle(e)) continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    adj.get(e.source)!.add(e.target);
  }

  // 从 target 出发，看能否到达 source
  const visited = new Set<string>();
  const stack: string[] = [target];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const nexts = adj.get(cur);
    if (nexts) {
      for (const nx of nexts) {
        if (!visited.has(nx)) stack.push(nx);
      }
    }
  }
  return false;
}

/** 环信息：环上节点序列 + 环上边 id 序列 */
export interface DerivationCycleInfo {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * 检测一组边里是否已存在环（用于加载历史画布时的兜底校验）。
 *
 * 使用三色标记法（WHITE/GRAY/BLACK）找到第一个环。
 *
 * @returns 找到的环信息；无环返回 null
 */
export function findDerivationCycle(
  nodes: string[],
  edges: CycleEdgeLike[],
): DerivationCycleInfo | null {
  const activeEdges = edges.filter(participatesInCycle);

  const adj = new Map<string, Array<{ to: string; edgeId: string }>>();
  for (const n of nodes) adj.set(n, []);
  for (const e of activeEdges) {
    if (adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push({ to: e.target, edgeId: e.id ?? `${e.source}->${e.target}` });
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  const nodePath: string[] = [];
  const edgePath: string[] = [];

  function dfs(u: string): DerivationCycleInfo | null {
    color.set(u, GRAY);
    nodePath.push(u);
    for (const { to, edgeId } of adj.get(u) || []) {
      if (color.get(to) === GRAY) {
        // 找到回边：截取环上的节点与边
        const idx = nodePath.indexOf(to);
        return {
          nodeIds: nodePath.slice(idx),
          edgeIds: edgePath.slice(idx).concat(edgeId),
        };
      }
      if (color.get(to) === WHITE) {
        edgePath.push(edgeId);
        const res = dfs(to);
        if (res) return res;
        edgePath.pop();
      }
    }
    nodePath.pop();
    color.set(u, BLACK);
    return null;
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE) {
      const res = dfs(n);
      if (res) return res;
    }
  }
  return null;
}