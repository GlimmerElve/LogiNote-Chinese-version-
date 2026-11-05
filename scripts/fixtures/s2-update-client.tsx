import React from 'react';
import { createRoot } from 'react-dom/client';
import { SceneBuilderPanel } from '../../src/components/scene/SceneBuilderPanel';
import { loadSceneInteractionPack } from '../../src/services/scene/sceneInteractionPackLoader';
import { scenePackLocalAdapter } from '../../src/services/scene/sceneInteractionHostServices';
import { S2_JSON_CHECK_PLUGIN } from '../../src/services/scene/sceneS2PluginRegistry';
import type { S2PluginOutcome } from '../../src/types/sceneS2Plugin';
import '../../src/index.css';
const first = { id: 'arithmetic-lab', version: '1.0.0' }, second = { ...first, version: '2.0.0' };
const call: any = { pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' };
const inputs: any = { a: [2], b: [3] };
let oldAdapter: ReturnType<typeof scenePackLocalAdapter>, pending: Promise<unknown>;
const baseAdapter = scenePackLocalAdapter(null);
const value = (outcome: any) => outcome.outputs.text[0].payload.value;
(window as any).__s2Update = {
  sharedManifest: structuredClone(S2_JSON_CHECK_PLUGIN),
  async sharedResult() {
    const result = await baseAdapter({ pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' } as any,
      { text: ['{}'] }, new AbortController().signal) as S2PluginOutcome;
    return (result.outputs.assessment[0].payload as any).value.status;
  },
  async beginOld() {
    await loadSceneInteractionPack(first); oldAdapter = scenePackLocalAdapter(first);
    pending = oldAdapter(call, inputs, new AbortController().signal).then(value);
  },
  async loadNew() { await loadSceneInteractionPack(second); },
  async oldResult() { return pending; },
  async newResult() { return value(await scenePackLocalAdapter(second)(call, inputs, new AbortController().signal)); },
};
createRoot(document.getElementById('app')!).render(<SceneBuilderPanel allNotes={[]} onEnterScene={() => {}} />);
