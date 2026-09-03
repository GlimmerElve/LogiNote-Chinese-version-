import { UserProfile } from '../../types';
import { getUserProfile } from './profileStore';

/**
 * 画像上下文注入（新权威，v2）：把画像序列化为注入 LLM 的紧凑文本前缀。
 * 读取改走新 profileStore（A1 内存缓存，同步）。
 * 由 llmService / llmStreamService 调用（P4 接入后）。
 */

/** 需要画像上下文注入的学习场景工作流（与 RAG 增强的白名单保持一致） */
const PROFILE_WORKFLOWS = new Set<string>([
  'review-questioning',
  'review-tutor',
  'review-scoring',
  'flow-analysis',
  'question-answer',
]);

/** 画像可信门槛：证据样本数 >= 2 且累计字符 >= 300 才在上下文中给出具体分数 */
export function isProfileTrusted(profile: UserProfile): boolean {
  const a = profile.ability;
  return a.evidenceCount >= 2 && a.evidenceChars >= 300;
}

/** 把画像序列化为适合注入 LLM 的紧凑文本（约 300-500 字） */
export function buildProfileContext(profile: UserProfile): string {
  const a = profile.ability;
  const c = profile.cognitiveStyle;
  const e = profile.expressionStyle;
  const trusted = isProfileTrusted(profile);

  if (profile.analysisCount === 0) return '';

  const parts: string[] = [];
  if (trusted) {
    parts.push(
      `概念清晰度 ${a.conceptClarity.toFixed(0)}，判断合理性 ${a.judgmentReasonableness.toFixed(0)}，推理有效性 ${a.reasoningValidity.toFixed(0)}`
    );
  } else {
    parts.push('能力画像数据积累中');
  }
  parts.push(
    `认知风格：抽象偏向 ${c.abstractVsConcrete.toFixed(0)}，系统偏向 ${c.systematicVsScattered.toFixed(0)}，发散偏向 ${c.divergentVsConvergent.toFixed(0)}，谨慎偏向 ${c.cautiousVsDogmatic.toFixed(0)}，深度偏向 ${c.deepVsSurface.toFixed(0)}`
  );
  parts.push(
    `表达：偏好举例 ${e.prefersExample.toFixed(2)}，偏好类比 ${e.prefersAnalogy.toFixed(2)}，偏好定义 ${e.prefersDefinition.toFixed(2)}，偏好推导 ${e.prefersDerivation.toFixed(2)}，先结论 ${e.conclusionFirst.toFixed(2)}`
  );
  parts.push(`术语准确度 ${e.terminologyAccuracy.toFixed(0)}，自我修正 ${e.selfCorrection.toFixed(0)}`);

  const header = `以下是学习者的长期画像（来自历史复盘的累积分析），请在回答时结合学习者的认知与表达特点：`;
  const body = parts.join('；');
  return `${header}\n${body}`;
}

/**
 * 返回画像上下文的「纯前缀」文本（不含用户输入与包裹标记）。
 * 非学习工作流或画像为空时返回空字符串。
 */
export function buildProfilePrefix(workflowId: string): string {
  if (!PROFILE_WORKFLOWS.has(workflowId)) return '';
  const profile = getUserProfile();
  if (profile.analysisCount === 0) return '';
  return buildProfileContext(profile);
}