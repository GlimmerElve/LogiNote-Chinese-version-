import type { TextbookChapter, TextbookFinding, TextbookJob, TeachingBlueprint } from './generationTypes';
import { stableTextbookValue } from './fingerprint';
import { textbookRequestBudget } from './modelPolicy';
import { textbookContinuitySummary } from './teachingPlan';

export class TextbookValidationError extends Error {
  constructor(message: string, readonly finding: TextbookFinding, readonly findings: TextbookFinding[] = [finding]) { super(message); this.name = 'TextbookValidationError'; }
}
const sections: Array<keyof TextbookChapter['sections']> = ['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'];

/** Legacy reviewer strings are localized conservatively. Unlocated issues are NOT a blueprint reset. */
export function locateTextbookIssue(message: string, blueprint?: TeachingBlueprint): TextbookFinding {
  if (/^(?:教学蓝图|蓝图|blueprint\b|学习目标\s*[A-Za-z]\w*|objectives\b|focuses\b)/iu.test(message.trim())) return { stage: 'blueprint', message };
  const chapter = blueprint?.chapters.find((item) => message.startsWith(`${item.id}.`) || message.startsWith(`${item.id}：`) || message.startsWith(`${item.id}:`) || message.startsWith(`章节 ${item.id}（`));
  if (chapter) return { stage: 'chapters', chapterId: chapter.id, section: sections.find((section) => message.startsWith(`${chapter.id}.${section}`)), message };
  return { stage: 'validating', message };
}

/** @deprecated Legacy serialized prose only; never authorizes a new repair or
 * publication. Production semantic review uses assessTextbookQuality. */
export function parseTextbookQuality(value: unknown, blueprint: TeachingBlueprint): { passed: boolean; issues: string[]; findings: TextbookFinding[] } {
  const quality = value as { passed?: unknown; issues?: unknown; findings?: unknown };
  if (typeof quality?.passed !== 'boolean' || !Array.isArray(quality.issues) || quality.issues.length > 20
    || quality.issues.some((issue) => typeof issue !== 'string' || !issue.trim() || issue.length > 4000)
    || quality.passed !== (quality.issues.length === 0)) throw new Error('教材质量复核返回无效');
  let findings: TextbookFinding[];
  if (quality.findings === undefined) findings = quality.issues.map((issue) => locateTextbookIssue(issue, blueprint));
  else {
    if (!Array.isArray(quality.findings) || quality.findings.length > 20 || quality.passed !== (quality.findings.length === 0)) throw new Error('教材质量复核的问题定位无效');
    findings = quality.findings.map((raw) => {
      const item = raw as TextbookFinding;
      if (!item || !['blueprint', 'chapters', 'validating'].includes(item.stage) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 4000
        || (item.stage === 'chapters' ? !blueprint.chapters.some((chapter) => chapter.id === item.chapterId) : item.chapterId !== undefined)
        || (item.section !== undefined && (item.stage !== 'chapters' || !sections.includes(item.section)))) throw new Error('教材质量复核的问题定位无效');
      return { stage: item.stage, chapterId: item.chapterId, section: item.section, message: item.message };
    });
    // An issue without a matching finding must remain unlocated, never silently drop a rejection.
    for (const issue of quality.issues) if (!findings.some((finding) => finding.message === issue)) findings.push(locateTextbookIssue(issue, blueprint));
    if (findings.length > 20) throw new Error('教材质量复核的问题定位无效');
  }
  return { passed: quality.passed, issues: quality.issues, findings };
}

export function chapterInputIdentity(job: TextbookJob, chapter: TeachingBlueprint['chapters'][number]): string {
  const blueprint = job.checkpoint.blueprint!;
  const index = blueprint.chapters.findIndex((item) => item.id === chapter.id);
  const previousId = blueprint.chapters[index - 1]?.id;
  return stableTextbookValue({ chapter, ...(job.spec?.promptVersion !== undefined ? { promptVersion: job.spec.promptVersion } : {}), objectives: blueprint.objectives.filter((item) => chapter.objectiveIds.includes(item.id)),
    focuses: blueprint.focuses.filter((item) => chapter.focusIds.includes(item.id)),
    previousSummary: textbookContinuitySummary(job.checkpoint.chapters?.find((item) => item.id === previousId)),
    ...(job.spec?.modelPolicy?.version === 4 ? { thinkingMode: textbookRequestBudget(job.spec.modelPolicy, 'chapter', blueprint, chapter.id).thinkingMode } : {}) });
}

export function recordTextbookFailure(job: TextbookJob, findings: TextbookFinding[], origin: 'deterministic' | 'reviewer' = 'deterministic'): void {
  job.checkpoint.quality = { passed: false, issues: findings.map((finding) => finding.message), findings, origin, status: 'blocked' };
  job.checkpoint.repair = { findings, applied: false, origin };
  job.checkpoint.repairIssues = findings.map((finding) => finding.message);
  for (const finding of findings) {
    const step = job.checkpoint.progress?.steps.find((item) => item.stage === finding.stage);
    if (step) step.status = 'failed';
  }
}
