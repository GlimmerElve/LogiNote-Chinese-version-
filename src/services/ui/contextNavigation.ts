/** Reference pages are a branch of the current workspace, not a replacement route. */
export interface ContextNotePage {
  key: string;
  noteId: string;
  projectContextId: string | null;
  heading?: string;
}

export interface ContextNavigationState {
  pages: ContextNotePage[];
  /** -1 is the still-mounted source workspace. */
  cursor: number;
}

export const EMPTY_CONTEXT_NAVIGATION: ContextNavigationState = { pages: [], cursor: -1 };

export function openContextNote(state: ContextNavigationState, page: ContextNotePage): ContextNavigationState {
  const current = state.pages[state.cursor];
  if (current?.noteId === page.noteId && current.projectContextId === page.projectContextId && current.heading === page.heading) return state;
  return { pages: [...state.pages.slice(0, state.cursor + 1), page], cursor: state.cursor + 1 };
}

export function moveContextNavigation(state: ContextNavigationState, cursor: number): ContextNavigationState {
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= state.pages.length || cursor === state.cursor) return state;
  return { ...state, cursor };
}

/** Agent actions follow the visible reference, never the hidden source selection. */
export function getContextFocusedNote<T extends { id: string }>(
  state: ContextNavigationState, notes: readonly T[], sourceNoteId?: string | null,
): T | null {
  const focusedId = state.pages[state.cursor]?.noteId || sourceNoteId;
  return notes.find((note) => note.id === focusedId) || null;
}

export function getContextSourceLabel(view: string, noteTitle?: string): string {
  if (view === 'editor') return noteTitle || '原笔记';
  return ({ scene: '场景模拟', timeline: '学习计划', plan: '计划草图', graph: '知识图谱',
    learn: '学习入口', flow: '心流学习', review: '复习', home: '首页' } as Record<string, string>)[view] || '来源页面';
}
