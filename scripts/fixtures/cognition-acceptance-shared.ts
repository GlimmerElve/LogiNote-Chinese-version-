import type { ArgDoc } from '../../src/services/argumentDoc/types';
import type { ReviewEpisodeCapture } from '../../src/services/memory/types';
import type { LlmCallRequest, LlmCallResponse } from '../../src/types';
import { ALIGNMENT_AXES, type CognitionAlignment } from '../../src/services/cognition/alignment';

export const INITIAL_CLAIM = '机器甲在负载 B 下会发热。';
export const ADDED_CLAIM = '机器甲在负载 B 下也会产生振动。';
export const REVISED_CLAIM = '机器甲在负载 B 下会发热，持续时间取决于运行时长。';
export function reviewEpisode(text = INITIAL_CLAIM): ReviewEpisodeCapture {
  const at = '2026-10-04T00:00:00.000Z';
  return { id: 'acceptance-review', startedAt: at, endedAt: at, questionText: '机器甲在负载 B 下会怎样？',
    knowledgeContext: '资料和 AI 的表述不自动成为用户认知。',
    messages: [{ id: 'teacher', role: 'assistant', content: '请用自己的话表述。', timestamp: at },
      { id: 'answer', role: 'user', content: text, timestamp: at },
      { id: 'feedback', role: 'assistant', content: 'AI 的诊断不是用户主张。', timestamp: at }],
    answerEvidence: [{ messageId: 'answer', answer: text, hintLevel: 0, consultedMaterialIds: [], targetKnowledgeNames: ['机器甲'] }] };
}
export function argumentFixture(): ArgDoc {
  return { doc_id: 'acceptance-editor', title: '合成论证编辑器入口', created_at: '2026-10-04T00:00:00.000Z',
    updated_at: '2026-10-04T00:00:00.000Z', iteration: 1, status: 'draft', edges: [],
    nodes: [{ id: 'n1', mainType: '事实陈述', text: INITIAL_CLAIM, position: { x: 0, y: 0 }, status: 'ok',
      issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false }] };
}
/** Explicit semantic test double. Retrieval, Agent orchestration and disk stores are real. */
export async function scriptedReviewer(request: LlmCallRequest): Promise<LlmCallResponse> {
  if (request.systemPromptOverride?.includes('You are a citation evidence reviewer')) {
    return { content: '', parsedJson: { coverage: 'sufficient', supportedCitationIds: ['D1'], risks: [], answerGuidance: [] } };
  }
  if (request.systemPromptOverride?.includes('选取最值得核对的一条')) {
    const data = JSON.parse(request.userInput);
    const personalIndex = data.personalCognition.items.findIndex((h: { text: string }) => h.text.includes('发热'));
    const p = data.personalCognition.items[personalIndex].text;
    const source = data.sources.find((s: { snippet: string }) => s.snippet.includes('振动'));
    const axes = Object.fromEntries(ALIGNMENT_AXES.map((axis) => [axis, {
      status: axis === 'time' || axis === 'baseline' ? 'not_applicable' : axis === 'metric' ? 'different' : 'same',
      personalQuote: axis === 'object' ? '机器甲' : axis === 'condition' ? '负载 B' : p,
      documentQuote: axis === 'object' ? '机器甲' : axis === 'condition' ? '负载 B' : source.snippet,
      reason: '固定合成场景的审核替身，不代表真实模型推理结果。',
    }])) as CognitionAlignment['axes'];
    return { content: JSON.stringify({ personalIndex, sourceId: source.sourceId, relation: 'supplement', personalQuote: p,
      documentQuote: source.snippet, sourcesCompatible: true, axes }) };
  }
  return { content: '资料记录了机器甲的振动。[D1]' };
}
