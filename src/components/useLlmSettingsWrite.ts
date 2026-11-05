import { useEffect, useSyncExternalStore } from 'react';
import { getLlmSettingsSaveState, subscribeLlmSettingsSave, hasUnsavedLlmSettings } from '../services/llmStorage';

/** The App owns close protection; a panel subscription never owns the write queue. */
export function useLlmSettingsWrite(protectClose = false) {
  const state = useSyncExternalStore(subscribeLlmSettingsSave, getLlmSettingsSaveState, getLlmSettingsSaveState);
  useEffect(() => {
    if (!protectClose) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedLlmSettings()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [protectClose]);
  return state;
}
