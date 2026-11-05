import type { DerivationCanvasState } from '../../../types/sceneS4';

export function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => sameData(item, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameData(a[key], b[key]));
}

/** User operations may move system givens, but cannot create, delete, retype or rewrite them. */
export function preservesSystemGivens(previous: DerivationCanvasState, next: DerivationCanvasState): boolean {
  const before = previous.nodes.filter(node => node.type === 'given');
  const after = next.nodes.filter(node => node.type === 'given');
  return before.length === after.length && before.every(node => {
    const current = after.find(item => item.id === node.id);
    return Boolean(current && sameData(node.data, current.data));
  });
}
