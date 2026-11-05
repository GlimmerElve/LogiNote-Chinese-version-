import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import { prepareCoreInputPacket } from './runner';
import { prepareCoreEvidenceAudit, runCoreEvidenceAudit, type CoreEvidenceAuditRequest } from './evidenceAudit';
import { parseCompactCoreAudit } from './compactAudit';
import { parseCoreDerivations, type CoreDerivationResult } from './derivation';
import { coreAuditBlockingQuarantines } from './shadowAuditReplay';
import type { AuditInput, AuditDecision } from './semanticAudit';
import type { CoreArgumentInput, CoreArgumentReply } from './types';
import type { CoreRangeFragment } from './rangeQuotes';

export const CORE_BOUNDED_AUDIT_LIMITS = Object.freeze({ candidatesPerBatch: 12, batches: 4,
  sourceCharactersPerBatch: 8000, packetCharactersPerBatch: 12000, totalRequestCharacters: 30000,
  totalOutputTokens: 12288 });
export interface CoreAuditSourceQuote { aliasId: string; nodeId: string; quote: string; fragments: CoreRangeFragment[] }
export interface CoreBoundedAuditBatch { input: AuditInput; request: CoreEvidenceAuditRequest; sourceQuotes: CoreAuditSourceQuote[] }
export interface CoreBoundedAuditPlan {
  version: 'core-complete-bounded-audit-v1'; sourceSnapshot: string; baselineSnapshot: string;
  limits: typeof CORE_BOUNDED_AUDIT_LIMITS; batches: CoreBoundedAuditBatch[];
  totalCandidates: number; totalRequestCharacters: number; totalOutputTokens: number;
  sourceQuotesAreLocalViews: true; fullSourceSent: false; productionWrites: false;
}

/** New opt-in transport. The original 16k source is used locally for anchoring;
 * only complete candidate quotes go on the wire. No legacy 8k guard is changed. */
export function prepareBoundedCoreAudit(source: CoreArgumentInput, baseline: CoreDerivationResult): CoreBoundedAuditPlan {
  prepareCoreInputPacket(source);
  if (coreAuditBlockingQuarantines(baseline).length) throw new Error('核心隔离尚未解决，不能分包声称完整审计');
  const steps = baseline.derivation.steps;
  if (!steps.length || steps.length > 30 || new Set(steps.map(s => s.id)).size !== steps.length) throw new Error('完整审计步骤数量或身份非法');
  const materials = new Map(baseline.derivation.materials.map(m => [m.id, m]));
  const passages = new Map(source.passages.map(p => [p.id, p]));
  const quotes = new Map<string, CoreAuditSourceQuote>();
  for (const step of steps) for (const nodeId of [step.conclusion, ...step.premises]) {
    if (quotes.has(nodeId)) continue;
    const material = materials.get(nodeId);
    if (!material || !material.source.length || material.source.length > 4) throw new Error('审计引用材料或来源无效');
    const fragments = material.source.map(ref => {
      const passage = passages.get(ref.passageId); if (!passage) throw new Error('审计来源段落不存在');
      const { start, end } = locateDocumentArgumentQuote(passage.text, ref.quote);
      return { passageId: passage.id, start, end, quote: passage.text.slice(start, end) };
    });
    if (fragments.length > 1) {
      const protocol = (baseline as CoreDerivationResult & { rangeProtocol?: { bindings: Array<{ fragments: CoreRangeFragment[] }> } }).rangeProtocol;
      if (!protocol?.bindings.some(b => JSON.stringify(b.fragments) === JSON.stringify(fragments))) {
        throw new Error('多范围材料没有精确连续定位记录，不能拼成一段审计原话');
      }
    }
    if (fragments.some((f, i) => i > 0 && source.passages.findIndex(p => p.id === f.passageId)
      <= source.passages.findIndex(p => p.id === fragments[i - 1].passageId))) throw new Error('多范围来源未按原文顺序排列');
    quotes.set(nodeId, { aliasId: `@audit-source:${nodeId}`, nodeId, quote: fragments.map(f => f.quote).join(''), fragments });
  }
  const batch = (items: typeof steps): CoreBoundedAuditBatch => {
    const nodeIds = [...new Set(items.flatMap(s => [s.conclusion, ...s.premises]))];
    const sourceQuotes = nodeIds.map(id => quotes.get(id)!);
    const characters = sourceQuotes.reduce((n, q) => n + q.quote.length, 0);
    if (characters > CORE_BOUNDED_AUDIT_LIMITS.sourceCharactersPerBatch) throw new Error('完整步骤引文超过单包来源预算');
    const view: CoreArgumentInput = { docId: source.docId, sourceVersion: source.sourceVersion,
      scope: { kind: 'excerpt', label: '仅候选原话的本地定位视图；原始范围见分包sourceQuotes，不代表资料被改写' },
      passages: sourceQuotes.map(q => ({ id: q.aliasId, section: '', text: q.quote })) };
    const ref = (id: string) => ({ passageId: quotes.get(id)!.aliasId, quote: quotes.get(id)!.quote });
    const input: AuditInput = { source: view, candidates: items.map(s => ({ id: s.id, kind: s.kind,
      target: ref(s.conclusion), premises: s.premises.map(ref), reason: s.reason })) };
    return { input, request: prepareCoreEvidenceAudit(input), sourceQuotes: structuredClone(sourceQuotes) };
  };
  const batches: CoreBoundedAuditBatch[] = []; let current: typeof steps = [];
  for (const step of steps) {
    const proposed = [...current, step];
    try { batch(proposed); current = proposed; }
    catch (error) {
      if (!current.length) throw error; // Never split a joint premise group.
      batches.push(batch(current)); current = [step]; batch(current);
    }
  }
  if (current.length) batches.push(batch(current));
  const totalRequestCharacters = batches.reduce((n, b) => n + b.request.systemPrompt.length + b.request.userInput.length, 0);
  const totalOutputTokens = batches.reduce((n, b) => n + b.request.parameters.maxTokens, 0);
  if (batches.length > CORE_BOUNDED_AUDIT_LIMITS.batches || totalRequestCharacters > CORE_BOUNDED_AUDIT_LIMITS.totalRequestCharacters
    || totalOutputTokens > CORE_BOUNDED_AUDIT_LIMITS.totalOutputTokens) throw new Error('完整审计超出总预算，未发请求、未返回部分分包');
  const ids = batches.flatMap(b => b.input.candidates.map(c => c.id));
  if (ids.length !== steps.length || new Set(ids).size !== steps.length || steps.some(s => !ids.includes(s.id))) throw new Error('分包未完整覆盖候选');
  return { version: 'core-complete-bounded-audit-v1', sourceSnapshot: JSON.stringify(source), baselineSnapshot: JSON.stringify(baseline),
    limits: CORE_BOUNDED_AUDIT_LIMITS, batches, totalCandidates: steps.length, totalRequestCharacters, totalOutputTokens,
    sourceQuotesAreLocalViews: true, fullSourceSent: false, productionWrites: false };
}

export interface CoreBoundedAuditRun {
  status: 'complete' | 'held'; plan: CoreBoundedAuditPlan;
  runs: Array<Awaited<ReturnType<typeof runCoreEvidenceAudit>>>;
  requests: number; error?: string; productionWrites: false; semanticCertified: false;
}
/** All batches must fit before the first call. Failure stops the run with no
 * retries and no partial shadow; approval is a caller-provided upper bound. */
export async function runBoundedCoreAudit(plan: CoreBoundedAuditPlan,
  model: { call(request: Readonly<CoreEvidenceAuditRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  approvedMaximumRequests: number, signal?: AbortSignal): Promise<CoreBoundedAuditRun> {
  const input = structuredClone(plan);
  const checked = prepareBoundedCoreAudit(JSON.parse(input.sourceSnapshot), JSON.parse(input.baselineSnapshot));
  if (JSON.stringify(checked) !== JSON.stringify(input)) throw new Error('审计计划已变动，必须重新准备并确认预算');
  if (!Number.isInteger(approvedMaximumRequests) || approvedMaximumRequests < input.batches.length
    || approvedMaximumRequests > input.limits.batches) throw new Error('请求授权预算不足或非法，未发送');
  const result: CoreBoundedAuditRun = { status: 'held', plan: input, runs: [], requests: 0, productionWrites: false, semanticCertified: false };
  for (const b of input.batches) {
    if (signal?.aborted) { result.error = '完整审计已取消'; return result; }
    const run = await runCoreEvidenceAudit(b.input, model, signal);
    result.runs.push(run); result.requests += run.receipt.requests;
    if (run.status !== 'proposed') { result.error = run.error; return result; }
  }
  result.status = 'complete'; return result;
}

/** Revalidate every saved decision and full coverage. Revocations only; no
 * automatic kind change, retarget, new edge, or deletion of source material. */
export function replayBoundedCoreAudit(source: CoreArgumentInput, baseline: CoreDerivationResult, run: CoreBoundedAuditRun) {
  const plan = prepareBoundedCoreAudit(source, baseline);
  if (run.status !== 'complete' || JSON.stringify(plan) !== JSON.stringify(run.plan)
    || run.runs.length !== plan.batches.length) throw new Error('完整审计未完成或基线发生变化，不能生成部分修订');
  const decisions = new Map<string, AuditDecision>(), provenance = [];
  for (const [i, b] of plan.batches.entries()) {
    const saved = run.runs[i];
    if (saved.status !== 'proposed' || JSON.stringify(saved.request) !== JSON.stringify(b.request)) throw new Error('审计回执不匹配');
    const validated = parseCompactCoreAudit(JSON.stringify({ decisions: saved.decisions }), b.input);
    for (const d of validated) {
      if (decisions.has(d.id)) throw new Error('候选重复审计'); decisions.set(d.id, d);
      const target = d.target ? b.sourceQuotes.find(q => q.aliasId === d.target!.passageId) : undefined;
      provenance.push({ ...d, batch: i + 1, ...(target ? { proposedTargetSources: structuredClone(target.fragments) } : {}) });
    }
  }
  if (decisions.size !== baseline.derivation.steps.length) throw new Error('候选覆盖不完整');
  const revoked = baseline.derivation.steps.filter(s => decisions.get(s.id)!.action === 'revoke');
  const pendingRetargets = baseline.derivation.steps.filter(s => decisions.get(s.id)!.action === 'retarget');
  const result = parseCoreDerivations(JSON.stringify({ materials: baseline.derivation.materials,
    steps: baseline.derivation.steps.filter(s => !revoked.some(r => r.id === s.id)),
    conclusions: baseline.derivation.conclusions, unresolved: baseline.graph.unresolved.map(({ nodeId, reason }) => ({ ...(nodeId ? { nodeId } : {}), reason })) }), source);
  if (result.quarantined.length) throw new Error('影子投影产生隔离，不能宣称链路通过');
  result.quarantined.unshift(...structuredClone(baseline.quarantined));
  result.issues.unshift(...structuredClone(baseline.issues.filter(i => baseline.quarantined.some(q => q.id === i.id))));
  for (const step of revoked) result.issues.push({ id: step.id, code: 'shadow_step_revoked', reason: decisions.get(step.id)!.reason });
  for (const step of pendingRetargets) result.issues.push({ id: step.id, code: 'shadow_retarget_pending', reason: '目标修订仅留痕，未自动应用' });
  for (const chain of result.chains) chain.state = 'source_review_required';
  return { result, revoked: structuredClone(revoked), pendingRetargets: structuredClone(pendingRetargets), reviewUses: provenance,
    coverage: { reviewedSteps: decisions.size, baselineSteps: baseline.derivation.steps.length, batches: plan.batches.length },
    boundary: { productionWrites: false, semanticCertified: false, automaticallyAddedEdges: 0, retargetsAutomaticallyApplied: false },
    sourceProvenance: 'rangeProtocol' in baseline ? structuredClone(baseline.rangeProtocol) : undefined };
}
