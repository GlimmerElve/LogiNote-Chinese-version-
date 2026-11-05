import type { LlmCallRequest, LlmCallResponse } from '../../src/types';
import type { InquirySource } from '../../src/services/cognition/inquiry';

/** Protocol fixture only; no claim of model semantic quality. */
export function inquiryReviewer(request: LlmCallRequest): LlmCallResponse {
  const body = JSON.parse(request.userInput);
  const sources: InquirySource[] = body.pages.flatMap((p: { sources: InquirySource[] }) => p.sources);
  return { content: '', parsedJson: { action: 'answer', paragraphs: sources.slice(0, 8).map((source) => ({
    text: `记录中的${source.current === false ? '历史' : '当前'}表述是：${source.text}`.slice(0, 650),
    evidence: [{ id: source.id, quote: source.text.slice(0, 80) }],
  })) } };
}
