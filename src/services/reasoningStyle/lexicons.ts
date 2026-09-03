/**
 * 推理用语权威词表（纯前端正则匹配，零 AI 成本）。
 * 按语义类别分组，后续可扩充；每个词条参与对应密度的计数。
 */

/** 因果/推导连接词（因果推理意识，计入 prefersDerivation） */
export const CAUSAL_CONNECTORS = [
  '因为', '所以', '因此', '由于', '从而', '导致', '既然', '于是',
  '如果', '那么', '只要', '就', '除非', '否则', '不管', '无论',
  '由此可见', '由此可见', '因而', '故而', '之所以', '是因为',
] as const;

/** 举例标记（举例论证偏好，计入 prefersExample） */
export const EXAMPLE_MARKERS = [
  '比如', '例如', '譬如', '举个例子', '举例来说', '拿', '来说',
  '比方说', '好比说', '诸如', '具体来说',
] as const;

/** 类比标记（类比论证偏好，计入 prefersAnalogy） */
export const ANALOGY_MARKERS = [
  '就像', '好比', '相当于', '类似', '如同', '跟', '一样', '正如',
  '好比说', '类比', '打个比方',
] as const;

/** 定义标记（定义偏好，计入 prefersDefinition） */
export const DEFINITION_MARKERS = [
  '所谓', '定义为', '意思是', '也就是说', '换句话说', '指的是',
  '即', '称为', '叫做', '换言之',
] as const;

/** 结论前置标记（用于判定 conclusionFirst，出现在首句/段首记为前置） */
export const CONCLUSION_MARKERS = [
  '所以', '因此', '总之', '总的来说', '综上所述', '结论是',
  '归根结底', '一言以蔽之',
] as const;

/** 模糊词（表达含糊，负向信号，统计到 vagueTermDensity） */
export const VAGUE_TERMS = [
  '那个', '差不多', '某种', '大概', '好像', '似乎', '也许', '可能',
  '或许', '应该', '有点儿', '有点', '某种程度', '一定程度上',
  '之类', '什么的', '等等吧',
] as const;

/** 绝对化词（武断表达，负向信号，统计到 absolutistDensity） */
export const ABSOLUTIST_TERMS = [
  '一定', '必然', '肯定', '所有', '全部', '绝对', '不可能', '毫无疑问',
  '从来', '永远', '完全', '总是', '从不', '毫无', '百分之百', '必须',
] as const;