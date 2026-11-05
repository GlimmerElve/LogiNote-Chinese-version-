import stage1 from './documentGraphStage1';
import stage2 from './documentGraphStage2';
import stage3 from './documentGraphStage3';

export const DOCUMENT_GRAPH_PROMPT_VERSION='document-graph-draft-review-boundary-v3';

// The frozen node prompt is the single source of type meanings. Keep all baseline
// files unchanged so that the live adapter can be compared with or rolled back to them.
const start='## 节点类型（仅九类，按上下文主要功能选择）';
const end='## 切块规则';
const begin=stage1.indexOf(start),finish=stage1.indexOf(end);
if(begin<0||finish<=begin)throw new Error('document_graph_type_contract_missing');
export const DOCUMENT_GRAPH_TYPE_CONTRACT=stage1.slice(begin,finish).trim();

const reviewBoundary=`## 类型核对口径
以上类型定义与节点抽取阶段共用。判断冻结标签是否不当时，先按这套定义核对，而不是另设分类标准。
实验设计、观察数据、引用前人结论可以属于事实陈述；研究目的、来源或过渡承担材料组织作用时也可以保留为事实陈述。
报告类型问题须指出具体原文为何不符合上述定义；真实的混块、错误归类仍应报告。上一阶段的诊断也按此口径重判，不因已列入unresolved就自动保留。
这只是类型含义约定，不认证材料为真，不改变冻结节点，也不为满足标签而补线。`;

const gapContract=`## 诊断分类与补检索范围
unresolved每项为{nodeId,kind,reason}，kind仅选以下三值：
- missing_material：确实缺少具体前提、事实或被指代对象，需要从输入外找材料。reason说明缺什么；输入内材料齐全的漏边应直接修复，不列为缺材料。
- node_issue：混块、错误类型、已有文本无法消除的歧义等节点问题；不等于缺少外部材料。
- classification_note：正常分类说明，例如“该事实不属于核心主张”。通常直接省略；若保留，仅作说明，不是待修缺口。
只有missing_material触发本地跨图候选检索。引用前人结论没有展开原论文推导，不自动是缺材料。
复核上一阶段诊断后重新分类；不因先前出现在unresolved就继承为缺口。`;

function addContract(prompt:string,marker:string){
  if(prompt.split(marker).length!==2)throw new Error('document_graph_prompt_insertion_marker');
  return prompt
    .replace('unresolved: [{nodeId, reason}]','unresolved: [{nodeId, kind, reason}]')
    .replace('unresolved每项为{"nodeId":"已有节点ID","reason":"具体类型、边界、缺失对象或语义歧义及原文理由"}；无问题为空数组。',
      'unresolved每项为{"nodeId":"已有节点ID","kind":"missing_material / node_issue / classification_note三选一","reason":"具体诊断及原文理由"}；无问题为空数组。')
    .replace(marker,`${DOCUMENT_GRAPH_TYPE_CONTRACT}\n\n${reviewBoundary}\n\n${gapContract}\n\n${marker}`);
}

export const documentGraphRuntimePrompts={
  nodes:stage1,
  relations:addContract(stage2,'## 执行步骤'),
  review:addContract(stage3,'## 执行流程').replace('## 执行流程',`## 草图闭环专项任务
check=relation_cycle时，quote是系统给出的闭环组JSON，含kind、nodeIds、relationIds；这些ID指向draft中的待审关系，不是最终输出ID或指定删除答案。
回读组内各端原文，独立核对直接用途、方向和冗余；有据保留、错边修正、无据删除，不机械删最后一条或按编号选择。不改冻结节点。
decision说明该组如何处理；relationIds只引用最终关系且须连接任务nodeId，删除后无相关边可为空。无法判定的用途记入unresolved，不为凑无环造线。
最终support与explain各自必须无环，不能只在文字中报告闭环而原样保留。系统最终校验和入库不会放行闭环。

## 执行流程`),
};
