import type { ArgDoc, StructureReviewMode } from './types';
import { callLLM } from '../llmService';
import { ARGUMENT_STRUCTURE_REVIEW_PROMPT } from '../../workflows/argumentStructureReviewPrompt';
import { applyScopedStructureReview, buildScopedStructureReviewInput, planStructureReview } from './structureReview';

/**
 * 只重新评价用户当前编辑后的论证结构。
 *
 * 这里刻意不运行 flow-analysis 总结器，也不重新计算口语复盘三层分数；
 * 返回值仅用于刷新画布节点的问题、严重度与改进建议。
 */
export async function reassessArgumentStructure(doc: ArgDoc, caller = callLLM, mode: StructureReviewMode = 'changes'): Promise<ArgDoc> {
  const snapshot = structuredClone(doc);
  const plan = planStructureReview(snapshot, mode);
  const count = plan.targets.nodes.length + plan.targets.edges.length;
  if (!count) return snapshot; // No edits or unresolved issues: no provider request.
  const response = await caller({
    providerId: '', model: '', workflow: 'argument-quality-review',
    systemPromptOverride: ARGUMENT_STRUCTURE_REVIEW_PROMPT,
    userInput: JSON.stringify(buildScopedStructureReviewInput(snapshot, plan)),
    skipMemoryInjection: true, skipProfileInjection: true,
    thinkingMode: 'disabled',
    temperatureOverride: 0, maxTokensOverride: Math.min(16384, Math.max(2048, count * 200)),
  });
  if (response.diagnostics?.finishReason === 'length') throw new Error('结构重评输出不完整');
  const raw = response.parsedJson ?? JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
  return applyScopedStructureReview(snapshot, raw, plan);
}
