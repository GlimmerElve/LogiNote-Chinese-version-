import type { ShadowRequest } from '../src/services/flowShadow/runner';
import { FLOW_LIGHT_PARAMETERS } from './flow-light-comparison';
import { flowReviewMaxTokens } from '../src/services/flowAnalysis/modelBudgets';

/** Experiment transport only; production thinking settings are unchanged. */
export function buildFlowAcceptanceWireBody(request: ShadowRequest, model: string, omitThinking = false) {
  return {
    model, temperature: FLOW_LIGHT_PARAMETERS.temperature,
    max_tokens: flowReviewMaxTokens(request.stage),
    response_format: FLOW_LIGHT_PARAMETERS.response_format,
    ...(omitThinking ? {} : { thinking: FLOW_LIGHT_PARAMETERS.thinking }),
    messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userInput }],
  };
}
