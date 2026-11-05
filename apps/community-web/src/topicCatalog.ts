export type ContentTopic = {id:string; name:string; aliases:string[]; description:string; directions:string[]};
export const initialTopicCatalog: ContentTopic[] = [
  {id:'linear-algebra',name:'线性代数',aliases:['矩阵','向量'],description:'从向量、矩阵到空间变换，一起理解线性代数。',directions:['数学']},
  {id:'machine-learning',name:'机器学习',aliases:['ML','梯度下降','神经网络'],description:'交流模型原理、训练方法和实践中的问题。',directions:['人工智能','数学']},
  {id:'paper-reading',name:'论文共读',aliases:['论文阅读'],description:'一起读懂论文，交换理解和疑问。',directions:['阅读与写作']},
  {id:'reading-methods',name:'阅读方法',aliases:['读书','阅读笔记'],description:'分享阅读、复述和留下自己理解的方法。',directions:['阅读与写作']},
  {id:'writing',name:'写作',aliases:['表达'],description:'用自己的话，把想法写清楚。',directions:['阅读与写作']},
  {id:'probability',name:'概率与统计',aliases:['概率','统计'],description:'从具体问题理解随机性、数据和推断。',directions:['数学']},
  {id:'ai',name:'人工智能',aliases:['AI','人工智慧'],description:'关于人工智能原理、工具和应用的交流。',directions:['人工智能']},
  {id:'mathematics',name:'数学',aliases:['数学学习'],description:'交流数学概念、证明和计算中的发现。',directions:['数学']},
  {id:'reading-writing',name:'阅读与写作',aliases:[],description:'交流阅读与表达中的发现。',directions:['阅读与写作']},
];
export const normalizeTopicName=(name:string)=>name.normalize('NFKC').replace(/^#+|#+$/g,'').trim().toLocaleLowerCase();
export function legacyTopicIds(value:unknown,catalog:ContentTopic[]=initialTopicCatalog):string[]{
  if(typeof value!=='string'||!value||value==='未分类')return [];
  const normalized=normalizeTopicName(value);
  const topic=catalog.find(t=>[t.name,...t.aliases].some(name=>normalizeTopicName(name)===normalized));
  return topic?[topic.id]:[];
}
export function validTopicIds(value:unknown,catalog:ContentTopic[]):string[]{
  return Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'&&catalog.some(topic=>topic.id===id)))].slice(0,3):[];
}
