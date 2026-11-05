export const MASTERY_SHADOW_LAYERS = ['concept', 'judgment', 'reasoning'] as const;

export type MasteryShadowLayer = (typeof MASTERY_SHADOW_LAYERS)[number];

export type MasteryShadowLayerState =
  | 'unassessed'
  | 'provisional'
  | 'confirmed'
  | 'needs_review';

export type MasteryShadowCoverage =
  | 'not_tested'
  | 'incidental'
  | 'assessed'
  | 'unverifiable';

export type MasteryShadowVerdict = 'pass' | 'partial' | 'fail' | 'not_observed' | 'unverifiable';
export type MasteryShadowAssistance = 'independent' | 'assisted';
export type MasteryShadowReferenceBasis = 'grounded' | 'model_only' | 'unavailable';
export type MasteryShadowEvidenceStrength = 'natural' | 'targeted';
export type MasteryShadowSource =
  | 'flow_review'
  | 'socratic_review'
  | 'quick_check'
  | 'scene'
  | 'exercise'
  | 'other';

export interface MasteryShadowLayerResult {
  layer: MasteryShadowLayer;
  verdict: MasteryShadowVerdict;
  /** 本次判定实际使用的评价条件；不能只给总评。 */
  criterionIds: string[];
  /** 指向用户原话、作答或步骤的证据 ID。 */
  userEvidenceIds: string[];
  /** 指向教材、资源或知识点参考包的证据 ID。 */
  referenceIds: string[];
  /** Per-criterion outcomes. Historical layer-only results cannot certify comprehensive coverage. */
  criterionResults?: Array<{
    id: string;
    verdict: MasteryShadowVerdict | 'not_applicable';
    userEvidenceIds: string[];
    referenceIds: string[];
    referenceBasis: MasteryShadowReferenceBasis;
    /** Locally derived from validated open-answer evidence, never a model-supplied upgrade. Passes only. */
    passStrength?: MasteryShadowEvidenceStrength;
  }>;
}

export interface MasteryShadowObservation {
  id: string;
  knowledgePointId: string;
  occurredAt: string;
  source: MasteryShadowSource;
  coverage: MasteryShadowCoverage;
  assistance: MasteryShadowAssistance;
  referenceBasis: MasteryShadowReferenceBasis;
  strength: MasteryShadowEvidenceStrength;
  results: MasteryShadowLayerResult[];
}

export interface MasteryShadowEvidenceRecord {
  state: MasteryShadowLayerState;
  /** 两次自然证据可完成确认；定向简测的一次强证据可直接确认。 */
  independentPasses: number;
  /** 已确认状态遇到一次自然失败时先挂起警报，不立即抹掉旧确认。 */
  unresolvedFailures: number;
  lastObservedAt?: string;
  lastConfirmedAt?: string;
  /** 仅保留少量定位 ID，影子状态不复制正文。 */
  recentEvidenceIds: string[];
}

export interface MasteryShadowLayerRecord extends MasteryShadowEvidenceRecord {
  /** Closed rubric IDs are validated by the state machine. Missing IDs mean missing evidence. */
  criteria?: Record<string, MasteryShadowEvidenceRecord>;
  /** Preserve the old aggregate without manufacturing criterion-specific confirmations. */
  legacySummary?: MasteryShadowEvidenceRecord;
}

export interface MasteryShadowState {
  version: 1;
  knowledgePointId: string;
  layers: Record<MasteryShadowLayer, MasteryShadowLayerRecord>;
  /** 保证重复回放同一事件不会重复累计。 */
  appliedObservationIds: string[];
  updatedAt?: string;
  /** One-time imported estimate, never a scored answer or criterion confirmation. */
  migration?: {
    version: 1;
    kind: 'legacy-score';
    migrationId: string;
    migratedAt: string;
    sourceScore: number;
    sourceSamples?: number;
    sourceUpdatedAt?: string;
    estimatedLevel: 0 | 1 | 2 | 3;
    thresholds: { concept: number; judgment: number; reasoning: number };
    /** Initial seeds retire per layer when a new grounded pass/fail takes over. */
    activeLayers: MasteryShadowLayer[];
  };
}

export type MasteryShadowContentStatus = 'incomplete' | 'ready' | 'needs_review';
export type MasteryShadowAssessmentStatus =
  | 'unassessed'
  | 'provisional'
  | 'confirmed'
  | 'needs_review';

export type MasteryShadowReviewCategory =
  | 'content_incomplete'
  | 'verify'
  | 'strengthen'
  | 'confirm'
  | 'diagnose'
  | 'memory_refresh'
  | 'stable';

export interface MasteryShadowLegacyEstimate {
  score?: number;
  samples?: number;
  updatedAt?: string;
}

export interface MasteryShadowProjectionInput {
  knowledgePointId: string;
  state?: MasteryShadowState;
  contentStatus: MasteryShadowContentStatus;
  /** 项目对该知识点要求到达的层级：1=概念、2=判断、3=推理。 */
  requiredLevel: 1 | 2 | 3 | null;
  /** 记忆可提取性与理解掌握分开；0~1。 */
  retrievability?: number;
  /** 旧分只展示和迁移，不参与新状态机。 */
  legacy?: MasteryShadowLegacyEstimate;
}

export interface MasteryShadowView {
  knowledgePointId: string;
  contentStatus: MasteryShadowContentStatus;
  assessmentStatus: MasteryShadowAssessmentStatus;
  layers: Record<MasteryShadowLayer, MasteryShadowLayerState>;
  confirmedLevel: 0 | 1 | 2 | 3;
  requiredLevel: 1 | 2 | 3 | null;
  targetGap: 0 | 1 | 2 | 3 | null;
  targetMet: boolean | null;
  retrievability: number | null;
  reviewCategory: MasteryShadowReviewCategory;
  /** 只用于排序，不作为掌握度真值。 */
  reviewPriority: number;
  displayLabel: string;
  criterionProgress?: Record<MasteryShadowLayer, { confirmed: number; total: number; pendingIds: string[] }>;
  legacy?: MasteryShadowLegacyEstimate;
  legacyOnly: boolean;
}

export interface MasteryShadowAggregate {
  total: number;
  content: { ready: number; incomplete: number; needsReview: number };
  assessment: { unassessed: number; provisional: number; confirmed: number; needsReview: number };
  highestConfirmedLevel: { none: number; concept: number; judgment: number; reasoning: number };
  target: { met: number; gap: number; unset: number };
  reviewCategories: Record<MasteryShadowReviewCategory, number>;
  legacyOnly: number;
}

/** Result-page adapter; legacy numeric deltas must not be used for this result. */
export interface MasteryShadowPresentation {
  evaluationId: string;
  status: 'evaluated' | 'failed';
  overview?: { label: string; summary: string; nextAction: string };
  layers: Record<MasteryShadowLayer, {
    coverage: MasteryShadowCoverage;
    verdict: MasteryShadowVerdict;
    state: MasteryShadowLayerState;
    reason: string;
    /** Display-only details; absent in older saved reports. Never changes the state machine. */
    assessment?: {
      criteria: Array<{ id: string; label: string; state: MasteryShadowVerdict | 'not_applicable'; reason: string;
        referenceQuotes?: Array<{ referenceId: string; quote: string }> }>;
      evidence: Array<{ id: string; quote: string }>;
      references: Array<{ id: string; label: string; locator?: string; quote: string }>;
    };
  }>;
}

export const MASTERY_SHADOW_STATE_LABELS: Record<MasteryShadowLayerState, string> = {
  unassessed: '未评估', provisional: '待确认', confirmed: '已确认', needs_review: '待复核',
};
export const MASTERY_SHADOW_STATE_MARKERS: Record<MasteryShadowLayerState, string> = {
  unassessed: '—', provisional: '◐', confirmed: '✓', needs_review: '!',
};
export const MASTERY_SHADOW_VERDICT_LABELS: Record<MasteryShadowVerdict, string> = {
  pass: '本次通过', partial: '本次部分满足', fail: '本次发现问题',
  not_observed: '本次未展示', unverifiable: '依据不足，暂不评价',
};
