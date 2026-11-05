import type { SceneInteractionPack } from '../../types/sceneInteractionPack';
import { promptLabManifest } from './manifest';
import { describePromptLab } from './description';
import { validatePromptLab, createPromptLabRuntime } from './runtime';
import { S2_TEXT_TEMPLATE_PLUGIN, executeS2TextTemplate } from './textTemplate';
import { S2_MODEL_TEST_PLUGIN } from './modelCapability';
import { promptLabAuthoring } from './authoring';

export const promptLabPack: SceneInteractionPack = {
  manifest: promptLabManifest,
  execution: 'on-demand',
  describe: describePromptLab,
  validate: validatePromptLab,
  createRuntime: createPromptLabRuntime,
  capabilities: [S2_TEXT_TEMPLATE_PLUGIN, S2_MODEL_TEST_PLUGIN],
  authoring: promptLabAuthoring,
  async executeLocal(call, inputs, signal) {
    if (signal.aborted) throw new DOMException('操作已取消', 'AbortError');
    return await executeS2TextTemplate(call, inputs) as Awaited<ReturnType<SceneInteractionPack['executeLocal']>>;
  },
};
export default promptLabPack;
