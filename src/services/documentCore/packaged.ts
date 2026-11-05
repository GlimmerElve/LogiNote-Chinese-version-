import { DOCUMENT_CORE_PACKAGED_PROMPT, DOCUMENT_CORE_PACKAGED_VERSION } from '../../workflows/documentCorePackagedPrompt';
import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import { parseIdenticalCoreJson, type IdenticalJsonCoalescence } from './identicalJson';
import { parseCoreDirectQuotes, type CoreDirectQuoteResult } from './directQuote';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply, type CoreArgumentRequest, type CoreArgumentRun } from './types';

export interface CorePackagedRequest extends Omit<CoreArgumentRequest, 'version'> { version: typeof DOCUMENT_CORE_PACKAGED_VERSION }
export interface CorePackagedModel { call(request: Readonly<CorePackagedRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export interface CorePackageProjection {
  ordinal: number; question: string; rootNodeId?: string; rootDeclared: boolean;
  declaredStepIds: string[]; projectedStepIds: string[]; rootReachableStepIds: string[]; detachedStepIds: string[];
  state: 'connected_structure' | 'declared_only' | 'unbound_root' | 'incomplete_projection' | 'detached_steps';
}
export interface CorePackagedResult extends CoreDirectQuoteResult {
  packagedProtocol: { version: typeof DOCUMENT_CORE_PACKAGED_VERSION; rawResponse: string; sourceResponse: unknown;
    jsonNormalizations: IdenticalJsonCoalescence[]; packages: CorePackageProjection[];
    stepOwners: Record<string, { packageOrdinal: number; localStepOrdinal: number }>;
    projectionSource: 'explicit-package-records-flattened-without-new-edges'; groupingIsNotAnEdge: true;
    semanticRewriting: false; originalInputChanged: false };
}
export type CorePackagedRun = Omit<CoreArgumentRun, 'version' | 'request' | 'result'> & {
  version: typeof DOCUMENT_CORE_PACKAGED_VERSION; request: CorePackagedRequest; result?: CorePackagedResult;
};
function demand(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function shape(value: any, keys: string[]) {
  demand(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), '论证包字段结构不匹配');
}

/** Mechanical projection only: packaging/adjacency never creates or changes a relation.
 * The existing quote and derivation parsers own source binding, IDs and graph role projection. */
export function parseCorePackagedQuotes(raw: string, input: CoreArgumentInput): CorePackagedResult {
  prepareCoreInputPacket(input);
  const decoded = parseIdenticalCoreJson(raw), value = decoded.value;
  shape(value, ['chains', 'unresolved']);
  demand(Array.isArray(value.chains) && value.chains.length <= CORE_ARGUMENT_LIMITS.coreClaims, '论证包数量或容器超预算');
  // Bound the TOTAL raw steps before projecting any package, including malformed siblings.
  const total = value.chains.reduce((n: number, c: any) => n + (Array.isArray(c?.steps) ? c.steps.length : 0), 0);
  demand(total <= CORE_ARGUMENT_LIMITS.arguments, '所有论证包的步骤合计超过30，未截断');
  const steps: any[] = [], conclusions: any[] = [];
  const packages: Array<{ ordinal: number; question: string; conclusion: any; stepIds: string[] }> = [];
  const stepOwners: CorePackagedResult['packagedProtocol']['stepOwners'] = {};
  const extraIssues: CoreDirectQuoteResult['issues'] = [], extraQuarantines: CoreDirectQuoteResult['quarantined'] = [];
  for (const [index, chain] of value.chains.entries()) {
    const ordinal = index + 1;
    try {
      shape(chain, Object.hasOwn(chain ?? {}, 'question') ? ['question', 'conclusion', 'steps'] : ['conclusion', 'steps']);
      demand(Array.isArray(chain.steps), '包内steps不是数组');
      // A broken descriptive label must not discard valid source-bound reasoning.
      // Retain the supplied label (or empty when non-text), do not generate a model claim.
      const question = typeof chain.question === 'string' ? chain.question : '';
      if (!question.trim() || question.length > 120) {
        extraIssues.push({ id: `PACKAGE:${ordinal}:question`, code: 'package_question_invalid', reason: '包问题标签缺失、为空、非文字或超预算；保留本包显式推导，不生成替代问题' });
        extraQuarantines.push({ layer: 'package_question', id: `PACKAGE:${ordinal}:question`, value: chain.question ?? null });
      }
      const stepIds = chain.steps.map((s: any, i: number) => {
        const id = `S${steps.length + 1}`; steps.push(s);
        stepOwners[id] = { packageOrdinal: ordinal, localStepOrdinal: i + 1 }; return id;
      });
      conclusions.push(chain.conclusion);
      packages.push({ ordinal, question, conclusion: chain.conclusion, stepIds });
    } catch (error) {
      extraIssues.push({ id: `PACKAGE:${ordinal}`, code: 'package_quarantined', reason: error instanceof Error ? error.message : String(error) });
      extraQuarantines.push({ layer: 'package', id: `PACKAGE:${ordinal}`, value: chain });
    }
  }
  // No semantic deduplication, membership-to-support conversion, inferred bridge or direction fix.
  const projected = parseCoreDirectQuotes(JSON.stringify({ steps, conclusions, unresolved: value.unresolved }), input);
  const nodeByPosition = new Map(projected.quoteProtocol.bindings.map(b => [JSON.stringify([b.passageId, b.start, b.end]), b.nodeId]));
  function rootId(ref: any): string | undefined {
    const p = input.passages.find(p => p.id === ref?.passageId);
    if (!p || typeof ref.quote !== 'string') return;
    try { const r = locateDocumentArgumentQuote(p.text, ref.quote); return nodeByPosition.get(JSON.stringify([p.id, r.start, r.end])); }
    catch { return; }
  }
  const projections: CorePackageProjection[] = packages.map(p => {
    const rootNodeId = rootId(p.conclusion?.target);
    const rootDeclared = !!rootNodeId && projected.derivation.conclusions.some(c => c.nodeId === rootNodeId);
    const explicit = projected.derivation.steps.filter(s => p.stepIds.includes(s.id));
    const visited = new Set<string>(), reachable = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return; visited.add(id);
      for (const s of explicit.filter(s => s.conclusion === id)) {
        reachable.add(s.id); s.premises.forEach(visit);
      }
      // Preserve original opposed expectations reached from evidence serving this root.
      // Do NOT follow outgoing support edges to unrelated conclusions in this or other packages.
      for (const s of explicit.filter(s => s.kind === 'oppose' && s.premises.includes(id))) {
        reachable.add(s.id); visit(s.conclusion); s.premises.forEach(visit);
      }
    };
    if (rootDeclared) visit(rootNodeId!);
    const detachedStepIds = explicit.filter(s => !reachable.has(s.id)).map(s => s.id);
    const projectedStepIds = explicit.map(s => s.id);
    const state: CorePackageProjection['state'] = !rootDeclared ? 'unbound_root'
      : projectedStepIds.length !== p.stepIds.length ? 'incomplete_projection'
        : detachedStepIds.length ? 'detached_steps' : !explicit.length ? 'declared_only' : 'connected_structure';
    if (['unbound_root', 'incomplete_projection', 'detached_steps'].includes(state)) extraIssues.push({ id: `PACKAGE:${p.ordinal}`,
      code: `package_${state}`, reason: '保留包归属和显式步骤；本包投影不完整或存在未回接步骤，未猜边、借用别包步骤或改写引文' });
    return { ordinal: p.ordinal, question: p.question, ...(rootNodeId ? { rootNodeId } : {}), rootDeclared,
      declaredStepIds: p.stepIds, projectedStepIds, rootReachableStepIds: explicit.filter(s => reachable.has(s.id)).map(s => s.id), detachedStepIds, state };
  });
  projected.issues.unshift(...extraIssues); projected.quarantined.unshift(...extraQuarantines);
  if (extraIssues.length) projected.chains.forEach(c => { c.state = 'source_review_required'; });
  return { ...projected, packagedProtocol: { version: DOCUMENT_CORE_PACKAGED_VERSION, rawResponse: raw, sourceResponse: value,
    jsonNormalizations: decoded.coalesced, packages: projections, stepOwners,
    projectionSource: 'explicit-package-records-flattened-without-new-edges', groupingIsNotAnEdge: true,
    semanticRewriting: false, originalInputChanged: false } };
}

// Opaque experiment-version label only: preserve frozen transport/parser files and discriminants.
const runVersionedExperiment = runPreparedCoreExtraction as unknown as (
  source: CoreArgumentInput, request: CorePackagedRequest, model: CorePackagedModel,
  parse: typeof parseCorePackagedQuotes, signal?: AbortSignal,
) => Promise<CorePackagedRun>;
export function prepareCorePackagedRequest(input: CoreArgumentInput): CorePackagedRequest {
  return { version: DOCUMENT_CORE_PACKAGED_VERSION, systemPrompt: DOCUMENT_CORE_PACKAGED_PROMPT,
    userInput: prepareCoreInputPacket(input), parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
export async function runCorePackagedExtraction(source: CoreArgumentInput, model: CorePackagedModel,
  signal?: AbortSignal): Promise<CorePackagedRun> {
  const input = structuredClone(source);
  return runVersionedExperiment(input, prepareCorePackagedRequest(input), model, parseCorePackagedQuotes, signal);
}
