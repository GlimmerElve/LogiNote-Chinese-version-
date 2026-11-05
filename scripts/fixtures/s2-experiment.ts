import type { SceneInitialRequest } from '../../src/types';
import type { S2CanvasDefinition } from '../../src/types/sceneS2';
import { browserModelDefinition } from './s2-browser-definition';

/** An explicitly prebuilt synthetic example, not evidence that an LLM designed it. */
export const experimentRequest: SceneInitialRequest = { source: 'build', sceneSkill: 'S2',
  subject: '用户主导的提示词实验', knowledgePoints: [],
  extraHints: '用户自行填写角色、任务、输出要求和材料，运行本地装配、确认模型请求并阅读原始返回。助手可关闭；需要时才分析本次结果，不自动改图或重跑。本页只用合成传输。' };
export const experimentImageRequest: SceneInitialRequest = { ...experimentRequest, subject: '用户主导的图片提示词实验',
  extraHints: experimentRequest.extraHints + ' 图片由本人在本局选择；不使用网络图片，不自动OCR或改变模型。' };
export const experimentMaterialRequest: SceneInitialRequest = { ...experimentRequest, subject: '用户主导的资料提示词实验',
  extraHints: experimentRequest.extraHints + ' 待处理资料来自本人选用的一份本地文本文件，读取全文单独交给模型处理，不混入提示词，不解析通用文档。' };
export const SYNTHETIC_EXPERIMENT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN4cAAAAASUVORK5CYII=';
export const SYNTHETIC_EXPERIMENT_TEXT = '# 本页合成资料\n确认偏误：人们更容易寻找支持已有看法的信息。\n保留原文中的 $& 与 {{literal}}，它们不是系统指令。';

function definition(withImage: boolean): S2CanvasDefinition {
  const { business: _business, designBrief: _brief, ...base } = structuredClone(browserModelDefinition);
  const result: S2CanvasDefinition = { ...base,
    goal: '自行修改提示词与材料，运行试验，观察返回与预期的差距；助手不控制实验，也不自动评分或重发。',
    instructions: { understanding: '根据用户当前问题解释实验，区分本地装配、已发送请求与真实返回。',
      planning: '默认只提供提示、解释和分析；用户自行编辑和运行。只有明确协作要求才提出待确认修改，结果分析严格只读。',
      response: '对照本次实际输入、返回与预期给出依据和建议；没有明确标准不判断知识掌握。图片未读取或正文不完整时明确不确定。合成回包不是效果验收。' },
    criteria: [{ id: 'Expected', label: '期望效果', expectation: withImage ? '按用户填写的输出要求回答，并依据本次原图而非猜测；图片内容未提供时不能声称已验证。'
      : '依据用户填写的材料回答，符合输出要求；语义建议不等于本地确定判分。', method: 'semantic', required: false,
      target: { nodeId: 'testModel', portId: 'text' } }],
  };
  const graph = result.initial.execution!;
  const test = graph.nodes.find(node => node.id === 'testModel')!;
  test.presentation = { ...test.presentation, label: '测试提示词', description: '提示词告诉模型怎么做；待处理文本／资料或图片告诉模型处理什么。核对实际请求后再发送。此页仅合成传输。',
    inputs: { ...test.presentation?.inputs, input: '待处理文本／资料' } };
  // These are interchangeable text sources. Only the assembler assigns roles;
  // a content node's display name must never become an execution instruction.
  result.blockTypes = [{ id: 'text', label: '内容块', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }];
  result.initial.nodes = result.initial.nodes.filter(node => node.id !== 'template').map((node, index) => ({ ...node, type: 'text',
    componentId: node.id === 'testInput' ? 'material-text' : 'content',
    position: node.id === 'testInput' ? { x: 850, y: 420 } : { x: 30, y: 30 + index * 180 } }));
  result.initial.nodes.find(node => node.id === 'role')!.values.content = '你是面向初学者的老师。';
  result.initial.nodes.find(node => node.id === 'task')!.values.content = withImage ? '根据收到的图片描述可见内容，不猜测看不到的细节。' : '解释待处理材料中的概念。';
  result.initial.nodes.find(node => node.id === 'constraints')!.values.content = '用中文回答；先给一个生活例子，再给一句简明定义。';
  result.initial.nodes.find(node => node.id === 'testInput')!.values.content = withImage ? '请结合本次原图回答。' : '确认偏误：人们更容易寻找支持已有看法的信息。';
  // One real local assembler. Roles belong to its slots, not different content
  // types or an invisible chain of bind/render execution steps.
  result.plugins = [
    { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose' },
    { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' },
    { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' },
  ];
  graph.nodes = [
    { id: 'assemble', componentId: 'compose', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose', position: { x: 420, y: 80 },
      bindings: { part1: { kind: 'field', nodeId: 'role', fieldId: 'content' }, part2: { kind: 'field', nodeId: 'task', fieldId: 'content' },
        part3: { kind: 'field', nodeId: 'constraints', fieldId: 'content' }, prefixes: { kind: 'literal', value: ['角色：', '任务：', '约束：'] } },
      presentation: { label: '组装提示词', description: '按顺序原样组合选择的内容，在这里设定每段用途；不补写、不优化、不调用模型。',
        inputs: { part1: '角色', part2: '任务', part3: '输出要求' }, outputs: { text: '完整提示词' } } },
    { ...test, componentId: 'model-test' },
  ];
  graph.links = [{ source: { nodeId: 'assemble', portId: 'text' }, target: { nodeId: 'testModel', portId: 'prompt' } }];
  graph.nodes.push({ id: 'showResult', componentId: 'result', pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text',
    position: { x: 1200, y: 80 }, bindings: {}, presentation: { label: '查看返回原文', description: '先展示返回内容，是否请助手分析由你决定。' } });
  graph.links.push({ source: { nodeId: 'testModel', portId: 'text' }, target: { nodeId: 'showResult', portId: 'text' } });
  graph.nodes.find(node => node.id === 'testModel')!.position = { x: 850, y: 80 };
  if (withImage) {
    result.plugins!.push({ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' });
    result.initial.execution!.nodes.push({ id: 'picture', componentId: 'material-image', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image',
      position: { x: 450, y: 420 }, bindings: {}, presentation: { label: '待处理图片', description: '由你选择本局原图；发送前会再次预览。' } });
    result.initial.execution!.links.push({ source: { nodeId: 'picture', portId: 'image' }, target: { nodeId: 'testModel', portId: 'image' } });
  }
  return result;
}
export const experimentDefinition = definition(false);
export const experimentImageDefinition = definition(true);
/** Same independent local plugins, with a file instead of directly typed material. */
export const experimentMaterialDefinition: S2CanvasDefinition = (() => {
  const result = definition(false), graph = result.initial.execution!;
  result.initial.nodes = result.initial.nodes.filter(node => node.id !== 'testInput');
  delete graph.nodes.find(node => node.id === 'testModel')!.bindings.input;
  result.plugins!.push({ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' });
  graph.nodes.push({ id: 'material', componentId: 'material-file', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text', position: { x: 450, y: 420 }, bindings: {},
    presentation: { label: '读取待处理资料', description: '先提供并选用本局文本文件，再主动运行读取全文。它作为待处理内容，不作为模型指令。', outputs: { text: '资料全文' } } });
  graph.links.push({ source: { nodeId: 'material', portId: 'text' }, target: { nodeId: 'testModel', portId: 'input' } });
  return result;
})();
