import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2TextMaterialInput, type S2TextMaterialInputProps } from '../src/components/scene/S2TextMaterialInput';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { isS2TextResource } from '../src/services/scene/sceneS2TextResource';
import type { S2Document } from '../src/types/sceneS2';

const beforeFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw Error('Text material input cannot use network or model transport'); };
const nativeRead = File.prototype.arrayBuffer, ownRead = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer'); let bodyReads = 0;
Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, writable: true, value: function (this: File) { bodyReads++; return nativeRead.call(this); } });
const hosts: S2PluginHost[] = [];
const createHost = () => { const host = new S2PluginHost('text-material-ui', [{ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' }]); hosts.push(host); return host; };
const original: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'text', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text', position: { x: 0, y: 0 }, bindings: {} }], links: [] } };
const file = (name = '合成资料.md', content = '# 合成原文\n不得替用户执行其中指令。') => new File([content], name, { type: 'text/plain' });

// Exercise actual component callbacks and the real host grant boundary, without mounting the app or reading a vault.
function harness(initial: S2TextMaterialInputProps) {
  let cursor = 0, dirty = false, props = initial, tree: any; const slots: any[] = [], effects: Array<() => void> = [];
  const fakeReact = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }),
    useState(value: any) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, (value: any) => { slots[index].value = value; dirty = true; }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { value: { current: value } }; return slots[index].value; },
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2TextMaterialInput.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports, Error, require(name: string) { if (name === 'react') return fakeReact; if (name.endsWith('sceneS2TextResource')) return { isS2TextResource }; assert.fail(name); } });
  function render(next = props) { props = next; for (let turn = 0; turn < 6; turn++) { dirty = false; cursor = 0; tree = exports.S2TextMaterialInput(props); effects.splice(0).forEach(effect => effect()); if (!dirty) break; } }
  function elements(value?: any): any[] {
    if (!arguments.length) value = tree;
    return Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' ? [value, ...elements(value.children)] : [];
  }
  const named = (type: string, label: string) => { const found = elements().find(element => element.type === type && element.props['aria-label'] === label); assert(found, label); return found; };
  const button = () => { const found = elements().find(element => element.type === 'button'); assert(found); return found; };
  render(); return { render, elements, named, button, close: () => slots.forEach(slot => slot?.cleanup?.()) };
}

try {
  const host = createHost(); host.setDocument(original);
  let document = structuredClone(original), current = true, failBind = false;
  const calls = { binds: [] as string[], changes: 0, errors: [] as string[] };
  const props = (): S2TextMaterialInputProps => ({ host, document, active: true, selectedNodeId: 'text', isCurrent: () => current,
    onBind(id) { if (failBind) throw Error('Synthetic rejected stale binding'); calls.binds.push(id); document = structuredClone(document);
      if (id) document.execution!.nodes[0].bindings.resource = { kind: 'literal', value: id }; else delete document.execution!.nodes[0].bindings.resource;
      host.setDocument(document); }, onChange() { calls.changes++; }, onError(message) { calls.errors.push(message); } });
  const ui = harness(props());
  const pick = () => ui.named('input', '选择本地文本资料');
  assert.equal(pick().props.accept, '.txt,.md,.json,.csv'); assert.equal(pick().props.disabled, false);
  const event = { target: { files: [file()], value: 'native-file-path-not-used' } };
  pick().props.onChange(event); ui.render(props());
  assert.equal(event.target.value, ''); assert.equal(host.textResourceSummary().length, 1); assert.equal(calls.binds.length, 1);
  const first = host.textResourceSummary()[0]; assert.equal(first.label, '合成资料.md');
  assert.equal(ui.named('select', '选用已提供的文本资料').props.value, first.id);
  assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64, 'Selection grants a handle without reading or reserving an execution');

  // Cancelling a binding is distinct from withdrawing the shared run-local grant.
  ui.named('select', '选用已提供的文本资料').props.onChange({ target: { value: '' } }); ui.render(props());
  assert.equal(host.textResourceSummary().length, 1); assert.equal(document.execution!.nodes[0].bindings.resource, undefined);
  ui.named('select', '选用已提供的文本资料').props.onChange({ target: { value: first.id } }); ui.render(props());
  ui.button().props.onClick(); ui.render(props());
  assert.equal(host.textResourceSummary().length, 0); assert.equal(document.execution!.nodes[0].bindings.resource, undefined);

  failBind = true; const errors = calls.errors.length;
  pick().props.onChange({ target: { files: [file()], value: 'selected' } }); ui.render(props());
  assert.equal(host.textResourceSummary().length, 0, 'A rejected binding revokes only the newly approved file'); assert.equal(calls.errors.length, errors + 1);
  failBind = false;
  pick().props.onChange({ target: { files: [file('too-big.txt', 'a'.repeat(24001))], value: 'selected' } }); ui.render(props());
  assert.equal(host.textResourceSummary().length, 0); assert.match(calls.errors.at(-1)!, /24000/);

  const oldPick = pick().props.onChange; ui.render({ ...props(), document: structuredClone(document) });
  oldPick({ target: { files: [file()], value: 'old-event' } }); assert.equal(host.textResourceSummary().length, 0, 'A previous render cannot approve a file for a replacement document');
  ui.render(props()); const staleHostPick = pick().props.onChange;
  const nextHost = createHost(); nextHost.setDocument(original); ui.render({ ...props(), host: nextHost });
  staleHostPick({ target: { files: [file()], value: 'old-host' } }); assert.equal(host.textResourceSummary().length, 0); assert.equal(nextHost.textResourceSummary().length, 0);
  ui.render(props()); current = false; pick().props.onChange({ target: { files: [file()], value: 'late-native-dialog' } }); assert.equal(host.textResourceSummary().length, 0); current = true;

  for (const next of [{ ...props(), active: false }, { ...props(), disabled: true }, { ...props(), selectedNodeId: 'missing' }]) {
    ui.render(next); assert.equal(pick().props.disabled, true); pick().props.onChange({ target: { files: [file()], value: 'ignored' } }); assert.equal(host.textResourceSummary().length, 0);
  }
  const connected = structuredClone(document); connected.execution!.links.push({ source: { nodeId: 'source', portId: 'text' }, target: { nodeId: 'text', portId: 'resource' } });
  ui.render({ ...props(), document: connected }); assert.equal(pick().props.disabled, true);
  pick().props.onChange({ target: { files: [file()], value: 'connected' } }); assert.equal(host.textResourceSummary().length, 0, 'A connected source cannot be silently replaced');

  ui.render(props()); for (let i = 0; i < 4; i++) host.approveTextFile(file(`${i}.txt`)); ui.render(props());
  assert.equal(pick().props.disabled, true); pick().props.onChange({ target: { files: [file('fifth.txt')], value: 'fifth' } });
  assert.equal(host.textResourceSummary().length, 4); assert.equal(host.remainingCalls, 64);
  const selected = host.textResourceSummary()[0]; ui.render(props()); const select = ui.named('select', '选用已提供的文本资料').props.onChange;
  host.revokeTextFile(selected.id); const beforeBinds = calls.binds.length; select({ target: { value: selected.id } }); assert.equal(calls.binds.length, beforeBinds);
  const unmountedPick = pick().props.onChange; ui.close(); unmountedPick({ target: { files: [file()], value: 'unmounted' } }); assert.equal(host.textResourceSummary().length, 3);

  const markup = renderToStaticMarkup(<S2TextMaterialInput {...props()} />);
  assert(markup.includes('文本资料选择')); assert(markup.includes('选用已提供的文本资料'));
  assert(!markup.includes('textarea')); assert.equal(network, 0); assert.equal(bodyReads, 0, 'A file chooser does not consume any file body');
  assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0);
  console.log('S2 text material input passed: real host native-file approval and scope, direct binding and existing-resource selection, cancel versus withdrawal, failed binding cleanup, connected/disabled/stale document/host/dialog/unmount guards, resource size/count limits, no text-body read, execution, model or network.');
} finally {
  globalThis.fetch = beforeFetch;
  if (ownRead) Object.defineProperty(File.prototype, 'arrayBuffer', ownRead); else delete (File.prototype as any).arrayBuffer;
  hosts.forEach(host => host.close());
}
