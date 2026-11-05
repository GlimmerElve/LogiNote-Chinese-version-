import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserRecordFormDefinition, browserRecordFormRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

async function settle(check: () => boolean, render: () => void) {
  for (let i = 0; i < 600; i++) { render(); if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Sidebar fixture did not settle');
}
let network = 0, modelCalls = 0;
const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Sidebar tests cannot access external IO'); };
try {
  for (const deferStateUpdates of [false, true]) {
    const definition = structuredClone(browserRecordFormDefinition);
    definition.plugins = [...definition.plugins!, { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'confirm' },
      { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' }];
    definition.initial.execution!.nodes.push(
      { id: 'review', pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'confirm', position: { x: 900, y: 100 }, bindings: { prompt: { kind: 'literal', value: '本人核对；不是模型授权' } } },
      { id: 'model', pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate', position: { x: 1300, y: 100 }, bindings: { prompt: { kind: 'literal', value: '仅合成提示词' }, input: { kind: 'literal', value: '仅合成输入' } } });
    const scene = createS2Scene(browserRecordFormRequest); scene.canvasWorkspace = readS2Definition(definition, { requireBusiness: true });
    let host!: S2PluginHost;
    const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; }, modelProvider: async () => ({
      providerLabel: 'Synthetic', model: 'synthetic-sidebar', resourceId: 'sidebar-resource', supportsImages: false,
      createSession(sceneId, runId, limits) { return new S2ModelTestSession({ sceneId, runId, limits, resourceId: 'sidebar-resource',
        providerId: 'synthetic', providerLabel: 'Synthetic', model: 'synthetic-sidebar', invoke: async () => {
          modelCalls++; throw new Error('Navigation must never invoke a model');
        } }); },
    }) });
    try {
      const root = () => ui.elements().find(e => e.type === 'aside' && String(e.props.className).split(' ').includes('s2-sidebar'))!;
      const area = (name: string) => ui.elements().find(e => e.props['aria-label'] === name)!;
      const ancestorPath = (target: any, node: any = ui.elements()[0], parents: any[] = []): any[] | null => {
        if (Array.isArray(node)) { for (const child of node) { const path = ancestorPath(target, child, parents); if (path) return path; } return null; }
        if (!node || typeof node !== 'object') return null;
        if (node === target) return parents;
        for (const child of node.children ?? []) {
          for (const value of Array.isArray(child) ? child : [child]) {
            if (value && typeof value === 'object') { const path = ancestorPath(target, value, [...parents, node]); if (path) return path; }
          }
        }
        return null;
      };
      const outsideDisclosures = (target: any) => {
        const ancestors = ancestorPath(target); assert.ok(ancestors); assert.ok(!ancestors.some(e => e.type === 'details'), 'Required controls cannot be nested in collapsed management');
      };
      assert.ok(root()); assert.ok(area('选择与填写')); assert.ok(area('运行与等待操作'));
      assert.ok(!ui.elements(root()).some(element => ['选择与填写', '运行与等待操作', '组合与蓝图管理', '添加处理步骤'].includes(element.props['aria-label'])),
        'The persistent right sidebar is assistance only; editing/running/library controls live in explicit canvas panels');
      for (const name of ['组合与蓝图管理', '添加处理步骤']) {
        assert.equal(area(name).type, 'details'); assert.notEqual(area(name).props.open, true);
      }
      for (const name of ['选择执行节点', '选择块']) outsideDisclosures(ui.labelControl(name, 'select'));
      outsideDisclosures(area('模型测试授权与用量'));
      outsideDisclosures(ui.elements().find(e => e.type === 'details' && ui.text(e).startsWith('确认本局能力范围'))!);
      assert.deepEqual(ui.elements(area('画布工具')).filter(element => element.type === 'button').map(element => ui.text(element)), ['添加', '运行', '更多']);
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
      const checkHelpBoundary = (boundary: string) => {
        const help = area('当前步骤的使用帮助'), details = ui.elements(help).find(e => e.type === 'details')!;
        assert(details); assert.equal(details.props.open, undefined);
        assert.ok(help.children.some((child: any) => child?.type === 'p' && ui.text(child).includes(boundary)), 'Critical boundary remains outside the optional help');
        assert.ok(!ui.elements(details).some(e => ['input', 'textarea', 'select', 'button', 'human-input', 'json-parameter'].includes(String(e.type))));
        return details;
      };
      const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
      const ledger = () => structuredClone([document(), host.history(), host.workflowHistory(), host.remainingCalls, host.modelTestSummary(), ui.modelCalls(), modelCalls]);
      focus('recordView'); ui.button('运行所选步骤').props.onClick();
      await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      focus('review'); checkHelpBoundary('Agent 不能代答');
      ui.button('运行所选步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      ui.button('准备本局模型测试（不发送）').props.onClick(); await settle(() => ui.text().includes('核对并批准本局预算'), ui.render);
      ui.button('批准本局模型测试预算（仍逐次确认）').props.onClick(); ui.render();
      focus('model'); checkHelpBoundary('费用'); ui.button('运行所选步骤').props.onClick(); await settle(() => host.waitingModelTests().length === 1, ui.render);
      outsideDisclosures(ui.elements().find(e => e.type === 'human-input'));
      outsideDisclosures(ui.button('确认发送本次模型请求'));
      outsideDisclosures(ui.button('拒绝本次模型请求'));
      assert.equal(host.modelTestSummary()!.usedRequests, 0); assert.equal(modelCalls, 0);
      const human = ui.elements().find(e => e.type === 'human-input')!;
      human.props.drafts.set('sidebar-private-draft', { raw: '尚未提交的本人草稿' });
      focus('recordRows');
      const parameter = ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'recordRows')!;
      parameter.props.drafts.set('sidebar-private-parameter', { raw: '尚未应用的材料' });
      const before = ledger(), humanDraft = JSON.stringify([...human.props.drafts]), parameterDraft = JSON.stringify([...parameter.props.drafts]);
      const helpDetails = checkHelpBoundary('不调用模型');
      assert.equal(helpDetails.props.onToggle, undefined, 'Native help disclosure has no dispatch handler');
      ui.render();
      assert.deepEqual(ledger(), before); assert.equal(JSON.stringify([...parameter.props.drafts]), parameterDraft);
      ui.button('添加').props.onClick(); ui.render(); assert.equal(area('添加处理步骤').props.open, true);
      for (const name of ['更多', '运行记录与授权']) { ui.button(name).props.onClick(); ui.render(); }
      assert.deepEqual(ledger(), before); assert.equal(JSON.stringify([...human.props.drafts]), humanDraft); assert.equal(JSON.stringify([...parameter.props.drafts]), parameterDraft);
      const mode = ui.elements().find(e => e.type === 'label' && ui.text(e) === '重新计算，不使用已有结果')!;
      ui.elements(mode).find(e => e.type === 'input')!.props.onChange({ target: { checked: true } }); ui.render();
      assert.ok(ui.text().includes('下次运行会重新计算')); assert.deepEqual(ledger(), before);
      ui.labelControl('选择块', 'select').props.onChange({ target: { value: document().nodes[0].id } }); ui.render();
      const selectedContent = ui.flow().props.nodes.find((node: any) => node.id === document().nodes[0].id);
      ui.flow().props.onNodeClick({}, selectedContent); ui.render();
      assert.equal(area('所选内容说明').props.open, true, 'Selecting a content node opens its real canvas editor without changing the document');
      human.props.onSubmit(false, 'form'); await settle(() => host.waitingHumanInputs().length === 0, ui.render);
      assert.equal(host.waitingModelTests().length, 1); assert.equal(modelCalls, 0);
      ui.button('拒绝本次模型请求').props.onClick(); await settle(() => host.waitingModelTests().length === 0, ui.render);
      assert.equal(host.modelTestSummary()!.usedRequests, 0); assert.equal(host.remainingCalls, 63);
      ui.button('结束试验').props.onClick(); ui.render(); assert.equal(modelCalls, 0);
    } finally { ui.dispose(); }
  }
  assert.equal(network, 0);
  console.log('S2 sidebar passed: assistant-only persistent sidebar, explicit five-action canvas toolbar and library panels, collapsed non-unmounting management, real content-node navigation, future force mode, separate human/model confirmations, and unchanged design/private drafts/history/budgets under ordinary/deferred hooks. Synthetic offline only; native disclosure, keyboard, scroll and layout require browser evidence. Zero model/network calls.');
} finally { globalThis.fetch = previous; }
