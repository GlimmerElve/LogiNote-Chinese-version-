import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import type { AuditCandidate, AuditInput, AuditQuote } from './semanticAudit';

export const CORE_AUDIT_RISK_VERSION = 'core-audit-risk-queue-v1';
export interface AuditRiskOptions { limit?: number; round?: number; coreTargets?: AuditQuote[] }
export interface AuditRiskSignal { code: string; weight: number; detail: string }
function demand(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const numberTokens = (text: string) => new Set(text.match(/[+\-−]?\d+(?:[.,]\d+)?(?:[%％‰])?/gu) || []);

/** Scheduling hints only. No LLM output, previous audit verdict, semantic approval,
 * graph mutation or request execution is accepted by this function. */
export function selectCoreAuditRisk(input: AuditInput, options: AuditRiskOptions = {}) {
  const limit = options.limit ?? 4, round = options.round ?? 0;
  demand(Number.isInteger(limit) && limit >= 1 && limit <= 4, '风险审计预算须为1至4条');
  demand(Number.isSafeInteger(round) && round >= 0, '抽查轮次非法');
  demand(input.candidates.length <= 30 && new Set(input.candidates.map(c => c.id)).size === input.candidates.length, '候选超过30或ID重复');
  demand(new Set(input.source.passages.map(p => p.id)).size === input.source.passages.length, '原文段落ID重复');
  const locate = (ref: AuditQuote) => {
    const passage = input.source.passages.find(p => p.id === ref.passageId);
    demand(passage && typeof ref.quote === 'string' && ref.quote.trim() && ref.quote.length <= 5000, '风险候选引文非法');
    const range = locateDocumentArgumentQuote(passage.text, ref.quote);
    return { passageId: passage.id, ...range, text: passage.text.slice(range.start, range.end), key: JSON.stringify([passage.id, range.start, range.end]) };
  };
  const coreKeys = new Set((options.coreTargets || []).map(ref => locate(ref).key));
  const located = input.candidates.map((candidate, order) => {
    demand(typeof candidate.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(candidate.id), '风险候选ID非法');
    demand(['support', 'oppose'].includes(candidate.kind) && candidate.premises.length > 0 && candidate.premises.length <= 8, '候选用途或前提数量非法');
    return { candidate, order, target: locate(candidate.target), premises: candidate.premises.map(locate) };
  });
  const ranked = located.map(({ candidate, order, target, premises }) => {
    const signals: AuditRiskSignal[] = [];
    const add = (code: string, weight: number, detail: string) => signals.push({ code, weight, detail });
    const targetNumbers = numberTokens(target.text), premiseNumbers = numberTokens(premises.map(p => p.text).join('\n'));
    if (targetNumbers.size && !premiseNumbers.size) add('numeric_target_without_numeric_premise', 6, '数量目标的前提未含阿拉伯数字；可能缺测量或计算依据，仍需语义判断');
    else if ([...targetNumbers].some(n => !premiseNumbers.has(n))) add('numeric_form_novelty', 3, '目标含前提中未原样出现的数值写法；合法计算也会触发，不表示错误');
    if (premises.some(p => p.passageId === target.passageId && p.start >= target.start && p.end <= target.end)) add('premise_contained_in_target', 3, '目标原文包含前提片段，需区分合理分句与循环/混合目标');
    if (candidate.kind === 'oppose') add('opposition_direction_check', 2, '反对关系优先核对对象；不表示方向一定错误');
    const downstream = located.filter(other => other.candidate.id !== candidate.id && other.premises.some(p => p.key === target.key)).length;
    if (downstream >= 2) add('shared_downstream_basis', 2, `该目标被${downstream}条后续步骤复用，审计影响范围较大`);
    if (coreKeys.has(target.key)) add('selected_core_target', 1, '目标属于抽取模型所选结论，需关注关键结论而非认定其正确');
    if (premises.length > 1) add('joint_premise_group', 1, '保留整组前提检查，不把联合依据拆成独立充分依据');
    return { id: candidate.id, order, score: signals.reduce((n, s) => n + s.weight, 0), signals };
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  // Reserve one slot for deterministic rotating spot checks. No automatic loop.
  const capacity = Math.min(limit, ranked.length), riskSlots = capacity > 1 ? capacity - 1 : capacity;
  const risk = ranked.slice(0, riskSlots);
  const rest = ranked.filter(r => !risk.some(s => s.id === r.id)).sort((a, b) => a.order - b.order);
  const sampled = capacity > riskSlots && rest.length ? [rest[round % rest.length]] : [];
  const chosen = new Set([...risk, ...sampled].map(r => r.id));
  const selected = input.candidates.filter(c => chosen.has(c.id)).map(c => structuredClone(c));
  const deferred = input.candidates.filter(c => !chosen.has(c.id)).map(c => c.id);
  return { version: CORE_AUDIT_RISK_VERSION, limit, round, selected, deferred,
    schedule: ranked.map(r => ({ ...r, state: chosen.has(r.id) ? 'scheduled' as const : 'not_reviewed' as const,
      selection: risk.some(s => s.id === r.id) ? 'risk' as const : sampled.some(s => s.id === r.id) ? 'spot_check' as const : 'deferred' as const })),
    coverage: { total: input.candidates.length, scheduled: selected.length, notReviewed: deferred.length },
    boundary: { productionWrites: false, semanticCertified: false, requests: 0, deferredTreatedAsKeep: false } as const };
}
