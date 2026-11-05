import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { selectFigureMechanism, selectPageFigureMechanism, loadFigureMechanismGuidance, type FigureMechanism } from '../src/services/textbook/interactiveFigureDesign';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import type { FigureArtifact } from '../src/electron/interactiveFigureStore';

const cases: Array<[FigureMechanism, string, string]> = [
  ['sampler','调整采样温度观察概率','理论概率'],
  ['tokens','观察分词器如何分词和计费','token'],
  ['embedding','改变向量嵌入观察向量相似度','示意'],
  ['attention','观察自注意力权重与输出','归一化'],
  ['architecture','改变模型架构的层数','尺寸'],
  ['training','比较训练损失曲线','验证'],
  ['context','观察上下文窗口的截断','容量'],
  ['chunker','观察文档切块与检索','切分'],
  ['validator','改变验证规则观察通过或失败','无法判断'],
  ['builder','通过组合部件观察生成器','组合'],
  ['flow','观察工作流的分支与失败','终点'],
  ['agent','观察智能体循环和停止条件','批准'],
  ['threshold','调整分类阈值观察误报','假阳性'],
  ['frontier','比较帕累托多目标权衡','支配关系'],
  ['scorer','调整加权评分的权重','排序'],
  ['economics','观察资金流入与现金流','存量'],
  ['assembly','观察零件装配顺序','对齐'],
  ['kinematics','观察构件运动轨迹','运动'],
  ['section','改变剖切平面观察截面','内部'],
  ['spatial','改变视角进行空间观察','视角'],
];
for (const [id, goal, evidence] of cases) {
  assert.equal(selectFigureMechanism(goal), id, `routing ${id}`);
  const guide = await loadFigureMechanismGuidance(id);
  assert.ok(guide.includes(evidence) && guide.length < 500, `bounded guide ${id}`);
}
assert.equal(selectFigureMechanism('比较分类阈值与现金流'), undefined, 'ambiguous requested mechanisms do not select one by accident');
assert.equal(selectFigureMechanism('比较分类阈值与齿轮传动'), undefined, 'detailed and legacy mechanisms must both be considered');
assert.equal(selectFigureMechanism('观察采样温度与随机抽样'), 'sampler', 'a broad legacy alias does not make one mechanism ambiguous');
assert.equal(selectPageFigureMechanism('# 分类阈值与现金流\n正文'), undefined);
assert.equal(selectPageFigureMechanism('# 加权评分\n```md\n# 现金流\n```'), 'scorer');
assert.equal(selectFigureMechanism('阅读一篇有关人类心理的文章'), undefined);
assert.equal(await loadFigureMechanismGuidance(undefined), '');

Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});
const records = new Map<string, FigureArtifact>();
const api = {read:async(key:string)=>records.get(key)||null,write:async(key:string,value:FigureArtifact)=>{records.set(key,value)},open:async()=>({processId:1}),bounds:async()=>{},visible:async()=>{},close:async()=>{},onFailure:()=>()=>{}};
const html = '<input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换个情境</p>';
for (const [id, goal, marker] of [cases[1],cases[6],cases[12],cases[14]] as const) {
  const body = `# 合成教材\n${goal}`;
  await prepareInteractiveFigure(await interactiveFigureKey(id,body,goal),body,goal,false,{api,generate:async request=>{
    assert.ok(request.systemPromptOverride?.includes(marker));
    assert.ok(request.systemPromptOverride?.includes('一次有效操作'));
    assert.ok(!request.systemPromptOverride?.includes('说明资金来源'), 'unselected guidance is not sent');
    return {content:JSON.stringify({design:{anchor:goal,goal,action:'调整条件',observation:'观察变化',model:'示意规则',prediction:'预测',caveat:'示意',transfer:'迁移'},html})};
  }});
}
console.log(`PASS ${cases.length} upstream mechanism routes, scoped disclosure, ambiguity fallback and generation contract; synthetic only`);
