/** Renderer-local leave protection. Stores status and callbacks, never private text. */
export interface CognitionLeaveEntry {
  blocked: () => boolean;
  element: () => HTMLElement | null;
  notify: () => void;
}

export function createCognitionLeaveRegistry() {
  const entries = new Map<symbol, CognitionLeaveEntry>();
  const blocked = (scope?: HTMLElement | null) => [...entries.values()]
    .filter(entry => (!scope || scope.contains(entry.element())) && entry.blocked());
  return {
    register(entry: CognitionLeaveEntry) {
      const token = Symbol('cognition-edit');
      entries.set(token, entry);
      return () => { entries.delete(token); };
    },
    blocked,
    allow(scope?: HTMLElement | null) {
      const pending = blocked(scope);
      // The first editing surface owns the feedback/focus, not the last subscriber.
      pending[0]?.notify();
      return pending.length === 0;
    },
  };
}

export const cognitionLeaveRegistry = createCognitionLeaveRegistry();
export const allowCognitionLeave = (scope?: HTMLElement | null) => cognitionLeaveRegistry.allow(scope);
