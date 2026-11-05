import type { S2WorkflowNode } from '../../types/sceneS2';
import type { S2PluginNode, S2PluginPort } from '../../types/sceneS2Plugin';
import { s2BuiltinPluginRegistry, s2CapabilityKey } from './sceneS2PluginRegistry';
import { s2NodeTitle, s2NodeDescription, s2PortLabel } from './sceneS2Presentation';
import { sceneInteractionPacks } from './sceneInteractionPacks';

type Ref = Omit<S2PluginNode, 'id'> & Pick<S2WorkflowNode, 'presentation'> & Partial<Pick<S2WorkflowNode, 'bindings'>>;
type Usage = { when: string; example: string; difference: string };
// Reviewed help for exact installed releases. Never a binding/default, authority or executable example.
const usage: Record<string, Usage> = {
  'local-material@1.0.0/read-text': {
    when: '需要把自己在本局选择的文本文件作为后续材料时。',
    example: '示例：选择一份合成记录的 JSON 文件，运行读取后，再接“读取结构化内容”转换。',
    difference: '选择文件只是提供本局范围；确认运行后才读正文。不读取任意路径、目录或其他文件，读取的文字也不自动成为表格。',
  },
  'local-material@1.0.0/read-image': {
    when: '希望把自己选择的一张本地图片作为试验材料，交给支持图片的模型时。',
    example: '示例：直接在图片节点选择一张本地示意图，连接到“测试提示词”的图片入口；发送前仍能核对原图。',
    difference: '传递原图，不做OCR或转成文字；不是任意路径或网络图片下载。图片权限仅在本局有效，模板不携带图片字节或授权，模型须明确支持图片。',
  },
  'project-notes@1.0.0/read-text': {
    when: '需要使用进入场景时所选项目中，自己逐项允许的知识笔记时。',
    example: '示例：允许一篇项目笔记，为读取步骤选用它，确认运行后将完整文字交给后续步骤。',
    difference: '不是全库搜索或 RAG。只读本局允许的项目知识笔记；笔记更新或移出后要重新核对，模板不恢复授权。',
  },
  'structured-data@1.0.0/parse-json': {
    when: '手里是 JSON 格式的文字，需要让后续步骤按字段处理，而不是只显示原文时。',
    example: '示例：文字 [{"姓名":"小林","分数":80}] 解析后成为一条可继续处理的记录；再接“整理为表格”。',
    difference: '与“检查 JSON 格式”不同，成功后会输出可处理的数据。不自动修补错误，也不判断记录是否符合业务要求。',
  },
  'structured-data@1.0.0/select': {
    when: '只需要数据中的某个字段、一条记录或一个局部时。',
    example: '示例：数据为 {"姓名":"小林"}，查看当前材料的字段，再选择“姓名”并明确应用；单独运行后得到“小林”。也可以选择整体数据。',
    difference: '按明确位置取内容，不是按自然语言筛选记录、搜索资料或自动猜字段。固定材料或当前完整结果可按名称选择，未知结构不自动运行；自定义路径和动态来源保留高级编辑。',
  },
  'structured-data@1.0.0/stringify': {
    when: '上一步得到结构化数据，需要变成文字供提示词或其他文本步骤使用时。',
    example: '示例：将 {"分数":80} 转成文字“{"分数":80}”，文字中的数字和字段保持原有含义。',
    difference: '这是数据转文字，与“读取结构化内容”的方向相反；不调用模型解释、概括或改写内容。',
  },
  'structured-data@1.0.0/to-table': {
    when: '已经得到多条记录，想把每条记录作为一行查看时。',
    example: '示例：[{"姓名":"小林","分数":80}] 整理后得到“姓名、分数”两列和一行记录。',
    difference: '只接受字段值为文本、数字、布尔或空值的记录列表，不直接接 JSON 文字，不自动展开嵌套对象或筛选不合格记录。',
  },
  'structured-data@1.0.0/table-to-json': {
    when: '已有表格结果，需要还原成记录列表继续提取或转为文字时。',
    example: '示例：把“姓名、分数”的一行表格还原成 [{"姓名":"小林","分数":80}]。',
    difference: '与“整理为表格”方向相反；保留缺失字段与空值的区别，不是读取任意电子表格文件。',
  },
  'structured-view@1.0.0/json-tree': {
    when: '想展开查看结构化数据中有哪些层级和字段时。',
    example: '示例：接上解析后的记录，展开第一条记录查看姓名和分数。',
    difference: '这是只读展示，没有新的处理输出；查看或展开不等于修改、筛选或验证数据。',
  },
  'structured-view@1.0.0/text': {
    when: '需要直接阅读上一处理步骤或模型返回的原始文字时。',
    example: '示例：把“测试提示词”的返回文字连接到这里，运行后先看原文；需要建议时再请助手分析。',
    difference: '只负责原样展示，不改写内容、不执行HTML，也不要求Agent先审查。展示成功不代表模型答案正确或符合预期。',
  },
  'structured-view@1.0.0/table': {
    when: '已有规范表格结果，希望查看行列或选择数值列看图表时。',
    example: '示例：将“整理为表格”的结果接入，查看记录，或选择分数列看柱状图。',
    difference: '只负责展示，不把 JSON 文字自动转成表格，不执行额外模型调用。表格预览可能省略行，不会截断下游原始数据。',
  },
  'json-check@1.0.0/validate': {
    when: '只想先检查一段文字是否符合 JSON 格式时。',
    example: '示例：{"分数":80} 格式可通过，{分数:80} 缺少字段名引号；修改后再检查。',
    difference: '输出格式检查结果，不输出解析后的记录；格式正确不代表姓名、分数或业务规则正确。',
  },
  'human-input@1.0.0/text': {
    when: '流程需要停下来，让参与者补充一句解释或一段文字时。',
    example: '示例：要求“请说明选择这个方案的理由”，运行到这里后等待你填写，再把回答交给后续步骤。',
    difference: '与普通内容块不同，它是运行中的等待入口。回答只能由用户提交，Agent 不替你回答，也不会新增工具授权。',
  },
  'human-input@1.0.0/json': {
    when: '流程需要等待用户提交有结构的回答，如一条记录或一组参数时。',
    example: '示例：要求补充 {"数量":2}；场景有专属表单时按名称填写，否则使用完整 JSON。格式错误会保留草稿和等待。',
    difference: '与“填写回答”不同，输出的是可继续处理的数据，而不是普通文字；专属表单是否存在取决于场景配置。',
  },
  'human-input@1.0.0/confirm': {
    when: '希望参与者明确同意或拒绝，再由条件分支决定后续路径时。',
    example: '示例：询问“是否采用这个方案”，你选择同意或拒绝；后续节点须另设对应条件，不会因为同意自动配置分支。',
    difference: '这是对此次问题的选择，不是模型、文件或插件授权；也不表示已完成审核或执行真实业务。',
  },
  'workflow-simulation@1.0.0/step': {
    when: '想演练一个暂不连接真实服务的业务步骤，并明确记录假设和预设结果时。',
    example: '示例：目的写“演练审核”，假设写“仅用示例”，预设输出写 {"通过":true}；结果记录的是这份预设，而非自动审核。',
    difference: '不会根据输入自动推导业务结果，也不调用外部系统。改变输入后，应重新核对假设与预设输出。',
  },
  'workflow-simulation@1.0.0/inspect': {
    when: '已有模拟轨迹，想查看每一步假设、输入与预设输出时。',
    example: '示例：接上两个“模拟一个步骤”串接的结果，逐步查看预设如何传递。',
    difference: '只读模拟过程，没有新输出，不是执行日志中的真实业务成功证明。',
  },
  'workflow-merge@1.0.0/merge-json': {
    when: '多个互斥条件分支都可能提供数据，但每次只允许一路继续时。',
    example: '示例：两条数据分支只有一条命中条件，将它的结果原样交给下游；两条同时命中则报冲突。',
    difference: '不是把多份数据拼接成列表，也不自动择优或忽略失败；候选必须是同类结构化数据。需运行所选执行图。',
  },
  'workflow-merge@1.0.0/merge-assessment': {
    when: '互斥分支分别产生检查结果，需要转交本次唯一命中的那份时。',
    example: '示例：不同条件下使用不同格式检查，只有一路命中，将该路检查结果继续传递。',
    difference: '不会合并评分、投票或把失败变通过；不能接普通记录或模拟轨迹。需运行所选执行图。',
  },
  'workflow-merge@1.0.0/merge-simulation': {
    when: '互斥模拟分支需要汇成一条继续展示的模拟轨迹时。',
    example: '示例：两条假设分支只有一条命中，保留该路完整模拟轨迹供查看。',
    difference: '输出仍是模拟，不会转成真实业务结果；不是合并多条轨迹。需运行所选执行图。',
  },
};
const typeNames: Record<string, string> = { 'core.text': '文字', 'core.image': '本局原图', 'structured-data.value': '结构化数据',
  'structured-data.table': '表格', 'core.assessment': '检查结果', 'human-input.decision': '用户选择', 'workflow-simulation.result': '模拟轨迹' };
function category(ref: Ref, kind: string) {
  const custom = sceneInteractionPacks.capabilityHelp(ref)?.category;
  if (custom) return custom;
  if (['local-material', 'project-notes'].includes(ref.pluginId)) return '读取资料';
  if (kind === 'human') return '等待用户';
  if (kind === 'renderer') return '展示结果';
  if (kind === 'validator') return '检查格式';
  if (ref.pluginId === 'workflow-simulation') return '示例模拟';
  if (ref.pluginId === 'workflow-merge') return '汇合分支';
  return '整理数据';
}

/** Local descriptive data only. Ports/compatibility come from the real registry, not tutorial guesses or Agent output. */
export function s2PluginHelp(ref: Ref, allowed: Array<Omit<S2PluginNode, 'id'>>) {
  const registry = s2BuiltinPluginRegistry(), cap = registry.capability(ref);
  const custom = sceneInteractionPacks.capabilityHelp(ref), copy = custom ?? usage[s2CapabilityKey(ref)];
  const describe = (port: S2PluginPort, direction: 'inputs' | 'outputs') => ({
    label: s2PortLabel(ref, port, direction), type: typeNames[port.type.id] ?? '专用材料', required: port.required, multiple: port.multiple,
    consumers: direction === 'outputs' ? allowed.flatMap(next => {
      const target = registry.capability(next);
      return target.inputs.some(input => registry.compatible(port.type, input.type) && (!port.multiple || input.multiple)) ? [s2NodeTitle(next)] : [];
    }).filter((label, index, all) => all.indexOf(label) === index) : [],
  });
  const boundary = cap.permissions.includes('model-call') ? '会发送完整请求给模型，可能产生费用；须本局预算授权并逐次确认。'
    : ref.pluginId === 'local-material' && ref.capabilityId === 'read-image' ? '在图片节点选择后即可本地预览，不发送给模型；主动运行并确认实际请求后才发送。'
    : cap.permissions.length ? '仅使用本局明确允许的资料范围；选择不读取，确认运行后才读取。'
    : cap.kind === 'human' ? '运行到这里会等待你的真实操作；不是工具授权，Agent 不能代答。'
    : ref.pluginId === 'workflow-simulation' || ref.capabilityId === 'merge-simulation' ? '仅演练预设示例，不执行真实业务。'
    : cap.kind === 'renderer' ? '只在本地展示已有结果，不调用模型，不产生新的处理输出。'
    : '本地处理，不调用模型；添加、填写或查看帮助不会运行。';
  return { title: s2NodeTitle(ref), description: s2NodeDescription(ref), category: category(ref, cap.kind), documented: !!copy,
    when: copy?.when ?? '按当前步骤的输入要求提供材料；尚未提供专项使用示例，请先核对用途。',
    example: copy?.example ?? '', difference: copy?.difference ?? '帮助不是执行、兼容性或业务达标证明。', boundary,
    inputs: cap.inputs.filter(port => !(custom?.hideLiteralInputs?.includes(port.id) && ref.bindings?.[port.id]?.kind === 'literal'))
      .map(port => describe(port, 'inputs')), outputs: cap.outputs.map(port => describe(port, 'outputs')) };
}
export function s2PluginHelpMatches(ref: Ref, query: string) {
  const guide = s2PluginHelp(ref, []), words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Do not advertise unsupported features merely because a caveat says “not filtering / not RAG”.
  const text = [guide.title, guide.description, guide.category, guide.when,
    ...guide.inputs.map(input => input.label), ...guide.outputs.map(output => output.label)].join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}
