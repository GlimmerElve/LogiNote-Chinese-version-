import {
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
  CognitiveStyle,
  ConceptObservation,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { DiagnosisItem, LayeredEvidenceBundle } from './types';

/**
 * 五路画像证据小请求 → 合并后为三路：
 * - fetchLayeredEvidence：概念/判断/推理三层合一（profile-evidence-layered）
 * - fetchCognitiveStyle：认知风格五维（profile-style-cognitive）
 * - fetchConceptAliases：概念归并（profile-concept-aliases）
 * 每个请求同时返回：锚点（算画像 / 周报）+ 诊断（进结果面板）。
 */

const TEXT = (t: string) => `口语复盘文本：\n${t}`;

/** 三层合一的证据请求：解析 LLM 返回的嵌套结构，映射回旧平铺结构 + 文字总结 */
export async function fetchLayeredEvidence(text: string): Promise<LayeredEvidenceBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-layered', userInput: TEXT(text) });
    const j = resp.parsedJson || {};

    const concept = (j.concept || {}) as Record<string, unknown>;
    const judgment = (j.judgment || {}) as Record<string, unknown>;
    const reasoning = (j.reasoning || {}) as Record<string, unknown>;

    const conceptEvidence: ConceptEvidence = {
      redefinesInOwnWords: concept.redefinesInOwnWords as boolean | undefined,
      distinguishesSimilarConcepts: concept.distinguishesSimilarConcepts as boolean | undefined,
      givesCounterExamples: concept.givesCounterExamples as boolean | undefined,
      vagueTerms: Array.isArray(concept.vagueTerms) ? (concept.vagueTerms as string[]) : undefined,
      conceptErrors: Array.isArray(concept.conceptErrors) ? (concept.conceptErrors as string[]) : undefined,
    };

    const judgmentEvidence: JudgmentEvidence = {
      considersConditions: judgment.considersConditions as boolean | undefined,
      distinguishesFactOpinion: judgment.distinguishesFactOpinion as boolean | undefined,
      usesQualifiers: judgment.usesQualifiers as boolean | undefined,
      absolutistCount: typeof judgment.absolutistCount === 'number' ? judgment.absolutistCount : undefined,
      judgmentErrors: Array.isArray(judgment.judgmentErrors) ? (judgment.judgmentErrors as string[]) : undefined,
    };

    const reasoningEvidence: ReasoningEvidence = {
      providesPremises: reasoning.providesPremises as boolean | undefined,
      completeChain: reasoning.completeChain as boolean | undefined,
      identifiesAssumptions: reasoning.identifiesAssumptions as boolean | undefined,
      distinguishesDeductiveInductive: reasoning.distinguishesDeductiveInductive as boolean | undefined,
      considersCounterfactuals: reasoning.considersCounterfactuals as boolean | undefined,
      fallacyTypes: Array.isArray(reasoning.fallacyTypes) ? (reasoning.fallacyTypes as string[]) : undefined,
    };

    return {
      conceptEvidence,
      terminologyAccuracy: typeof concept.terminologyAccuracy === 'number' ? concept.terminologyAccuracy : undefined,
      conceptDiagnosis: Array.isArray(concept.conceptDiagnosis) ? (concept.conceptDiagnosis as DiagnosisItem[]) : [],
      judgmentEvidence,
      judgmentDiagnosis: Array.isArray(judgment.judgmentDiagnosis) ? (judgment.judgmentDiagnosis as DiagnosisItem[]) : [],
      reasoningEvidence,
      selfCorrection: typeof reasoning.selfCorrection === 'number' ? reasoning.selfCorrection : undefined,
      logicDiagnosis: Array.isArray(reasoning.logicDiagnosis) ? (reasoning.logicDiagnosis as DiagnosisItem[]) : [],
      thinkingStyleBrief: typeof j.thinkingStyleBrief === 'string' ? j.thinkingStyleBrief : undefined,
      conceptSummary: typeof concept.summary === 'string' ? concept.summary : undefined,
      judgmentSummary: typeof judgment.summary === 'string' ? judgment.summary : undefined,
      reasoningSummary: typeof reasoning.summary === 'string' ? reasoning.summary : undefined,
      overallComment: typeof j.overallComment === 'string' ? j.overallComment : undefined,
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}

/** 认知风格请求返回 */
export interface CognitiveStyleBundle {
  cognitiveStyle?: Partial<CognitiveStyle>;
  cognitiveInterpretation?: string;
}

/** 认知风格（五维）+ 文字解读 */
export async function fetchCognitiveStyle(text: string): Promise<CognitiveStyleBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-style-cognitive', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    return {
      cognitiveStyle: j.cognitiveStyle as Partial<CognitiveStyle> | undefined,
      cognitiveInterpretation: typeof j.cognitiveInterpretation === 'string' ? j.cognitiveInterpretation : undefined,
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}

/** 概念归并请求返回 */
export interface ConceptAliasesBundle {
  concepts?: ConceptObservation[];
  relatedKnowledge?: Array<{ term: string; relation: string; suggestedWikiLink?: string }>;
}

/** 概念归并 + 关联知识 */
export async function fetchConceptAliases(
  text: string,
  allNoteTitles: string,
): Promise<ConceptAliasesBundle> {
  try {
    const resp = await callLLM({
      providerId: '',
      model: '',
      workflow: 'profile-concept-aliases',
      userInput: `已有笔记标题：${allNoteTitles || '（无）'}\n\n${TEXT(text)}`,
    });
    const j = resp.parsedJson || {};
    return {
      concepts: Array.isArray(j.concepts) ? (j.concepts as ConceptObservation[]) : [],
      relatedKnowledge: Array.isArray(j.relatedKnowledge)
        ? (j.relatedKnowledge as Array<{ term: string; relation: string; suggestedWikiLink?: string }>)
        : [],
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}