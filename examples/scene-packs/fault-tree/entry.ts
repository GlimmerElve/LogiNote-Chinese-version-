import type { ScenePackActivationServices, SceneInteractionPackDefinition, SceneInteractionPackManifest, ScenePackAuthoringCatalog } from '../../../src/types/sceneInteractionPack';
import metadata from './scene-pack.json';
import { logicPlugin, executeLocal } from './plugins';
import { validate, createRuntime } from './runtime';
import { createViews, help } from './views';
export function activate(services: ScenePackActivationServices): SceneInteractionPackDefinition {
  return { manifest: structuredClone(metadata.manifest) as SceneInteractionPackManifest, authoring: structuredClone(metadata.authoring) as ScenePackAuthoringCatalog,
    execution: 'none', capabilities: [structuredClone(logicPlugin)], executeLocal, validate, createRuntime, views: createViews(services), help: structuredClone(help) };
}
