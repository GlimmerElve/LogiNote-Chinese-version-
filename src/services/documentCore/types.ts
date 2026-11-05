import type { DocumentArgumentGraph } from '../documentArgumentV5Types';
import type { DOCUMENT_CORE_ARGUMENT_VERSION } from '../../workflows/documentCoreArgumentPrompt';
import type { DOCUMENT_CORE_DERIVATION_VERSION } from '../../workflows/documentCoreDerivationPrompt';
import type { DOCUMENT_CORE_QUOTE_VERSION } from '../../workflows/documentCoreQuotePrompt';
import type { DOCUMENT_CORE_ALIGNED_QUOTE_VERSION } from '../../workflows/documentCoreQuotePrompt';
import type { DOCUMENT_CORE_FUNCTIONAL_QUOTE_VERSION } from '../../workflows/documentCoreQuotePrompt';
import type { DOCUMENT_CORE_CONTRACT_QUOTE_VERSION } from '../../workflows/documentCoreQuotePrompt';
export type CoreRequestVersion = typeof DOCUMENT_CORE_ARGUMENT_VERSION | typeof DOCUMENT_CORE_DERIVATION_VERSION | typeof DOCUMENT_CORE_QUOTE_VERSION | typeof DOCUMENT_CORE_ALIGNED_QUOTE_VERSION | typeof DOCUMENT_CORE_FUNCTIONAL_QUOTE_VERSION | typeof DOCUMENT_CORE_CONTRACT_QUOTE_VERSION;

export const CORE_ARGUMENT_LIMITS = Object.freeze({ inputCharacters: 16000, packetCharacters: 22000,
  maxTokens: 6144, nodes: 60, arguments: 30, relations: 100, coreClaims: 12 });
export interface CorePassage { id: string; section: string; text: string }
export interface CoreArgumentInput {
  docId: string; sourceVersion: string;
  scope: { kind: 'document' | 'chapter' | 'excerpt'; label: string };
  passages: CorePassage[];
  /** Disclosure only; omitted passages are never silently read or model-filled. */
  omittedPassageIds?: string[];
}
export interface CoreArgumentRequest {
  version: CoreRequestVersion;
  systemPrompt: string; userInput: string;
  parameters: { temperature: 0; maxTokens: number; thinkingMode: 'disabled' };
}
export interface CoreArgumentReply {
  content: string; finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; reasoningTokens?: number };
}
export interface CoreArgumentModel { call(request: Readonly<CoreArgumentRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export interface CoreArgumentIssue { id: string; code: string; reason: string }
/** Chain membership is model-declared organisation, never a graph edge. */
export const CORE_CHAIN_MEMBER_KEYS = ['evidence', 'intermediates', 'counterpoints', 'conditions', 'limitations', 'methods', 'context'] as const;
export type CoreChainMemberKey = typeof CORE_CHAIN_MEMBER_KEYS[number];
export type CoreChainMembers = Record<CoreChainMemberKey, string[]>;
export function emptyCoreChainMembers(): CoreChainMembers {
  return { evidence: [], intermediates: [], counterpoints: [], conditions: [], limitations: [], methods: [], context: [] };
}
export interface CoreChainPackage {
  claimId: string; nodeIds: string[]; argumentIds: string[]; relationIds: string[];
  members: CoreChainMembers;
  /** Legacy replay never claims these fields were produced by the earlier model. */
  membershipSource: 'model' | 'derivation' | 'partial' | 'missing' | 'legacy';
  modelStatus: 'argued' | 'stated_only' | 'incomplete';
  state: 'candidate' | 'source_review_required'; reason: string; gaps: string[];
}
export interface CoreArgumentResult {
  graph: DocumentArgumentGraph; chains: CoreChainPackage[]; issues: CoreArgumentIssue[];
  quarantined: Array<{ layer: string; id: string; value: unknown }>;
}
export interface CoreArgumentRun {
  mode: 'shadow'; version: CoreRequestVersion;
  status: 'extracted' | 'review_required' | 'held';
  input: CoreArgumentInput; request: CoreArgumentRequest; result?: CoreArgumentResult;
  rawResponse?: string; error?: string;
  receipt: { requests: number; durationMs: number; finishReason?: string; usage?: CoreArgumentReply['usage'] };
  boundary: { sourceBasis: 'experiment-passages-v1'; coverageGoal: 'selected-core'; semanticCertified: false;
    bridgeRequests: 0; automaticRetries: 0; productionWrites: false };
}
