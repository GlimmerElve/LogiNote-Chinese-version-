import type { ArgumentFunctionType } from '../../types';

/**
 * 论证结构编辑器 · ArgDoc 类型定义（loginote 侧存储模型）
 *
 * 与 argument-editor-standalone 的 ArgDoc 结构对齐，供心流复盘分析产出的
 * 论证结构（逐句标注 + 连线 + 漏洞）持久化到笔记 vault。
 * 该数据作为「可分享」字段随笔记分享，不含隐私。
 */

export type ArgumentLayer = 'concept' | 'judgment' | 'logic';

/** 节点状态（与编辑器视觉表对齐） */
export type NodeStatus =
  | 'ok'
  | 'error'
  | 'warning'
  | 'suggested'
  | 'to_delete'
  | 'edited'
  | 'isolated';

/** 连线关系 */
export type RelationType = 'support' | 'oppose';

export interface Point {
  x: number;
  y: number;
}

/** 论证结构节点（对齐编辑器 ArgNode） */
export interface ArgNode {
  /** 节点 id，形如 s1、s2（对齐 SentenceAnnotation.id） */
  id: string;
  /** 论证功能主类型，决定层级与标题栏文字 */
  mainType: ArgumentFunctionType;
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
}

/** 论证结构连线（对齐编辑器 ArgEdge） */
export interface ArgEdge {
  /** 递增 id，形如 e1、e2 */
  id: string;
  source: string;
  target: string;
  relation: RelationType;
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
  /** 总结/评分（LLM 返回，导出时使用） */
  summary?: string;
  scores?: {
    conceptScore: number;
    judgmentScore: number;
    logicScore: number;
  };
}

/** 9 类论证类型 → 三层层级（复制自编辑器；evidenceQuality 里是散落加减，此处集中定义） */
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

/** 类型 → 层级 */
export function getNodeLayer(mainType: ArgumentFunctionType): ArgumentLayer {
  return LAYER_OF_TYPE[mainType];
}

/** 类型 → 层级 rank（概念层 0 / 判断层 1 / 逻辑层 2） */
export function getNodeRank(mainType: ArgumentFunctionType): number {
  const layer = LAYER_OF_TYPE[mainType];
  return layer === 'concept' ? 0 : layer === 'judgment' ? 1 : 2;
}
