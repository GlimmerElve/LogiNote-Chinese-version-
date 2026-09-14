import { ProfileInsight } from '../../types';
import { scoreConcept, scoreJudgment, scoreReasoning, ema } from './scoring/ability';
import { foldCognitiveStyle } from './scoring/styleScoring';
import { getUserProfile, saveUserProfile, registerConceptAliases } from './profileStore';

/**
 * 画像融合（新权威，v2）：把一次心流分析的「并行汇总后的 ProfileInsight」融合进长期画像。
 * 与知识点掌握度（threeLayer 0 基准）是两套独立体系；三层能力保持 50 基准 + EMA 0.4。
 * 认知风格折叠含第五维 deepVsSurface；表达风格偏好字段已由正则层量化、能力字段由 AI 输出。
 */

const ABILITY_ALPHA = 0.4;

export async function fuseProfileInsight(insight: ProfileInsight, textLen: number): Promise<void> {
  const profile = getUserProfile();
  const ability = profile.ability;

  // 1. 三层能力：步骤②整体论证质量 → 三层 final 分数 → EMA 融合
  //    步②产出 layeredScores 时优先走新链路；复习链路无 layeredScores 时走旧证据逻辑。
  let conceptScore: number | null = null;
  let judgmentScore: number | null = null;
  let reasoningScore: number | null = null;

  if (insight.layeredScores) {
    conceptScore = insight.layeredScores.final.concept;
    judgmentScore = insight.layeredScores.final.judgment;
    reasoningScore = insight.layeredScores.final.logic;
  } else {
    if (insight.conceptEvidence) conceptScore = scoreConcept(insight.conceptEvidence);
    if (insight.judgmentEvidence) judgmentScore = scoreJudgment(insight.judgmentEvidence);
    if (insight.reasoningEvidence) reasoningScore = scoreReasoning(insight.reasoningEvidence);
  }

  if (conceptScore !== null) ability.conceptClarity = ema(ability.conceptClarity, conceptScore, ABILITY_ALPHA);
  if (judgmentScore !== null) ability.judgmentReasonableness = ema(ability.judgmentReasonableness, judgmentScore, ABILITY_ALPHA);
  if (reasoningScore !== null) ability.reasoningValidity = ema(ability.reasoningValidity, reasoningScore, ABILITY_ALPHA);

  ability.evidenceCount += 1;
  ability.evidenceChars += textLen;

  // 2. 认知风格（含第五维 deepVsSurface）
  profile.cognitiveStyle = foldCognitiveStyle(profile.cognitiveStyle, insight.cognitiveStyle);

  profile.analysisCount += 1;

  // 3. 注册概念别名（中英文归并）
  for (const c of insight.concepts || []) {
    registerConceptAliases(c.canonicalName, c.aliases);
  }

  // 4. 保存（同步更新内存缓存 + 异步落盘 profile.json）
  saveUserProfile(profile);
}