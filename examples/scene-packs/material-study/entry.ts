import type { SceneInteractionPack, SceneInteractionPackManifest, ScenePackActivationServices, ScenePackDescription } from '../../../src/types/sceneInteractionPack';
import metadata from './scene-pack.json';
import { studyPlugin, executeLocal } from './plugins/study';
import { validate, createRuntime } from './runtime';
import { createViews, studyHelp } from './views';

/** Assembly only: no material reads, URL creation or scene execution at activation. */
export function activate(services: ScenePackActivationServices): SceneInteractionPack {
  return { manifest: structuredClone(metadata.manifest) as SceneInteractionPackManifest,
    describe: () => structuredClone(metadata.description) as ScenePackDescription,
    capabilities: [structuredClone(studyPlugin)], validate, createRuntime, executeLocal,
    views: createViews(services), help: structuredClone(studyHelp) };
}
