import type { LlmSettings } from '../../src/types';
import { browserFixtureState, notifyBrowserFixture } from './s2-browser-model';

/** No provider configuration, credentials or browser storage; production context budget uses its LOCAL ceiling. */
function settings(): LlmSettings {
  browserFixtureState.settingsReads++; notifyBrowserFixture();
  return { providers: [], workflowBinding: {} };
}
export async function ensureLlmSettingsLoaded(): Promise<void> { /* no storage hydration */ }
export function readLlmSettingsForUse(): LlmSettings { return settings(); }
export function loadLlmSettings(): LlmSettings { return settings(); }
export function getDefaultLlmSettings(): LlmSettings { return settings(); }
