import type { ArgumentFunctionType } from '../../types';

/**
 * 论证结构编辑器 · ArgDoc 类型定义（loginote 侧存储模型）
 *
 * 与 argument-editor-standalone 的 ArgDoc 结构对齐，供心流复盘分析产出的
 * 论证结构（逐句标注 + 连线 + 漏洞）持久化到笔记 vault。
 * 该数据作为「可分享」字段随笔记分享，不含隐私。
 */

export type ArgumentLayer = 'concept' | 'judgment' | 'logic';

/** v2 论证角色。旧文档可缺省，由 mainType 兼容显示。 */
export type ArgumentRole = 'claim' | 'premise' | 'background' | 'method';

/** Lossless source structure from the current Flow extractor, not an assessment.
 * Kept alongside the canvas projection; edits do not rewrite the original analysis.
 */
export interface FlowArgumentStructure {
  version: 1;
  nodes: Array<{ id: string; role: ArgumentRole; text: string; rawQuote: string }>;
  arguments: Array<{ id: string; claim: string; support: string[]; oppose: string[]; status: 'argued' | 'stated_only' | 'incomplete' }>;
  relations: Array<{ id: string; kind: 'context' | 'method_for' | 'relates'; from: string; to: string; reason: string }>;
  unresolved: Array<{ nodeId?: string; reason: string }>;
}

/** 节点状态（与编辑器视觉表对齐） */
export type NodeStatus =
  | 'ok'
  | 'error'
  | 'warning'
  | 'suggested'
  | 'to_delete'
  | 'edited'
  | 'isolated';

/**
 * 连线关系。support/oppose 是论证边；其余是组织与来源边，
 * 不得在评分或 RAG 中自动视为证明。
 */
export type RelationType = 'support' | 'oppose' | 'context' | 'method_for' | 'relates';

export interface Point {
  x: number;
  y: number;
}

/** 用户明确绑定的可打开证据；不接受模型自行生成的 URL 或引用。 */
export interface ArgumentSourceRef {
  type: 'note' | 'document';
  /** noteId 或 docId。 */
  entityId: string;
  /** 资料引用需要稳定 chunkId；笔记引用可省略。 */
  chunkId?: string;
  title?: string;
  quote: string;
  sectionPath?: string[];
  /** 只有用户从真实检索结果绑定时才写入。 */
  verifiedAt: string;
}

/** 论证结构节点（对齐编辑器 ArgNode） */
export interface ArgNode {
  /** 节点 id，形如 s1、s2（对齐 SentenceAnnotation.id） */
  id: string;
  /** 论证功能主类型，决定层级与标题栏文字 */
  mainType: ArgumentFunctionType;
  /** v2 语义角色；存在时优先于旧九类标签用于显示和检索。 */
  role?: ArgumentRole;
  /** 节点正文，可含 LaTeX（$...$） */
  text: string;
  /** 画布坐标（左上角） */
  position: Point;
  status: NodeStatus;
  /** 问题诊断描述；无则为 null */
  issue: string | null;
  /** 问题严重程度（1-5，来自 LLM 诊断；无则为 null） */
  severity: number | null;
  /** 改进建议（来自 LLM 诊断；无则为 null） */
  suggestion: string | null;
  /** 论证副类型/说明（来自 SentenceAnnotation.subTypes） */
  subTypes?: string;
  /** 疑似语音转文字识别误差说明（来自 SentenceAnnotation.asrNote） */
  asrNote?: string;
  /** 是否被用户手动编辑过 */
  user_edited: boolean;
  /** 是否收起（截断显示）；false 表示展开 */
  collapsed: boolean;
  /** 该主张的可核验证据引用，由用户显式绑定。 */
  sources?: ArgumentSourceRef[];
}

/** 论证结构连线（对齐编辑器 ArgEdge） */
export interface ArgEdge {
  /** 递增 id，形如 e1、e2 */
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  /** 辅助关系的简短原文依据；旧论证边可缺省。 */
  reason?: string;
}

/** Structure-only review. This is not a new assessment of the user's spoken performance. */
export interface StructureCheck {
  id: string;
  state: 'clear' | 'issue' | 'uncertain';
  reason: string;
  severity?: 'low' | 'medium' | 'high';
  suggestion?: string;
  targetKey?: string;
}

export type StructureReviewMode = 'changes' | 'full';
/** Compact local edit baseline: no duplicate source text, scores or personal evidence. */
export interface StructureBaseline {
  nodes: Array<{ id: string; key: string }>;
  edges: Array<{ id: string; key: string; source: string; target: string; relation: RelationType }>;
}

export interface StructureReview {
  version: 1;
  graphKey: string;
  reviewedAt: string;
  nodes: StructureCheck[];
  edges: StructureCheck[];
  mode?: StructureReviewMode;
  checkedNodes?: string[];
  checkedEdges?: string[];
  pendingNodes?: string[];
  pendingEdges?: string[];
  warnings?: string[];
}

export type ArgumentAdmissionLevel = 'full' | 'limited' | 'review_required';

export interface ArgumentQualityIssue {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  suggestion: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ArgumentQualityAssessment {
  version: 1;
  score: number;
  admission: ArgumentAdmissionLevel;
  /** 证据强度与结构质量分开；没有 source refs 时不得伪造 A/B/C。 */
  evidenceGrade: 'A' | 'B' | 'C' | 'ungraded';
  dimensions: {
    structure: number;
    clarity: number;
    relationCorrectness: number;
    coverage: number;
    consistency: number;
  };
  issues: ArgumentQualityIssue[];
  evaluatedAt: string;
}

export type ArgumentSemanticIssueCategory =
  | 'structural-invalid'
  | 'compound-claim'
  | 'ambiguous-node'
  | 'type-mismatch'
  | 'edge-direction'
  | 'unsupported-inference'
  | 'missing-premise'
  | 'missing-qualifier'
  | 'circular-reasoning'
  | 'internal-conflict'
  | 'ungrounded-factual-claim';

export interface ArgumentSemanticIssue {
  id: string;
  target: { kind: 'node' | 'edge' | 'graph'; id?: string };
  category: ArgumentSemanticIssueCategory;
  severity: 'blocker' | 'major' | 'minor';
  explanation: string;
  suggestedAction: string;
  suggestedText?: string;
}

/**
 * 复核当时的问题目标快照。整份报告过期后，仍可据此判断某个具体节点/连线
 * 是否保持原样，从而安全地继续处理同一批建议。
 */
export interface ArgumentSemanticTargetSnapshot {
  target: ArgumentSemanticIssue['target'];
  fingerprint: string;
}

/** LLM 只评估内部语义和论证关系，不得充当事实核验器。 */
export interface ArgumentSemanticAssessment {
  version: 1;
  promptVersion: 1;
  revisionHash: string;
  score: number;
  admission: ArgumentAdmissionLevel;
  dimensions: ArgumentQualityAssessment['dimensions'];
  issues: ArgumentSemanticIssue[];
  /** 可选以兼容旧报告；旧报告过期后需重新复核，不能继续自动应用建议。 */
  targetSnapshots?: ArgumentSemanticTargetSnapshot[];
  reviewedAt: string;
  model?: string;
}

/** 用户对语义问题作出的显式决策。只在相同 revision 下有效。 */
export interface ArgumentIssueDecision {
  version: 1;
  issueId: string;
  revisionHash: string;
  action: 'ignored';
  reason: string;
  decidedAt: string;
}

export interface ArgumentEvidenceAssessment {
  version: 1;
  revisionHash: string;
  grade: 'A' | 'B' | 'C';
  factualNodeCount: number;
  coveredFactualNodeCount: number;
  documentCoveredNodeCount: number;
  coverageRatio: number;
  evaluatedAt: string;
}

export interface ArgumentQualityAuditEntry {
  id: string;
  event: 'semantic_review' | 'issue_ignored' | 'suggestion_applied' | 'published' | 'withdrawn';
  revisionHash: string;
  at: string;
  deterministicScore: number;
  semanticScore?: number;
  effectiveAdmission: ArgumentAdmissionLevel;
  evidenceGrade: ArgumentQualityAssessment['evidenceGrade'];
  model?: string;
  issueId?: string;
  reason?: string;
  /** 复核事件保留当时的详细问题；发布/撤回事件可仅记录决策摘要。 */
  deterministicIssues?: ArgumentQualityIssue[];
  semanticIssues?: ArgumentSemanticIssue[];
}

/** 已经由用户确认发布的不可变检索快照；后续草稿不合格时继续使用此版本。 */
export interface ArgumentPublishedSnapshot {
  revisionHash: string;
  title: string;
  nodes: ArgNode[];
  edges: ArgEdge[];
  summary?: string;
  scores?: ArgDoc['scores'];
  assessment: ArgumentQualityAssessment;
  semanticAssessment?: ArgumentSemanticAssessment;
  evidenceAssessment?: ArgumentEvidenceAssessment;
  /** 发布时仍有效的非 blocker 忽略说明，用于回溯而不改变评分。 */
  issueDecisions?: ArgumentIssueDecision[];
  effectiveAdmission?: ArgumentAdmissionLevel;
  publishedAt: string;
}

export interface ArgumentRagState {
  sourceKind: 'user_graph';
  draftAssessment: ArgumentQualityAssessment;
  semanticAssessment?: ArgumentSemanticAssessment;
  evidenceAssessment?: ArgumentEvidenceAssessment;
  /** 最多保留最近若干次用户问题决策；读取时必须按 revisionHash 过滤。 */
  issueDecisions?: ArgumentIssueDecision[];
  /** 便于跨设备追溯的最近质量事件，上限由写入函数控制。 */
  qualityAudit?: ArgumentQualityAuditEntry[];
  publishedSnapshot?: ArgumentPublishedSnapshot;
}

/** 论证结构文档（对齐编辑器 ArgDoc） */
export interface ArgDoc {
  /** 时间戳生成 doc_${Date.now()} */
  doc_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  iteration: number;
  status: 'draft';
  nodes: ArgNode[];
  edges: ArgEdge[];
  /** Private runtime source extraction; persisted in UserNoteState, never sharable metadata.
   * Use flowStructureMatches before treating it as the current graph. */
  flowStructure?: FlowArgumentStructure;
  /** 总结/评分（LLM 返回，导出时使用） */
  summary?: string;
  scores?: {
    conceptScore: number;
    judgmentScore: number;
    logicScore: number;
  };
  /** 论证层 RAG 的质量门控；缺省代表旧数据尚未评估，不进入论证索引。 */
  rag?: ArgumentRagState;
  structureReview?: StructureReview;
  structureReviewBase?: StructureBaseline;
}

/** 9 类论证类型 → 三层层级；保留历史论证图与编辑器字段兼容，不参与新版复盘评分。 */
export const LAYER_OF_TYPE: Record<ArgumentFunctionType, ArgumentLayer> = {
  定义: 'concept',
  命名: 'concept',
  对比: 'concept',
  假设: 'judgment',
  举例: 'judgment',
  事实陈述: 'judgment',
  推理: 'logic',
  反例削弱: 'logic',
  建议对策: 'logic',
};

/** 层级中文名（UI 展示） */
export const LAYER_LABEL: Record<ArgumentLayer, string> = {
  concept: '概念层',
  judgment: '判断层',
  logic: '逻辑层',
};

/** 9 类论证类型全量（工具栏/右键菜单下拉用） */
export const ALL_ARGUMENT_TYPES: ArgumentFunctionType[] = Object.keys(LAYER_OF_TYPE) as ArgumentFunctionType[];

export const ALL_ARGUMENT_ROLES: ArgumentRole[] = ['claim', 'premise', 'background', 'method'];

export const ARGUMENT_ROLE_LABELS: Record<ArgumentRole, string> = {
  claim: '主张', premise: '前提', background: '背景', method: '方法',
};

export const RELATION_LABELS: Record<RelationType, string> = {
  support: '支持', oppose: '反对', context: '上下文', method_for: '方法产生', relates: '明确关联',
};

/** 类型 → 层级 */
export function getNodeLayer(mainType: ArgumentFunctionType, role?: ArgumentRole): ArgumentLayer {
  if (role === 'background') return 'concept';
  if (role === 'claim' || role === 'premise') return 'judgment';
  if (role === 'method') return 'logic';
  return LAYER_OF_TYPE[mainType];
}

/** 类型 → 层级 rank（概念层 0 / 判断层 1 / 逻辑层 2） */
export function getNodeRank(mainType: ArgumentFunctionType, role?: ArgumentRole): number {
  const layer = getNodeLayer(mainType, role);
  return layer === 'concept' ? 0 : layer === 'judgment' ? 1 : 2;
}
