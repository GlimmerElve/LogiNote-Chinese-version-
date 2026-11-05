import { LITERAL_ARITHMETIC_CONTRACT, type ShadowArithmeticCheck, type ShadowAssessment, type ShadowCalculationReview,
  type ShadowCriterionId, type ShadowGraph, type ShadowInput, type ShadowWarning } from './types';
import { SHADOW_CRITERIA } from './rubric';

type Fraction = [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a < 0n ? -a : a;
const reduce = ([n, d]: Fraction): Fraction => { const g = gcd(n, d); return [n / g, d / g]; };
function decimal(value: string): Fraction {
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return [BigInt(whole + fraction) * (negative ? -1n : 1n), 10n ** BigInt(fraction.length)];
}
function finiteDecimal(value: Fraction): string | null {
  let [n, d] = reduce(value);
  if (d < 0n) { n = -n; d = -d; }
  let denominator = d, places = 0;
  while (denominator % 2n === 0n) denominator /= 2n;
  while (denominator % 5n === 0n) denominator /= 5n;
  if (denominator !== 1n) return null; // No rounding policy: repeating decimals are outside this literal checker.
  while (10n ** BigInt(places) % d !== 0n) if (++places > 12) return null;
  const scaled = n * (10n ** BigInt(places) / d), sign = scaled < 0n ? '-' : '';
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(places + 1, '0');
  return sign + (places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/u, '') : digits);
}

/** Narrow literal checker, not a general natural-language/math/fact classifier. Never uses eval or external data. */
export function checkLiteralArithmetic(rawText: string): ShadowArithmeticCheck[] {
  const number = '\\d{1,9}(?:\\.\\d{1,6})?', space = '[ \\t]*';
  const ordinary = new RegExp(`(?<![\\d.A-Za-z+\\-])(${number})${space}(\\+|＋|加上?|-|－|减去?|\\*|×|乘以?|÷|/|除以)${space}(${number})${space}(?:=|＝|等于|得到|得|结果是|结果为)${space}(-?${number})(?![\\d.%％A-Za-z\\p{Script=Han}])`, 'gu');
  const percentage = new RegExp(`(?<![\\d.A-Za-z+\\-])(${number})[%％]${space}(?:减去?|-|－)${space}(${number})[%％]${space}[，,]?${space}(?:差了?|相差|等于|=|＝)${space}(-?${number})个百分点`, 'gu');
  const found: Omit<ShadowArithmeticCheck, 'id'>[] = [];
  const add = (match: RegExpExecArray, left: string, operator: ShadowArithmeticCheck['operator'], right: string, claimed: string, unit: ShadowArithmeticCheck['unit']) => {
    const before = rawText.slice(Math.max(0, match.index - 32), match.index), after = rawText.slice(match.index + match[0].length);
    // Do not mistake a tail term of a compound expression or a thousands-separated number for a full equation.
    if (/[+＋*×÷/\-－^]\s*$/u.test(before) || /(?:加上?|减去?|乘以?|除以)\s*$/u.test(before)
      || /\d[,，]$/u.test(before) || /^\s*[+＋*×÷/\-－^]/u.test(after) || /^[,，]\d/u.test(after)) return;
    const [a, ad] = decimal(left), [b, bd] = decimal(right);
    let result: Fraction;
    if (operator === '+') result = [a * bd + b * ad, ad * bd];
    else if (operator === '-') result = [a * bd - b * ad, ad * bd];
    else if (operator === '*') result = [a * b, ad * bd];
    else { if (b === 0n) return; result = [a * bd, ad * b]; }
    const expected = finiteDecimal(result);
    if (expected === null) return;
    const [c, cd] = decimal(claimed);
    found.push({ start: match.index, end: match.index + match[0].length, quote: match[0], left, right, operator, claimed,
      expected, status: result[0] * cd === c * result[1] ? 'match' : 'mismatch', unit });
  };
  for (const match of rawText.matchAll(ordinary)) {
    const operator = /^[+＋加]/u.test(match[2]) ? '+' : /^[-－减]/u.test(match[2]) ? '-' : /^[*×乘]/u.test(match[2]) ? '*' : '/';
    add(match as RegExpExecArray, match[1], operator, match[3], match[4], 'number');
  }
  for (const match of rawText.matchAll(percentage)) add(match as RegExpExecArray, match[1], '-', match[2], match[3], 'percentage_point');
  return found.sort((a, b) => a.start - b.start).map((check, i) => ({ id: `M${i + 1}`, ...check }));
}

/** Optional model context declarations are quarantined individually; they never replace the local numeric result. */
export function parseCalculationReviews(raw: unknown): { reviews: ShadowCalculationReview[]; warnings: ShadowWarning[] } {
  const warnings: ShadowWarning[] = [], reviews: ShadowCalculationReview[] = [];
  if (raw === undefined) return { reviews, warnings };
  if (!Array.isArray(raw) || raw.length > 200) return { reviews, warnings: [{ code: 'calculation_reviews_invalid', target: 'calculationReviews', message: '计算用途声明无效；仅暂缓相关评价，不阻断图。' }] };
  const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 30
    && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) && new Set(value).size === value.length;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.checkId !== 'string' || !item.checkId || item.checkId.length > 200
      || !['current', 'retracted', 'quoted', 'hypothetical', 'uncertain'].includes(item.usage)
      || !validIds(item.evidenceIds) || !validIds(item.criterionIds) || !item.criterionIds.every((id: string) => SHADOW_CRITERIA.some(c => c.id === id))
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000) {
      warnings.push({ code: 'calculation_review_invalid', target: 'calculationReviews', message: '一条计算用途声明缺字段或无效，未采纳；不猜测其用途。' }); continue;
    }
    reviews.push({ checkId: item.checkId, usage: item.usage, evidenceIds: [...item.evidenceIds], criterionIds: [...item.criterionIds] as ShadowCriterionId[], reason: item.reason });
  }
  return { reviews, warnings };
}

/** Recompute facts even on readback. A cached score/check is not authority. No inferred user stance or grade. */
export function arithmeticVerificationDecision(input: ShadowInput, graph: ShadowGraph, assessment: ShadowAssessment) {
  const pendingCriteria = new Set<ShadowCriterionId>(), pendingNodes = new Set<string>(), currentMismatchNodes = new Set<string>(), excludedMismatchNodes = new Set<string>();
  const warnings: ShadowWarning[] = [];
  if (assessment.localVerification?.contract !== LITERAL_ARITHMETIC_CONTRACT) return { checks: [], pendingCriteria, pendingNodes, currentMismatchNodes, excludedMismatchNodes, warnings };
  const checks = checkLiteralArithmetic(input.rawText);
  const parsed = parseCalculationReviews(assessment.localVerification.calculationReviews);
  warnings.push(...parsed.warnings);
  const counts = new Map<string, number>();
  assessment.evidence.forEach(e => counts.set(e.id, (counts.get(e.id) || 0) + 1));
  const evidence = new Map(assessment.evidence.filter(e => counts.get(e.id) === 1 && input.rawText.includes(e.quote) && e.quote.trim() && e.nodeIds.length
    && new Set(e.nodeIds).size === e.nodeIds.length && e.nodeIds.every(id => graph.nodes.some(n => n.id === id))).map(e => [e.id, e]));
  for (const review of parsed.reviews) if (!checks.some(check => check.id === review.checkId)) warnings.push({ code: 'calculation_review_unknown', target: review.checkId, message: '计算用途声明指向未知检查ID，未用于解除待核验。' });
  for (const check of checks.filter(c => c.status === 'mismatch')) {
    const nodes = graph.nodes.filter(n => n.rawQuote && input.rawText.includes(n.rawQuote) && n.rawQuote.includes(check.quote)
      || n.text.includes(check.quote)).map(n => n.id);
    const candidates = parsed.reviews.filter(r => r.checkId === check.id);
    const review = candidates.length === 1 ? candidates[0] : undefined;
    const bound = review && review.evidenceIds.length && review.evidenceIds.every(id => evidence.has(id))
      && review.evidenceIds.some(id => evidence.get(id)!.quote.includes(check.quote));
    let pending = !bound || review!.usage === 'uncertain';
    if (bound && review!.usage === 'current') {
      nodes.forEach(id => currentMismatchNodes.add(id));
      const criterion = assessment.criteria.find(c => c.id === 'reasoning_consistency');
      const reported = assessment.issues.some(issue => issue.kind === 'confirmed_internal' && issue.evidenceIds.some(id => review!.evidenceIds.includes(id))
        && issue.targetIds.some(id => nodes.includes(id)));
      // Current wrong arithmetic cannot coexist with "no hard error" (levels 3/4) in its consistency criterion.
      pending = review!.evidenceIds.some(id => evidence.get(id)!.attribution !== 'user')
        || !review!.criterionIds.includes('reasoning_consistency') || !reported || !criterion
        || criterion.state !== 'observed' || criterion.level === null || criterion.level >= 3;
    } else if (bound && ['retracted', 'quoted', 'hypothetical'].includes(review!.usage)) {
      nodes.forEach(id => excludedMismatchNodes.add(id)); // Model-declared context, not a local language classifier.
    }
    if (pending) {
      pendingCriteria.add('reasoning_consistency');
      review?.criterionIds.forEach(id => pendingCriteria.add(id));
      nodes.forEach(id => pendingNodes.add(id));
      warnings.push({ code: 'arithmetic_review_pending', target: check.id,
        message: `算式“${check.quote}”的复算结果为${check.expected}${check.unit === 'percentage_point' ? '个百分点' : ''}；模型用途/影响尚未一致核清，相关分数暂缓，不自动扣分。` });
    }
  }
  return { checks, pendingCriteria, pendingNodes, currentMismatchNodes, excludedMismatchNodes, warnings };
}
