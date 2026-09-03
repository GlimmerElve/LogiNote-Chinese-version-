import {
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
  CognitiveStyle,
  ConceptObservation,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { DiagnosisItem } from './types';

/**
 * 五路画像证据小请求（P8：锚点 + 诊断双输出）。
 * 每个请求同时返回：
 * - 锚点（算画像 / 周报）
 * - 诊断（指原文 + 改法，进结果面板）
 * 对应 workflow id 在 workflowRegistry 注册模板。
 */

const TEXT = (t: string) => `口语复盘文本：\n${t}`;

/** 路1返回：概念证据 + 术语准确度 + 概念诊断 */
export interface ConceptEvidenceBundle {
  conceptEvidence?: ConceptEvidence;
  terminologyAccuracy?: number;
  conceptDiagnosis?: DiagnosisItem[];
}

/** 路1：概念层证据 + 术语准确度 + 概念诊断 */
export async function fetchConceptEvidence(text: string): Promise<ConceptEvidenceBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-concept', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    return {
      conceptEvidence: j.conceptEvidence as ConceptEvidence | undefined,
      terminologyAccuracy: typeof j.terminologyAccuracy === 'number' ? j.terminologyAccuracy : undefined,
      conceptDiagnosis: Array.isArray(j.conceptDiagnosis) ? (j.conceptDiagnosis as DiagnosisItem[]) : [],
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}

/** 路2返回：判断证据 + 判断诊断 */
export interface JudgmentEvidenceBundle {
  judgmentEvidence?: JudgmentEvidence;
  judgmentDiagnosis?: DiagnosisItem[];
}

/** 路2：判断层证据 + 判断诊断 */
export async function fetchJudgmentEvidence(text: string): Promise<JudgmentEvidenceBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-judgment', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    return {
      judgmentEvidence: j.judgmentEvidence as JudgmentEvidence | undefined,
      judgmentDiagnosis: Array.isArray(j.judgmentDiagnosis) ? (j.judgmentDiagnosis as DiagnosisItem[]) : [],
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}

/** 路3返回：推理证据 + 自我修正 + 逻辑诊断 */
export interface ReasoningEvidenceBundle {
  reasoningEvidence?: ReasoningEvidence;
  selfCorrection?: number;
  logicDiagnosis?: DiagnosisItem[];
}

/** 路3：推理层证据 + 自我修正 + 逻辑诊断 */
export async function fetchReasoningEvidence(text: string): Promise<ReasoningEvidenceBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-reasoning', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    return {
      reasoningEvidence: j.reasoningEvidence as ReasoningEvidence | undefined,
      selfCorrection: typeof j.selfCorrection === 'number' ? j.selfCorrection : undefined,
      logicDiagnosis: Array.isArray(j.logicDiagnosis) ? (j.logicDiagnosis as DiagnosisItem[]) : [],
    };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return {};
  }
}

/** 路4返回：认知风格 + 解读 */
export interface CognitiveStyleBundle {
  cognitiveStyle?: Partial<CognitiveStyle>;
  cognitiveInterpretation?: string;
}

/** 路4：认知风格（五维）+ 文字解读 */
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

/** 路5返回：概念归并 + 关联知识 */
export interface ConceptAliasesBundle {
  concepts?: ConceptObservation[];
  relatedKnowledge?: Array<{ term: string; relation: string; suggestedWikiLink?: string }>;
}

/** 路5：概念归并 + 关联知识 */
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
