import type { LlmCallResponse } from '../../types';
import { callLLM, resolveProvider } from '../llmService';
import { ensureLlmSettingsLoaded } from '../llmStorage';
import {
  assessArgumentDoc,
  assessArgumentEvidence,
  computeArgumentIssueTargetFingerprint,
  computeArgumentRevisionHash,
  getEffectiveArgumentQuality,
  rejectedEvidenceNodeIds,
} from './quality';
import type {
  ArgDoc,
  ArgumentEvidenceAssessment,
  ArgumentQualityAssessment,
  ArgumentQualityAuditEntry,
  ArgumentSemanticAssessment,
  ArgumentSemanticIssue,
  ArgumentSemanticIssueCategory,
} from './types';

type QualityCaller = (request: Parameters<typeof callLLM>[0]) => Promise<LlmCallResponse>;

const ISSUE_CATEGORIES = new Set<ArgumentSemanticIssueCategory>([
  'structural-invalid',
  'compound-claim',
  'ambiguous-node',
  'type-mismatch',
  'edge-direction',
  'unsupported-inference',
  'missing-premise',
  'missing-qualifier',
  'circular-reasoning',
  'internal-conflict',
  'ungrounded-factual-claim',
]);

const DIMENSION_MAX = {
  structure: 20,
  clarity: 20,
  relationCorrectness: 30,
  coverage: 15,
  consistency: 15,
} as const;

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('语义复核结果不是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function boundedInteger(value: unknown, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`语义复核缺少有效维度：${field}`);
  }
  return Math.max(0, Math.min(max, Math.round(value)));
}

function compact(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
}

function normalizeIssues(raw: unknown, doc: ArgDoc): ArgumentSemanticIssue[] {
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  const edgeIds = new Set(doc.edges.map((edge) => edge.id));
  const values = Array.isArray(raw) ? raw.slice(0, 50) : [];
  const issues: ArgumentSemanticIssue[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const targetRaw = item.target && typeof item.target === 'object'
      ? item.target as Record<string, unknown>
      : {};
    const kind = targetRaw.kind;
    const targetId = compact(targetRaw.id, 200);
    if (kind !== 'node' && kind !== 'edge' && kind !== 'graph') continue;
    if (kind === 'node' && !nodeIds.has(targetId)) continue;
    if (kind === 'edge' && !edgeIds.has(targetId)) continue;
    const category = item.category as ArgumentSemanticIssueCategory;
    if (!ISSUE_CATEGORIES.has(category)) continue;
    const rawSeverity = item.severity;
    if (rawSeverity !== 'blocker' && rawSeverity !== 'major' && rawSeverity !== 'minor') continue;
    let severity: ArgumentSemanticIssue['severity'] = rawSeverity;
    // 缺少来源不是结构 blocker；证据等级由确定性规则计算。
    if (category === 'ungrounded-factual-claim' && severity === 'blocker') severity = 'major';
    const explanation = compact(item.explanation, 240);
    const suggestedAction = compact(item.suggestedAction, 200);
    if (!explanation || !suggestedAction) continue;
    issues.push({
      id: `sem-${issues.length + 1}`,
      target: { kind, ...(kind !== 'graph' ? { id: targetId } : {}) },
      category,
      severity,
      explanation,
      suggestedAction,
      suggestedText: compact(item.suggestedText, 500) || undefined,
    });
    if (issues.length >= 20) break;
  }
  return issues;
}

export function normalizeArgumentSemanticReview(
  doc: ArgDoc,
  raw: unknown,
  options?: { reviewedAt?: string; model?: string },
): ArgumentSemanticAssessment {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const rawDimensions = value.dimensions && typeof value.dimensions === 'object'
    ? value.dimensions as Record<string, unknown>
    : {};
  const dimensions = {
    structure: boundedInteger(rawDimensions.structure, DIMENSION_MAX.structure, 'structure'),
    clarity: boundedInteger(rawDimensions.clarity, DIMENSION_MAX.clarity, 'clarity'),
    relationCorrectness: boundedInteger(rawDimensions.relationCorrectness, DIMENSION_MAX.relationCorrectness, 'relationCorrectness'),
    coverage: boundedInteger(rawDimensions.coverage, DIMENSION_MAX.coverage, 'coverage'),
    consistency: boundedInteger(rawDimensions.consistency, DIMENSION_MAX.consistency, 'consistency'),
  };
  const issues = normalizeIssues(value.issues, doc);
  const targetSnapshots = Array.from(new Map(issues.map((issue) => {
    const key = `${issue.target.kind}:${issue.target.id || ''}`;
    return [key, {
      target: { ...issue.target },
      fingerprint: computeArgumentIssueTargetFingerprint(doc, issue.target),
    }];
  })).values());
  const score = Object.values(dimensions).reduce((sum, item) => sum + item, 0);
  const admission = issues.some((issue) => issue.severity === 'blocker') || score < 65
    ? 'review_required'
    : score >= 80 ? 'full' : 'limited';
  return {
    version: 1,
    promptVersion: 1,
    revisionHash: computeArgumentRevisionHash(doc),
    score,
    admission,
    dimensions,
    issues,
    targetSnapshots,
    reviewedAt: options?.reviewedAt || new Date().toISOString(),
    model: compact(options?.model, 200) || undefined,
  };
}

function buildReviewInput(doc: ArgDoc, deterministic: ArgumentQualityAssessment): string {
  return JSON.stringify({
    revisionHash: computeArgumentRevisionHash(doc),
    title: doc.title,
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      mainType: node.mainType,
      text: node.text,
      sources: (node.sources || []).map((source) => ({
        type: source.type,
        entityId: source.entityId,
        chunkId: source.chunkId,
        title: source.title,
        quote: source.quote,
        sectionPath: source.sectionPath,
      })),
    })),
    edges: doc.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
    })),
    deterministicGate: {
      score: deterministic.score,
      admission: deterministic.admission,
      issues: deterministic.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        nodeId: issue.nodeId,
        edgeId: issue.edgeId,
        message: issue.message,
      })),
    },
  });
}

export interface ArgumentQualityReviewResult {
  deterministic: ArgumentQualityAssessment;
  semantic: ArgumentSemanticAssessment;
  evidence: ArgumentEvidenceAssessment;
  effective: ReturnType<typeof getEffectiveArgumentQuality>;
  auditEntry: ArgumentQualityAuditEntry;
}

export async function reviewArgumentQuality(
  doc: ArgDoc,
  caller: QualityCaller = callLLM,
): Promise<ArgumentQualityReviewResult> {
  if (caller === callLLM) await ensureLlmSettingsLoaded();
  const provider = caller === callLLM ? resolveProvider('argument-quality-review') : null;
  if (!provider && caller === callLLM) {
    throw new Error('请先为“论证图·语义质量复核”配置 LLM 服务商');
  }
  const reviewedAt = new Date().toISOString();
  const deterministic = assessArgumentDoc(doc, reviewedAt);
  const response = await caller({
    providerId: '',
    model: '',
    workflow: 'argument-quality-review',
    userInput: buildReviewInput(doc, deterministic),
    skipMemoryInjection: true,
    skipProfileInjection: true,
    thinkingMode: 'disabled',
  });
  const parsed = response.parsedJson && typeof response.parsedJson === 'object'
    ? response.parsedJson
    : parseJsonObject(response.content || '');
  const semantic = normalizeArgumentSemanticReview(doc, parsed, {
    reviewedAt,
    model: response.diagnostics?.responseModel || provider?.selectedModel,
  });
  const evidence = assessArgumentEvidence(doc, reviewedAt, rejectedEvidenceNodeIds(semantic));
  const effective = getEffectiveArgumentQuality(deterministic, semantic);
  return {
    deterministic,
    semantic,
    evidence,
    effective,
    auditEntry: {
      id: `quality-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      event: 'semantic_review',
      revisionHash: semantic.revisionHash,
      at: reviewedAt,
      deterministicScore: deterministic.score,
      semanticScore: semantic.score,
      effectiveAdmission: effective.admission,
      evidenceGrade: evidence.grade,
      model: semantic.model,
      deterministicIssues: structuredClone(deterministic.issues),
      semanticIssues: structuredClone(semantic.issues),
    },
  };
}
