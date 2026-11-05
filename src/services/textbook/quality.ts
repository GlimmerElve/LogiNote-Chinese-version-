import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookFinding, TextbookJob, TextbookQuality,
  TextbookReviewBasis, TextbookReviewDiagnostic, TextbookReviewFinding, TextbookReviewReport, TextbookReviewTarget, TextbookSource } from './generationTypes';
import { hasChapterRestatement } from './restatement';

const sections = ['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'];
const categories = ['factual_support', 'internal_consistency', 'task_alignment', 'personalization', 'pedagogy'];
// Distinguish an ID/whitelist accusation from the legitimate semantic statement
// "N1 exists, but its text does not support this causal claim".
const metadataAccusation = /(?:来源|引用|证据|目标)(?:编号|\s*ID)[^。\n]{0,32}(?:不存在|未提供|不在|未包含|不属于|缺失)|(?:不在|未包含|不存在)[^。\n]{0,24}(?:来源|引用)?白名单|\b[LN]\d+\b[^。\n]{0,12}(?:不在|不属于)[^。\n]{0,24}(?:来源|原文|编号|白名单)|\b[LN]\d+\b\s*(?:这一来源|该来源)?\s*(?:不存在|未提供)[，。；;.!\s]*$|(?:source|citation|reference|evidence)\s+(?:id|identifier)[^.!?\n]{0,32}(?:not\s+(?:provided|supplied|included|allowed)|does\s+not\s+exist)|\b[LN]\d+\b\s+(?:is\s+)?(?:not\s+(?:in|included\s+in|among)\s+[^.!?\n]{0,24}(?:source|whitelist|allowed)|(?:was|is)\s+not\s+(?:provided|supplied)|does\s+not\s+exist)/iu;
export type TextbookReviewInput = { context: TextbookContext; blueprint: TeachingBlueprint; chapters: Array<{ id: string; sections: Partial<TextbookChapter['sections']> }>; sources: TextbookSource[] };
type ReviewInput = TextbookReviewInput;
export class TextbookReviewError extends Error {
  constructor(message: string, public diagnostics: TextbookReviewDiagnostic[] = []) { super(message); this.name = 'TextbookReviewError'; }
}
function reviewField<T>(index: number, field: string, quote: unknown, read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof TextbookReviewError && !error.diagnostics.length) error.diagnostics = [{ findingIndex: index + 1, field,
      message: error.message, disposition: 'needs_recheck', ...(typeof quote === 'string' ? { quote: quote.slice(0, 240) } : {}) }];
    throw error;
  }
}
function requireReview(ok: unknown, message: string): asserts ok { if (!ok) throw new TextbookReviewError(message); }
function text(value: unknown, min = 8, max = 1200): asserts value is string {
  requireReview(typeof value === 'string' && value.trim().length >= min && value.length <= max, '复核证据或理由缺失、过短或过长');
}
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
function contains(original: string, quote: unknown): asserts quote is string {
  // A real short objective/task/title must not be forced into a fabricated
  // eight-character quote. Longer content still needs a meaningful fragment.
  text(quote, Math.max(1, Math.min(8, normalize(original).length)));
  requireReview(normalize(original).includes(normalize(quote)), '复核引文不在本次提供的原文中');
}
function target(raw: unknown, input: ReviewInput): TextbookReviewTarget {
  requireReview(raw && typeof raw === 'object', '复核没有定位到真实教材内容');
  const item = raw as TextbookReviewTarget;
  let original: string | undefined;
  if (item.kind === 'chapter' && sections.includes(item.section)) original = input.chapters.find((chapter) => chapter.id === item.chapterId)?.sections[item.section];
  else if (item.kind === 'objective') original = input.blueprint.objectives.find((objective) => objective.id === item.id)?.text;
  else if (item.kind === 'focus' && ['description', 'strategy'].includes(item.field)) original = input.blueprint.focuses.find((focus) => focus.id === item.id)?.[item.field];
  else if (item.kind === 'bridge') original = input.blueprint.chapters.find((chapter) => chapter.id === item.chapterId)?.bridge;
  requireReview(typeof original === 'string', '复核指向不存在的教材位置');
  contains(original, item.quote);
  // A bare [N1] is metadata, not an erroneous factual claim.
  const withoutIds = (value: string) => normalize(value.replace(/\[[LN]\d+\]/gu, ''));
  requireReview(withoutIds(item.quote).length >= Math.max(1, Math.min(8, withoutIds(original).length)), '复核只有来源编号，没有具体教材论断');
  if (item.kind === 'chapter') return { kind: item.kind, chapterId: item.chapterId, section: item.section, quote: item.quote };
  if (item.kind === 'objective') return { kind: item.kind, id: item.id, quote: item.quote };
  if (item.kind === 'focus') return { kind: item.kind, id: item.id, field: item.field, quote: item.quote };
  return { kind: 'bridge', chapterId: item.chapterId, quote: item.quote };
}
function allowedSources(item: TextbookReviewTarget, blueprint: TeachingBlueprint): Set<string> {
  const chapters = blueprint.chapters.filter((chapter) => item.kind === 'chapter' || item.kind === 'bridge'
    ? chapter.id === item.chapterId : item.kind === 'objective' ? chapter.objectiveIds.includes(item.id) : chapter.focusIds.includes(item.id));
  return new Set(chapters.flatMap((chapter) => chapter.sourceIds));
}
function basis(raw: unknown, location: TextbookReviewTarget, input: ReviewInput): TextbookReviewBasis {
  requireReview(raw && typeof raw === 'object', '复核依据格式无效');
  const item = raw as TextbookReviewBasis;
  if (item.kind === 'source') {
    const source = input.sources.find((source) => source.sourceId === item.sourceId);
    requireReview(source && allowedSources(location, input.blueprint).has(item.sourceId), '复核使用了该位置范围外的来源');
    contains(source.text, item.quote);
    return { kind: item.kind, sourceId: item.sourceId, quote: item.quote };
  }
  if (item.kind === 'textbook') return { kind: item.kind, target: target(item.target, input) };
  if (item.kind === 'task') {
    requireReview(Number.isSafeInteger(item.index) && item.index >= 0 && typeof input.context.project.tasks[item.index] === 'string', '复核使用了不存在的任务');
    contains(input.context.project.tasks[item.index], item.quote);
    return { kind: item.kind, index: item.index, quote: item.quote };
  }
  if (item.kind === 'personal') {
    const personal = input.context.personal.find((personal) => personal.evidenceId === item.evidenceId);
    requireReview(personal, '复核使用了不存在的个人证据'); contains(personal.text, item.quote);
    return { kind: item.kind, evidenceId: item.evidenceId, quote: item.quote };
  }
  requireReview(item.kind === 'previous_learning' && input.context.previousLearning, '复核使用了不存在的上一学习主题');
  contains(input.context.previousLearning.title, item.quote);
  return { kind: item.kind, quote: item.quote };
}
function sameTarget(a: TextbookReviewTarget, b: TextbookReviewTarget): boolean {
  return a.kind === b.kind && (a.kind === 'chapter' && b.kind === 'chapter' ? a.chapterId === b.chapterId && a.section === b.section
    : a.kind === 'bridge' && b.kind === 'bridge' ? a.chapterId === b.chapterId
    : a.kind === 'focus' && b.kind === 'focus' ? a.id === b.id && a.field === b.field
    : a.kind === 'objective' && b.kind === 'objective' && a.id === b.id) && normalize(a.quote) === normalize(b.quote);
}
function repairFinding(item: TextbookReviewFinding): TextbookFinding {
  return item.target.kind === 'chapter' ? { stage: 'chapters', chapterId: item.target.chapterId, section: item.target.section, message: item.message }
    : { stage: 'blueprint', message: item.message };
}
/** Grounding verifies locations/quoted evidence, not semantic truth. Unreliable reports
 * fail closed in the review stage; they must never invalidate a validated chapter. */
export function assessTextbookQuality(value: unknown, input: ReviewInput): TextbookQuality {
  const report = value as TextbookReviewReport;
  requireReview([2, 3].includes(report?.schemaVersion) && typeof report.passed === 'boolean' && Array.isArray(report.findings) && report.findings.length <= 20,
    '质量复核未返回带证据定位的新版报告');
  const diagnostics: TextbookReviewDiagnostic[] = [];
  const findings = report.findings.flatMap((raw, index): TextbookReviewFinding[] => {
    reviewField(index, 'finding', undefined, () => requireReview(raw && ['blocker', 'warning'].includes(raw.severity) && categories.includes(raw.category), '复核问题等级或类型无效'));
    const relaxed = report.schemaVersion === 3;
    if (relaxed) reviewField(index, 'finding', undefined, () => requireReview(['critical', 'minor'].includes(raw.impact!) && ['clear', 'uncertain'].includes(raw.certainty!), '复核缺少影响程度或确定性'));
    const recallTarget = raw.target?.kind === 'chapter' && raw.target.section === 'selfCheck' ? raw.target : undefined;
    const restatementAdvice = raw.category === 'task_alignment' && recallTarget
      && hasChapterRestatement(input.blueprint.chapters.find(chapter => chapter.id === recallTarget.chapterId)?.writingPlan);
    const severity = relaxed && (restatementAdvice || raw.category === 'pedagogy' || raw.impact === 'minor' || raw.certainty === 'uncertain') ? 'warning' : raw.severity;
    try {
      const referenceError = (raw as TextbookReviewFinding & { referenceError?: unknown }).referenceError;
      if (referenceError instanceof TextbookReviewError) throw referenceError;
      text(raw.message, 4, 1200); text(raw.reason, severity === 'warning' && relaxed ? 4 : 12, 2000);
      requireReview(Array.isArray(raw.basis) && raw.basis.length <= 6, '复核依据缺失或过多');
      // Metadata already passed validateBlueprint/validateChapter. The semantic
      // reviewer cannot overrule it with a hallucinated whitelist accusation.
      requireReview(!metadataAccusation.test(raw.message) && !metadataAccusation.test(raw.reason),
        '复核试图推翻已通过的编号检查，需重新复核');
      const location = reviewField(index, 'target.quote', raw.target?.quote, () => target(raw.target, input));
      const evidence = raw.basis.map((item, i) => reviewField(index, `basis[${i}].quote`,
        item?.kind === 'textbook' ? item.target?.quote : item?.quote, () => basis(item, location, input)));
      requireReview(!evidence.some((item) => item.kind === 'personal') || raw.category === 'personalization', '个人观点不能作为教材事实的复核依据');
      if (severity === 'blocker') {
        requireReview(raw.category !== 'pedagogy', '措辞与呈现改进建议不能作为阻断错误');
        if (raw.category === 'factual_support') requireReview(evidence.some((item) => item.kind === 'source'), '事实否决缺少对应来源原文');
        if (raw.category === 'internal_consistency') requireReview(evidence.some((item) => item.kind === 'textbook' && !sameTarget(item.target, location)), '逻辑矛盾缺少另一处真实教材论断');
        if (raw.category === 'task_alignment') requireReview(evidence.some((item) => item.kind === 'task' || item.kind === 'textbook' && item.target.kind === 'objective'), '任务覆盖否决缺少实际任务或学习目标');
        if (raw.category === 'personalization') requireReview(evidence.some((item) => item.kind === 'personal' || item.kind === 'previous_learning' || item.kind === 'source'), '个性化否决缺少实际记录或原文依据');
      }
      return [{ severity, ...(relaxed ? { impact: raw.impact, certainty: raw.certainty } : {}), category: raw.category, target: location, message: raw.message, reason: raw.reason, basis: evidence }];
    } catch (error) {
      if (!(error instanceof TextbookReviewError)) throw error;
      if (!error.diagnostics.length) error.diagnostics = [{ findingIndex: index + 1, field: 'finding', message: error.message, disposition: 'needs_recheck' }];
      const rawTarget = raw.target;
      if (rawTarget?.kind === 'chapter' && input.chapters.some(chapter => chapter.id === rawTarget.chapterId) && sections.includes(rawTarget.section)) {
        const { chapterId, section } = rawTarget;
        error.diagnostics = error.diagnostics.map(item => ({ ...item, chapterId, section }));
      }
      // Only clearly non-blocking v3 advice may be omitted. A critical, clear
      // blocker with bad evidence still stops the REPORT, never the chapters.
      if (!relaxed || severity !== 'warning') throw error;
      diagnostics.push(...error.diagnostics.map(item => ({ ...item, disposition: 'ignored_advice' as const })));
      return [];
    }
  });
  const blockers = findings.filter((item) => item.severity === 'blocker');
  const passed = blockers.length === 0;
  requireReview(report.passed === passed || report.schemaVersion === 3 && !report.passed && passed && report.findings.length > 0,
    '复核通过状态与阻断问题不一致');
  // Legacy issues must not smuggle an unlocated rejection outside findings.
  const extra = value as { issues?: unknown };
  requireReview(extra.issues === undefined || Array.isArray(extra.issues) && extra.issues.length === blockers.length
    && extra.issues.every((issue) => typeof issue === 'string' && blockers.some((item) => item.message === issue)), '复核包含未定位的额外否决');
  const unique = [...new Map(findings.map((item) => [JSON.stringify(item), item])).values()];
  const uniqueBlockers = unique.filter((item) => item.severity === 'blocker');
  const verifiedReport: TextbookReviewReport = { schemaVersion: report.schemaVersion, passed, findings: unique };
  return { schemaVersion: report.schemaVersion, origin: 'reviewer', status: passed ? 'passed' : 'blocked', passed,
    issues: uniqueBlockers.map((item) => item.message), findings: uniqueBlockers.map(repairFinding),
    warnings: unique.filter((item) => item.severity === 'warning'), report: verifiedReport,
    ...(diagnostics.length ? { reviewDiagnostics: diagnostics.slice(0, 20) } : {}) };
}
export function recordUnreliableTextbookReview(job: TextbookJob, error: string | TextbookReviewError): void {
  const message = typeof error === 'string' ? error : error.message;
  // A transport/truncation failure while correcting a report must retain the
  // same correction input on restart (and therefore its spent request budget).
  const diagnostics = typeof error === 'string'
    ? job.checkpoint.quality?.status === 'needs_recheck' ? job.checkpoint.quality.reviewDiagnostics || [] : []
    : error.diagnostics.length ? error.diagnostics : [{ findingIndex: 0, field: 'report', message, disposition: 'needs_recheck' as const }];
  job.checkpoint.quality = { schemaVersion: 2, origin: 'reviewer', status: 'needs_recheck', passed: false,
    issues: ['质量复核报告无效，需要重新复核；已有蓝图和章节保留'], findings: [], reviewErrors: [message],
    ...(diagnostics.length ? { reviewDiagnostics: diagnostics.slice(0, 20) } : {}) };
  delete job.checkpoint.repair; delete job.checkpoint.repairIssues;
}
