/**
 * 推挤避让算法（从 argument-editor-standalone 迁移）
 *
 * - 只推开与被移动节点重叠的节点（被移动节点本身不动，其它节点让位）
 * - 允许连锁推到底
 * - 瞬移、无动画
 */

export interface OverlapRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: OverlapRect, b: OverlapRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function pushApart(source: OverlapRect, target: OverlapRect): void {
  const overlapX =
    Math.min(source.x + source.width, target.x + target.width) -
    Math.max(source.x, target.x);
  const overlapY =
    Math.min(source.y + source.height, target.y + target.height) -
    Math.max(source.y, target.y);

  if (overlapX < overlapY) {
    const dir = target.x >= source.x ? 1 : -1;
    target.x += dir * overlapX;
  } else {
    const dir = target.y >= source.y ? 1 : -1;
    target.y += dir * overlapY;
  }
}

export function resolveOverlap(
  rects: OverlapRect[],
  movedId: string,
): Record<string, { x: number; y: number }> {
  const map = new Map<string, OverlapRect>();
  for (const r of rects) map.set(r.id, { ...r });

  const moved = map.get(movedId);
  if (!moved) {
    const out: Record<string, { x: number; y: number }> = {};
    for (const r of rects) out[r.id] = { x: r.x, y: r.y };
    return out;
  }

  const pushed = new Set<string>([movedId]);
  const pending: string[] = [movedId];

  while (pending.length > 0) {
    const curId = pending.shift()!;
    const cur = map.get(curId)!;

    for (const [otherId, other] of map) {
      if (otherId === curId) continue;
      if (pushed.has(otherId)) continue;
      if (!overlaps(cur, other)) continue;

      pushApart(cur, other);
      pushed.add(otherId);
      pending.push(otherId);
    }
  }

  const result: Record<string, { x: number; y: number }> = {};
  for (const [id, r] of map) result[id] = { x: r.x, y: r.y };
  return result;
}