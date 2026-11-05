import { sceneInteractionPacks } from '../../src/services/scene/sceneInteractionPacks';

/** Explicit protocol-v1 authoring replay. New public-interface checks never use this adapter. */
export function useLegacyS2Authoring() {
  const original = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
  const { authoring: _authoring, ...legacy } = original;
  sceneInteractionPacks.register(legacy, true);
  return () => sceneInteractionPacks.register(original, true);
}

/**
 * Explicit compatibility fixture for tests of the generic base's optional name/settings
 * panel and legacy immediate text editing. It retains the installed prompt capability
 * scope and exact package identity, while explicitly selecting its legacy authoring
 * adapter by omitting authoring as well as its optional canvas UI policy.
 * Real prompt UI tests must not call this helper. Each check runs in its own process;
 * restoring still prevents accidental effects on any subsequently imported checks.
 */
export function useGenericS2CanvasUi() {
  const original = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
  const { canvas: _canvas, authoring: _authoring, ...genericUi } = original;
  sceneInteractionPacks.register(genericUi, true);
  return () => sceneInteractionPacks.register(original, true);
}
