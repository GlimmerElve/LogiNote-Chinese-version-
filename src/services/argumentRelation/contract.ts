/** Experimental pair-classification contract. Does not extend production ArgumentRelation. */
export const ARGUMENT_RELATION_PROTOCOL_VERSION = 1;

export const ARGUMENT_RELATION_LABELS = [
  'support', 'oppose', 'explain', 'restate', 'define', 'compare',
  'insufficient_evidence', 'unrelated',
] as const;
export type ArgumentRelationLabel = typeof ARGUMENT_RELATION_LABELS[number];

export const ARGUMENT_RELATION_DEFINITIONS: Record<ArgumentRelationLabel, string> = {
  support: 'source 为 target 提供理由或证据；方向固定为理由到主张，保留原文条件、归属和不确定性，不代表现实事实已核验。',
  oppose: 'source 反驳或削弱 target；必须针对相同对象、条件和命题，报告“他人有分歧”不能代替被反驳的具体主张。',
  explain: '展开说明内容、流程或含义，但不增加相信 target 成立的独立理由；不是把一切因果解释都排除出 support。',
  restate: '实质上重复或改写同一命题，没有新增论据。',
  define: '命名、术语释义或定义对应；若定义参与实际推导，应按该对命题的推导关系判断，不能仅按节点类型判定。',
  compare: '并置不同对象、条件或维度的异同，尚未构成对同一命题的支持或反驳。',
  insufficient_evidence: '存在潜在论证联系，但当前输入缺少必要前提、数据、限定或正确端点；拒绝建立支持/反对边。',
  unrelated: '当前输入中没有可识别的论证或篇章联系；不是低置信度的通用替代标签。',
};

export interface ArgumentRelationInput {
  id: string;
  sentences: Array<{ id: string; text: string }>;
  sourceSentenceIds: string[];
  targetSentenceIds: string[];
}

export interface ArgumentRelationCase extends ArgumentRelationInput {
  /** Related/reversed examples must stay in the same split when creating a held-out set. */
  groupId: string;
  origin: 'synthetic' | 'local_review';
  phenomenon: string;
  annotationStatus: 'assistant_draft' | 'human_reviewed';
  expectedLabel: ArgumentRelationLabel;
  annotationReason: string;
}

export interface ArgumentRelationPrediction {
  id: string;
  label: ArgumentRelationLabel;
  evidenceSentenceIds: string[];
  explanation: string;
}

export function isArgumentRelationLabel(value: unknown): value is ArgumentRelationLabel {
  return typeof value === 'string' && (ARGUMENT_RELATION_LABELS as readonly string[]).includes(value);
}

export function isArgumentativeLabel(value: ArgumentRelationLabel): boolean {
  return value === 'support' || value === 'oppose';
}

/** Explicit whitelist: never send gold labels, annotation reasons or origin hints to a model. */
export function argumentRelationInput(item: ArgumentRelationCase): ArgumentRelationInput {
  return {
    id: item.id,
    sentences: item.sentences.map((sentence) => ({ ...sentence })),
    sourceSentenceIds: [...item.sourceSentenceIds],
    targetSentenceIds: [...item.targetSentenceIds],
  };
}
