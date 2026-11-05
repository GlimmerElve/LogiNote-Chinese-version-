import type { SceneInteractionPack, ScenePackActivationServices, ScenePackConfig, SceneInteractionRuntime, ScenePackViewContext } from '../../src/types/sceneInteractionPack';
import type { S2PluginPort, S2PluginOutcome } from '../../src/types/sceneS2Plugin';
import type React from 'react';

// Deliberately independent of prompt-lab, its runtime, and the terminal's implementation.
const port = (id: string, type: string): S2PluginPort => ({ id, label: id, meaning: id,
  type: { id: type, version: 1 }, required: true, multiple: false });
export function activate(services: ScenePackActivationServices): SceneInteractionPack {
  const ui = services.ui.react as typeof React;
  return {
    manifest: { protocolVersion: 1, id: 'arithmetic-lab', version: '1.0.0', name: '本地加法验收包',
      paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
    describe: () => ({ purpose: '计算两个有限数值的和，无模型服务。',
      components: [{ id: 'sum', name: '求和', purpose: '输出两数之和的文本', configuration: 'a、b 为数值 literal', example: { a: 2, b: 3 } }],
      combinations: ['arithmetic/sum.text → structured-view/text.text'],
      operations: [{ id: 'run', description: '执行计算图', parameters: 'targets：目标节点ID', errors: ['INVALID_CONFIG'] },
        { id: 'explainFormula', description: '说明此包的公式', parameters: '无', errors: [] }],
      builder: { assemble: '只使用加法及文本展示；数值为字面量。', repair: '修复数字输入及输出连线。' },
      assistant: { instructions: '说明用户的计算图。', defaultAllowedOperations: ['explainFormula'] } }),
    validate: config => config.document.execution?.nodes.some(node => node.pluginId === 'arithmetic') ? []
      : [{ path: '/document/execution', message: '缺少求和节点' }],
    capabilities: [{ protocolVersion: 1, id: 'arithmetic', version: '1.0.0', label: '本地数值计算', meaning: '纯数值运算',
      dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'sum', kind: 'transform',
        meaning: '两个有限数值相加后转成原样文本', inputs: [port('a', 'core.number'), port('b', 'core.number')],
        outputs: [port('text', 'core.text')], effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }] }],
    views: { 'arithmetic/sum': {
      settings: (props: { node: { id: string } }) => ui.createElement('div', null, '求和设置：' + props.node.id),
      // The independent fixture owns its Run affordance, just like real packs.
      // It delegates to the actual host; no test-only calculation/result injection.
      inline: (props: ScenePackViewContext) => ui.createElement('button', { type: 'button', disabled: !props.execution?.enabled,
        onClick: () => { props.guard(); props.execution?.run(['show']); } }, '计算并显示'),
    } },
    async executeLocal(call, inputs): Promise<S2PluginOutcome> {
      const a = inputs.a?.[0], b = inputs.b?.[0];
      if (call.pluginId !== 'arithmetic' || call.capabilityId !== 'sum' || typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a + b))
        return { status: 'failed', outputs: {}, error: { code: 'INVALID_NUMBERS', message: '输入须为有限数值' } };
      return { status: 'succeeded', outputs: { text: [{ protocolVersion: 1, id: 'arithmetic-' + crypto.randomUUID(),
        type: { id: 'core.text', version: 1 }, complete: true,
        source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
        payload: { kind: 'inline', value: String(a + b) } }] } };
    },
    createRuntime(config, host) {
      host.validateConfig(config);
      let active = true;
      const run: SceneInteractionRuntime['run'] = (targets, notify, options) => {
        if (!active) throw new Error('CLOSED');
        return host.run(targets, notify, options);
      };
      return { run, updateConfig(next) { host.applyConfig(next); },
        dispatch(operation, input) {
          if (!active) throw new Error('CLOSED');
          if (operation === 'explainFormula') return 'a + b';
          if (operation === 'readState') return host.readConfig();
          if (operation === 'run') return run(input?.targets);
          throw new Error('UNKNOWN_OPERATION');
        },
        dispose() { if (active) { active = false; host.close(); } } };
    },
  };
}
export const arithmeticConfig: ScenePackConfig = {
  definition: { version: 1, goal: '计算 2 + 3',
    instructions: { understanding: '读取数值', planning: '运行计算', response: '说明结果' },
    blockTypes: [{ id: 'note', label: '笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins: [{ pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' },
      { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' }],
    initial: { nodes: [], edges: [], execution: { version: 1, nodes: [
      { id: 'sum', pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum', position: { x: 0, y: 0 },
        bindings: { a: { kind: 'literal', value: 2 }, b: { kind: 'literal', value: 3 } } },
      { id: 'show', pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text', position: { x: 400, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'sum', portId: 'text' }, target: { nodeId: 'show', portId: 'text' } }] } } },
  get document() { return structuredClone(this.definition.initial); },
};
