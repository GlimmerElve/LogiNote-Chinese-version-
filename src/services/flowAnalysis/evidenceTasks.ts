import {
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
  KeyConclusion,
  LayerIssue,
  ArgumentAnalysis,
  CognitiveStyle,
  CognitiveStyleEvidence,
  ConceptObservation,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { LayeredEvidenceBundle } from './types';
import { scoreCognitiveStyle } from '../profile/scoring/styleScoring';

/**
 * 心流复盘「结论粒度」三段式链路中的两步证据请求：
 * - preprocessText：口语清洗 + 关键结论抽取（flow-preprocess，不落盘）
 * - fetchLayeredEvidence：对每条关键结论做论证链分析（profile-evidence-layered）
 * 认知风格 / 概念归并仍沿用旧请求（fetchCognitiveStyle / fetchConceptAliases）。
 */

const TEXT = (t: string) => `口语复盘文本：\n${t}`;

/** 步骤① 预处理：清洗口语噪声并提取 2~3 条关键结论（不落盘） */
export async function preprocessText(text: string): Promise<KeyConclusion[]> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'flow-preprocess', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    const arr = Array.isArray(j.keyConclusions) ? (j.keyConclusions as any[]) : [];
    return arr
      .filter((k) => k && typeof k === 'object')
      .map((k) => ({
        claim: typeof k.claim === 'string' ? k.claim : '',
        evidence: typeof k.evidence === 'string' ? k.evidence : '',
      }));
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return [];
  }
}

/** 解析单条结论的正向布尔（安全） */
function parseBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** 步骤②：对每条关键结论做论证链分析，解析为 ArgumentAnalysis[] */
export async function fetchLayeredEvidence(keyConclusions: KeyConclusion[]): Promise<LayeredEvidenceBundle> {
  try {
    const userInput = `关键结论列表：\n${JSON.stringify(keyConclusions, null, 2)}`;
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-layered', userInput });
    const j = resp.parsedJson || {};

    const rawArgs = Array.isArray(j.arguments) ? (j.arguments as any[]) : [];
    const argumentAnalyses: ArgumentAnalysis[] = rawArgs
      .filter((a) => a && typeof a === 'object')
      .map((a) => {
        const issues: LayerIssue[] = Array.isArray(a.issues)
          ? (a.issues as any[])
              .filter((it) => it && typeof it === 'object')
              .map((it) => ({
                layer: it.layer === 'judgment' || it.layer === 'reasoning' ? it.layer : 'concept',
                quote: typeof it.quote === 'string' ? it.quote : '',
                issue: typeof it.issue === 'string' ? it.issue : '',
                correction: typeof it.correction === 'string' ? it.correction : '',
                fallacyKind: typeof it.fallacyKind === 'string' && it.fallacyKind.trim() !== '' ? it.fallacyKind : undefined,
              }))
          : [];

        return {
          claim: typeof a.claim === 'string' ? a.claim : '',
          redefinesInOwnWords: parseBool(a.redefinesInOwnWords),
          distinguishesSimilarConcepts: parseBool(a.distinguishesSimilarConcepts),
          givesCounterExamples: parseBool(a.givesCounterExamples),
          considersConditions: parseBool(a.considersConditions),
          distinguishesFactOpinion: parseBool(a.distinguishesFactOpinion),
          usesQualifiers: parseBool(a.usesQualifiers),
          hasPremise: parseBool(a.hasPremise),
          completeChain: parseBool(a.completeChain),
          identifiesAssumption: parseBool(a.identifiesAssumption),
          distinguishesDeductiveInductive: parseBool(a.distinguishesDeductiveInductive),
          considersCounterfactual: parseBool(a.considersCounterfactual),
          issues,
        };
      });

    // 从 issues 派生 reasoning 层谬误类型（兼容旧 review 链路 reasoningEvidence.fallacyTypes；心流链路不再用它，见 orchestrator）
    const fallacyTypes: string[] = argumentAnalyses
      .flatMap((a) => a.issues || [])
      .filter((i) => i.layer === 'reasoning' && i.fallacyKind)
      .map((i) => i.fallacyKind as string);

    const reasoningEvidence: ReasoningEvidence = {
      providesPremises: argumentAnalyses.some((a) => a.hasPremise),
      completeChain: argumentAnalyses.some((a) => a.completeChain),
      identifiesAssumptions: argumentAnalyses.some((a) => a.identifiesAssumption),
      distinguishesDeductiveInductive: argumentAnalyses.some((a) => a.distinguishesDeductiveInductive),
      considersCounterfactuals: argumentAnalyses.some((a) => a.considersCounterfactual),
      fallacyTypes,
    };

    return {
      reasoningEvidence,
      terminologyAccuracy: typeof j.terminologyAccuracy === 'number' ? j.terminologyAccuracy : undefined,
      selfCorrection: typeof j.selfCorrection === 'number' ? j.selfCorrection : undefined,
      thinkingStyleBrief: typeof j.thinkingStyleBrief === 'string' ? j.thinkingStyleBrief : undefined,
      overallComment: typeof j.overallComment === 'string' ? j.overallComment : undefined,
      argumentAnalyses,
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

/** 21 个认知风格证据锚点字段名（与 CognitiveStyleEvidence 对齐） */
const COGNITIVE_EVIDENCE_KEYS: Array<keyof CognitiveStyleEvidence> = [
  'usesAbstractTerms',
  'generalizesDomain',
  'usesConcreteExamples',
  'staysOperational',
  'structuresHierarchically',
  'connectsPoints',
  'jumpsDisconnected',
  'listsWithoutOrder',
  'multipleAngles',
  'considersAlternatives',
  'singleAnswerOnly',
  'excludesAlternatives',
  'qualifiesStatements',
  'marksUncertainty',
  'absolutistClaims',
  'leavesNoRoom',
  'linksBroaderFramework',
  'probesMechanism',
  'reflectsOnAssumptions',
  'repeatsSurfaceInfo',
  'noWhyProbing',
];

/** 安全解析认知风格证据锚点（只接受布尔值，其余丢弃） */
function parseCognitiveEvidence(raw: unknown): CognitiveStyleEvidence {
  const out: CognitiveStyleEvidence = {};
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of COGNITIVE_EVIDENCE_KEYS) {
      if (typeof obj[key] === 'boolean') out[key] = obj[key] as boolean;
    }
  }
  return out;
}

/** 认知风格（五维）+ 文字解读：解析证据锚点 → 折算为 -100~+100 */
export async function fetchCognitiveStyle(text: string): Promise<CognitiveStyleBundle> {
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-style-cognitive', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    const evidence = parseCognitiveEvidence(j.evidence);
    return {
      cognitiveStyle: scoreCognitiveStyle(evidence),
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