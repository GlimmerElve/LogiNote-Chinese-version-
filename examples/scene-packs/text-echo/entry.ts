import type { ScenePackActivationServices, SceneInteractionPackDefinition, SceneInteractionPackManifest, ScenePackAuthoringCatalog } from '../../../src/types/sceneInteractionPack';
import metadata from './scene-pack.json';
import { echoPlugin, executeLocal } from './plugins/echo';
import { validate, createRuntime } from './runtime';
import { createViews } from './views';

export function activate(services: ScenePackActivationServices): SceneInteractionPackDefinition {
  return {
    manifest: structuredClone(metadata.manifest) as SceneInteractionPackManifest,
    authoring: structuredClone(metadata.authoring) as ScenePackAuthoringCatalog,
    execution: 'on-demand', capabilities: [structuredClone(echoPlugin)], validate, createRuntime, executeLocal,
    views: createViews(services),
  };
}
