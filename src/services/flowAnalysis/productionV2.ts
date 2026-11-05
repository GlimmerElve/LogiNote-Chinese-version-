import type { ShadowReferenceProvider } from '../flowShadow/references';
import type {
  ArgumentFunctionType, KnowledgePointMasteryResult, LayeredScoreResult,
  ProfileInsight, Vulnerability,
} from '../../types';
import { callLLM } from '../llmService';
import { layoutDoc } from '../argumentDoc/layout';
import type { ArgDoc, ArgEdge, ArgNode, ArgumentRole } from '../argumentDoc/types';
import { projectFlowEdges, readFlowStructure } from '../argumentDoc/flowStructure';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { runFlowShadow, type ShadowModel } from '../flowShadow/runner';
import type {
  ShadowBehavior, ShadowInput, ShadowLayer, ShadowRecord,
} from '../flowShadow/types';
import { SHADOW_BEHAVIORS } from '../flowShadow/rubric';
import { SHADOW_COGNITIVE_AXES, cognitiveDirectionLabel } from '../flowShadow/profileAlignment';
import type { FlowAnalysisInput, FlowAnalysisReport, ArgumentQualitySectionItem } from './types';
import { buildFlowStylePresentation } from './stylePresentation';
import { buildFlowReviewTask } from './reviewTask';
import { verifiedShadowUserEvidence, scoreShadowAssessment } from '../flowShadow/scoring';
import { scoreShadowReferenceAssessment } from '../flowShadow/referenceScoring';
import { arithmeticVerificationDecision } from '../flowShadow/literalArithmetic';
import { auditShadowCognitiveEvidence } from '../flowShadow/cognitiveEvidence';
import { createFlowReferenceProvider, type FlowReferenceReaders } from './referenceProvider';
import { flowReviewMaxTokens } from './modelBudgets';

export const FLOW_REVIEW_ANALYSIS_VERSION = 'flow-review-analysis-v2' as const;

export interface FlowReviewAnalysisResultV2 {
  schemaVersion: 2;
  pipeline: typeof FLOW_REVIEW_ANALYSIS_VERSION;
  analysisRunId: string;
  observedAt: string;
  record: ShadowRecord;
  /** 只用于项目复盘块的简短摘要，不是画像证据库。 */
  reviewBlockSummary: string;
}

export interface FlowAnalysisV2Bundle {
  report: FlowAnalysisReport;
  profileInsight: ProfileInsight;
  argumentDoc: ArgDoc;
  analysisV2: FlowReviewAnalysisResultV2;
}

const compact = (value: string, max = 2000): string => value.replace(/\s+/gu, ' ').trim().slice(0, max);
const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

export { createFlowReferenceProvider } from './referenceProvider';

function grade(score: number): string {
  return score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 55 ? '基本达成' : '需要加强';
}

function layerScores(record: ShadowRecord): LayeredScoreResult {
  const find = (layer: ShadowLayer) => clamp(record.scoring.layers.find((item) => item.layer === layer)?.score ?? 0);
  const concept = find('concept'), judgment = find('judgment'), logic = find('reasoning');
  return {
    raw: { concept, judgment, logic }, penalty: { concept: 0, judgment: 0, logic: 0 },
    final: { concept, judgment, logic },
    grade: { concept: grade(concept), judgment: grade(judgment), logic: grade(logic) },
  };
}

const ROLE_TO_LEGACY: Record<ArgumentRole, ArgumentFunctionType> = {
  background: '定义', premise: '事实陈述', method: '事实陈述', claim: '推理',
};

function issueSeverity(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 5 : value === 'medium' ? 3 : 1;
}

function buildArgumentDoc(record: ShadowRecord, title: string): ArgDoc {
  const byTarget = new Map<string, ShadowRecord['assessment']['issues'][number]>();
  for (const issue of record.assessment.issues) for (const target of issue.targetIds) {
    const prior = byTarget.get(target);
    if (!prior || issueSeverity(issue.severity) > issueSeverity(prior.severity)) byTarget.set(target, issue);
  }
  const nodes: ArgNode[] = record.graph.nodes.map((node) => {
    const issue = byTarget.get(node.id);
    return {
      id: node.id, mainType: ROLE_TO_LEGACY[node.role], role: node.role, text: node.text,
      position: { x: 0, y: 0 }, status: issue ? (issue.severity === 'high' ? 'error' : 'warning') : 'ok',
      issue: issue?.reason || null, severity: issue ? issueSeverity(issue.severity) : null,
      suggestion: issue ? record.assessment.recommendation : null,
      subTypes: `v2:${node.role}`, user_edited: false, collapsed: false,
    };
  });
  const flowStructure = readFlowStructure({ version: 1, ...record.graph })!;
  const edges: ArgEdge[] = projectFlowEdges(flowStructure);
  const positions = layoutDoc(nodes, edges);
  nodes.forEach((node) => { if (positions[node.id]) node.position = positions[node.id]; });
  const scores = layerScores(record).final;
  const hasScore = (layer: ShadowLayer) => record.scoring.layers.some(item => item.layer === layer && item.score !== null);
  const now = record.input.observedAt;
  return {
    doc_id: `flow_${record.input.attemptId}`, title, created_at: now, updated_at: now,
    iteration: 1, status: 'draft', nodes, edges, flowStructure, summary: record.assessment.summary,
    ...(hasScore('concept') && hasScore('judgment') && hasScore('reasoning')
      ? { scores: { conceptScore: scores.concept, judgmentScore: scores.judgment, logicScore: scores.logic } } : {}),
  };
}

function vulnerabilityFor(record: ShadowRecord, issue: ShadowRecord['assessment']['issues'][number]): Vulnerability {
  const evidence = issue.evidenceIds.map((id) => record.assessment.evidence.find((item) => item.id === id)?.quote).filter(Boolean).join('；');
  const labels = { extraction: '抽取疑点', argument_gap: '论证缺口', confirmed_internal: '内部一致性问题',
    external_unverified: '外部事实待核', asr_uncertain: '转写不确定' } as const;
  return {
    nodeId: issue.targetIds.find((id) => record.graph.nodes.some((node) => node.id === id)),
    type: labels[issue.kind], severity: issueSeverity(issue.severity), layer: '多层',
    evidence: evidence || issue.reason, suggestion: issue.kind === 'extraction'
      ? '先修正图的抽取或连线，不把该问题当成用户能力缺口。' : record.assessment.recommendation,
  };
}

function behaviorLines(behaviors: readonly ShadowBehavior[], dimension: 'expression' | 'strategy'): string[] {
  return behaviors.filter((item) => item.state === 'observed' && SHADOW_BEHAVIORS.some((definition) => definition.code === item.code && definition.dimension === dimension))
    .filter(item => dimension !== 'strategy' || item.direction != null)
    .map((item) => {
      const definition = SHADOW_BEHAVIORS.find((entry) => entry.code === item.code);
      const axis = SHADOW_COGNITIVE_AXES.find((entry) => entry.behavior === item.code);
      return `${definition?.label || item.code}${axis ? `（${cognitiveDirectionLabel(axis, item.direction)}）` : ''}：${item.reason}`;
    });
}

function criterionSummary(record: ShadowRecord, layer: ShadowLayer): string {
  const ids = layer === 'concept' ? ['concept_clarity', 'concept_consistency', 'concept_application']
    : layer === 'judgment' ? ['judgment_clarity', 'judgment_attribution', 'judgment_calibration']
      : ['reasoning_relevance', 'reasoning_sufficiency', 'reasoning_consistency'];
  return compact(record.assessment.criteria.filter((item) => ids.includes(item.id)).map((item) => item.reason).join('；'), 180);
}

function buildReport(record: ShadowRecord, masteryResults: KnowledgePointMasteryResult[]): FlowAnalysisReport {
  const scores = layerScores(record);
  const vulnerabilities = record.assessment.issues.map((issue) => vulnerabilityFor(record, issue));
  const quality: ArgumentQualitySectionItem = { layeredScores: scores, vulnerabilities, summary: record.assessment.summary };
  const cognitive = behaviorLines(record.assessment.behaviors, 'strategy');
  const expression = behaviorLines(record.assessment.behaviors, 'expression');
  const related = [...new Map(record.references.items.filter((item) => item.tier === 3)
    .map((item) => [item.sourceId, { term: item.title, relation: '本次复盘对照的关联知识点', suggestedWikiLink: item.title }])).values()];
  const clarity = record.assessment.clarity;
  const verified = verifiedShadowUserEvidence(record.input, record.graph, record.assessment).evidence;
  const clarityBound = clarity && clarity.evidenceIds.length > 0 && clarity.evidenceIds.every(id => verified.has(id));
  const arithmetic = arithmeticVerificationDecision(record.input, record.graph, record.assessment);
  const labels = { concept: '概念', judgment: '判断', reasoning: '推理' } as const;
  const verificationNotes = [...arithmetic.warnings.map(warning => warning.message),
    ...record.referenceScoring.layers.filter(layer => layer.verificationPending).map(layer => `${labels[layer.layer]}资料对照含计算用途或一致性待核验，暂不展示为已确认分数。`)];
  const pendingLayers = record.scoring.layers.filter(layer => layer.verificationPending).map(layer => layer.layer);
  const summary = verificationNotes.length ? `模型原评价（含待核验内容）：${record.assessment.summary}` : record.assessment.summary;
  return {
    ...(verificationNotes.length ? { verificationNotes, verificationPendingLayers: pendingLayers } : {}),
    ...(clarity ? { clarityComment: clarity.comment } : {}),
    ...(clarityBound && typeof clarity.score === 'number' && Number.isFinite(clarity.score) && clarity.score >= 0 && clarity.score <= 100
      ? { clarityScore: clarity.score } : {}),
    unscoredLayers: (['concept', 'judgment', 'reasoning'] as const).filter(layer => !record.scoring.layers.some(item => item.layer === layer && item.score !== null)),
    stylePresentation: buildFlowStylePresentation(record),
    summary, recommendation: record.assessment.recommendation,
    thinkingStyleBrief: cognitive[0] || undefined,
    expressionStyleComment: expression.length ? compact(expression.join('；'), 180) : undefined,
    conceptSummary: criterionSummary(record, 'concept'), judgmentSummary: criterionSummary(record, 'judgment'),
    reasoningSummary: `${pendingLayers.includes('reasoning') ? '待核验：' : ''}${criterionSummary(record, 'reasoning')}`,
    overallComment: compact(`${verificationNotes[0] ? `${verificationNotes[0]}；` : ''}${summary}${record.assessment.recommendation ? `；下一步：${record.assessment.recommendation}` : ''}`, 400),
    sections: [
      { kind: 'argumentQuality', title: '三层论证评价', items: [quality], total: 1 },
      ...(cognitive.length ? [{ kind: 'cognitiveInterpretation' as const, title: '本次认知策略观察', items: cognitive, total: cognitive.length }] : []),
      ...(expression.length ? [{ kind: 'expressionStyle' as const, title: '本次表达行为', items: expression, total: expression.length }] : []),
      ...(related.length ? [{ kind: 'relatedKnowledge' as const, title: '参考的关联知识', items: related, total: related.length }] : []),
      ...(masteryResults.length ? [{ kind: 'mastery' as const, title: '知识点掌握度', items: masteryResults, total: masteryResults.length }] : []),
    ],
  };
}

function buildProfileInsight(record: ShadowRecord): ProfileInsight {
  const scores = layerScores(record);
  const cognitiveStyle: ProfileInsight['cognitiveStyle'] = {};
  for (const axis of SHADOW_COGNITIVE_AXES) {
    const behavior = record.assessment.behaviors.find((item) => item.code === axis.behavior && item.state === 'observed');
    if (behavior?.direction != null) cognitiveStyle[axis.key] = behavior.direction * 50;
  }
  return { concepts: [], layeredScores: scores, cognitiveStyle };
}

function createModel(): ShadowModel {
  return {
    async call(request, signal) {
      const response = await callLLM({
        providerId: '', model: '', workflow: 'flow-analysis', userInput: request.userInput,
        systemPromptOverride: request.systemPrompt, outputSchema: JSON_OBJECT_OUTPUT,
        temperatureOverride: 0.1, maxTokensOverride: flowReviewMaxTokens(request.stage),
        skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled',
      }, { signal });
      return { content: response.content, usage: response.usage };
    },
  };
}

export async function runProductionFlowAnalysisV2(
  input: FlowAnalysisInput,
  masteryResults: KnowledgePointMasteryResult[] = [],
  onProgress?: (stage: 'evidence' | 'summary') => void,
  dependencies: { model?: ShadowModel; referenceReaders?: Partial<FlowReferenceReaders>; referenceProvider?:ShadowReferenceProvider } = {},
): Promise<FlowAnalysisV2Bundle> {
  const observedAt = new Date().toISOString();
  const analysisRunId = input.analysisRunId || `flow-${Date.now()}`;
  const source: ShadowInput = {
    attemptId: analysisRunId, assessmentRevision: 1, observedAt, rawText: input.speakingContent,
    task: buildFlowReviewTask(input),
    assistance: 'none',
  };
  const outcome = await runFlowShadow(source, dependencies.model || createModel(), {
    referenceProvider: dependencies.referenceProvider || createFlowReferenceProvider(input, dependencies.referenceReaders),
    onProgress: (stage) => onProgress?.(stage === 'assess' ? 'summary' : 'evidence'),
  });
  if (outcome.status !== 'reviewed' || !outcome.record) throw new Error(outcome.error || '新版复盘分析未完成');
  return adaptShadowRecordToFlowV2(outcome.record, input.noteTitle, masteryResults);
}

/** 纯适配层，方便用固定样例验证 UI/持久化契约，不调用网络。 */
export function adaptShadowRecordToFlowV2(
  record: ShadowRecord,
  noteTitle: string,
  masteryResults: KnowledgePointMasteryResult[] = [],
): FlowAnalysisV2Bundle {
  const audited = auditShadowCognitiveEvidence(record.input, record.graph, record.assessment);
  record = { ...record, assessment: audited.assessment,
    warnings: [...new Map([...record.warnings, ...audited.warnings].map(w => [`${w.code}:${w.target}:${w.message}`, w])).values()] };
  if (record.assessment.localVerification) {
    const scoring = scoreShadowAssessment(record.input, record.graph, record.assessment);
    const referenceScoring = scoreShadowReferenceAssessment(record.input, record.graph, record.references, record.assessment);
    record = { ...record, scoring, referenceScoring,
      warnings: [...new Map([...record.warnings, ...scoring.warnings, ...referenceScoring.warnings].map(w => [`${w.code}:${w.target}:${w.message}`, w])).values()] };
  }
  const observedAt = record.input.observedAt;
  const analysisRunId = record.input.attemptId;
  const analysisV2: FlowReviewAnalysisResultV2 = {
    schemaVersion: 2, pipeline: FLOW_REVIEW_ANALYSIS_VERSION, analysisRunId, observedAt, record,
    reviewBlockSummary: compact(`${[...record.scoring.layers, ...record.referenceScoring.layers].some(layer => layer.verificationPending) ? '含待核验算式；模型原评价：' : ''}${record.assessment.summary}${record.assessment.recommendation ? `；下一步：${record.assessment.recommendation}` : ''}`, 180),
  };
  return {
    report: buildReport(record, masteryResults), profileInsight: buildProfileInsight(record),
    argumentDoc: buildArgumentDoc(record, noteTitle || '本次复盘论证图'), analysisV2,
  };
}
