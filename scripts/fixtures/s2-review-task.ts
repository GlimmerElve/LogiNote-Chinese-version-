import type { SceneInitialRequest } from '../../src/types';
import type { S2CanvasDefinition, S2Document } from '../../src/types/sceneS2';
import { S2ProjectNoteSource } from '../../src/services/scene/sceneS2ProjectNotes';
import { browserFreeTemplateDefinition } from './s2-browser-definition';

/** Acceptance data only. No notebook, persistence, model transport or real resources. */
export const reviewTaskText = '合成参考资料：检索增强生成先找相关资料，再把资料交给模型。\n示例符号 $& 与 {{literal}} 保持原文。';
export const reviewTaskState = { reads: 0, version: 'v1' };
export const reviewTaskSource = new S2ProjectNoteSource({ projectId: 'synthetic-review-project',
  list: () => [{ noteId: 'reference-note', label: '提示词练习参考资料（合成）', updatedAt: reviewTaskState.version }],
  read: async noteId => { reviewTaskState.reads++;
    if (typeof window !== 'undefined') window.dispatchEvent?.(new Event('s2-review-read'));
    return { noteId, updatedAt: reviewTaskState.version, text: reviewTaskText }; },
});
export const reviewTaskRequest: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', knowledgePoints: [],
  subject: '合成浏览器验收：选资料、自由排版与人工核对', taskBinding: { noteId: 'synthetic-review-project' },
  extraHints: '只选用本局允许的合成项目笔记；按名称编辑模板，应用后单独装配。人工核对完整文本，同意和不同意进入显式条件分支；确认不是模型授权、事实核验或业务完成。保留原文，不自动评审、改图、读取或重试，不使用真实资料、网络和模型。',
};
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
function reviewDocument(reference: boolean): S2Document {
  const doc = structuredClone(browserFreeTemplateDefinition.initial), graph = doc.execution!;
  doc.nodes.find(node => node.id === 'template')!.values.content += '\n参考资料：{{reference}}';
  graph.links = graph.links.filter(link => link.target.nodeId !== 'render');
  graph.nodes.push({ id: 'readReference', ...cap('project-notes', 'read-text'), position: { x: 30, y: 1000 },
    bindings: reference ? { resource: { kind: 'literal', value: 'user-selected-reference' } } : {},
    presentation: { label: '读取练习参考资料', description: '先允许、再选用，单独运行时才读取正文；不检索其他笔记。' } },
  { id: 'bindReference', ...cap('text-template', 'bind'), position: { x: 1420, y: 400 }, bindings: { key: { kind: 'literal', value: 'reference' } },
    presentation: { label: '汇集参考资料', inputs: { value: '参考资料', variables: '角色、任务和输出要求' }, outputs: { variables: '含参考资料的材料' } } },
  { id: 'reviewText', ...cap('text-template', 'bind'), position: { x: 1780, y: 30 }, bindings: { key: { kind: 'literal', value: 'review' } },
    presentation: { label: '整理待核对文本', description: '把完整装配文本作为参考材料交给人工确认，不转换或省略正文。', inputs: { value: '完整提示词' }, outputs: { variables: '待核对完整文本' } } },
  { id: 'confirmText', ...cap('human-input', 'confirm'), position: { x: 2140, y: 30 },
    bindings: { prompt: { kind: 'literal', value: '请核对下方完整提示词。同意只保留这份文本；不同意则标记暂不确认。这里不发送模型请求、不核验内容正确性，也不新增任何权限。' } },
    presentation: { label: '人工核对完整提示词', inputs: { context: '待核对文本', prompt: '核对说明' }, outputs: { decision: '你的核对选择' } } },
  ...[true, false].map(approved => ({ id: approved ? 'acceptedText' : 'declinedText', ...cap('text-template', 'render'), position: { x: 2500, y: approved ? 30 : 400 },
    bindings: { template: { kind: 'literal' as const, value: approved ? '{{review}}' : '暂不确认，仅保留待修改文本：\n{{review}}' } },
    when: { nodeId: 'confirmText', portId: 'decision', pointer: '/approved', equals: true, match: approved },
    presentation: { label: approved ? '查看本次已确认文本' : '查看暂不确认的文本', description: '只展示本次选择及完整文字，不执行提示词或评判质量。' } })),
  );
  const wire = (from: string, output: string, to: string, input: string) => ({ source: { nodeId: from, portId: output }, target: { nodeId: to, portId: input } });
  graph.links.push(wire('bindConstraints', 'variables', 'bindReference', 'variables'), wire('readReference', 'text', 'bindReference', 'value'),
    wire('bindReference', 'variables', 'render', 'variables'), wire('render', 'text', 'reviewText', 'value'),
    wire('reviewText', 'variables', 'confirmText', 'context'), wire('reviewText', 'variables', 'acceptedText', 'variables'), wire('reviewText', 'variables', 'declinedText', 'variables'));
  return doc;
}
export const reviewTaskDefinition: S2CanvasDefinition = {
  ...structuredClone(browserFreeTemplateDefinition), goal: '在已有能力范围内选资料、按名称自由排版，再由用户核对完整文本；不同意不等于取消或失败。',
  initial: reviewDocument(false),
  plugins: [...structuredClone(browserFreeTemplateDefinition.plugins), cap('project-notes', 'read-text'), cap('human-input', 'confirm')],
  instructions: { understanding: '区分解释、填写、应用、选用资料、运行、人工核对和暂停；不从聊天推导确认。',
    planning: '按实际权限和用户表达自主选择帮助，不强制推进。本地装配、人工核对、付费授权和效果评价互不替代。',
    response: '说明完整文本及真实选择，不把不同意当失败、同意当质量通过，不自动改图、重跑或评审。' },
  business: { version: 1, purpose: '组合已有插件而非增加执行器；人工核对前必须展示实际完整装配文本，用户可讨论、拒绝或取消。',
    knowledge: [{ id: 'Types', title: '允许、装配与人工核对', content: '允许笔记不读取，选用不运行，运行才装配。文字先用汇集插件放进原生对象，再作为人工参考材料；不隐式混接不同端口类型。同意不是模型授权或质量结论。' }],
    workflow: [{ id: 'ReviewPath', goal: '自主编辑并核对完整文本', actor: 'tool', capabilities: [...structuredClone(browserFreeTemplateDefinition.plugins), cap('project-notes', 'read-text'), cap('human-input', 'confirm')],
      input: '用户明确选用的合成资料与原提示词材料', output: '完整装配文本、本次人工选择以及对应分支结果' }],
    completion: { mode: 'execution', reference: reviewDocument(true), targetNodeIds: ['acceptedText', 'declinedText'],
      coverage: [{ requirementId: 'r1', stepIds: ['ReviewPath'], nodeIds: reviewDocument(true).execution!.nodes.map(node => node.id) }] },
    criteria: [{ id: 'Boundary', label: '理解本次核对的边界', expectation: '区分材料许可、人工核对、执行状态和效果评价，仅作建议', method: 'advisory', required: false }],
  },
};

/** Empty public design; the complete private reference is a solvability witness, not a UI shortcut. */
export const manualPromptRequest: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', knowledgePoints: [],
  subject: '合成浏览器验收：从空图手搭提示词与核对分支',
  extraHints: '只提供本地汇集、提示词装配和本人确认能力。自己添加每个步骤，按中文用途填写、排版、接线及设置条件。运行后本人决定分支，保存重开是新试验，不继承旧选择或等待。不调用模型、网络或真实资料。',
};
export const manualPromptTexts = { role: '你是耐心的学习教练；保留 $& 与 {{literal}}。', task: '用一个形象的例子解释检索增强生成。' };
export const manualPromptExpected = `角色\n${manualPromptTexts.role}\n\n任务\n${manualPromptTexts.task}`;
const manualPromptTemplate = '角色\n{{material1}}\n\n任务\n{{material2}}';
const manualPromptReference: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
  { id: 'role', ...cap('text-template', 'bind'), position: { x: 0, y: 0 }, bindings: { key: { kind: 'literal', value: 'material1' }, value: { kind: 'literal', value: manualPromptTexts.role } } },
  { id: 'task', ...cap('text-template', 'bind'), position: { x: 390, y: 0 }, bindings: { key: { kind: 'literal', value: 'material2' }, value: { kind: 'literal', value: manualPromptTexts.task } } },
  { id: 'assembly', ...cap('text-template', 'render'), position: { x: 780, y: 0 }, bindings: { template: { kind: 'literal', value: manualPromptTemplate } } },
  { id: 'confirm', ...cap('human-input', 'confirm'), position: { x: 1170, y: 0 }, bindings: {} },
  ...[true, false].map(approved => ({ id: approved ? 'accepted' : 'declined', ...cap('text-template', 'render'), position: { x: 1560, y: approved ? 0 : 390 },
    bindings: { template: { kind: 'literal' as const, value: manualPromptTemplate } },
    when: { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: true, match: approved } })),
], links: [
  { source: { nodeId: 'role', portId: 'variables' }, target: { nodeId: 'task', portId: 'variables' } },
  ...['assembly', 'accepted', 'declined'].map(nodeId => ({ source: { nodeId: 'task', portId: 'variables' }, target: { nodeId, portId: 'variables' } })),
  { source: { nodeId: 'assembly', portId: 'text' }, target: { nodeId: 'confirm', portId: 'prompt' } },
] } };
export const manualPromptDefinition: S2CanvasDefinition = {
  version: 1, goal: '从空图手搭完整本地提示词和人工条件分支，保存设计后另行开始新的试验。',
  instructions: structuredClone(reviewTaskDefinition.instructions),
  blockTypes: [{ id: 'note', label: '说明块', fields: [{ id: 'content', label: '说明内容', kind: 'multiline' }] }],
  plugins: [cap('text-template', 'bind'), cap('text-template', 'render'), cap('human-input', 'confirm')],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } },
  business: { version: 1, purpose: '普通库手搭，只用现有本地能力；确认是本次文本选择，不是授权、评分或模型测试。',
    knowledge: [{ id: 'Types', title: '填写、装配与确认', content: '按用途填写原文和排版，连接真实兼容的材料。应用不运行；人工确认每次另行提交。保存只留设计，新试验不继承选择、等待或产物。' }],
    workflow: [{ id: 'ManualPrompt', goal: '自行组合提示词并核对分支', actor: 'tool', capabilities: [cap('text-template', 'bind'), cap('text-template', 'render'), cap('human-input', 'confirm')], input: '自己填写的角色和任务原文', output: '完整装配文本及本人本次选择对应的分支' }],
    completion: { mode: 'execution', reference: manualPromptReference, targetNodeIds: ['accepted', 'declined'], coverage: [{ requirementId: 'r1', stepIds: ['ManualPrompt'], nodeIds: manualPromptReference.execution!.nodes.map(node => node.id) }] },
    criteria: [{ id: 'Boundary', label: '区分装配与效果', expectation: '装配和本人确认不是模型回复或业务合格，只作解释建议。', method: 'advisory', required: false }],
  },
};
