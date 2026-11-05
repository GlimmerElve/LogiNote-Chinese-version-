import type { S2Document } from '../../types/sceneS2';

export type S2CanvasShortcut = 'delete' | 'undo' | 'redo';
export interface S2CanvasShortcutEvent {
  key: string;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number;
  target?: unknown;
  composedPath?: () => unknown[];
  nativeEvent?: { isComposing?: boolean; keyCode?: number; composedPath?: () => unknown[] };
}
export interface S2CanvasShortcutOptions {
  /** The actual canvas keyboard scope, never the whole application/document. */
  scope: { contains(target: any): boolean } | null | undefined;
  activeElement?: unknown;
  canDelete?: boolean; canUndo?: boolean; canRedo?: boolean;
}

/** Focus may be a text node, a nested editor child, or a shadow-root descendant. */
function editing(target: unknown): boolean {
  const seen = new Set<object>();
  let current = target;
  for (let depth = 0; current && typeof current === 'object' && depth < 64; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const node = current as { tagName?: string; nodeName?: string; isContentEditable?: boolean;
      getAttribute?: (name: string) => string | null; parentElement?: unknown; parentNode?: unknown; host?: unknown };
    const name = (node.tagName ?? node.nodeName ?? '').toLowerCase();
    if (['input', 'textarea', 'select', 'option'].includes(name) || node.isContentEditable === true) return true;
    const editable = node.getAttribute?.('contenteditable');
    if (editable !== undefined && editable !== null && editable.toLowerCase() !== 'false') return true;
    const roles = node.getAttribute?.('role')?.toLowerCase().split(/\s+/) ?? [];
    if (roles.some(role => ['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'slider'].includes(role))) return true;
    current = node.parentElement ?? node.parentNode ?? node.host;
  }
  return false;
}

/** Decision only. The caller prevents the native key only after it can perform this action. */
export function resolveS2CanvasShortcut(event: S2CanvasShortcutEvent, options: S2CanvasShortcutOptions): S2CanvasShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229 || event.altKey) return null;
  let path: unknown[] = [];
  try { path = event.composedPath?.() ?? event.nativeEvent?.composedPath?.() ?? []; } catch { /* No usable composed path. */ }
  const candidates = [event.target, options.activeElement, ...(Array.isArray(path) ? path : [])];
  if (candidates.some(editing)) return null;
  const inScope = candidates.some(target => {
    try { return !!target && options.scope?.contains(target) === true; } catch { return false; }
  });
  if (!inScope) return null;
  const key = event.key.toLowerCase(), modified = !!(event.ctrlKey || event.metaKey);
  const action: S2CanvasShortcut | null = modified && key === 'z' ? event.shiftKey ? 'redo' : 'undo'
    : event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'y' ? 'redo'
      : !modified && (event.key === 'Delete' || event.key === 'Backspace') ? 'delete' : null;
  return action && (action === 'delete' ? options.canDelete : action === 'undo' ? options.canUndo : options.canRedo) ? action : null;
}

export interface S2CanvasDeleteSelection { nodeIds?: readonly string[]; edgeIds?: readonly string[] }
const dataEdgeId = (link: NonNullable<S2Document['execution']>['links'][number]) =>
  JSON.stringify([link.source.nodeId, link.source.portId, link.target.nodeId, link.target.portId]);
const fieldEdgeId = (nodeId: string, portId: string, binding: unknown) => JSON.stringify([nodeId, portId, binding]);
const conditionEdgeId = (nodeId: string) => JSON.stringify(['condition', nodeId]);

/** One detached, uncommitted document for a user selection. No registry, IO or execution.
 * The caller validates the complete result and its readonly baseline, then commits once.
 * This avoids the Agent command-count limit for a user's multi-edge delete. */
export function deleteS2CanvasSelection(document: S2Document, selection: S2CanvasDeleteSelection): S2Document {
  const requested = new Set(selection.nodeIds ?? []), edges = new Set(selection.edgeIds ?? []);
  for (const shell of [...(document.groups ?? []), ...(document.composites ?? [])])
    if (requested.has(shell.id)) shell.nodeIds.forEach(id => requested.add(id));
  const nodes = new Set([...document.nodes, ...(document.execution?.nodes ?? [])].filter(node => requested.has(node.id)).map(node => node.id));
  const knownEdges = new Set([
    ...document.edges.map(edge => edge.id), ...(document.execution?.links ?? []).map(dataEdgeId),
    ...(document.execution?.nodes ?? []).flatMap(node => [
      ...(node.when ? [conditionEdgeId(node.id)] : []),
      ...Object.entries(node.bindings).flatMap(([port, binding]) => binding.kind === 'field' ? [fieldEdgeId(node.id, port, binding)] : []),
    ]),
  ]);
  if (!nodes.size && ![...edges].some(id => knownEdges.has(id))) return document;
  const next = structuredClone(document);
  next.nodes = next.nodes.filter(node => !nodes.has(node.id));
  next.edges = next.edges.filter(edge => !nodes.has(edge.source) && !nodes.has(edge.target) && !edges.has(edge.id));
  if (next.execution) {
    next.execution.nodes = next.execution.nodes.filter(node => !nodes.has(node.id));
    next.execution.links = next.execution.links.filter(link => !nodes.has(link.source.nodeId) && !nodes.has(link.target.nodeId) && !edges.has(dataEdgeId(link)));
    for (const node of next.execution.nodes) {
      node.bindings = Object.fromEntries(Object.entries(node.bindings).filter(([port, binding]) =>
        binding.kind !== 'field' || !nodes.has(binding.nodeId) && !edges.has(fieldEdgeId(node.id, port, binding))));
      if (node.when && (nodes.has(node.when.nodeId) || edges.has(conditionEdgeId(node.id)))) delete node.when;
    }
  }
  const remaining = new Set([...next.nodes, ...(next.execution?.nodes ?? [])].map(node => node.id));
  if (next.groups) next.groups = next.groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => remaining.has(id)) })).filter(group => group.nodeIds.length);
  if (next.composites) {
    const steps = new Set(next.execution?.nodes.map(node => node.id));
    next.composites = next.composites.map(composite => ({ ...composite, nodeIds: composite.nodeIds.filter(id => steps.has(id)) })).filter(composite => composite.nodeIds.length);
  }
  return next;
}
