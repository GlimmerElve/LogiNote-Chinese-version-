import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { s2PluginHelp, s2PluginHelpMatches } from '../src/services/scene/sceneS2PluginHelp';
import { s2BuiltinPluginRegistry, s2ComposableCapabilities, s2CapabilityKey } from '../src/services/scene/sceneS2PluginRegistry';
import { createS2Scene, readS2Definition, exportS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { s2PortLabel, s2NodeTitle } from '../src/services/scene/sceneS2Presentation';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserDefinition, browserRequest, browserTemplateDefinition, browserTemplateRequest, browserResourceDefinition, browserResourceRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

const registry = s2BuiltinPluginRegistry(), capabilities = s2ComposableCapabilities(), catalog = JSON.stringify(registry.catalog());
const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const oldFetch = globalThis.fetch; let requests = 0;
// Generic library search/help compatibility, independent of a package's classified add menu.
const restoreCanvasUi = useGenericS2CanvasUi();
globalThis.fetch = async () => { requests++; throw new Error('Help must not access network'); };
const uis: ReturnType<typeof harness>[] = [];
try {
  for (const entry of capabilities) {
    const cap = registry.capability(entry), guide = s2PluginHelp(entry, capabilities);
    assert.equal(guide.documented, true, `Every exact composable capability needs reviewed help: ${s2CapabilityKey(entry)}`);
    assert(guide.when && guide.example && guide.difference && guide.boundary);
    assert.equal(guide.inputs.length, cap.inputs.length); assert.equal(guide.outputs.length, cap.outputs.length);
    for (const [i, port] of cap.inputs.entries()) assert.deepEqual({ ...guide.inputs[i], consumers: [] }, {
      label: s2PortLabel(entry, port, 'inputs'), type: guide.inputs[i].type, required: port.required, multiple: port.multiple, consumers: [],
    });
    for (const [i, output] of cap.outputs.entries()) {
      const consumers = capabilities.filter(target => registry.capability(target).inputs.some(input => registry.compatible(output.type, input.type) && (!output.multiple || input.multiple))).map(s2NodeTitle);
      assert.deepEqual(guide.outputs[i].consumers, [...new Set(consumers)]);
    }
    const fresh = s2PluginHelp(entry, []);
    assert(fresh.outputs.every(port => port.consumers.length === 0), 'Help cannot list unapproved consumers');
    guide.inputs.splice(0); assert.equal(s2PluginHelp(entry, []).inputs.length, cap.inputs.length, 'Caller cannot mutate subsequent help');
  }
  assert.equal(capabilities.length, 24, 'All exact capabilities, including one-step compose, image source and literal display, need reviewed help coverage');
  assert.throws(() => s2PluginHelp({ ...ref('structured-data', 'parse-json'), pluginVersion: '9.0.0' }, []));
  assert.throws(() => s2PluginHelp(ref('invented', 'tool'), []));
  const parse = ref('structured-data', 'parse-json'), table = ref('structured-data', 'to-table');
  assert.deepEqual(s2PluginHelp(parse, [table]).outputs[0].consumers, ['整理为表格']);
  assert(s2PluginHelpMatches(ref('text-template', 'bind'), '角色'));
  const presetName = s2PluginHelp({ ...ref('text-template', 'bind'), bindings: { key: { kind: 'literal', value: 'PRIVATE_PRESET_NAME' } } }, []);
  assert(!presetName.inputs.some(port => port.label === '内容名称')); assert(!JSON.stringify(presetName).includes('PRIVATE_PRESET_NAME'));
  assert(s2PluginHelpMatches(table, '记录 表格'));
  assert(s2PluginHelpMatches(parse, '  JSON   '));
  assert(!s2PluginHelpMatches(table, '筛选'), 'Negated caveats do not advertise an unsupported purpose');
  assert(!s2PluginHelpMatches(ref('project-notes', 'read-text'), 'RAG'));
  assert(s2PluginHelp(ref('model-test', 'generate'), []).boundary.includes('费用'));
  assert(s2PluginHelp(ref('project-notes', 'read-text'), []).difference.includes('不是全库搜索'));
  assert(s2PluginHelp(ref('workflow-simulation', 'step'), []).boundary.includes('不执行真实业务'));
  assert(s2PluginHelp(ref('workflow-merge', 'merge-json'), []).difference.includes('不是把多份数据拼接'));
  assert(s2PluginHelp(ref('human-input', 'confirm'), []).boundary.includes('不能代答'));

  const makeUi = (definition: typeof browserDefinition, request = browserRequest) => {
    let host!: S2PluginHost;
    const scene = createS2Scene({ ...request, interactionPack: { id: 'prompt-lab', version: '0.1.0' } }); scene.canvasWorkspace = readS2Definition(structuredClone(definition));
    const ui = harness({ initialDraft: scene, initialRequest: request, deferStateUpdates: true, onHost(value) { host = value; } });
    uis.push(ui); return { ui, scene, host: () => host };
  };
  const { ui, scene, host } = makeUi(browserDefinition);
  const group = (label: string) => ui.elements().find(element => element.type === 'section' && element.props['aria-label'] === label)!;
  // This mirrors native disclosure visibility only; keyboard/focus/layout still need a real browser.
  const outsideDetailsText = (root: any): string => Array.isArray(root) ? root.map(outsideDetailsText).join('')
    : root && typeof root === 'object' ? root.type === 'details' ? '' : outsideDetailsText(root.children || []) : String(root ?? '');
  const compactHelp = (target: ReturnType<typeof harness>, node: any, allowed: any[]) => {
    const help = target.elements().find(element => element.type === 'section' && element.props['aria-label'] === '当前步骤的使用帮助')!;
    assert(help); assert(help.props.className.includes('s2-plugin-help-compact'));
    const details = target.elements(help).find(element => element.type === 'details')!;
    assert(details); assert.equal(details.props.open, undefined); assert.equal(details.props.key, node.id);
    assert.equal(details.props['aria-label'], '所选步骤详细帮助');
    assert.equal(target.text(target.elements(details).find(element => element.type === 'summary')), '用途、材料与示例（按需查看）');
    const guide = s2PluginHelp(node, allowed), visible = outsideDetailsText(help);
    assert(visible.includes(guide.boundary), 'Permissions/waiting/cost boundary must not be folded into optional help');
    assert(!visible.includes(guide.when)); assert(!visible.includes(guide.example));
    assert(target.text(details).includes(guide.title)); assert(target.text(details).includes(guide.when));
    assert(target.text(details).includes(guide.example)); assert(target.text(details).includes(guide.difference));
    assert(!target.elements(details).some(element => ['input', 'select', 'textarea', 'button', 'json-parameter', 'field-editor', 'human-input'].includes(String(element.type))), 'Only explanation belongs in help, never editable controls or recovery actions');
    return help;
  };
  const options = () => ui.elements(ui.labelControl('添加的执行能力', 'select')).filter(element => element.type === 'option' && element.props.value).map(element => element.props.value);
  const exportDocument = () => { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value); };
  assert(group('添加前了解这个步骤')); assert(!ui.elements(group('添加前了解这个步骤')).find(element => element.type === 'details')!.props.open);
  const initial = exportDocument(); assert.deepEqual(initial, JSON.parse(exportS2Workspace(scene.canvasWorkspace!, scene.canvasWorkspace!.initial, scene.interactionPack)));
  ui.labelControl('搜索已选能力', 'input').props.onChange({ target: { value: '记录 表格' } }); ui.render();
  assert.deepEqual(options(), ['structured-data@1.0.0/to-table']); assert(ui.text(group('添加前了解这个步骤')).includes('不自动展开嵌套对象'));
  ui.labelControl('按用途浏览', 'select').props.onChange({ target: { value: '展示结果' } }); ui.render();
  assert.equal(options().length, 0); assert.equal(ui.button('添加执行节点').props.disabled, true); assert(ui.text().includes('没有匹配的已允许步骤'));
  ui.labelControl('搜索已选能力', 'input').props.onChange({ target: { value: '' } }); ui.render();
  assert.deepEqual(options(), ['structured-view@1.0.0/table']);
  ui.labelControl('按用途浏览', 'select').props.onChange({ target: { value: '' } }); ui.render();
  ui.labelControl('搜索已选能力', 'input').props.onChange({ target: { value: '测试模型' } }); ui.render(); assert.equal(options().length, 0);
  assert.equal(ui.modelCalls(), 0); assert.deepEqual(exportDocument(), initial, 'Browsing and search never edit the document');
  ui.labelControl('搜索已选能力', 'input').props.onChange({ target: { value: '' } }); ui.render();
  ui.button('开始试验').props.onClick(); ui.render();
  const state = () => { const { event: _, ...frame } = host().prepare(null, undefined, '').frame; return JSON.stringify(frame); };
  const before = state(), remaining = host().remainingCalls;
  ui.labelControl('按用途浏览', 'select').props.onChange({ target: { value: '整理数据' } }); ui.render();
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'parse' } }); ui.render();
  assert(group('当前步骤的使用帮助')); assert(ui.text(group('当前步骤的使用帮助')).includes('格式'));
  compactHelp(ui, scene.canvasWorkspace!.initial.execution!.nodes.find(node => node.id === 'parse'), scene.canvasWorkspace!.plugins!);
  assert(!ui.elements().some(element => element.props['aria-label'] === '当前材料状态'), 'Do not duplicate the canvas input interface in a material-status sidebar');
  const parseNode = ui.flow().props.nodes.find((node: any) => node.id === 'parse'); assert(parseNode);
  assert.equal(parseNode.data.capability.inputs.find((port: any) => port.id === 'text').required, true);
  assert.match(parseNode.data.inputSources.text, /引用|来自/, 'The real input source remains available at the canvas port');
  assert(!ui.elements(group('当前步骤的使用帮助')).includes(ui.labelControl('为文本内容选择材料', 'select')), 'Material selection remains outside folded explanation');
  assert.equal(state(), before); assert.equal(host().history().length, 0); assert.equal(host().remainingCalls, remaining);
  assert.deepEqual(exportDocument(), initial); assert.equal(ui.modelCalls(), 0);
  // Adding remains an explicit existing edit: help must not apply examples or bind a material automatically.
  const count = initial.definition.initial.execution.nodes.length;
  ui.button('添加执行节点').props.onClick(); ui.render(); const added = exportDocument().definition.initial;
  assert.equal(added.execution.nodes.length, count + 1); assert.deepEqual(added.execution.nodes.at(-1).bindings, {});
  assert.deepEqual(added.nodes, initial.definition.initial.nodes); assert.deepEqual(added.execution.links, initial.definition.initial.execution.links);
  ui.keyShortcut('undo'); ui.render(); assert.deepEqual(exportDocument(), initial);
  ui.button('结束试验').props.onClick(); ui.render(); assert.equal(ui.button('添加执行节点').props.disabled, true); assert(group('添加前了解这个步骤'));

  // Same help for old templates without presentation, scene-specific aliases, and resource fixtures without reading them.
  const template = makeUi(browserTemplateDefinition, browserTemplateRequest);
  template.ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'bindRole' } }); template.ui.render();
  const help = template.ui.elements().find(element => element.type === 'section' && element.props['aria-label'] === '当前步骤的使用帮助')!;
  assert(template.ui.text(help).includes('汇集角色设定'));
  compactHelp(template.ui, template.scene.canvasWorkspace!.initial.execution!.nodes.find(node => node.id === 'bindRole'), template.scene.canvasWorkspace!.plugins!);
  assert(!template.ui.text(help).includes('你是严谨的老师'), 'Help does not disclose current prompt values');
  const resources = makeUi(browserResourceDefinition, browserResourceRequest);
  resources.ui.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: 'project-notes@1.0.0/read-text' } }); resources.ui.render();
  assert(resources.ui.text().includes('不是全库搜索或 RAG')); assert.equal(resources.ui.modelCalls(), 0);
  const note = resources.scene.canvasWorkspace!.initial.execution!.nodes.find(node => node.pluginId === 'project-notes')!;
  resources.ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: note.id } }); resources.ui.render();
  compactHelp(resources.ui, note, resources.scene.canvasWorkspace!.plugins!);
  // Native React escaping: aliases remain text, never plugin-supplied HTML. No execution output is in a help ref.
  const hostileTitle = s2PluginHelp({ ...parse, presentation: { label: '<img src=x onerror=alert(1)>', inputs: { text: '<script>private</script>' } } }, []);
  const markup = renderToStaticMarkup(<section><h4>{hostileTitle.title}</h4><p>{hostileTitle.inputs[0].label}</p></section>);
  assert(!markup.includes('<img')); assert(!markup.includes('<script>')); assert(markup.includes('&lt;img'));
  assert.equal(JSON.stringify(registry.catalog()), catalog); assert.equal(requests, 0);
  console.log('S2 generic-base plugin help compatibility passed (optional canvas policy omitted): reviewed coverage of 24 exact capabilities, real port/cardinality and selected-only receiver descriptions, no negated-feature search, labelled purpose filters and before-add/current-step guidance, unchanged documents/Host/budgets on browsing, explicit empty-binding add/undo, legacy/scene-alias/resource help and escaped text. Synthetic offline only; no model/notes/network or ordinary-user comprehension claim.');
} finally { uis.forEach(ui => ui.dispose()); restoreCanvasUi(); globalThis.fetch = oldFetch; }
