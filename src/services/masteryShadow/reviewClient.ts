import { callLLM } from '../llmService';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { evaluateReviewMastery, type ReviewMasteryBatch } from './review';
import type { LlmCallRequest, LlmCallResponse } from '../../types';
import type { ReviewEpisodeCapture } from '../memory/types';
import { evaluateReviewFeedback } from './reviewFeedback';

export function evaluateReviewFeedbackWithModel(episode: ReviewEpisodeCapture,
  call: (request: LlmCallRequest) => Promise<LlmCallResponse> = callLLM) {
  return evaluateReviewFeedback(episode, async request => (await call({ providerId: '', model: '',
    workflow: 'knowledge-mastery-scoring', userInput: request.userInput, systemPromptOverride: request.systemPrompt,
    outputSchema: JSON_OBJECT_OUTPUT, temperatureOverride: 0, maxTokensOverride: 2000,
    skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' })).content);
}

/** One compact semantic evaluation per knowledge point/assistance group, never the document graph pipeline. */
export function evaluateReviewMasteryWithModel(batch: ReviewMasteryBatch,
  call: (request: LlmCallRequest) => Promise<LlmCallResponse> = callLLM): Promise<ReviewMasteryBatch> {
  return evaluateReviewMastery(batch, async request => {
    const response = await call({ providerId: '', model: '', workflow: 'knowledge-mastery-scoring',
      userInput: request.userInput, systemPromptOverride: request.systemPrompt
        + '\n题目列表与回答段落按原顺序配对；引用必须来自同一轮用户回答，不拼接跨轮原话，不把导师提问算成用户证据。仅评价本知识点所问的层次。',
      outputSchema: JSON_OBJECT_OUTPUT, temperatureOverride: 0, maxTokensOverride: 7000,
      skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' });
    return response.content;
  });
}
