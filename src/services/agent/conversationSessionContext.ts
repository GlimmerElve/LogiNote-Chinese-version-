import type { AgentRuntimeContext, AgentWorkspaceSnapshot } from './types';
import { resolveNoteByTitleOrAlias } from '../noteResolver';

/** The visual plan/resource editors are still singletons. A lease prevents a
 * second conversation from reading, confirming, or discarding another's draft. */
export function createConversationContexts(legacyId: string, live: () => AgentRuntimeContext, assertScope: () => Promise<void> = async () => {},
  initialOwners: { plan?: string; resource?: string } = {}, fallbackOwner: () => string = () => legacyId) {
  let planOwner = initialOwners.plan || (live().getPlanDraftSession() || live().hasPendingPlanEditorDraft?.() ? legacyId : undefined);
  let resourceOwner = initialOwners.resource || (live().getResourceDraftSession() ? legacyId : undefined), planInFlight = 0;
  const contexts = new Map<string, AgentRuntimeContext>();
  const workspaces = new Map<string, AgentWorkspaceSnapshot>();
  const ownership = () => {
    if (!planInFlight && !live().getPlanDraftSession() && !live().hasPendingPlanEditorDraft?.()) planOwner = undefined;
    if (!live().getResourceDraftSession()) resourceOwner = undefined;
    if ((live().getPlanDraftSession() || live().hasPendingPlanEditorDraft?.()) && !planOwner) planOwner = fallbackOwner();
    if (live().getResourceDraftSession() && !resourceOwner) resourceOwner = fallbackOwner();
  };
  const assertOwner = (id: string, kind: 'plan' | 'resource', starting = false) => {
    ownership(); const owner = kind === 'plan' ? planOwner : resourceOwner;
    if (owner && owner !== id) throw new Error('这个共享编辑器的草稿属于另一个对话标签，请回到原标签处理；不会接管、提交或清除它');
    if (!starting && owner !== id) throw new Error('当前标签没有这类草稿，请先在本标签创建');
  };
  return {
    owners() { ownership(); return { plan: planOwner, resource: resourceOwner }; },
    owns(id: string, kind: 'plan' | 'resource') { ownership(); return (kind === 'plan' ? planOwner : resourceOwner) === id; },
    workspace(id: string) { return structuredClone(workspaces.get(id)!); },
    bind(id: string, workspace: AgentWorkspaceSnapshot) { workspaces.set(id, structuredClone(workspace)); },
    get(id: string, workspace: AgentWorkspaceSnapshot): AgentRuntimeContext {
      if (contexts.has(id)) return contexts.get(id)!;
      workspaces.set(id, structuredClone(workspace));
      const overrides: Partial<AgentRuntimeContext> = {
        ensureDataFresh: async () => { await assertScope(); await live().ensureDataFresh(); await assertScope(); },
        getConversationId: () => id,
        navigate: view => { live().navigate(view); const old = workspaces.get(id)!; workspaces.set(id, { ...old, view, revision: old.revision + 1 }); },
        openNoteByTitle: title => {
          const note = resolveNoteByTitleOrAlias(title, live().getNotes());
          if (!note) return false;
          const opened = live().openNoteByTitle(title);
          if (opened) { const old = workspaces.get(id)!; workspaces.set(id, { ...old, revision: old.revision + 1, view: 'editor',
            focusedNoteId: note.id, focusedNoteTitle: note.title, focusedNoteType: note.noteType }); }
          return opened;
        },
        enterLearningMode: input => {
          const bound = live().getNotes().find(note => note.id === (input.taskBinding?.noteId || workspaces.get(id)?.focusedNoteId));
          let request = { ...input };
          if (input.mode === 'quick_check' && !input.noteTitle && !input.quickCheckRequest?.noteId) {
            if (!bound || bound.noteType !== 'knowledge') return false;
            request.quickCheckRequest = { ...input.quickCheckRequest, noteId: bound.id };
          } else if (!input.noteTitle && input.mode !== 'bubble' && !input.sceneRequest) {
            if (!bound || resolveNoteByTitleOrAlias(bound.title, live().getNotes())?.id !== bound.id) return false;
            request.noteTitle = bound.title;
          }
          const entered = live().enterLearningMode(request);
          if (entered && input.mode !== 'quick_check') {
            const old = workspaces.get(id)!;
            workspaces.set(id, { ...old, revision: old.revision + 1, view: input.mode });
          }
          return entered;
        },
        getActiveNote: () => live().getNotes().find(note => note.id === workspaces.get(id)?.focusedNoteId) || null,
        getWorkspaceSnapshot: () => {
          const saved = workspaces.get(id)!, note = live().getNotes().find(note => note.id === saved.focusedNoteId);
          return { ...structuredClone(saved), ...(note ? { focusedNoteTitle: note.title, focusedNoteType: note.noteType } : {
            focusedNoteId: undefined, focusedNoteTitle: undefined, focusedNoteType: undefined,
          }) };
        },
        getPlanDraftSession: () => { ownership(); return planOwner === id ? live().getPlanDraftSession() : null; },
        getResourceDraftSession: () => { ownership(); return resourceOwner === id ? live().getResourceDraftSession() : null; },
        hasPendingPlanEditorDraft: () => { ownership(); return planOwner === id && !!live().hasPendingPlanEditorDraft?.(); },
        startPlanDraftSession: input => {
          assertOwner(id, 'plan', true);
          const focus = overrides.getActiveNote!();
          if (!input.scopeProjectTitle && input.scopeKind !== 'portfolio' && !focus) throw new Error('本标签未绑定项目，请先使用当前页面或明确项目名称');
          if (focus && !input.scopeProjectTitle && input.scopeKind !== 'portfolio'
            && resolveNoteByTitleOrAlias(focus.title, live().getNotes())?.id !== focus.id) throw new Error('项目同名，无法安全采用隐式范围，请明确项目');
          const result = live().startPlanDraftSession({ ...input, scopeProjectTitle: input.scopeProjectTitle || focus?.title });
          planOwner = id; return result;
        },
        startResourceDraftSession: input => {
          assertOwner(id, 'resource', true);
          const focus = overrides.getActiveNote!();
          if (!input.scopeProjectTitle && !focus) throw new Error('本标签未绑定项目，请先使用当前页面或明确项目名称');
          if (focus && !input.scopeProjectTitle && resolveNoteByTitleOrAlias(focus.title, live().getNotes())?.id !== focus.id) throw new Error('项目同名，无法安全采用隐式范围，请明确项目');
          const result = live().startResourceDraftSession({ ...input, scopeProjectTitle: input.scopeProjectTitle || focus?.title });
          resourceOwner = id; return result;
        },
        discardPlanDraftSession: () => { assertOwner(id, 'plan'); const result = live().discardPlanDraftSession(); planOwner = undefined; return result; },
        discardResourceDraftSession: () => { assertOwner(id, 'resource'); const result = live().discardResourceDraftSession(); resourceOwner = undefined; return result; },
        commitPlanDraftSession: async () => { assertOwner(id, 'plan'); planInFlight++;
          try { return await live().commitPlanDraftSession(); } finally { planInFlight--; } },
        commitResourceDraftSession: async () => { assertOwner(id, 'resource'); const result = await live().commitResourceDraftSession(); resourceOwner = undefined; return result; },
      };
      for (const name of ['createProjectPlan', 'applyPlanTaskChange'] as const) (overrides as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        assertOwner(id, 'plan', true); planOwner = id; planInFlight++;
        try { return await (live()[name] as (...values: unknown[]) => unknown)(...args); } finally { planInFlight--; }
      };
      const planMethods = ['stagePlanDraftBatch', 'stagePlanStructurePatches', 'stagePlanMetaPatch', 'stagePlanMilestonePatches',
        'stagePlanExecutionPatches', 'stagePortfolioPlanPatches'] as const;
      for (const name of planMethods) (overrides as Record<string, unknown>)[name] = (...args: unknown[]) => {
        assertOwner(id, 'plan'); return (live()[name] as (...values: unknown[]) => unknown)(...args);
      };
      overrides.stageResourceDraftBatch = input => { assertOwner(id, 'resource'); return live().stageResourceDraftBatch(input); };
      overrides.searchOnlineLearningResources = (input, execution) => { assertOwner(id, 'resource'); return live().searchOnlineLearningResources(input, execution); };
      // Proxy reads the latest App ports, not a stale render's closures. Each
      // request retains its own overrides and cannot rebind another tab's focus.
      const ctx = new Proxy(overrides as AgentRuntimeContext, { get: (target, key) => key in target ? Reflect.get(target, key) : Reflect.get(live(), key) });
      contexts.set(id, ctx); return ctx;
    },
  };
}
