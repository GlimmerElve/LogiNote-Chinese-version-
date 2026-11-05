import { UNIFIED_NARRATIVE_GRAPH_PROMPT, UNIFIED_NARRATIVE_GRAPH_VERSION } from '../../workflows/documentCoreUnifiedRelationsPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareScopedNarrativeRequest, projectScopedNarrativeGraph, type ScopedNarrativeRequest, type ScopedNarrativeResult, type ScopedNarrativeRun } from './narrativeGraphScoped';
import { parseIdenticalCoreJson } from './identicalJson';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedUse = 'supports' | 'rebuts' | 'limits' | 'condition' | 'none' | 'uncertain';
export interface DeclaredLink { id: string; premises: string[]; target: string; use: UnifiedUse }
export type UnifiedRequest = Omit<ScopedNarrativeRequest, 'version'> & { version: typeof UNIFIED_NARRATIVE_GRAPH_VERSION };
export interface UnifiedResult extends Omit<ScopedNarrativeResult, 'provenance'> {
  declaredLinks: DeclaredLink[];
  attachmentGroups: Array<DeclaredLink & { use: 'limits' | 'condition' }>;
  nonDrawingDecisions: DeclaredLink[];
  projection: Array<{ linkId: string; destination: 'inference' | 'attachment' | 'non-drawing'; inferenceId?: string }>;
  provenance: Omit<ScopedNarrativeResult['provenance'], 'version'> & {
    version: typeof UNIFIED_NARRATIVE_GRAPH_VERSION; useInferredLocally: false; projectionBasis: 'model-declared-use-only';
  };
}
export type UnifiedRun = Omit<ScopedNarrativeRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_NARRATIVE_GRAPH_VERSION; request: UnifiedRequest; result?: UnifiedResult;
};
const uses: UnifiedUse[] = ['supports', 'rebuts', 'limits', 'condition', 'none', 'uncertain'];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80;
export function prepareUnifiedRequest(input: NarrativeGraphInput): UnifiedRequest {
  return { ...prepareScopedNarrativeRequest(input), version: UNIFIED_NARRATIVE_GRAPH_VERSION, systemPrompt: UNIFIED_NARRATIVE_GRAPH_PROMPT };
}
/** Mechanical projection only. Never choose a use from text, erase an erroneous rebuttal, or bridge missing endpoints. */
export function projectUnifiedRelations(raw: string, input: NarrativeGraphInput): UnifiedResult {
  const decoded = parseIdenticalCoreJson(raw), value = decoded.value;
  if (!object(value) || !Array.isArray(value.links) || value.links.length > 30
    || !Array.isArray(value.coreIds) || value.coreIds.length > 12) throw new Error('统一用途容器或预算非法，原始回复待核查');
  const canonical = { statements: value.statements, inferences: [] as any[],
    conclusions: value.coreIds.map((root: unknown) => ({ id: root, conditions: [], limitations: [] })), unresolved: value.unresolved };
  // Identity/source/scope handling is frozen; use its node identities before admitting any link.
  const identities = projectScopedNarrativeGraph(JSON.stringify(canonical), input);
  const nodeIds = new Set(identities.semanticView.nodes.map(n => n.id));
  const accepted: DeclaredLink[] = [], rejected: Array<{ id: string; value: unknown }> = [];
  for (const [index, row] of value.links.entries()) {
    const label = `L${index + 1}`;
    if (!object(row) || !Array.isArray(row.premises) || !row.premises.length || row.premises.length > 60
      || !row.premises.every(id) || new Set(row.premises).size !== row.premises.length
      || !id(row.target) || !uses.includes(row.use) || !nodeIds.has(row.target)
      || !row.premises.every((p: string) => nodeIds.has(p) && p !== row.target)) {
      rejected.push({ id: label, value: row }); continue;
    }
    accepted.push({ id: label, premises: [...row.premises], target: row.target, use: row.use });
  }
  const argumentsOnly = accepted.filter(l => l.use === 'supports' || l.use === 'rebuts');
  canonical.inferences = argumentsOnly.map(l => ({ premises: l.premises, target: l.target, kind: l.use === 'supports' ? 'support' : 'oppose' }));
  const parsed = projectScopedNarrativeGraph(JSON.stringify(canonical), input);
  const result: UnifiedResult = { ...parsed, declaredLinks: accepted, attachmentGroups: [], nonDrawingDecisions: [], projection: [],
    provenance: { ...parsed.provenance, rawResponse: raw, version: UNIFIED_NARRATIVE_GRAPH_VERSION,
      useInferredLocally: false, projectionBasis: 'model-declared-use-only' } };
  for (const row of rejected) {
    result.pending.push({ layer: 'link', ...row });
    result.issues.push({ id: row.id, code: 'link_pending', reason: '用途或端点非法；整组保留待核查，不裁前提、不猜关系、不影响其他组' });
  }
  for (const item of decoded.coalesced) result.issues.push({ id: item.path, code: 'identical_duplicate_key', reason: '原始同值重复字段已记录，没有按语义合并' });
  for (const key of Object.keys(value)) if (!['statements', 'links', 'coreIds', 'unresolved'].includes(key)) {
    result.pending.push({ layer: 'field', id: key, value: value[key] });
    result.issues.push({ id: key, code: 'field_pending', reason: '未知顶层字段保留，不解释为关系' });
  }
  for (const link of accepted) {
    if (link.use === 'supports' || link.use === 'rebuts') {
      result.projection.push({ linkId: link.id, destination: 'inference', inferenceId: `I${argumentsOnly.indexOf(link) + 1}` });
    } else if (link.use === 'limits' || link.use === 'condition') {
      result.attachmentGroups.push({ ...link, use: link.use });
      result.projection.push({ linkId: link.id, destination: 'attachment' });
      const key = link.use === 'limits' ? 'limitations' : 'conditions';
      // A non-core target remains a non-core target. Preserve joint attachment groups in the sidecar.
      const root = result.semanticView.conclusions.find(r => r.id === link.target);
      if (root) root[key] = [...new Set([...root[key], ...link.premises])];
      for (const node of result.semanticView.nodes) if (link.premises.includes(node.id) && !node.uses.includes(key)) node.uses.push(key);
    } else {
      result.nonDrawingDecisions.push(link);
      result.projection.push({ linkId: link.id, destination: 'non-drawing' });
    }
  }
  return result;
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedRequest,
  model: { call(request: Readonly<UnifiedRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedResult, signal?: AbortSignal
) => Promise<Omit<UnifiedRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedRelations(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedRequest(narrative), model, raw => projectUnifiedRelations(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
