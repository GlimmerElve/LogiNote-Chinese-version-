import type { SceneManifestEntry, SceneSkillManifest, SceneSpec } from '../../src/types';
import { browserFixtureState, notifyBrowserFixture } from './s2-browser-model';

/** Ephemeral fixture library only; saving is still initiated by the real production UI handler. */
const scenes = new Map<string, SceneSpec>();
function entry(spec: SceneSpec): SceneManifestEntry {
  return { sceneId: spec.sceneId, name: spec.meta.name, subject: spec.meta.subject, sceneSkill: 'S2',
    knowledgePoints: [...spec.meta.knowledgePoints], goal: spec.meta.goal,
    architecture: { paradigmLabel: 'S2 合成浏览器画布', technologies: [], engines: ['S2Canvas'], hasEvents: false,
      eventInjection: false, injectProfile: false, interactionTypes: [] }, createdAt: spec.createdAt, reuseCount: 0 };
}
export async function loadManifest(_options?: { strict?: boolean }): Promise<SceneSkillManifest> {
  browserFixtureState.storeReads++; notifyBrowserFixture();
  return { version: '1.0', updatedAt: new Date().toISOString(), scenes: [...scenes.values()].map(entry) };
}
export async function loadScene(sceneId: string): Promise<SceneSpec | null> {
  browserFixtureState.storeReads++; notifyBrowserFixture();
  const value = scenes.get(sceneId); return value ? structuredClone(value) : null;
}
export async function saveScene(spec: SceneSpec): Promise<SceneSpec> {
  if (spec.meta.sceneSkill !== 'S2' || !spec.sceneId || spec.canvasWorkspace?.version !== 1) throw new Error('Synthetic browser library accepts only complete S2 templates');
  const saved = structuredClone({ ...spec, updatedAt: new Date().toISOString() }); scenes.set(saved.sceneId, saved);
  browserFixtureState.storeWrites++; browserFixtureState.savedTemplates = [...scenes.values()].map(value => structuredClone(value));
  notifyBrowserFixture(); return structuredClone(saved);
}
