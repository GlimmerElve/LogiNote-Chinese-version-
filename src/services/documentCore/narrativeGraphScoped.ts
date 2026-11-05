import { SCOPED_NARRATIVE_GRAPH_PROMPT, SCOPED_NARRATIVE_GRAPH_VERSION } from '../../workflows/documentCoreNarrativeGraphScopedPrompt';
import { prepareNarrativeGraphRequest, narrativeGraphSource, projectNarrativeGraph, type NarrativeGraphInput, type NarrativeGraphResult, type NarrativeGraphRun } from './narrativeGraph';
import { parseIdenticalCoreJson } from './identicalJson';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export interface DeclaredStatementScope { level: 'content' | 'attribution'; speaker: string; condition?: string }
export type ScopedNarrativeRequest = Omit<ReturnType<typeof prepareNarrativeGraphRequest>, 'version'> & { version: typeof SCOPED_NARRATIVE_GRAPH_VERSION };
export interface ScopedNarrativeResult extends Omit<NarrativeGraphResult, 'semanticView' | 'provenance'> {
  semanticView: Omit<NarrativeGraphResult['semanticView'], 'nodes'> & {
    nodes: Array<NarrativeGraphResult['semanticView']['nodes'][number] & { declaredScope?: DeclaredStatementScope }>;
  };
  provenance: Omit<NarrativeGraphResult['provenance'], 'version'> & { version: typeof SCOPED_NARRATIVE_GRAPH_VERSION; scopeInferredLocally: false };
}
export type ScopedNarrativeRun = Omit<NarrativeGraphRun, 'version' | 'request' | 'result'> & {
  version: typeof SCOPED_NARRATIVE_GRAPH_VERSION; request: ScopedNarrativeRequest; result?: ScopedNarrativeResult;
};
export function prepareScopedNarrativeRequest(input: NarrativeGraphInput): ScopedNarrativeRequest {
  return { ...prepareNarrativeGraphRequest(input), version: SCOPED_NARRATIVE_GRAPH_VERSION, systemPrompt: SCOPED_NARRATIVE_GRAPH_PROMPT };
}
export function projectScopedNarrativeGraph(raw: string, input: NarrativeGraphInput): ScopedNarrativeResult {
  const value = parseIdenticalCoreJson(raw).value;
  const parsed = projectNarrativeGraph(raw, input);
  const result: ScopedNarrativeResult = { ...parsed, provenance: { ...parsed.provenance,
    version: SCOPED_NARRATIVE_GRAPH_VERSION, scopeInferredLocally: false } };
  for (const node of result.semanticView.nodes) {
    const row = value.statements.find((s: any) => s?.id === node.id);
    if (row.scope === undefined) continue;
    const scope = row.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || !['content', 'attribution'].includes(scope.level) || typeof scope.speaker !== 'string' || !scope.speaker.trim() || scope.speaker.length > 200
      || scope.condition !== undefined && (typeof scope.condition !== 'string' || scope.condition.length > 1000)
      || Object.keys(scope).some(k => !['level', 'speaker', 'condition'].includes(k))) {
      result.pending.push({ layer: 'scope', id: node.id, value: scope });
      result.issues.push({ id: node.id, code: 'scope_pending', reason: '声明归属字段非法；原始项保留，不改命题或关系、不本地猜测归属' });
      continue;
    }
    Object.assign(node, { declaredScope: structuredClone(scope) });
  }
  return result;
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: ScopedNarrativeRequest,
  model: { call(request: Readonly<ScopedNarrativeRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => ScopedNarrativeResult, signal?: AbortSignal
) => Promise<Omit<ScopedNarrativeRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
/** Only graph-from-narrative is automatic here; source corrections and reference decisions are never model input. */
export async function runScopedNarrativeGraph(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<ScopedNarrativeRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareScopedNarrativeRequest(narrative), model, raw => projectScopedNarrativeGraph(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
