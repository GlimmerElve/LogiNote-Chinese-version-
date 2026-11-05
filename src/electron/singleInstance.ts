interface SingleInstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  exit(code: number): void;
}

/** Acquire after selecting userData, before any ready-time services or windows.
 * Repeated launches only signal the owner; their arguments are never executed. */
export function acquireSingleInstance({ app, getWindow, canActivate = () => true }: {
  app: SingleInstanceApp;
  getWindow: () => SingleInstanceWindow | null | undefined;
  canActivate?: () => boolean;
}): { primary: boolean; windowReady: () => void } {
  if (!app.requestSingleInstanceLock()) {
    // The newcomer has not initialized anything that needs flushing. In
    // particular, do not enter the primary application's before-quit workflow.
    app.exit(0);
    return { primary: false, windowReady() {} };
  }

  let pendingActivation = false;
  const activatePending = () => {
    if (!pendingActivation) return;
    if (!canActivate()) { pendingActivation = false; return; }
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      if (window.isMinimized()) window.restore();
      if (window.isDestroyed()) return;
      window.show();
      if (window.isDestroyed()) return;
      window.focus();
      pendingActivation = false;
    } catch (error) {
      // Native close/restore can race. A shortcut must not crash the owner or
      // create replacement services/windows; the next explicit signal can retry.
      console.warn('[single-instance] Unable to activate the existing window:', error);
    }
  };
  app.on('second-instance', () => {
    pendingActivation = true;
    activatePending();
  });
  return { primary: true, windowReady: activatePending };
}
