import {
  CognitiveStyle,
  CognitiveStyleEvidence,
  ConceptObservation,
  PreprocessResult,
  SentenceAnnotation,
  ArgumentFunctionType,
  ArgumentEdge,
  ArgumentRelation,
  ArgumentQualityResult,
  QualityIndicator,
  Vulnerability,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { LayeredEvidenceBundle } from './types';
import { scoreCognitiveStyle } from '../profile/scoring/styleScoring';
import { computeTypeCounts } from '../profile/styleScoring';

/**
 * 心流复盘「结论粒度」三段式链路中的两步证据请求：
 * - preprocessText：口语清洗 + 关键结论抽取（flow-preprocess，不落盘）
 * - fetchLayeredEvidence：对每条关键结论做论证链分析（profile-evidence-layered）
 * 认知风格 / 概念归并仍沿用旧请求（fetchCognitiveStyle / fetchConceptAliases）。
 */

const TEXT = (t: string) => `口语复盘文本：\n${t}`;

/** 合法的主类型集合（用于解析时过滤非法值） */
const ARGUMENT_TYPES: ArgumentFunctionType[] = [
  '定义', '对比', '假设', '举例', '推理', '反例削弱', '建议对策', '命名', '事实陈述',
];

/** 解析逐句标注 */
function parseSentences(raw: unknown): SentenceAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const out: SentenceAnnotation[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const mainType = ARGUMENT_TYPES.includes(o.mainType as ArgumentFunctionType)
      ? (o.mainType as ArgumentFunctionType)
      : '事实陈述';
    out.push({
      id: typeof o.id === 'string' ? o.id : `s${out.length + 1}`,
      index: typeof o.index === 'number' ? o.index : out.length + 1,
      text: typeof o.text === 'string' ? o.text : '',
      mainType,
      subTypes: typeof o.subTypes === 'string' ? o.subTypes : undefined,
      asrNote: typeof o.asrNote === 'string' ? o.asrNote : undefined,
    });
  }
  return out;
}

/** 解析连线关系（过滤非法 relation 与引用不存在节点的边） */
function parseEdges(raw: unknown, validIds: Set<string>): ArgumentEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: ArgumentEdge[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const source = typeof o.source === 'string' ? o.source : '';
    const target = typeof o.target === 'string' ? o.target : '';
    const relation: ArgumentRelation =
      o.relation === 'support' || o.relation === 'oppose'
        ? (o.relation as ArgumentRelation)
        : 'support';
    // 源、目标必须都存在；自环丢弃
    if (!source || !target || source === target) continue;
    if (!validIds.has(source) || !validIds.has(target)) continue;
    out.push({ source, target, relation });
  }
  return out;
}

/** 步骤① 预处理：逐句拆分论证结构 + 类型标注 + 连线关系 */
export async function preprocessText(text: string): Promise<PreprocessResult> {
  const empty: PreprocessResult = { sentences: [], edges: [] };
  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'flow-preprocess', userInput: TEXT(text) });
    const j = resp.parsedJson || {};
    const sentences = parseSentences(j.sentences);
    const validIds = new Set(sentences.map((s) => s.id));
    const edges = parseEdges(j.edges, validIds);
    return { sentences, edges };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    return empty;
  }
}

/** 解析单个质量指标（0-4 分 + 依据） */
function parseIndicator(v: unknown): QualityIndicator {
  const o = (v || {}) as Record<string, unknown>;
  return {
    score: typeof o.score === 'number' ? o.score : 0,
    evidence: typeof o.evidence === 'string' ? o.evidence : '',
  };
}

/** 解析漏洞表 */
function parseVulnerabilities(raw: unknown): Vulnerability[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const o = it as Record<string, unknown>;
      const layer = o.layer === '概念层' || o.layer === '判断层' || o.layer === '逻辑层' || o.layer === '多层' || o.layer === '无法判断'
        ? (o.layer as Vulnerability['layer'])
        : '无法判断';
      return {
        nodeId: typeof o.nodeId === 'string' ? o.nodeId : undefined,
        type: typeof o.type === 'string' ? o.type : '',
        severity: typeof o.severity === 'number' ? o.severity : 1,
        layer,
        evidence: typeof o.evidence === 'string' ? o.evidence : '',
        suggestion: typeof o.suggestion === 'string' ? o.suggestion : '',
      };
    });
}

/** 步骤②：对整段论证结构做整体质量评估，解析为 ArgumentQualityResult */
export async function fetchLayeredEvidence(
  preprocess: PreprocessResult,
  originalText: string,
): Promise<LayeredEvidenceBundle> {
  try {
    const counts = computeTypeCounts(preprocess.sentences);
    const userInput = JSON.stringify({
      originalText,
      sentences: preprocess.sentences,
      edges: preprocess.edges,
      counts,
    }, null, 2);
    const resp = await callLLM({ providerId: '', model: '', workflow: 'profile-evidence-layered', userInput });
    const j = resp.parsedJson || {};

    const q = (j.quality || {}) as Record<string, unknown>;
    const qualityResult: ArgumentQualityResult = {
      quality: {
        conceptClarity: parseIndicator(q.conceptClarity),
        exampleQuality: parseIndicator(q.exampleQuality),
        factSpeculation: parseIndicator(q.factSpeculation),
        reasoningChain: parseIndicator(q.reasoningChain),
      },
      vulnerabilities: parseVulnerabilities(j.vulnerabilities),
      summary: typeof j.summary === 'string' ? j.summary : '',
    };

    return { qualityResult };
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