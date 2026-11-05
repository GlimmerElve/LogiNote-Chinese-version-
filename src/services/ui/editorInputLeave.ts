import { cognitionLeaveRegistry } from './cognitionLeave';
import { registerPendingFlush } from '../agent/dataFreshness';

/** Registers status only, never the draft text. A local input is committed only
 * by its existing Save/Enter/blur contract; navigation/quit cannot discard it. */
export function registerEditorInputLeave(entry: {
  pending: () => string | null; element: () => HTMLElement | null; notify: (message: string) => void;
}) {
  const notify = () => { const message = entry.pending(); if (message) entry.notify(message); };
  const release = cognitionLeaveRegistry.register({ blocked: () => Boolean(entry.pending()), element: entry.element, notify });
  const releaseFlush = registerPendingFlush(async () => {
    const message = entry.pending(); if (!message) return;
    entry.notify(message); throw new Error(message);
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!entry.pending()) return;
    event.preventDefault(); event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => { release(); releaseFlush(); window.removeEventListener('beforeunload', beforeUnload); };
}
