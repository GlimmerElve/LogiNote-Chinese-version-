/** Session-only view coordinates. These are never cognition mutations. */
export interface CognitionCanvasPosition { x: number; y: number }
export type CognitionCanvasLayouts = Record<string, Record<string, CognitionCanvasPosition>>;

export const cognitionCanvasLayoutKey = (scope: string | undefined, groupId?: string | null) =>
  JSON.stringify([scope ?? null, groupId ?? null]);

export function moveCognitionCanvasNodes(layouts: CognitionCanvasLayouts, key: string,
  moves: Array<{ id: string; position: CognitionCanvasPosition }>, allowedIds: ReadonlySet<string>): CognitionCanvasLayouts {
  const current = layouts[key] || {};
  let next = current;
  for (const { id, position } of moves) {
    if (!allowedIds.has(id) || !Number.isFinite(position.x) || !Number.isFinite(position.y)
      || Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) continue;
    if (next[id]?.x === position.x && next[id]?.y === position.y) continue;
    if (next === current) next = { ...current };
    next[id] = { x: position.x, y: position.y };
  }
  return next === current ? layouts : { ...layouts, [key]: next };
}

export function restoreCognitionCanvasNode(layouts: CognitionCanvasLayouts, key: string, id: string,
  previous?: CognitionCanvasPosition): CognitionCanvasLayouts {
  if (previous) return moveCognitionCanvasNodes(layouts, key, [{ id, position: previous }], new Set([id]));
  if (!layouts[key] || !Object.hasOwn(layouts[key], id)) return layouts;
  const next = { ...layouts[key] }; delete next[id];
  return { ...layouts, [key]: next };
}

export function resetCognitionCanvasLayout(layouts: CognitionCanvasLayouts, key: string): CognitionCanvasLayouts {
  if (!Object.hasOwn(layouts, key)) return layouts;
  const next = { ...layouts }; delete next[key]; return next;
}
