import type { S2Document, S2WorkflowNode } from '../../types/sceneS2';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { isS2TextResource } from './sceneS2TextResource';
import { isS2ImageResource } from './sceneS2ImageResource';
import { isS2ProjectNotes } from './sceneS2ProjectNotes';

export function s2SessionResourceKind(node: S2WorkflowNode) {
  return isS2TextResource(node) ? 'text' : isS2ImageResource(node) ? 'image' : isS2ProjectNotes(node) ? 'note' : undefined;
}

/** Reusable design, not a resource grant. Only call on a checked document.
 * Preserve arbitrary business strings, field references, graph links and published blueprints. */
export function reusableS2Document(document: S2Document): S2Document {
  const copy = structuredClone(document), registry = s2BuiltinPluginRegistry();
  for (const node of copy.execution?.nodes ?? []) {
    if (s2SessionResourceKind(node) && node.bindings.resource?.kind === 'literal') delete node.bindings.resource;
    // core.image values are host-owned handles, including literals on third-party inputs.
    for (const port of registry.capability(node).inputs) {
      if (port.type.id === 'core.image' && port.type.version === 1 && node.bindings[port.id]?.kind === 'literal') delete node.bindings[port.id];
    }
  }
  return copy;
}

export function unselectedS2Resources(document: S2Document) {
  return (document.execution?.nodes ?? []).filter(node => s2SessionResourceKind(node) && !node.bindings.resource
    && !document.execution?.links.some(link => link.target.nodeId === node.id && link.target.portId === 'resource'));
}
