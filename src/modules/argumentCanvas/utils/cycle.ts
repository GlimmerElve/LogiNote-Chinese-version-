/**
 * 环检测工具（从 argument-editor-standalone 迁移）
 *
 * - 自环：直接禁止
 * - support 环：阻止创建（support 边作为层级依据，环会破坏三层布局）
 * - oppose 环：允许（oppose 不参与环判断）
 */

/** 判断新增一条 support 边 source→target 后是否会成环（oppose 不参与） */
export function wouldCreateCycle(
  source: string,
  target: string,
  edges: Array<{ source: string; target: string; relation?: string }>,
): boolean {
  if (source === target) return true;

  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.relation === 'oppose') continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    adj.get(e.source)!.add(e.target);
  }

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

/** 环信息：环上节点序列 + 环上支撑边 id 序列 */
export interface SupportCycleInfo {
  nodeIds: string[];
  edgeIds: string[];
}

/** 检测一组边里是否已存在 support 环（用于加载旧文档） */
export function findSupportCycleWithEdges(
  nodes: string[],
  edges: Array<{ id?: string; source: string; target: string; relation?: string }>,
): SupportCycleInfo | null {
  const supportEdges = edges.filter((e) => e.relation !== 'oppose');

  const adj = new Map<string, Array<{ to: string; edgeId: string }>>();
  for (const n of nodes) adj.set(n, []);
  for (const e of supportEdges) {
    if (adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push({ to: e.target, edgeId: e.id ?? `${e.source}->${e.target}` });
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  const nodePath: string[] = [];
  const edgePath: string[] = [];

  function dfs(u: string): SupportCycleInfo | null {
    color.set(u, GRAY);
    nodePath.push(u);
    for (const { to, edgeId } of adj.get(u) || []) {
      if (color.get(to) === GRAY) {
        const idx = nodePath.indexOf(to);
        return { nodeIds: nodePath.slice(idx), edgeIds: edgePath.slice(idx).concat(edgeId) };
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