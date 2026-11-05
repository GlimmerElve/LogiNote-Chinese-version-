import type { ScenePackAuthoringCatalog, ScenePackPublicComponent } from '../../types/sceneInteractionPack';

const group = (id: string, label: string) => ({ id, label });
const content = (id: string, label: string, purpose: string, category: { id: string; label: string }): ScenePackPublicComponent => ({
  id, label, purpose, group: category,
  implementation: { kind: 'content', blockType: { id: 'text', label: '内容块', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] } },
  inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' },
});
const capability = (id: string, label: string, purpose: string, category: { id: string; label: string }, pluginId: string, capabilityId: string,
  inputs: string[], outputs: string[], parameters: string[], defaults?: ScenePackPublicComponent['defaults']): ScenePackPublicComponent => ({
  id, label, purpose, group: category, implementation: { kind: 'capability', pluginId, pluginVersion: '1.0.0', capabilityId },
  inputs, outputs, parameters, ...(defaults ? { defaults } : {}),
});

/** One machine directory shared by the canvas menu and building Agent.
 * Seven concrete types form five logical groups; full private implementations
 * (including legacy template helpers) remain in the runtime registry. */
export const promptLabAuthoring: ScenePackAuthoringCatalog = {
  version: 1,
  components: [
    content('content', '内容块', '编辑一份文字，通过连线提供给其他公开块。', group('content', '内容块')),
    capability('compose', '提示词组装块', '按预设槽位与结构拼接所连内容。', group('assembly', '提示词组装块'), 'text-template', 'compose',
      Array.from({ length: 8 }, (_, index) => `part${index + 1}`), ['text'], ['prefixes', 'separator'], { prefixes: ['角色：', '任务：', '输出要求：'], separator: '\n' }),
    capability('model-test', '提示词测试块', '测试当前所连的完整提示词与待处理资料。', group('model', '提示词测试块'), 'model-test', 'generate',
      ['prompt', 'input', 'image'], ['text'], ['maxOutputTokens', 'temperature', 'thinkingMode']),
    capability('result', '结果展示块', '显示所连模型返回的完整文字。', group('results', '结果展示块'), 'structured-view', 'text', ['text'], [], []),
    content('material-text', '待测文字资料', '编辑待处理的文字资料，连接测试块的资料入口。', group('materials', '待测资料块')),
    capability('material-file', '待测文本文件', '在本局选择文本文件，原文连接测试块的资料入口。', group('materials', '待测资料块'), 'local-material', 'read-text',
      [], ['text'], ['resource']),
    capability('material-image', '待测图片', '在本局选择原始图片，连接测试块的图片入口。', group('materials', '待测资料块'), 'local-material', 'read-image',
      [], ['image'], ['resource']),
  ],
};
