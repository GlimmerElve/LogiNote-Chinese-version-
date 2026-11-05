import { DOCUMENT_CORE_CHAIN_FIRST_PROMPT, DOCUMENT_CORE_CHAIN_FIRST_VERSION } from '../../workflows/documentCoreChainFirstPrompt';
import { parseCoreDirectQuotes, type CoreDirectQuoteResult } from './directQuote';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply, type CoreArgumentRequest, type CoreArgumentRun } from './types';

export interface CoreChainFirstRequest extends Omit<CoreArgumentRequest, 'version'> {
  version: typeof DOCUMENT_CORE_CHAIN_FIRST_VERSION;
}
export interface CoreChainFirstModel {
  call(request: Readonly<CoreChainFirstRequest>, signal?: AbortSignal): Promise<CoreArgumentReply>;
}
export type CoreChainFirstRun = Omit<CoreArgumentRun, 'version' | 'request' | 'result'> & {
  version: typeof DOCUMENT_CORE_CHAIN_FIRST_VERSION; request: CoreChainFirstRequest; result?: CoreDirectQuoteResult;
};

// The frozen transport treats the version as an opaque label and never switches on it.
// Widen ONLY that literal type at this opt-in boundary; do not relabel the actual request,
// extend shared frozen version types, duplicate transport logic, or change parser/budgets.
// Tests assert the new label survives both model input and receipts without translation.
const runVersionedExperiment = runPreparedCoreExtraction as unknown as (
  source: CoreArgumentInput, request: CoreChainFirstRequest, model: CoreChainFirstModel,
  parse: typeof parseCoreDirectQuotes, signal?: AbortSignal,
) => Promise<CoreChainFirstRun>;

/** No production switch. Same source packet, budgets, parser and one-request transport. */
export function prepareCoreChainFirstRequest(input: CoreArgumentInput): CoreChainFirstRequest {
  return { version: DOCUMENT_CORE_CHAIN_FIRST_VERSION, systemPrompt: DOCUMENT_CORE_CHAIN_FIRST_PROMPT,
    userInput: prepareCoreInputPacket(input),
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
export async function runCoreChainFirstExtraction(source: CoreArgumentInput, model: CoreChainFirstModel,
  signal?: AbortSignal): Promise<CoreChainFirstRun> {
  const input = structuredClone(source);
  return runVersionedExperiment(input, prepareCoreChainFirstRequest(input), model, parseCoreDirectQuotes, signal);
}
