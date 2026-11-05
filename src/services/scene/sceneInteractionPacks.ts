import type { SceneInteractionPackRef } from '../../types/sceneInteractionPack';
import { SceneInteractionPackRegistry } from './sceneInteractionPackRegistry';

/** Empty until the terminal loads an installed package. No business implementation belongs in startup. */
export const sceneInteractionPacks = new SceneInteractionPackRegistry();
/** Historical scene identity only; resolution still requires an installed exact package. */
export const DEFAULT_PROMPT_PACK: SceneInteractionPackRef = { id: 'prompt-lab', version: '0.1.0' };
