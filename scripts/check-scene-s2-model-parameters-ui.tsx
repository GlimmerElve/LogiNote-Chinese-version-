import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2ModelParameters, type S2ModelParametersProps } from '../src/interaction-packs/prompt-lab/ModelParameters';
import { applyS2Commands, createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import * as controlDrafts from '../src/services/scene/sceneS2ControlDrafts';
import type { S2InputBinding } from '../src/types/sceneS2';

const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Model parameter UI regression forbids all real IO'); };
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成模型参数配置', knowledgePoints: [] });
const capability = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [capability], initial: { nodes: [
  { id: 'text', type: 'text', position: { x: 0, y: 0 }, values: { content: '合成原文' } },
], edges: [], execution: { version: 1, nodes: [{ id: 'model', ...capability, position: { x: 200, y: 0 }, bindings: { prompt: { kind: 'field', nodeId: 'text', fieldId: 'content' } } }], links: [] } } });
let document = definition.initial;
const changes: Array<{ port: string; binding: S2InputBinding | null; key: string }> = [], errors: string[] = [];
let props: S2ModelParametersProps = { node: document.execution!.nodes[0], document, active: true,
  onChange(port, binding, key) {
    assert.equal(controlDrafts.s2ParameterSource(document, 'model', port).key, key);
    binding = binding === null ? null : structuredClone(binding);
    changes.push({ port, binding, key });
    document = applyS2Commands(definition, document, binding ? [{ op: 'update-execution-node', id: 'model', bindings: { [port]: binding } }]
      : [{ op: 'unbind-input', id: 'model', portId: port }]);
    props = { ...props, document, node: document.execution!.nodes[0] };
  }, onError: message => errors.push(message) };

const slots: any[] = []; let cursor = 0, tree: any;
const effects: Array<() => void> = [];
const fakeReact = {
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, (value: any) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
  useRef(initial: any) { const i = cursor++; slots[i] ??= { value: { current: initial } }; return slots[i].value; },
  useEffect(effect: () => any, deps: any[]) { const i = cursor++, previous = slots[i];
    if (!previous || deps.some((dep, index) => !Object.is(dep, previous.deps[index]))) {
      slots[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
    }
  },
};
const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/interaction-packs/prompt-lab/ModelParameters.tsx', 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText, { exports, Object, Number, JSON, require: (id: string) => id === 'react' ? fakeReact : id.endsWith('uiHost') ? controlDrafts : assert.fail(`Unexpected parameter UI import ${id}`) });
const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null)) : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('') : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
const control = (label: string) => { const value = elements().find(item => item.props['aria-label'] === label); assert.ok(value, label); return value; };
function render() { cursor = 0; tree = exports.S2ModelParameters(props); effects.splice(0).forEach(effect => effect()); }
const change = (label: string, value: string) => { control(label).props.onChange({ target: { value } }); render(); };
const blur = (label: string, value: string) => { control(label).props.onBlur({ target: { value } }); render(); };
const enter = (label: string, value: string, extra: Record<string, unknown> = {}) => {
  control(label).props.onKeyDown({ key: 'Enter', currentTarget: { value }, nativeEvent: {}, preventDefault() {}, stopPropagation() {}, ...extra }); render();
};
try {
  render();
  assert.equal(control('输出长度上限').props.max, 2048); assert.equal(control('输出长度上限').props.value, '');
  assert.equal(control('随机性（Temperature）').props.step, 0.1); assert.equal(control('思考模式').props.value, '');
  assert.ok(control('输出长度上限').props.title.includes('沿用配置默认值'));
  assert.ok(!control('输出长度上限').props.title.includes('授权'), 'Model parameters do not ask for another approval');
  assert.ok(!text().includes('256–2048'), 'Normal controls do not repeat a paragraph of parameter instructions');
  change('输出长度上限', '7'); assert.equal(changes.length, 0); assert.ok(text().includes('数字草稿尚未生效'));
  blur('输出长度上限', '7'); assert.equal(changes.length, 0); assert.equal(control('输出长度上限').props['aria-invalid'], true);
  change('输出长度上限', '512'); const duplicateBlur = control('输出长度上限').props.onBlur;
  enter('输出长度上限', '512'); assert.deepEqual(changes.at(-1)!.binding, { kind: 'literal', value: 512 });
  const afterEnter = changes.length; duplicateBlur({ target: { value: '512' } }); assert.equal(changes.length, afterEnter, 'Old blur cannot apply the Enter commit twice');
  assert.equal(control('输出长度上限').props.value, '512');
  change('输出长度上限', '512.0'); blur('输出长度上限', '512.0');
  assert.equal(changes.length, afterEnter); assert.equal(control('输出长度上限').props.value, '512', 'Equivalent numeric input settles without a false pending draft or graph edit');
  change('输出长度上限', ''); blur('输出长度上限', ''); assert.equal(changes.at(-1)!.binding, null);
  change('随机性（Temperature）', '0.'); assert.equal(changes.length, afterEnter + 1);
  change('随机性（Temperature）', '0.7'); enter('随机性（Temperature）', '0.7', { nativeEvent: { isComposing: true } });
  assert.equal(changes.length, afterEnter + 1, 'IME Enter is not submission');
  blur('随机性（Temperature）', '0.7'); assert.deepEqual(changes.at(-1)!.binding, { kind: 'literal', value: 0.7 });
  const validCount = changes.length;
  // A reused control instance must not treat another same-configured node's private draft as its own.
  change('随机性（Temperature）', '1.8');
  const draftBlur = control('随机性（Temperature）').props.onBlur, originalProps = props;
  const secondDocument = structuredClone(document);
  secondDocument.execution!.nodes.push({ ...structuredClone(secondDocument.execution!.nodes[0]), id: 'otherModel' });
  assert.equal(controlDrafts.s2ParameterSource(secondDocument, 'otherModel', 'temperature').key, controlDrafts.s2ParameterSource(document, 'model', 'temperature').key,
    'The source key alone deliberately does not identify the owning node');
  props = { ...props, document: secondDocument, node: secondDocument.execution!.nodes[1] }; render();
  assert.equal(control('随机性（Temperature）').props.value, '0.7', 'Node B shows its saved setting, not node A private draft');
  assert.ok(!text().includes('数字草稿尚未生效'));
  control('随机性（Temperature）').props.onBlur({ target: { value: '0.7' } }); render();
  draftBlur({ target: { value: '1.8' } }); assert.equal(changes.length, validCount, 'Neither a new B blur nor an old A blur commits the inherited draft');
  props = originalProps; render();
  change('随机性（Temperature）', '0.7'); blur('随机性（Temperature）', '0.7'); assert.equal(changes.length, validCount);
  for (const value of ['NaN', 'Infinity', '-0.1', '2.1']) { change('随机性（Temperature）', value); blur('随机性（Temperature）', value); }
  assert.equal(changes.length, validCount);

  // Capability changes invalidate an old handler even when graph/node identity is unchanged.
  const oldCeiling = control('输出长度上限').props.onBlur;
  props = { ...props, maxOutputTokens: 4096 }; render();
  oldCeiling({ target: { value: '1024' } }); assert.equal(changes.length, validCount);
  assert.equal(control('输出长度上限').props.max, 4096);
  change('输出长度上限', '3000'); blur('输出长度上限', '3000'); assert.deepEqual(changes.at(-1)!.binding, { kind: 'literal', value: 3000 });
  const held = document;
  props = { ...props, maxOutputTokens: 512 }; render();
  assert.equal(document, held); assert.equal(control('输出长度上限').props.value, '3000'); assert.ok(text().includes('现有值无效或超出本局上限'));
  const noSilentChange = changes.length;

  control('思考模式').props.onChange({ target: { value: 'enabled' } }); render(); assert.equal(changes.length, noSilentChange);
  props = { ...props, supportsThinking: true }; render(); change('思考模式', 'enabled');
  assert.deepEqual(changes.at(-1)!.binding, { kind: 'literal', value: 'enabled' });
  const oldThinking = control('思考模式').props.onChange;
  props = { ...props, supportsThinking: false }; render();
  assert.equal(control('思考模式').props.value, 'enabled'); assert.ok(text().includes('此设置不可用；可改为模型默认'));
  const thinkingCount = changes.length;
  oldThinking({ target: { value: 'disabled' } }); assert.equal(changes.length, thinkingCount);
  control('思考模式').props.onChange({ target: { value: 'disabled' } }); render(); assert.equal(changes.length, thinkingCount);
  change('思考模式', ''); assert.equal(changes.at(-1)!.binding, null);

  const staleDocument = control('随机性（Temperature）').props.onBlur;
  document = structuredClone(document); props = { ...props, document, node: document.execution!.nodes[0] }; render();
  const sourceChanged = changes.length; staleDocument({ target: { value: '1' } }); assert.equal(changes.length, sourceChanged);
  const fieldDocument = structuredClone(document); fieldDocument.execution!.nodes[0].bindings.temperature = { kind: 'field', nodeId: 'text', fieldId: 'content' };
  props = { ...props, document: fieldDocument, node: fieldDocument.execution!.nodes[0] }; render();
  assert.equal(control('随机性（Temperature）').props.disabled, true); assert.ok(text().includes('由连接的内容提供'));
  control('随机性（Temperature）').props.onChange({ target: { value: '1' } }); control('随机性（Temperature）').props.onBlur({ target: { value: '1' } });
  assert.equal(changes.length, sourceChanged);
  const wiredDocument = structuredClone(document); wiredDocument.execution!.links.push({ source: { nodeId: 'other', portId: 'number' }, target: { nodeId: 'model', portId: 'maxOutputTokens' } });
  props = { ...props, document: wiredDocument, node: wiredDocument.execution!.nodes[0] }; render(); assert.equal(control('输出长度上限').props.disabled, true);
  props = { ...props, document, node: document.execution!.nodes[0] }; render();
  const ended = control('随机性（Temperature）').props.onBlur; props = { ...props, active: false }; render();
  ended({ target: { value: '1' } }); assert.equal(changes.length, sourceChanged);
  assert.equal(elements().find(item => item.type === 'fieldset')!.props.disabled, true);
  props = { ...props, active: true }; render(); const unmounted = control('随机性（Temperature）').props.onBlur;
  slots.forEach(slot => slot.cleanup?.()); unmounted({ target: { value: '1' } }); assert.equal(changes.length, sourceChanged);
  const markup = renderToStaticMarkup(<S2ModelParameters {...props} />);
  assert.ok(markup.includes('输出长度上限')); assert.ok(markup.includes('随机性（Temperature）')); assert.ok(markup.includes('思考模式'));
  assert.ok(markup.includes('aria-label')); assert.ok(markup.includes('title=')); assert.ok(!markup.includes('应用参数'));
  assert.equal(network, 0); assert.ok(errors.length >= 1);
  console.log('S2 model parameters UI passed: three direct Chinese controls, numeric drafts apply only on blur/Enter with exact source keys, blank defaults, finite/range/cap validation without budget changes, unsupported thinking preserved and explicitly clearable, no field/wire override, stale document/node/capability/end/unmount and IME/duplicate guards, accessible labels and zero IO. Synthetic component handlers, not browser or provider compatibility acceptance.');
} finally { globalThis.fetch = priorFetch; }
