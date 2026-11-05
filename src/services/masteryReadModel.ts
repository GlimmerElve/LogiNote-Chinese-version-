import type { NoteItem } from '../types';
import { hasSubstantiveReferenceText } from './ragSourcePolicy';
import { projectMasteryShadow, aggregateMasteryShadowViews } from './masteryShadow/projection';
import type { MasteryShadowState, MasteryShadowView } from './masteryShadow/types';
import { MASTERY_LINE } from './profile/scoring/threeLayer';
import { MASTERY_SHADOW_CRITERIA } from './masteryShadow/rubric';

export type MasteryReadMode = 'current' | 'legacy';
export type KnowledgeMasteryBand = 'unassessed' | 'provisional' | 'confirmed' | 'needs_review' | 'content_incomplete' | 'history';
export const KNOWLEDGE_MASTERY_FILTERS: Array<{ id: KnowledgeMasteryBand; label: string }> = [
  { id: 'unassessed', label: '待评估' }, { id: 'provisional', label: '分层待确认' },
  { id: 'confirmed', label: '已确认' }, { id: 'needs_review', label: '待复核' },
  { id: 'content_incomplete', label: '资料待补全' }, { id: 'history', label: '仅历史评分' },
];

/** Build-time rollback only; no writes, data migration, network or localStorage reads. */
export function masteryReadMode(): MasteryReadMode {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  const value = env?.VITE_MASTERY_READ_MODE
    ?? (typeof process !== 'undefined' ? process.env.VITE_MASTERY_READ_MODE : undefined);
  return value === 'legacy' ? 'legacy' : 'current';
}

export interface KnowledgeMasteryView extends MasteryShadowView {
  mode: MasteryReadMode;
  band: KnowledgeMasteryBand;
  historyScore: number | null;
  hasCurrentEvidence: boolean;
  confirmed: boolean;
  summary: string;
  nextAction: string;
  readWarnings: string[];
  legacyMigration?: MasteryShadowState['migration'];
}

export interface MasteryReadOptions {
  mode?: MasteryReadMode;
  requiredLevel?: 1 | 2 | 3 | null;
  now?: number;
}

export function readKnowledgeMastery(note: NoteItem, options: MasteryReadOptions = {}): KnowledgeMasteryView {
  const mode = options.mode || masteryReadMode();
  const raw = note.dsrState?.conceptMastery;
  const historyScore = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : null;
  const stored = note.dsrState?.masteryShadow;
  const validState = stored && stored.version === 1 && stored.knowledgePointId === note.id
    && Array.isArray(stored.appliedObservationIds) && ['concept', 'judgment', 'reasoning'].every(layer =>
      ['unassessed', 'provisional', 'confirmed', 'needs_review'].includes(stored.layers?.[layer]?.state));
  const state = validState ? stored : undefined;
  const migration = state?.migration;
  const activeEstimate = migration?.version === 1 && migration.kind === 'legacy-score'
    && Array.isArray(migration.activeLayers) && migration.activeLayers.length > 0
    && Number.isFinite(migration.sourceScore) && [0, 1, 2, 3].includes(migration.estimatedLevel) ? migration : undefined;
  const hasCurrentEvidence = Boolean(state && (state.appliedObservationIds.length
    || Object.values(state.layers).some(layer => layer.state !== 'unassessed')));
  const dsr = note.dsrState;
  const reviewedAt = dsr?.lastReviewedAt ? Date.parse(dsr.lastReviewedAt) : NaN;
  const retrievability = Number.isFinite(reviewedAt) && dsr && Number.isFinite(dsr.stability)
    ? Math.exp(-Math.max(0, ((options.now ?? Date.now()) - reviewedAt) / 86400000) / Math.max(dsr.stability, 0.1)) : undefined;
  const view = projectMasteryShadow({ knowledgePointId: note.id,
    state: mode === 'current' ? state : undefined,
    contentStatus: hasSubstantiveReferenceText(note.content || '') ? 'ready' : 'incomplete',
    requiredLevel: options.requiredLevel ?? null, retrievability,
    legacy: historyScore == null ? undefined : { score: historyScore, samples: dsr?.conceptMasterySamples } });
  const confirmed = mode === 'legacy' ? historyScore != null && historyScore >= MASTERY_LINE
    : view.targetMet === true || view.confirmedLevel === 3 && view.assessmentStatus === 'confirmed';
  const band: KnowledgeMasteryBand = !hasCurrentEvidence && historyScore != null ? 'history' : view.assessmentStatus;
  const currentProblem = Object.values(state?.layers || {}).some(layer => Object.values(layer.criteria || {})
    .some(criterion => criterion.state === 'needs_review' || criterion.unresolvedFailures > 0));
  const abilityLabel = view.assessmentStatus === 'needs_review' ? '待复核'
    : view.targetMet === true ? '达到目标'
      : view.confirmedLevel > 0 ? `${['', '概念', '判断', '推理'][view.confirmedLevel]}已确认`
        : view.assessmentStatus === 'provisional' ? '待确认' : '未评估';
  const displayLabel = mode === 'legacy' ? historyScore == null ? '未评估' : `历史评分 ${Math.round(historyScore)}%`
    : currentProblem ? '待复核'
      : activeEstimate ? activeEstimate.estimatedLevel === 0 ? '待复核（历史估计）'
      : `历史估计至${['', '概念', '判断', '推理'][activeEstimate.estimatedLevel]}层（待确认）`
      : !hasCurrentEvidence && historyScore != null ? '待评估（仅历史评分）' : abilityLabel;
  const level = ['尚无连续确认层级', '已确认至概念层', '已确认至判断层', '三层已确认'][view.confirmedLevel];
  const target = view.requiredLevel == null ? '目标未设置'
    : `目标：${['', '概念', '判断', '推理'][view.requiredLevel]}层 · ${view.targetMet ? '已达目标' : '未达目标'}`;
  const actions: Record<MasteryShadowView['reviewCategory'], string> = {
    content_incomplete: '先补全知识点资料', verify: '复核有据的问题', strengthen: '补强目标层次',
    confirm: '确认已有通过表现', diagnose: '补充评价证据', memory_refresh: '刷新记忆，不重复判为不理解', stable: '保持巩固',
  };
  const pending = Object.values(view.criterionProgress || {}).flatMap(progress => progress.pendingIds);
  const hasCriterionProgress = Object.values(state?.layers || {}).some(layer => Object.values(layer.criteria || {})
    .some(criterion => criterion.state !== 'unassessed'));
  const nextAction = mode === 'current' && hasCriterionProgress && pending.length && ['confirm', 'diagnose', 'strengthen'].includes(view.reviewCategory)
    ? `补充验证：${pending.slice(0, 2).map(id => MASTERY_SHADOW_CRITERIA.find(criterion => criterion.id === id)!.label).join('、')}`
    : mode === 'current' && currentProblem ? actions.verify
      : mode === 'current' && activeEstimate ? activeEstimate.estimatedLevel === 0
      ? '复核历史低分，不代表已确认存在错误' : '通过复盘或复习逐项确认历史估计'
      : actions[view.reviewCategory];
  const migrationSummary = mode === 'current' && activeEstimate
    ? `历史 ${activeEstimate.sourceScore} 分的迁移估计，尚非新版逐项确认 · ` : '';
  return { ...view, displayLabel, mode, historyScore, hasCurrentEvidence, confirmed, band,
    summary: mode === 'legacy' ? displayLabel : `${migrationSummary}${level} · ${target}`,
    nextAction, readWarnings: [
      ...(stored && !validState ? ['掌握记录归属或结构异常，未作为有效确认读取。'] : []),
      ...(mode === 'current' && activeEstimate ? ['历史分数仅作初始估计，没有补造判据通过次数或原话证据。'] : []),
    ], ...(migration ? { legacyMigration: migration } : {}) };
}

export function summarizeKnowledgeMastery(notes: NoteItem[], options: MasteryReadOptions = {}) {
  const views = notes.filter(note => note.noteType === 'knowledge').map(note => readKnowledgeMastery(note, options));
  const aggregate = aggregateMasteryShadowViews(views);
  return { ...aggregate, views, confirmedCount: views.filter(view => view.confirmed).length,
    historyCount: views.filter(view => view.historyScore != null && !view.hasCurrentEvidence).length,
    bands: Object.fromEntries(KNOWLEDGE_MASTERY_FILTERS.map(filter => [filter.id, views.filter(view => matchesKnowledgeMasteryFilter(view, filter.id)).length])) as Record<KnowledgeMasteryBand, number> };
}

/** Content readiness and ability are independent filters; their counts can overlap. */
export function matchesKnowledgeMasteryFilter(view: KnowledgeMasteryView, filter: KnowledgeMasteryBand): boolean {
  return filter === 'content_incomplete' ? view.contentStatus !== 'ready'
    : filter === 'history' ? !view.hasCurrentEvidence && view.historyScore != null
      : filter === 'needs_review' ? view.assessmentStatus === filter || view.reviewCategory === 'verify'
        : view.assessmentStatus === filter;
}

export function knowledgeMasteryCaption(note: NoteItem, options: MasteryReadOptions = {}): string {
  const view = readKnowledgeMastery(note, options);
  if (view.mode === 'legacy') return view.displayLabel;
  return `${view.displayLabel}${view.historyScore == null ? '' : ` · 历史评分 ${Math.round(view.historyScore)}%`}`;
}
