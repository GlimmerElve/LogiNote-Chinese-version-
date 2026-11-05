import { COGNITIVE_EVIDENCE_CONTRACT, FLOW_SHADOW_PROTOCOL, FLOW_SHADOW_RUBRIC, SHADOW_WRITES, FLAT_BEHAVIOR_TRANSPORT, LITERAL_ARITHMETIC_CONTRACT, type ShadowGraph, type ShadowInput, type ShadowRecord, type ShadowCallReceipt, type ShadowReferencePacket } from './types.ts';
import { normalizeShadowInput, parseShadowAssessment, parseShadowExtraction, shadowFingerprint, type ShadowAssessmentParseOptions } from './protocol.ts';
import { FLOW_SHADOW_EXTRACTION_PROMPT, FLOW_SHADOW_ASSESSMENT_PROMPT, SHADOW_EXTRACTION_PROMPT_ID, SHADOW_ASSESSMENT_PROMPT_ID } from './prompts.ts';
import { scoreShadowAssessment } from './scoring.ts';
import { scoreShadowReferenceAssessment } from './referenceScoring.ts';
import { buildShadowReferencePacket, buildShadowReferenceTargets, emptyShadowReferencePacket, type ShadowReferenceProvider } from './references.ts';
import { requiresCognitiveEvidenceAudit } from './cognitiveEvidence';
import { requiresAssessmentCoverageReview } from './assessmentCoverage';
import { projectShadowReferencePacket, SHARED_REFERENCE_TRANSPORT, type SharedReferenceTransport } from './referenceTransport';
import type { FlatBehaviorTransport } from './behaviorTransport';
import { checkLiteralArithmetic } from './literalArithmetic';

export interface ShadowRequest { stage: 'extract' | 'assess'; promptId: string; systemPrompt: string; userInput: string;
  referenceTransport?: SharedReferenceTransport; behaviorTransport?: FlatBehaviorTransport;
  arithmeticVerification?: typeof LITERAL_ARITHMETIC_CONTRACT }
export interface ShadowModelReply { content: string; usage?: { promptTokens?: number; completionTokens?: number } }
/** No built-in provider, store, IPC, fetch, or production callback. Explicitly injected by an experiment runner. */
export interface ShadowModel { call(request: Readonly<ShadowRequest>, signal?: AbortSignal): Promise<ShadowModelReply> }
export interface ShadowRunOutcome {
  status: 'reviewed' | 'held'; record?: ShadowRecord; graph?: ShadowGraph; error?: string;
  rawResponses: { extract?: string; assess?: string }; receipts: ShadowCallReceipt[];
  mode: 'shadow'; writes: typeof SHADOW_WRITES;
}
export function prepareShadowExtraction(source: ShadowInput): ShadowRequest {
  const input = normalizeShadowInput(source);
  return { stage: 'extract', promptId: SHADOW_EXTRACTION_PROMPT_ID, systemPrompt: FLOW_SHADOW_EXTRACTION_PROMPT,
    userInput: JSON.stringify({ protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), rawText: input.rawText, task: input.task,
      assistance: input.assistance }, null, 2) };
}
export function prepareShadowAssessment(source: ShadowInput, graph: ShadowGraph, references: ShadowReferencePacket = emptyShadowReferencePacket(source, graph),
  options: { referenceTransport?: SharedReferenceTransport } = {}): ShadowRequest {
  const input = normalizeShadowInput(source);
  // Original language is sent once; omit repeated rawQuote from each candidate node.
  // The key still pins the FULL graph, not this transport-only projection.
  const compactGraph = { ...graph, nodes: graph.nodes.map(({ id, role, text }) => ({ id, role, text })) };
  const userInput = JSON.stringify({ protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), graphKey: shadowFingerprint(graph), referenceKey: shadowFingerprint(references),
    rawText: input.rawText, task: input.task, assistance: input.assistance, graph: compactGraph,
    behaviorTransport: FLAT_BEHAVIOR_TRANSPORT,
    localArithmeticChecks: { contract: LITERAL_ARITHMETIC_CONTRACT, items: checkLiteralArithmetic(input.rawText),
      boundary: '仅核验匹配到的字面算式，不代表全文核验；用户是否认可、引用、假设或撤回须结合原话判定。' },
    referencePacket: options.referenceTransport ? projectShadowReferencePacket(references).packet : references,
    ...(requiresCognitiveEvidenceAudit(SHADOW_ASSESSMENT_PROMPT_ID)
      ? { behaviorContract: COGNITIVE_EVIDENCE_CONTRACT } : {}),
    boundary: 'graph为模型候选，不是用户的正确答案；图漏边须回读rawText，不能直接扣用户分。' }, null, 2);
  if (userInput.length > 30000) throw new Error('影子评估包超过30000字符，未发送、未截断；需要独立设计分批评价。');
  return { stage: 'assess', promptId: SHADOW_ASSESSMENT_PROMPT_ID, systemPrompt: FLOW_SHADOW_ASSESSMENT_PROMPT, userInput,
    behaviorTransport: FLAT_BEHAVIOR_TRANSPORT, arithmeticVerification: LITERAL_ARITHMETIC_CONTRACT,
    ...(options.referenceTransport ? { referenceTransport: options.referenceTransport } : {}) };
}
export function replayShadowResponses(source: ShadowInput, extractRaw: unknown, assessRaw: unknown, references?: ShadowReferencePacket,
  options: ShadowAssessmentParseOptions = {}): ShadowRecord {
  const input = normalizeShadowInput(source);
  const extracted = parseShadowExtraction(extractRaw, input);
  const packet = references || emptyShadowReferencePacket(input, extracted.graph);
  const assessed = parseShadowAssessment(assessRaw, input, extracted.graph, packet, options);
  const scoring = scoreShadowAssessment(input, extracted.graph, assessed.assessment);
  const referenceScoring = scoreShadowReferenceAssessment(input, extracted.graph, packet, assessed.assessment);
  return { protocol: FLOW_SHADOW_PROTOCOL, rubricVersion: FLOW_SHADOW_RUBRIC, mode: 'shadow', writes: { ...SHADOW_WRITES },
    input, graph: extracted.graph, references: packet, assessment: assessed.assessment, scoring, referenceScoring,
    warnings: [...extracted.warnings, ...assessed.warnings, ...scoring.warnings, ...referenceScoring.warnings], receipts: [], semanticCertification: 'not_certified',
    ...(options.referenceTransport ? { referenceTransport: options.referenceTransport } : {}),
    ...(options.behaviorTransport ? { behaviorTransport: options.behaviorTransport } : {}) };
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** At most two calls, sequential, never automatic retries. Raw replies survive a held result. */
export async function runFlowShadow(source: ShadowInput, model: ShadowModel,
  options: { signal?: AbortSignal; onProgress?: (stage: 'extract' | 'retrieve' | 'assess') => void;
    referenceProvider?: ShadowReferenceProvider } = {}): Promise<ShadowRunOutcome> {
  const rawResponses: ShadowRunOutcome['rawResponses'] = {}, receipts: ShadowCallReceipt[] = [];
  let graph: ShadowGraph | undefined;
  const base = { mode: 'shadow' as const, writes: { ...SHADOW_WRITES }, rawResponses, receipts };
  const check = () => { if (options.signal?.aborted) throw new Error('影子测试已取消；不自动重发。'); };
  const call = async (request: ShadowRequest): Promise<string> => {
    check(); options.onProgress?.(request.stage);
    const receipt: ShadowCallReceipt = { stage: request.stage, promptId: request.promptId,
      promptTokens: null, completionTokens: null, status: 'failed' };
    receipts.push(receipt);
    const reply = await model.call(Object.freeze({ ...request }), options.signal);
    if (!reply || typeof reply.content !== 'string') throw new Error('影子模型未返回文本');
    rawResponses[request.stage] = reply.content;
    receipt.status = 'completed'; receipt.promptTokens = count(reply.usage?.promptTokens); receipt.completionTokens = count(reply.usage?.completionTokens);
    check(); return reply.content;
  };
  try {
    const input = normalizeShadowInput(source);
    const extractRaw = await call(prepareShadowExtraction(input));
    const extracted = parseShadowExtraction(extractRaw, input);
    graph = extracted.graph;
    options.onProgress?.('retrieve'); check();
    const targets = buildShadowReferenceTargets(extracted.graph);
    const candidates = options.referenceProvider ? await options.referenceProvider.retrieve(input, extracted.graph, targets, options.signal) : [];
    check();
    const references = buildShadowReferencePacket(input, extracted.graph, candidates);
    const assessRequest = prepareShadowAssessment(input, extracted.graph, references, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
    const assessRaw = await call(assessRequest);
    const record = replayShadowResponses(input, extractRaw, assessRaw, references,
      { requireCognitiveAudit: requiresCognitiveEvidenceAudit(SHADOW_ASSESSMENT_PROMPT_ID), referenceTransport: assessRequest.referenceTransport,
        behaviorTransport: assessRequest.behaviorTransport, arithmeticVerification: assessRequest.arithmeticVerification === LITERAL_ARITHMETIC_CONTRACT,
        reviewBehaviorCoverage: requiresAssessmentCoverageReview(SHADOW_ASSESSMENT_PROMPT_ID) });
    record.receipts = structuredClone(receipts);
    return { ...base, status: 'reviewed', graph, record };
  } catch (error) {
    return { ...base, status: 'held', ...(graph ? { graph } : {}), error: error instanceof Error ? error.message : '影子测试未完成' };
  }
}
