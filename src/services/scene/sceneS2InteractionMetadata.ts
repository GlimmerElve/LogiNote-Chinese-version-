import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';

/** A portable/current snapshot retires dangling trigger references. The live
 * editor can retain its original configuration so undo restores those rules. */
export function pruneS2InteractionConfig(definition: S2CanvasDefinition, document: S2Document) {
  if (!definition.interaction) return undefined;
  const ids = new Set([...document.nodes, ...(document.execution?.nodes ?? [])].map(node => node.id));
  return { version: 1 as const, triggers: definition.interaction.triggers.filter(trigger => ids.has(trigger.on.nodeId)).map(trigger => ({
    ...structuredClone(trigger), ...(trigger.scope?.nodeIds ? { scope: { ...structuredClone(trigger.scope), nodeIds: trigger.scope.nodeIds.filter(id => ids.has(id)) } } : {}),
  })) };
}
export function s2InteractionDocumentSnapshot(definition: S2CanvasDefinition, document: S2Document): S2CanvasDefinition {
  return { ...definition, initial: document, ...(definition.interaction ? { interaction: pruneS2InteractionConfig(definition, document) } : {}) };
}
