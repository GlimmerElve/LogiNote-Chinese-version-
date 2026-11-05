import type { S2PluginManifest } from '../../types/sceneS2Plugin';
export const S2_MODEL_TEST_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'model-test', version: '1.0.0', label: '受控模型测试',
  meaning: '点击测试，把当前完整提示词与可选输入发送给已配置模型。真实模型调用与本地文本装配分离；返回文本不代表满足业务指标。',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [],
  capabilities: [{ id: 'generate', kind: 'action', effect: 'external', permissions: ['model-call'], confirmation: 'per-call', retry: 'manual-only', timeoutMs: 120000,
    meaning: '每次点击测试执行一次当前提示词与资料的请求，程序绑定模型并检查运行限制。不注入画像、笔记或主持规则，不自动重试或增加评审调用；截断、拒绝、工具调用或不确定结束状态不发布成功产物。',
    inputs: [
      { id: 'prompt', label: '完整待测提示词', meaning: '原样作为system prompt，不能以摘要代替；最多6000字。', type: { id: 'core.text', version: 1 }, required: true, multiple: false },
      { id: 'input', label: '待处理文本／资料', meaning: '需要模型处理的文本原文，可来自内容块或只读资料；原样作为user input，省略时为空；最多6000字，不是另一份提示词。', type: { id: 'core.text', version: 1 }, required: false, multiple: false },
      { id: 'image', label: '可选原始图片', meaning: '仅接本局明确选择的原图句柄；不把路径、URL或base64当文本，不自动OCR，不更换不支持图片的模型。', type: { id: 'core.image', version: 1 }, required: false, multiple: false },
      { id: 'maxOutputTokens', label: '输出长度', meaning: '可选整数输出 tokens 上限，256至当前运行上限；省略沿用配置默认值。', type: { id: 'core.number', version: 1 }, required: false, multiple: false },
      { id: 'temperature', label: '随机性', meaning: '可选0至2有限数，原值作为temperature传输；省略沿用既有工作流默认，不保证所有模型接受。', type: { id: 'core.number', version: 1 }, required: false, multiple: false },
      { id: 'thinkingMode', label: '思考', meaning: '可选enabled或disabled；省略按模型默认。仅已配置传输明确支持时可设置，否则本地拒绝，不静默忽略。', type: { id: 'core.text', version: 1 }, required: false, multiple: false },
    ],
    outputs: [{ id: 'text', label: '完整模型文本', meaning: '真实模型返回的完整原始文本，最多6000字；不代表通过评价指标或用户认可。', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
  }],
};

