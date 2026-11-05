export const NOTE_AUTOSAVE_IDLE_MS = 8_000;

export interface NavigationSave {
  capture: () => void;
  dirty: () => boolean;
  revision: () => number;
  flush: () => Promise<void>;
}

/** A successful save can still cancel leaving when a newer edit/position
 * arrives in flight. Activity exit owners must await that decision too. */
export function confirmNoteNavigation(
  request: (commit: () => void, cancel: () => void) => void,
  commit: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request(() => {
      try { commit(); resolve(); } catch (error) { reject(error); }
    }, () => reject(new Error('最新内容尚未完成保存，已保留在本页，请重试退出')));
  });
}
/** Keep the current editor mounted until its latest draft is acknowledged.
 * Requests made in one interaction (select note + select view) commit together.
 * New edits during the write cancel navigation instead of discarding input. */
export function createNoteNavigationSave() {
  let running: Promise<void> | undefined, committing = false;
  let actions: Array<{ commit: () => void; cancel?: () => void }> = [];
  const cancel = (requested = actions) => { actions = []; for (const action of requested) action.cancel?.(); };
  return {
    request(action: () => void, io: NavigationSave, onCancel?: () => void): void {
      if (committing) { action(); return; }
      io.capture();
      if (!running && !io.dirty()) {
        committing = true; try { action(); } finally { committing = false; } return;
      }
      actions.push({ commit: action, cancel: onCancel });
      if (running) return;
      const revision = io.revision();
      running = Promise.resolve().then(io.flush).then(() => {
        const requested = actions; actions = [];
        if (io.dirty() || io.revision() !== revision) { cancel(requested); return; }
        committing = true;
        try { for (const action of requested) action.commit(); }
        finally { committing = false; }
      }).catch(() => { cancel(); }) // The save owner retains/error-labels the draft.
        .finally(() => { running = undefined; });
    },
  };
}
