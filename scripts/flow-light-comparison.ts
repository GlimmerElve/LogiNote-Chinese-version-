/** Synthetic, read-only prompt comparison. No provider/configuration/storage access. */
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import { buildFlowReviewTask } from '../src/services/flowAnalysis/reviewTask';
import { normalizeShadowInput, parseShadowAssessment, parseShadowExtraction, shadowFingerprint } from '../src/services/flowShadow/protocol';
import { prepareShadowAssessment, prepareShadowExtraction, type ShadowRequest } from '../src/services/flowShadow/runner';
import { SHADOW_ASSESSMENT_PROMPT_ID_V3, SHADOW_EXTRACTION_PROMPT_ID_V3,
  FLOW_SHADOW_ASSESSMENT_PROMPT_V3, FLOW_SHADOW_EXTRACTION_PROMPT_V3 } from '../src/services/flowShadow/promptsV3';
import { scoreShadowAssessment } from '../src/services/flowShadow/scoring';
import { scoreShadowReferenceAssessment } from '../src/services/flowShadow/referenceScoring';
import type { ShadowGraph } from '../src/services/flowShadow/types';
import { requiresCognitiveEvidenceAudit } from '../src/services/flowShadow/cognitiveEvidence';
import { FLOW_REVIEW_MODEL_BUDGETS } from '../src/services/flowAnalysis/modelBudgets';

export const FLOW_LIGHT_PARAMETERS = Object.freeze({ temperature: 0.1, ...FLOW_REVIEW_MODEL_BUDGETS,
  response_format: { type: 'json_object' }, thinking: { type: 'disabled' } });
export interface FlowLightVote { id: string; variant: 'baseline' | 'candidate'; request: ShadowRequest; maxTokens: number }

export function createFlowLightComparison() {
  const sample = createFlowResultPreview();
  const input = normalizeShadowInput({ ...sample.input, attemptId: 'synthetic-flow-light-prompt-comparison-v1',
    task: buildFlowReviewTask({ speakingContent: sample.input.rawText, noteTitle: '合成心理账户复盘', allNotes: [] }) });
  const graph = structuredClone(sample.record.graph), references = structuredClone(sample.record.references);
  const extract = prepareShadowExtraction(input), assess = prepareShadowAssessment(input, graph, references);
  const votes: FlowLightVote[] = [
    { id: 'baseline-extract', variant: 'baseline', request: { ...extract, promptId: SHADOW_EXTRACTION_PROMPT_ID_V3, systemPrompt: FLOW_SHADOW_EXTRACTION_PROMPT_V3 }, maxTokens: FLOW_LIGHT_PARAMETERS.extractionMaxTokens },
    { id: 'candidate-extract', variant: 'candidate', request: extract, maxTokens: FLOW_LIGHT_PARAMETERS.extractionMaxTokens },
    { id: 'baseline-assess', variant: 'baseline', request: { ...assess, promptId: SHADOW_ASSESSMENT_PROMPT_ID_V3, systemPrompt: FLOW_SHADOW_ASSESSMENT_PROMPT_V3 }, maxTokens: FLOW_LIGHT_PARAMETERS.assessmentMaxTokens },
    { id: 'candidate-assess', variant: 'candidate', request: assess, maxTokens: FLOW_LIGHT_PARAMETERS.assessmentMaxTokens },
  ];
  return { input, graph, references, votes, manifest: {
    version: 'flow-light-prompt-comparison-v1', dataKind: 'synthetic', sampleCharacters: [...input.rawText].length,
    inputKey: shadowFingerprint(input), graphKey: shadowFingerprint(graph), referenceKey: shadowFingerprint(references),
    maxRequests: 4, automaticRetries: 0, parameters: FLOW_LIGHT_PARAMETERS, productionWrites: false,
    design: 'Initial extraction compared on identical input; assessment compared on one frozen graph/reference packet, not on either extraction reply.',
    limitations: ['One sample and one vote per prompt do not measure stability or certify semantic accuracy.',
      'Original/default task differences are deliberately frozen out; only prompt text changes.',
      'Clarity is candidate-only and is not included in the shared-score comparison.',
      'Graph size, coverage and connectivity are diagnostics, never user ability scores.'],
  } };
}

export type FlowLightPlan = ReturnType<typeof createFlowLightComparison>;
export function summarizeFlowLightVote(plan: FlowLightPlan, vote: FlowLightVote, content: string) {
  if (vote.request.stage === 'extract') {
    const parsed = parseShadowExtraction(content, plan.input), graph: ShadowGraph = parsed.graph;
    const connected = new Set<string>();
    const edges = graph.arguments.flatMap(a => [...a.support.map(from => ({ from, to: a.claim, kind: 'support' })),
      ...a.oppose.map(from => ({ from, to: a.claim, kind: 'oppose' }))])
      .concat(graph.relations.map(r => ({ from: r.from, to: r.to, kind: r.kind })));
    for (const edge of edges) { connected.add(edge.from); connected.add(edge.to); }
    const covered = new Set<number>();
    for (const node of graph.nodes) if (node.rawQuote) {
      for (let pos = plan.input.rawText.indexOf(node.rawQuote); pos >= 0; pos = plan.input.rawText.indexOf(node.rawQuote, pos + 1)) {
        for (let index = pos; index < pos + node.rawQuote.length; index++) covered.add(index);
      }
    }
    return { id: vote.id, stage: vote.request.stage, status: 'parsed', nodes: graph.nodes.length, arguments: graph.arguments.length,
      edges: edges.length, quoteCoverage: covered.size / plan.input.rawText.length,
      isolatedNodes: graph.nodes.filter(n => !connected.has(n.id)).map(n => ({ id: n.id, role: n.role, text: n.text })),
      graph, warnings: parsed.warnings };
  }
  const parsed = parseShadowAssessment(content, plan.input, plan.graph, plan.references,
    { requireCognitiveAudit: requiresCognitiveEvidenceAudit(vote.request.promptId),
      ...(vote.variant === 'candidate' ? { behaviorTransport: vote.request.behaviorTransport, arithmeticVerification: Boolean(vote.request.arithmeticVerification) } : {}) });
  const scoring = scoreShadowAssessment(plan.input, plan.graph, parsed.assessment);
  const referenceScoring = scoreShadowReferenceAssessment(plan.input, plan.graph, plan.references, parsed.assessment);
  return { id: vote.id, stage: vote.request.stage, status: 'parsed', assessment: parsed.assessment,
    scoring, referenceScoring, warnings: [...parsed.warnings, ...scoring.warnings, ...referenceScoring.warnings] };
}
