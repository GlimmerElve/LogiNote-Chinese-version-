import type { SceneInteractionPackManifest } from '../../types/sceneInteractionPack';
export const promptLabManifest: SceneInteractionPackManifest = {
  protocolVersion: 1, id: 'prompt-lab', version: '0.1.0', name: '提示词实验',
  paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution', 'model', 'resources'],
};
