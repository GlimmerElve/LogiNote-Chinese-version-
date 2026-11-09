import type { LlmProvider, LlmSettings, LlmThinkingPreference } from '../../types';
import { requireLlmModel } from '../llmModelSelection';
import { resolveLlmOutputBudget } from '../llmOutputBudget';
import { describeThinkingPreference } from '../llmThinkingPolicy';
import { resolveInteractiveFigureBudget, type InteractiveFigureBudget } from './interactiveFigureBudget';
import type { TextbookModelPolicy, TextbookModelStage } from './modelPolicy';

export const TEXTBOOK_THINKING_WORKFLOWS = ['textbook-blueprint', 'textbook-chapter', 'textbook-quality'] as const;
type Workflow = typeof TEXTBOOK_THINKING_WORKFLOWS[number];
type ManualPreference = Exclude<LlmThinkingPreference, 'default'>;
const stages: TextbookModelStage[] = ['selection', 'blueprint', 'chapter', 'quality'];
const workflowForStage: Record<TextbookModelStage, Workflow> = {
  selection: 'textbook-blueprint', blueprint: 'textbook-blueprint', chapter: 'textbook-chapter', quality: 'textbook-quality',
};
const labels = { selection: '选材', blueprint: '蓝图', chapter: '每章', quality: '质检' };
const preferences: ManualPreference[] = ['off', 'low', 'medium', 'high'];
const preferenceLabels: Record<ManualPreference, string> = { off: '关闭', low: '低', medium: '中', high: '高' };

/** Optional new-task approval data. Missing on old jobs: preserve their exact
 * policy/hash/budgets rather than reading today's workflow UI on resume. */
export interface TextbookThinkingSnapshot {
  version: 1;
  preferences: Partial<Record<Workflow, ManualPreference>>;
  stages: Record<TextbookModelStage, { maxTokens: number; retryMaxTokens: number }>;
  notes?: string[];
  /** Absent on older manual sidecars: their automatic figure cap remains 4096. */
  figureBudget?: InteractiveFigureBudget;
}

export function captureTextbookThinkingSnapshot(settings: LlmSettings, policy: TextbookModelPolicy,
  providerFor: (workflow: Workflow) => LlmProvider | null): TextbookThinkingSnapshot | undefined {
  const manual = Object.fromEntries(TEXTBOOK_THINKING_WORKFLOWS.flatMap(workflow => {
    const value = settings.workflowThinking?.[workflow];
    if (value === undefined || value === 'default') return [];
    if (!preferences.includes(value)) throw new Error('教材思考档位无效，请重新选择');
    return [[workflow, value]];
  })) as TextbookThinkingSnapshot['preferences'];
  if (!Object.keys(manual).length) return;
  const notes = new Set<string>();
  const budgets = Object.fromEntries(stages.map(stage => {
    const original = policy.stages[stage], workflow = workflowForStage[stage], preference = manual[workflow];
    if (!preference) return [stage, { maxTokens: original.maxTokens, retryMaxTokens: original.retryMaxTokens }];
    const provider = providerFor(workflow);
    if (!provider) throw new Error('请先为教材配置可用模型');
    const model = requireLlmModel(provider), note = describeThinkingPreference(provider, model, preference);
    if (note) notes.add(`${labels[stage]}：${note}`);
    return [stage, {
      maxTokens: resolveLlmOutputBudget(provider, model, original.maxTokens, 'response', preference),
      retryMaxTokens: resolveLlmOutputBudget(provider, model, original.retryMaxTokens, 'response', preference),
    }];
  })) as TextbookThinkingSnapshot['stages'];
  const chapterProvider = manual['textbook-chapter'] ? providerFor('textbook-chapter') : undefined;
  if (manual['textbook-chapter'] && !chapterProvider) throw new Error('请先为教材配置可用模型');
  const figureBudget = chapterProvider ? resolveInteractiveFigureBudget(chapterProvider, manual['textbook-chapter']) : undefined;
  const snapshot: TextbookThinkingSnapshot = { version: 1, preferences: manual, stages: budgets, ...(notes.size ? { notes: [...notes] } : {}),
    ...(figureBudget ? { figureBudget } : {}) };
  validateTextbookThinkingSnapshot(snapshot, policy);
  return snapshot;
}

export function validateTextbookThinkingSnapshot(value: unknown, policy?: TextbookModelPolicy): asserts value is TextbookThinkingSnapshot | undefined {
  if (value === undefined) return;
  const snapshot = value as TextbookThinkingSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !policy || snapshot.version !== 1
    || Object.keys(snapshot).some(key => !['version', 'preferences', 'stages', 'notes', 'figureBudget'].includes(key))
    || !snapshot.preferences || typeof snapshot.preferences !== 'object' || Array.isArray(snapshot.preferences)
    || !Object.keys(snapshot.preferences).length
    || Object.entries(snapshot.preferences).some(([key, value]) => !TEXTBOOK_THINKING_WORKFLOWS.includes(key as Workflow) || !preferences.includes(value as ManualPreference))
    || !snapshot.stages || typeof snapshot.stages !== 'object' || Array.isArray(snapshot.stages)
    || Object.keys(snapshot.stages).length !== stages.length
    || stages.some(stage => {
      const budget = snapshot.stages[stage];
      return !budget || typeof budget !== 'object' || Object.keys(budget).length !== 2
        || !Number.isSafeInteger(budget.maxTokens) || !Number.isSafeInteger(budget.retryMaxTokens)
        || budget.maxTokens < policy.stages[stage].maxTokens || budget.retryMaxTokens < policy.stages[stage].retryMaxTokens
        || budget.retryMaxTokens < budget.maxTokens || budget.retryMaxTokens > 32768;
    })
    || snapshot.notes !== undefined && (!Array.isArray(snapshot.notes) || snapshot.notes.length > 4
      || snapshot.notes.some(note => typeof note !== 'string' || note.length > 200))
    || snapshot.figureBudget !== undefined && (!snapshot.preferences['textbook-chapter'] || !snapshot.figureBudget
      || typeof snapshot.figureBudget !== 'object' || Array.isArray(snapshot.figureBudget) || Object.keys(snapshot.figureBudget).length !== 2
      || !Number.isSafeInteger(snapshot.figureBudget.configuration) || !Number.isSafeInteger(snapshot.figureBudget.html)
      || snapshot.figureBudget.configuration < 4096 || snapshot.figureBudget.html < snapshot.figureBudget.configuration
      || snapshot.figureBudget.html > 32768)) {
    throw new Error('教材已批准思考与输出预算快照无效，请重新准备并确认');
  }
}

export function textbookThinkingSnapshotSummary(snapshot: TextbookThinkingSnapshot | undefined): string {
  if (!snapshot) return '';
  return `本任务手动思考快照覆盖系统规则：${stages.map(stage => `${labels[stage]}${snapshot.preferences[workflowForStage[stage]]
    ? preferenceLabels[snapshot.preferences[workflowForStage[stage]]!] : '保持系统默认'} ${snapshot.stages[stage].maxTokens}/${snapshot.stages[stage].retryMaxTokens}`).join('、')} tokens（初始/截断重试，均已包含思考）。${snapshot.notes?.join('；') || ''}累计总额与请求次数仍按原批准上限；之后修改工作流档位不改写本任务。`;
}
