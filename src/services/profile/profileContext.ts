import { UserProfile, ExpressionStyleKind } from '../../types';
import { getExpressionStyleDisplay } from './profileStore';
import { EXPRESSION_KINDS, EXPRESSION_STYLE_LABELS } from './styleScoring';
export { isProfileIndicatorTrusted, isProfileTrusted } from './profileTrust';
import { isProfileIndicatorTrusted } from './profileTrust';

/**
 * 画像上下文注入（新权威，v2）：把画像序列化为注入 LLM 的紧凑文本前缀。
 * 读取改走新 profileStore（A1 内存缓存，同步）。
 * 由 memoryContextBuilder 按工作流配方调用。
 */

/** 表达风格显示值达到该阈值才在上下文中呈现（避免弱信号噪音） */
const STYLE_DISPLAY_THRESHOLD = 20;

/**
 * 画像数值的口径说明：数值本身不自带基准，不说明 LLM 无法判断绝对高低
 * （例如「概念清晰度 47」会被按百分制直觉误读为偏弱，实际是接近均值的正常水平）。
 * 独立成行放在 header 之后：场景路径会剥离 header 行，此说明仍能保留给 NPC 读取。
 */
const SCALE_NOTE =
  '数值基准：能力三项 0-100（50 为均值）；认知风格 -100~+100（0 为居中，正值偏向字段名那一极，负值偏向相反一极）；表达风格为 0-100 的占比，只看相对高低';

/** 把画像序列化为适合注入 LLM 的紧凑文本（约 300-560 字） */
export function buildProfileContext(profile: UserProfile): string {
  const a = profile.ability;
  const c = profile.cognitiveStyle;
  if (profile.analysisCount === 0) return '';

  const parts: string[] = [];
  const abilityItems = [
    ['conceptClarity', '概念清晰度', a.conceptClarity],
    ['judgmentReasonableness', '判断合理性', a.judgmentReasonableness],
    ['reasoningValidity', '推理有效性', a.reasoningValidity],
  ] as const;
  const trustedAbility = abilityItems.filter(([key]) => isProfileIndicatorTrusted(profile, 'ability', key));
  if (trustedAbility.length > 0) {
    parts.push(trustedAbility.map(([, label, value]) => `${label} ${value.toFixed(0)}`).join('，'));
  } else {
    parts.push('能力画像数据积累中');
  }
  const cognitiveItems = [
    ['abstractVsConcrete', '抽象偏向', c.abstractVsConcrete],
    ['systematicVsScattered', '系统偏向', c.systematicVsScattered],
    ['divergentVsConvergent', '发散偏向', c.divergentVsConvergent],
    ['cautiousVsDogmatic', '谨慎偏向', c.cautiousVsDogmatic],
    ['deepVsSurface', '深度偏向', c.deepVsSurface],
  ] as const;
  const trustedCognitive = cognitiveItems.filter(([key]) => isProfileIndicatorTrusted(profile, 'cognitive_style', key));
  if (trustedCognitive.length > 0) {
    parts.push(`认知风格：${trustedCognitive.map(([, label, value]) => `${label} ${value.toFixed(0)}`).join('，')}`);
  }

  // 表达风格偏好：取 display 中超过阈值的风格按占比降序呈现（最多 3 项）；
  // 数据来自 style-snapshot.json 的指数平滑值，未 hydrate 或全低于阈值时静默跳过
  const styleDisplay = getExpressionStyleDisplay();
  const styleItems = (EXPRESSION_KINDS as ExpressionStyleKind[])
    .map((k) => ({ label: EXPRESSION_STYLE_LABELS[k], value: styleDisplay[k] ?? 0 }))
    .filter((s) => s.value >= STYLE_DISPLAY_THRESHOLD)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  if (styleItems.length > 0) {
    parts.push(
      `表达风格偏好：${styleItems.map((s) => `${s.label} ${s.value.toFixed(0)}`).join('，')}`
    );
  }

  const header = `以下是学习者的长期画像（来自历史复盘的累积分析），请在回答时结合学习者的认知特点：`;
  const body = parts.join('；');
  return `${header}\n${SCALE_NOTE}\n${body}`;
}
