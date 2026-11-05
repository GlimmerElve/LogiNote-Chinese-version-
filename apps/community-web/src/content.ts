import type { Resource } from './model';

type PreviewText = { outline: [string, string][]; paragraphs: string[] };
/** Layout fixtures only. New authored resources never receive invented usage. */
export function demoResourceUsage(resource:Resource):number|null {
  if(resource.body!==undefined)return null;
  const counts:Record<string,number>={linear:186,matrix:128,regression:64,gradient:93,reading:42};
  return counts[resource.id]??null;
}
/** Synthetic, selected-resource-specific text. No remote material is fetched. */
export function previewText(resource: Resource): PreviewText {
  if(resource.body!==undefined)return {outline:[],paragraphs:[resource.body]};
  if (resource.topic === '阅读与写作') return {
    outline: [['先留下一个问题', '读之前，想想自己最想弄清楚什么。'], ['用自己的话复述', '合上材料，写下这一章的主要观点。'], ['回到原文核对', '区分作者观点、自己的推测和仍有疑问的部分。']],
    paragraphs: ['读完一章后，先不复制原文，用三句话记录主要观点，再补上自己的问题。', '回看原文时核对遗漏和误解，保留引用出处，逐步形成自己的理解。'],
  };
  if (resource.art === 'code') return {
    outline: [['准备一个小数据集', '用几组输入和输出，观察大致的变化方向。'], ['拟合并画出直线', '比较预测值与观测值之间的误差。'], ['改变数据再试一次', '加入一个不同的样本，观察拟合结果怎样变化。']],
    paragraphs: ['先画出几个二维数据点，再尝试用一条直线描述它们。不要急着记住所有公式，先比较直线与数据点之间的距离。', '演示练习：用 Python 和 NumPy 表示输入与输出，计算一个简单的线性预测，再画出残差。此页面不执行代码。'],
  };
  if (resource.art === 'gradient') return {
    outline: [['找到下降的方向', '把梯度与当前点附近的函数变化联系起来。'], ['理解学习率', '步幅太大可能跨过低点，引起来回震荡。'], ['画出几次更新', '对比不同步幅，观察当前位置如何变化。']],
    paragraphs: ['把优化想成在一张起伏的地形上寻找低处。梯度描述局部上升最快的方向，负梯度为一次下降更新提供方向。', '学习率决定这一步走多远。先用一维二次函数画出几次迭代，比较小步幅和过大步幅的差别。'],
  };
  if (resource.art === 'matrix') return {
    outline: [['基向量的去向', '观察变换后两个坐标方向落在什么位置。'], ['组合空间变换', '通过先旋转再拉伸，理解矩阵乘法的顺序。'], ['画图验证直觉', '用一个简单向量，比较两种变换次序的结果。']],
    paragraphs: ['把向量看成从原点出发的箭头。矩阵乘法把每个基向量移到新的位置，并由线性组合决定其他向量的位置。', '试一试：画出 (1, 0) 和 (0, 1)，先旋转九十度再沿横轴拉伸，随后交换这两步，比较结果。'],
  };
  return {
    outline: [['向量与空间的直觉', '从生活中的例子出发，建立向量和向量空间的直观认识。'], ['矩阵怎样改变空间', '通过图形与实例，理解矩阵变换的几何意义。'], ['用小练习检验理解', '配套的思考题与练习，帮助巩固关键概念。']],
    paragraphs: ['从向量的方向和长度出发，再认识坐标、线性组合与空间变换。每一小节选一个例子，尝试画出来。', '先理解基向量的变化，再用自己的话解释矩阵的作用。不必一次完成全部路线，可以带着问题回到共学交流。'],
  };
}
