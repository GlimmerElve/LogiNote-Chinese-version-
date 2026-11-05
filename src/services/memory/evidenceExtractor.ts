import type { PlanNode, ProfileInsight, ReviewAnalysis, SceneRunState, SceneSpec } from '../../types';
import type { FlowAnalysisReport, FlowReviewAnalysisResultV2 } from '../flowAnalysis/types';
import { SHADOW_COGNITIVE_AXES, SHADOW_EXPRESSION_STYLES, SHADOW_EXPRESSION_WEIGHTS } from '../flowShadow/profileAlignment';
import { SHADOW_BEHAVIORS } from '../flowShadow/rubric';
import { verifiedShadowUserEvidence, scoreShadowAssessment } from '../flowShadow/scoring';
import { auditShadowCognitiveEvidence } from '../flowShadow/cognitiveEvidence';
import type { EpisodeMessage, EvidenceSnippet, ProfileSignal } from './types';
import { masteryReadMode } from '../masteryReadModel';
import type { MasteryShadowEvaluationResult } from '../masteryShadow/evaluator';
import { MASTERY_SHADOW_CRITERIA } from '../masteryShadow/rubric';

const MAX_SNIPPETS = 5;
const MAX_SNIPPET_CHARS = 500;

export interface DerivationProcessSummary {
  submitCount: number;
  editCount: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  correctedNodeCount: number;
}

/** 只聚合推导事件，不把逐次公式修改写入长期记忆。 */
export function summarizeDerivationProcess(run: SceneRunState): DerivationProcessSummary {
  const failedNodes = new Set<string>();
  const correctedNodes = new Set<string>();
  let submitCount = 0;
  let editCount = 0;
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const event of run.derivationEvents || []) {
    if (event.type === 'node_submit') submitCount += 1;
    if (event.type === 'node_edit') editCount += 1;
    if (event.type !== 'node_verify') continue;
    if (event.result === 'pass' || event.result === 'frozen') {
      passCount += 1;
      if (failedNodes.has(event.nodeId)) correctedNodes.add(event.nodeId);
    } else if (event.result === 'warn') {
      warnCount += 1;
    } else if (event.result === 'fail') {
      failCount += 1;
      failedNodes.add(event.nodeId);
    }
  }

  return { submitCount, editCount, passCount, warnCount, failCount, correctedNodeCount: correctedNodes.size };
}

function compact(text: string, max = MAX_SNIPPET_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function uniqueSnippets(items: EvidenceSnippet[], episodeId: string): EvidenceSnippet[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.text.toLocaleLowerCase();
    if (!item.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.importance - a.importance).slice(0, MAX_SNIPPETS)
    .map((item, index) => ({ ...item, id: item.id || `${episodeId}-e${index + 1}` }));
}

function signal(
  episodeId: string,
  observedAt: string,
  dimension: ProfileSignal['dimension'],
  indicator: string,
  value: number | string,
  confidence: number,
  evidenceType: ProfileSignal['evidenceType'],
  trace?: Pick<ProfileSignal, 'evidenceSnippetIds' | 'matchedCriteria' | 'rubricVersion'>,
): ProfileSignal {
  return { sourceEpisodeId: episodeId, dimension, indicator, value, confidence, evidenceType, observedAt, ...trace };
}

export function extractReviewEvidence(input: {
  episodeId: string;
  observedAt: string;
  messages: EpisodeMessage[];
  analysis: ReviewAnalysis | null;
  knowledgePoints: string[];
  /** Supplied by prepareReviewExitOutcome after source/evidence revalidation, never by feedback. */
  masteryEvaluations?: MasteryShadowEvaluationResult[];
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  const userAnswers = input.messages.filter((item) => item.role === 'user' && item.content.trim());
  const answerChars = userAnswers.reduce((sum, item) => sum + item.content.trim().length, 0);
  const confidence = Math.min(0.9, 0.55 + Math.min(userAnswers.length, 5) * 0.04 + Math.min(answerChars, 500) / 5000);
  const snippets: EvidenceSnippet[] = [];
  const analysis = masteryReadMode() === 'legacy' ? input.analysis : null;

  for (const missing of (analysis?.missingKnowledge || []).slice(0, 2)) {
    snippets.push({ type: 'mistake', text: compact(`知识缺口：${missing}`), importance: 1, source: 'scored_analysis' });
  }

  const answerType: EvidenceSnippet['type'] = analysis?.overallRating === 'easy' || analysis?.overallRating === 'good'
    ? 'success'
    : analysis?.overallRating === 'again' ? 'mistake' : 'observation';
  const candidates = [...userAnswers]
    .sort((a, b) => b.content.trim().length - a.content.trim().length)
    .slice(0, 2);
  const lastAnswer = userAnswers.at(-1);
  if (lastAnswer && !candidates.some((item) => item === lastAnswer)) candidates.push(lastAnswer);
  for (const answer of candidates) {
    snippets.push({ type: answerType, text: compact(answer.content), importance: 0.65, source: 'user_statement' });
  }

  if (masteryReadMode() === 'current') {
    for (const evaluation of input.masteryEvaluations || []) {
      for (const evidence of evaluation.evidence.slice(0, 2)) {
        if (userAnswers.some(answer => answer.content.includes(evidence.quote))) {
          snippets.unshift({ type: 'observation', text: compact(evidence.quote), importance: 1, source: 'user_statement' });
        }
      }
    }
  }
  const evidenceSnippets = uniqueSnippets(snippets, input.episodeId);
  const evidenceSnippetIds = evidenceSnippets.flatMap((item) => item.id ? [item.id] : []);
  const scoredTrace = (criteria: string[]): Pick<ProfileSignal, 'evidenceSnippetIds' | 'matchedCriteria' | 'rubricVersion'> => ({
    evidenceSnippetIds,
    matchedCriteria: criteria,
    rubricVersion: 'review-analysis-v1',
  });
  const signals: ProfileSignal[] = [];
  if (analysis && masteryReadMode() === 'legacy') {
    signals.push(
      signal(input.episodeId, input.observedAt, 'ability', 'conceptClarity', (analysis.accuracyScore + analysis.completenessScore) / 2, confidence, 'scored', scoredTrace(['accuracyScore', 'completenessScore'])),
      signal(input.episodeId, input.observedAt, 'ability', 'judgmentReasonableness', analysis.relevanceScore, confidence * 0.85, 'scored', scoredTrace(['relevanceScore'])),
      signal(input.episodeId, input.observedAt, 'ability', 'reasoningValidity', analysis.logicScore, confidence, 'scored', scoredTrace(['logicScore'])),
    );
    // Overall review performance is not per-knowledge mastery. Current mastery lives in evidence-backed note states.
    if (masteryReadMode() === 'legacy') {
      const masteryScore = (analysis.accuracyScore + analysis.completenessScore + analysis.logicScore + analysis.relevanceScore) / 4;
      for (const knowledgePoint of input.knowledgePoints.length > 0 ? input.knowledgePoints : ['current_review']) {
        signals.push(signal(input.episodeId, input.observedAt, 'knowledge_mastery', knowledgePoint, masteryScore, confidence, 'scored', scoredTrace(['accuracyScore', 'completenessScore', 'logicScore', 'relevanceScore'])));
      }
    }
  }
  if (masteryReadMode() === 'current') {
    const indicators = { concept: 'conceptClarity', judgment: 'judgmentReasonableness', reasoning: 'reasoningValidity' } as const;
    for (const layer of ['concept', 'judgment', 'reasoning'] as const) {
      const criteria = (input.masteryEvaluations || []).flatMap(evaluation => {
        const observed = evaluation.observations.find(observation => observation.results.some(result => result.layer === layer));
        if (observed?.coverage !== 'assessed' || observed.assistance !== 'independent' || observed.referenceBasis !== 'grounded') return [];
        return evaluation.criteria.filter(criterion => MASTERY_SHADOW_CRITERIA.find(row => row.id === criterion.id)?.layer === layer
          && ['pass', 'partial', 'fail'].includes(criterion.state) && criterion.evidenceIds.some(id => {
            const evidence = evaluation.evidence.find(row => row.id === id);
            return evidence && userAnswers.some(answer => answer.content.includes(evidence.quote));
          })).flatMap(criterion => {
            const quotes = evaluation.evidence.filter(evidence => criterion.evidenceIds.includes(evidence.id)).map(evidence => compact(evidence.quote));
            const snippetIds = evidenceSnippets.filter(snippet => quotes.includes(snippet.text)).flatMap(snippet => snippet.id ? [snippet.id] : []);
            return snippetIds.length ? [{ ...criterion, snippetIds }] : [];
          });
      });
      if (!criteria.length) continue;
      // Evidence quality, not mastery percentage: pass=100, partial=50, fail=0; unobserved items are excluded.
      const value = criteria.reduce((sum, criterion) => sum + (criterion.state === 'pass' ? 100 : criterion.state === 'partial' ? 50 : 0), 0) / criteria.length;
      signals.push(signal(input.episodeId, input.observedAt, 'ability', indicators[layer], value, Math.min(confidence, 0.75), 'scored', {
        evidenceSnippetIds: [...new Set(criteria.flatMap(criterion => criterion.snippetIds))],
        matchedCriteria: [...new Set(criteria.map(criterion => criterion.id))], rubricVersion: 'review-criteria-v2',
      }));
    }
  }
  signals.push(
    signal(input.episodeId, input.observedAt, 'learning_habit', 'reviewAnswerCount', userAnswers.length, 1, 'observed', { evidenceSnippetIds }),
    signal(input.episodeId, input.observedAt, 'learning_habit', 'reviewAnswerChars', answerChars, 1, 'observed', { evidenceSnippetIds }),
  );

  return { evidenceSnippets, profileSignals: signals };
}

export function extractFlowEvidence(input: {
  episodeId: string;
  observedAt: string;
  report: FlowAnalysisReport;
  profileInsight?: ProfileInsight;
  analysisV2?: FlowReviewAnalysisResultV2;
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  if (input.analysisV2) return extractFlowV2Evidence({ ...input, analysisV2: input.analysisV2 });
  const snippets: EvidenceSnippet[] = [];
  if (input.report.summary) {
    snippets.push({ type: 'observation', text: compact(input.report.summary), importance: 0.7, source: 'scored_analysis' });
  }
  for (const section of input.report.sections) {
    if (section.kind !== 'argumentQuality') continue;
    for (const item of section.items) {
      const vulnerabilities = (item as { vulnerabilities?: Array<{ type?: string; evidence?: string; severity?: number }> }).vulnerabilities || [];
      for (const vulnerability of vulnerabilities) {
        const text = compact(`${vulnerability.type || '推理问题'}：${vulnerability.evidence || '未提供原文依据'}`);
        snippets.push({ type: 'mistake', text, importance: Math.min(1, 0.55 + (vulnerability.severity || 1) * 0.08), source: 'scored_analysis' });
      }
    }
  }

  const evidenceSnippets = uniqueSnippets(snippets, input.episodeId);
  const evidenceSnippetIds = evidenceSnippets.flatMap((item) => item.id ? [item.id] : []);
  const trace = (criteria: string[]): Pick<ProfileSignal, 'evidenceSnippetIds' | 'matchedCriteria' | 'rubricVersion'> => ({
    evidenceSnippetIds,
    matchedCriteria: criteria,
    rubricVersion: 'flow-argument-quality-v1',
  });
  const signals: ProfileSignal[] = [];
  const layered = input.profileInsight?.layeredScores?.final;
  if (layered) {
    signals.push(
      signal(input.episodeId, input.observedAt, 'ability', 'conceptClarity', layered.concept, 0.8, 'scored', trace(['layeredScores.final.concept'])),
      signal(input.episodeId, input.observedAt, 'ability', 'judgmentReasonableness', layered.judgment, 0.8, 'scored', trace(['layeredScores.final.judgment'])),
      signal(input.episodeId, input.observedAt, 'ability', 'reasoningValidity', layered.logic, 0.8, 'scored', trace(['layeredScores.final.logic'])),
    );
  }
  if (typeof input.report.clarityScore === 'number') {
    signals.push(signal(
      input.episodeId,
      input.observedAt,
      'expression_style',
      'clarityScore',
      input.report.clarityScore,
      0.7,
      'scored',
      trace(['report.clarityScore']),
    ));
  }
  for (const [indicator, value] of Object.entries(input.profileInsight?.cognitiveStyle || {})) {
    if (typeof value === 'number') signals.push(signal(input.episodeId, input.observedAt, 'cognitive_style', indicator, value, 0.7, 'scored', trace([indicator])));
  }

  return { evidenceSnippets, profileSignals: signals };
}

/** V2 只把通过原话绑定和量规门槛的观察写入画像证据门。 */
function extractFlowV2Evidence(input: {
  episodeId: string; observedAt: string; report: FlowAnalysisReport;
  profileInsight?: ProfileInsight; analysisV2: FlowReviewAnalysisResultV2;
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  const record = input.analysisV2.record;
  const checked = verifiedShadowUserEvidence(record.input, record.graph, record.assessment);
  const snippets: EvidenceSnippet[] = [];
  for (const evidence of checked.evidence.values()) snippets.push({
    type: 'observation', text: compact(evidence.quote), importance: 0.72, source: 'user_statement',
  });
  for (const issue of record.assessment.issues) {
    if (issue.kind === 'extraction' || issue.kind === 'external_unverified') continue;
    snippets.push({
      type: issue.kind === 'confirmed_internal' || issue.kind === 'argument_gap' ? 'mistake' : 'observation',
      text: compact(issue.reason), importance: issue.severity === 'high' ? 1 : issue.severity === 'medium' ? .82 : .65,
      source: 'scored_analysis',
    });
  }
  const evidenceSnippets = uniqueSnippets(snippets, input.episodeId);
  const evidenceSnippetIds = evidenceSnippets.flatMap((item) => item.id ? [item.id] : []);
  const trace = (criteria: string[]): Pick<ProfileSignal, 'evidenceSnippetIds' | 'matchedCriteria' | 'rubricVersion'> => ({
    evidenceSnippetIds, matchedCriteria: criteria, rubricVersion: record.rubricVersion,
  });
  const signals: ProfileSignal[] = [];
  const abilityMap = { concept: 'conceptClarity', judgment: 'judgmentReasonableness', reasoning: 'reasoningValidity' } as const;
  const abilityScoring = record.assessment.localVerification ? scoreShadowAssessment(record.input, record.graph, record.assessment) : record.scoring;
  for (const layer of abilityScoring.layers) {
    if (!layer.eligibleForProfile || layer.score == null) continue;
    signals.push(signal(input.episodeId, input.observedAt, 'ability', abilityMap[layer.layer], layer.score, .82, 'scored',
      trace(record.assessment.criteria.filter((item) => item.id.startsWith(layer.layer === 'reasoning' ? 'reasoning_' : `${layer.layer}_`)).map((item) => item.id))));
  }
  const assessment = auditShadowCognitiveEvidence(record.input, record.graph, record.assessment).assessment;
  const usable = assessment.behaviors.filter((behavior) => behavior.state === 'observed'
    && behavior.evidenceIds.length > 0 && behavior.evidenceIds.every((id) => checked.evidence.has(id))
    && !record.input.task.promptedBehaviors.includes(behavior.code));
  for (const axis of SHADOW_COGNITIVE_AXES) {
    const behavior = usable.find((item) => item.code === axis.behavior);
    if (behavior?.direction == null) continue;
    signals.push(signal(input.episodeId, input.observedAt, 'cognitive_style', axis.key, behavior.direction * 50, .75, 'scored', trace([axis.behavior])));
  }
  const expressionCodes = usable.filter((behavior) => SHADOW_BEHAVIORS.some((definition) => definition.code === behavior.code
    && definition.dimension === 'expression')).map((behavior) => behavior.code);
  if (expressionCodes.length) {
    const raw = Object.fromEntries(SHADOW_EXPRESSION_STYLES.map((style) => [style,
      expressionCodes.reduce((sum, code) => sum + (SHADOW_EXPRESSION_WEIGHTS[code][style] || 0), 0)])) as Record<(typeof SHADOW_EXPRESSION_STYLES)[number], number>;
    const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
    if (total > 0) for (const style of SHADOW_EXPRESSION_STYLES) signals.push(signal(
      input.episodeId, input.observedAt, 'expression_style', style, Math.round(raw[style] / total * 1000) / 10,
      .72, 'scored', trace(expressionCodes),
    ));
  }
  return { evidenceSnippets, profileSignals: signals };
}

export function extractSceneEvidence(input: {
  episodeId: string;
  observedAt: string;
  spec: SceneSpec;
  run: SceneRunState;
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  const snippets: EvidenceSnippet[] = [];
  const completed = input.run.completionOutcome ? input.run.completionOutcome === 'completed' : input.run.status === 'success';
  const resultText = completed ? '完成' : input.run.completionOutcome === 'stopped' ? '由用户结束'
    : input.run.completionOutcome === 'limit-reached' ? '达到回合上限' : '未完成';
  snippets.push({
    type: completed ? 'success' : 'observation',
    text: compact(`场景${resultText}：${input.run.endReason || '未提供结束原因'}；共 ${input.run.turnCount} 回合`),
    importance: 0.85,
    source: 'behavior',
  });

  if (input.spec.meta.sceneSkill === 'S4') {
    const process = summarizeDerivationProcess(input.run);
    if (process.submitCount > 0 || process.editCount > 0) {
      snippets.push({
        type: process.correctedNodeCount > 0 ? 'correction' : process.failCount > 0 ? 'mistake' : 'observation',
        text: compact(
          `推导过程：提交 ${process.submitCount} 次，修改 ${process.editCount} 次，通过 ${process.passCount} 次，警告 ${process.warnCount} 次，失败 ${process.failCount} 次${process.correctedNodeCount > 0 ? `，修正后通过 ${process.correctedNodeCount} 个步骤` : ''}`,
        ),
        importance: process.correctedNodeCount > 0 || process.failCount > 0 ? 0.88 : 0.68,
        source: 'behavior',
      });
    }
    const formulaNodes = (input.run.canvas?.nodes || [])
      .filter((node) => node.type !== 'given' && node.data.latex?.trim())
      .slice(-2);
    for (const node of formulaNodes) {
      snippets.push({
        type: node.data.status === 'pass' || node.data.status === 'frozen' ? 'success' : 'observation',
        text: compact(node.data.latex || ''),
        importance: node.type === 'conclusion' ? 0.9 : 0.7,
        source: 'user_statement',
      });
    }
  } else {
    const userMessages = input.run.messages
      .filter((message) => message.speakerType === 'user' && message.content.trim())
      .slice(-2);
    for (const message of userMessages) {
      snippets.push({ type: 'observation', text: compact(message.content), importance: 0.65, source: 'user_statement' });
    }
  }

  const evidenceSnippets = uniqueSnippets(snippets, input.episodeId);
  const evidenceSnippetIds = evidenceSnippets.flatMap((item) => item.id ? [item.id] : []);
  const signals: ProfileSignal[] = [
    signal(input.episodeId, input.observedAt, 'learning_habit', 'sceneTurnCount', input.run.turnCount, 1, 'observed'),
  ];

  if (input.run.canvas) {
    signals.push(signal(
      input.episodeId,
      input.observedAt,
      'learning_habit',
      'sceneHelpCount',
      input.run.canvas.helpUsed,
      1,
      'observed',
    ));
  }

  if (input.spec.meta.sceneSkill === 'S4') {
    const process = summarizeDerivationProcess(input.run);
    signals.push(
      signal(input.episodeId, input.observedAt, 'learning_habit', 'derivationSubmitCount', process.submitCount, 1, 'observed'),
      signal(input.episodeId, input.observedAt, 'learning_habit', 'derivationFailureCount', process.failCount, 1, 'observed'),
      signal(input.episodeId, input.observedAt, 'learning_habit', 'derivationCorrectionCount', process.correctedNodeCount, 1, 'observed'),
    );
  }

  if (input.spec.meta.sceneSkill === 'S4' && typeof input.run.finalScore === 'number') {
    const score = Math.max(0, Math.min(100, input.run.finalScore * 100));
    const trace = {
      evidenceSnippetIds,
      matchedCriteria: ['finalScore', 'verifiedDerivation', 'independenceScore'],
      rubricVersion: 'scene-s4-v1',
    };
    signals.push(signal(input.episodeId, input.observedAt, 'ability', 'reasoningValidity', score, 0.75, 'scored', trace));
    for (const knowledgePoint of input.spec.meta.knowledgePoints) {
      signals.push(signal(input.episodeId, input.observedAt, 'knowledge_mastery', knowledgePoint, score, 0.75, 'scored', trace));
    }
  }

  return { evidenceSnippets, profileSignals: signals };
}

export function extractQaEvidence(input: {
  episodeId: string;
  observedAt: string;
  question: string;
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  return {
    evidenceSnippets: uniqueSnippets([
      { type: 'observation', text: compact(`用户提问：${input.question}`), importance: 0.7, source: 'user_statement' },
    ], input.episodeId),
    profileSignals: [signal(input.episodeId, input.observedAt, 'learning_habit', 'qaQuestionCount', 1, 1, 'observed')],
  };
}

export function summarizePlan(tree: PlanNode[]): {
  nodeCount: number;
  scheduledCount: number;
  titles: string[];
} {
  const nodes: PlanNode[] = [];
  const visit = (items: PlanNode[]) => {
    for (const item of items) {
      if (item.title.trim() || item.children.length > 0) nodes.push(item);
      visit(item.children);
    }
  };
  visit(tree);
  return {
    nodeCount: nodes.length,
    scheduledCount: nodes.filter((node) => Boolean(node.dueDate)).length,
    titles: nodes.map((node) => node.title.trim()).filter(Boolean),
  };
}

export function extractPlanEvidence(input: {
  episodeId: string;
  observedAt: string;
  tree: PlanNode[];
  action?: 'create' | 'update';
}): { evidenceSnippets: EvidenceSnippet[]; profileSignals: ProfileSignal[] } {
  const summary = summarizePlan(input.tree);
  const titlePreview = summary.titles.slice(0, 5).join('、');
  return {
    evidenceSnippets: uniqueSnippets([{
      type: 'observation',
      text: compact(`${input.action === 'update' ? '调整' : '创建'}学习计划：${summary.nodeCount} 个节点，${summary.scheduledCount} 个有日期${titlePreview ? `；包括 ${titlePreview}` : ''}`),
      importance: 0.7,
      source: 'behavior',
    }], input.episodeId),
    profileSignals: [
      signal(input.episodeId, input.observedAt, 'learning_habit', 'planNodeCount', summary.nodeCount, 1, 'observed'),
      signal(input.episodeId, input.observedAt, 'learning_habit', 'scheduledPlanNodeCount', summary.scheduledCount, 1, 'observed'),
    ],
  };
}
