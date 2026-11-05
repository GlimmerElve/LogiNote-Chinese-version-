import type { SceneInteractionPackDefinition, SceneInteractionPackManifest, ScenePackActivationServices, ScenePackAuthoringCatalog } from '../../../src/types/sceneInteractionPack';
import metadata from './scene-pack.json';
import { scalePlugin, executeLocal } from './plugins/scale';
import { validate, createRuntime } from './runtime';
import { createViews, scaleHelp } from './views';

/** Only assemble the public entry. Importing/activating never runs a graph or reads a resource. */
export function activate(services: ScenePackActivationServices): SceneInteractionPackDefinition {
  return {
    manifest: structuredClone(metadata.manifest) as SceneInteractionPackManifest,
    authoring: structuredClone(metadata.authoring) as ScenePackAuthoringCatalog,
    capabilities: [structuredClone(scalePlugin)],
    validate, createRuntime, executeLocal,
    help: structuredClone(scaleHelp),
    views: createViews(services),
  };
}
