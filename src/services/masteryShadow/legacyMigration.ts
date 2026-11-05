import type { NoteItem, UserNoteState } from '../../types';
import { createMasteryShadowState, effectiveMasteryShadowState } from './stateMachine';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowState } from './types';

export const LEGACY_MASTERY_THRESHOLDS = { concept: 55, judgment: 75, reasoning: 90 } as const;
export interface LegacyMasteryMigrationPlan {
  version: 1;
  policy: 'legacy-score-estimate-v1';
  migrationId: string;
  migratedAt: string;
  thresholds: { concept: number; judgment: number; reasoning: number };
  changes: Array<{ noteId: string; title: string; before: MasteryShadowState | undefined;
    after: MasteryShadowState; sourceScore: number; estimatedLevel: 0 | 1 | 2 | 3 }>;
  skipped: Array<{ noteId: string; reason: string }>;
}

function emptyState(value: MasteryShadowState, noteId: string): boolean {
  return value?.version === 1 && value.knowledgePointId === noteId && !value.migration && !value.updatedAt
    && Array.isArray(value.appliedObservationIds) && value.appliedObservationIds.length === 0
    && MASTERY_SHADOW_LAYERS.every(layer => {
      const row = value.layers?.[layer];
      return row?.state === 'unassessed' && row.independentPasses === 0 && row.unresolvedFailures === 0
        && Array.isArray(row.recentEvidenceIds) && row.recentEvidenceIds.length === 0
        && !row.legacySummary && !row.lastObservedAt && !row.lastConfirmedAt
        && Object.values(row.criteria || {}).every(criterion => criterion?.state === 'unassessed'
          && criterion.independentPasses === 0 && criterion.unresolvedFailures === 0
          && Array.isArray(criterion.recentEvidenceIds) && criterion.recentEvidenceIds.length === 0
          && !criterion.lastObservedAt && !criterion.lastConfirmedAt);
    });
}

/** Pure, deterministic plan. Score bands seed estimates, never nine fake criterion passes.
 * Existing new-mode data (including invalid/unknown shapes) is deliberately preserved. */
export function planLegacyMasteryMigration(notes: Array<Pick<NoteItem, 'id' | 'title' | 'noteType'>>,
  states: Record<string, UserNoteState>, options: { migrationId: string; migratedAt: string;
    thresholds?: { concept: number; judgment: number; reasoning: number } }): LegacyMasteryMigrationPlan {
  if (!options.migrationId.trim() || !Number.isFinite(Date.parse(options.migratedAt))) throw new Error('迁移批次或时间无效');
  const thresholds = { ...(options.thresholds || LEGACY_MASTERY_THRESHOLDS) };
  const { concept, judgment, reasoning } = thresholds;
  if (![concept, judgment, reasoning].every(Number.isFinite) || !(0 < concept && concept < judgment && judgment < reasoning && reasoning <= 100)) {
    throw new Error('迁移阈值必须满足 0 < 概念 < 判断 < 推理 ≤ 100');
  }
  const plan: LegacyMasteryMigrationPlan = { version: 1, policy: 'legacy-score-estimate-v1', ...options,
    thresholds, changes: [], skipped: [] };
  const seen = new Set<string>();
  for (const note of notes) {
    if (seen.has(note.id)) throw new Error(`笔记ID重复：${note.id}`);
    seen.add(note.id);
    if (note.noteType !== 'knowledge') continue;
    const skip = (reason: string) => plan.skipped.push({ noteId: note.id, reason });
    const dsr = states[note.id]?.dsrState;
    const score = dsr?.conceptMastery;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) { skip('no_valid_legacy_score'); continue; }
    const previous = dsr?.masteryShadow;
    if (previous != null && !emptyState(previous, note.id)) { skip(previous.migration ? 'already_migrated' : 'existing_new_state'); continue; }
    const samples = dsr?.conceptMasterySamples;
    if (samples !== undefined && (!Number.isSafeInteger(samples) || samples < 0)) { skip('invalid_legacy_samples'); continue; }
    const sourceDate = dsr?.conceptMasteryUpdatedAt;
    const validDate = typeof sourceDate === 'string' && Number.isFinite(Date.parse(sourceDate));
    // A default 0 without an actual mastery sample/date is unknown, not evidence of failure.
    if (score === 0 && !(samples && samples > 0) && !validDate) { skip('default_zero_without_assessment'); continue; }
    const estimatedLevel = score >= reasoning ? 3 : score >= judgment ? 2 : score >= concept ? 1 : 0;
    const activeLayers = MASTERY_SHADOW_LAYERS.slice(0, estimatedLevel || 1);
    const state = createMasteryShadowState(note.id);
    state.migration = { version: 1, kind: 'legacy-score', migrationId: options.migrationId, migratedAt: options.migratedAt,
      sourceScore: score, ...(samples !== undefined ? { sourceSamples: samples } : {}),
      ...(validDate ? { sourceUpdatedAt: sourceDate } : {}), estimatedLevel, thresholds: { ...thresholds }, activeLayers };
    for (const layer of activeLayers) state.layers[layer].legacySummary = {
      state: estimatedLevel === 0 ? 'needs_review' : 'provisional', independentPasses: 0,
      unresolvedFailures: 0, recentEvidenceIds: [],
    };
    state.updatedAt = options.migratedAt;
    plan.changes.push({ noteId: note.id, title: note.title, before: previous && structuredClone(previous),
      after: effectiveMasteryShadowState(state), sourceScore: score, estimatedLevel });
  }
  return plan;
}
