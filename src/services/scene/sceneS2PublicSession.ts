import type { SceneInteractionPack, ScenePackConfig } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { assertS2PublicEdit, compileS2PublicCanvas, findS2PublicComponent } from './sceneS2PublicAuthoring';
import { validateS2PublicInteraction } from './sceneS2InteractionEvents';

/** Only a newly created local starter is replaced with an empty public canvas.
 * Existing/imported graphs must satisfy the package contract before normalization. */
export function prepareS2PublicDefinition(pack: SceneInteractionPack, definition: S2CanvasDefinition,
  options: { fresh?: boolean } = {}): S2CanvasDefinition {
  if (!pack.authoring) return definition;
  const canonical = compileS2PublicCanvas(pack, { version: 1, nodes: [], connections: [] },
    { goal: definition.goal, instructions: definition.instructions });
  if (options.fresh) return canonical.definition;
  const before = { definition, document: definition.initial };
  assertS2PublicEdit(pack, before, before);
  // Upgrade only an already validated, unambiguous public instance. Internal
  // instances remain byte-for-byte package-owned; labels never become authority.
  const initial = structuredClone(definition.initial);
  for (const node of [...initial.nodes, ...(initial.execution?.nodes ?? [])]) {
    const component = findS2PublicComponent(pack, node, initial);
    if (component) node.componentId = component.id;
  }
  const result = readS2Definition({ ...definition, blockTypes: canonical.definition.blockTypes,
    plugins: canonical.definition.plugins, initial });
  validateS2PublicInteraction(pack, result);
  assertS2PublicEdit(pack, before, { definition: result, document: result.initial });
  return result;
}

/** The same logical component compiler used by the building Agent.
 * Append only the new instance, preserving native editor history/grouping/readonly metadata. */
export function appendS2PublicComponent(pack: SceneInteractionPack, before: ScenePackConfig,
  componentId: string, id: string, position: { x: number; y: number }): ScenePackConfig {
  const compiled = compileS2PublicCanvas(pack, { version: 1, nodes: [{ id, componentId, position }], connections: [] },
    { goal: before.definition.goal, instructions: before.definition.instructions });
  const document: S2Document = structuredClone(before.document);
  document.nodes.push(...compiled.document.nodes.filter(node => node.id === id));
  const steps = compiled.document.execution?.nodes.filter(node => node.id === id) ?? [];
  if (steps.length) {
    document.execution ??= { version: 1, nodes: [], links: [] };
    document.execution.nodes.push(...steps);
  }
  const definition = readS2Definition({ ...before.definition, blockTypes: compiled.definition.blockTypes,
    plugins: compiled.definition.plugins, initial: document });
  const next = { definition, document: readS2Document(document, definition) };
  assertS2PublicEdit(pack, before, next);
  return next;
}
