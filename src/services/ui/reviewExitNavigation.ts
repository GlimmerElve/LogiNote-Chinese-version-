export type ReviewExitSaveState = 'idle' | 'saving' | 'failed';
export type ReviewExitNavigationState = { sessionId: string; phase: Exclude<ReviewExitSaveState, 'idle'> } | null;

/** The same session owns both its pending save and its retry after failure. */
export function createReviewExitNavigationLock() {
  let current: ReviewExitNavigationState = null;
  return {
    getSnapshot: () => current,
    update(phase: ReviewExitSaveState, sessionId: string): boolean {
      if (!sessionId || (current && current.sessionId !== sessionId)) return false;
      if (phase === 'idle') {
        if (!current) return false;
        current = null;
      } else {
        current = { sessionId, phase };
      }
      return true;
    },
  };
}

export function reviewExitNavigationNotice(state: ReviewExitNavigationState): string {
  if (!state) return '';
  return state.phase === 'saving'
    ? '复习正在保存，请稍候。保存完成后会返回原页面。'
    : '复习尚未完整保存，请先在当前页面重试保存。回答仍保留在本页。';
}
