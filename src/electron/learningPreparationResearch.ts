import type { NoteItem, ResourceBrowserSearchRequest, ResourceItem } from '../types';
import { planResourceSearch, reviewResourceCandidates, type ResourceSemanticModel } from '../services/resourceSemanticSearch';
import { buildAutomaticResourcePlan, automaticResourceIntentIssue, resourceIdentity } from '../services/resourceCuration';
import { automaticResourceAccessIssue, deriveResourcePreferenceSignals, selectResourcesForAutomaticCollection,
  trustedResourceHosts, type ResourceStateFile } from '../services/resourceState';
import { automaticResourceContentIssue } from '../services/resourceContentAdmission';
import { extractResourceCoreTerm } from './resourceBrowserCore';

export interface PreparationResearchContext {
  root: NoteItem;
  state: ResourceStateFile;
  formatPreference?: string;
}
export interface PreparationResearchDependencies {
  context(rootId: string): Promise<PreparationResearchContext>;
  model: ResourceSemanticModel;
  search(request: ResourceBrowserSearchRequest, browserOnly: boolean, signal: AbortSignal): Promise<ResourceItem[]>;
}

/** Recheck local choices at publication time, without sending private feedback
 * or note bodies to a model. Restricted pages authorize a link only. */
export function preparationResourceIssue(resource: ResourceItem, context: PreparationResearchContext): string | undefined {
  const { root, state } = context;
  const hosts = trustedResourceHosts(state, [root]);
  const blocked = deriveResourcePreferenceSignals(Object.values(state.discoveryPreferences), Object.values(state.feedback)).blockedHosts;
  if (Object.values(state.discoveryPreferences).some(item => item.decision === 'rejected' && resourceIdentity(item) === resourceIdentity(resource))) return '用户已排除该链接';
  let host: string; try { host = new URL(resource.url).hostname.toLowerCase(); } catch { return '资源链接无效'; }
  if (blocked.some(item => item.host === host)) return '用户多次对该站点给出负面反馈';
  return automaticResourceAccessIssue(resource, hosts)
    || automaticResourceContentIssue(resource, { projectTitle: root.title, knowledgeTitles: resource.knowledgeTitles || [root.title] })
    || automaticResourceIntentIssue(resource);
}

/** The root preparation entry shares the Agent's planner, semantic review,
 * preference quotas and final admission. Only public learning goals leave the
 * device. Search execution stays in the isolated browser/API implementation. */
export function createLearningPreparationResearch(deps: PreparationResearchDependencies) {
  return async (rootId: string, title: string, signal: AbortSignal): Promise<ResourceItem[]> => {
    signal.throwIfAborted();
    const context = await deps.context(rootId);
    signal.throwIfAborted();
    const mix = buildAutomaticResourcePlan(context.state, context.formatPreference, [context.root]);
    const taskText = `为“${title}”准备可直接学习的教学资料`;
    const knowledgeTitles = [extractResourceCoreTerm(title) || title];
    let plan: Awaited<ReturnType<typeof planResourceSearch>> | undefined;
    try {
      plan = await planResourceSearch({ projectTitle: title, rootProjectTitle: title, taskText, knowledgeTitles, targets: mix.targets }, deps.model, signal);
      // One query per lane for this compact background entry. Explicit refresh
      // can research again; a shortfall never triggers an unbounded model loop.
      plan = { ...plan, lanes: plan.lanes.map(lane => ({ ...lane, queries: lane.queries.slice(0, 1) })) };
    } catch { signal.throwIfAborted(); }
    const request: ResourceBrowserSearchRequest = { projectTitle: title, rootProjectTitle: title, taskText, knowledgeTitles,
      maxResults: 12, automaticTargets: mix.targets, trustedResourceHosts: [...trustedResourceHosts(context.state, [context.root])],
      semanticPlan: plan, interactionMode: 'auto', source: 'note-editor', apiEmptyFallback: true };
    let candidates: ResourceItem[];
    try { candidates = await deps.search(request, false, signal); }
    catch {
      signal.throwIfAborted();
      // One browser-only retry also covers API auth/format failures locally to
      // this entry; it never repeats the failed API or forwards its credentials.
      candidates = await deps.search(request, true, signal);
    }
    signal.throwIfAborted();
    if (plan && candidates.length) {
      try { candidates = (await reviewResourceCandidates(plan, candidates, deps.model, signal)).resources; }
      catch { signal.throwIfAborted(); /* Fall back to the same deterministic admission, never invent sources. */ }
    }
    return selectResourcesForAutomaticCollection(candidates, { taskText, projectTitle: title, knowledgeTitles,
      existingUrls: (context.root.resources || []).flatMap(item => [item.url, ...(item.sourceUrl ? [item.sourceUrl] : [])]),
      state: context.state, notes: [context.root], targets: mix.targets }).selected;
  };
}
