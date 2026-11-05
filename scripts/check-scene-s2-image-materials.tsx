import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2ImageMaterials, type S2ImageMaterialsProps } from '../src/components/scene/S2ImageMaterials';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { isS2ImageResource } from '../src/services/scene/sceneS2ImageResource';
import type { S2Artifact } from '../src/types/sceneS2Plugin';
import type { S2Document } from '../src/types/sceneS2';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Image UI synthetic test forbids network'); };
const hosts: S2PluginHost[] = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
const file = (name = '合成图片.png') => new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], name, { type: 'image/png' });
const makeHost = () => { const host = new S2PluginHost('image-ui', [{ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' }]); hosts.push(host); return host; };
const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'image', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image', position: { x: 0, y: 0 }, bindings: {}, presentation: { label: '待测图片' } }], links: [] } };

// Real component handlers with deterministic React hooks; not a browser-layout assertion.
function harness(initial: S2ImageMaterialsProps) {
  const slots: any[] = []; let cursor = 0, dirty = false, props = initial, tree: any;
  const effects: Array<() => void> = [];
  const fakeReact = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }),
    useState(value: any) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, (value: any) => { slots[index].value = value; dirty = true; }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { value: { current: value } }; return slots[index].value; },
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2ImageMaterials.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText,
    { exports, require: (name: string) => name === 'react' ? fakeReact : name.endsWith('sceneS2ImageResource') ? { isS2ImageResource } : assert.fail(`Unexpected image UI import ${name}`) });
  function render(next = props) { props = next; for (let i = 0; i < 6; i++) { dirty = false; cursor = 0; tree = exports.S2ImageMaterials(props); effects.splice(0).forEach(effect => effect()); if (!dirty) break; } return tree; }
  function elements(value?: any): any[] { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => elements(item)); return value && typeof value === 'object' ? [value, ...elements(value.children)] : []; }
  function named(type: string, label: string) { const found = elements().find(element => element.type === type && element.props['aria-label'] === label); assert.ok(found, label); return found; }
  render(); return { render, named, elements, close: () => slots.forEach(slot => slot.cleanup?.()) };
}
try {
  const host = makeHost(); host.setDocument(document);
  const calls = { changes: 0, binds: [] as string[], errors: [] as string[] }; let current = true;
  const props: S2ImageMaterialsProps = { host, document, active: true, isCurrent: () => current, selectedNodeId: 'image', onBind: id => calls.binds.push(id), onChange: () => { calls.changes++; }, onError: message => calls.errors.push(message) };
  const ui = harness(props), pick = ui.named('input', '选择本地图片');
  assert.ok(pick.props.accept.includes('image/webp')); assert.equal(pick.props.disabled, false);
  await pick.props.onChange({ target: { files: [file()], value: 'browser-selected' } }); ui.render();
  assert.equal(host.imageResourceSummary().length, 1); assert.equal(calls.changes, 1); assert.equal(calls.binds.length, 0); assert.equal(host.workflowHistory().length, 0);
  const image = host.imageResourceSummary()[0];
  assert.ok(ui.elements().some(element => element.type === 'img' && element.props.alt.includes(image.label)));
  assert.ok(!ui.elements().some(element => element.type === 'img' && !element.props.src.startsWith('data:image/png;')));
  ui.named('select', '为图片资料入口选择图片').props.onChange({ target: { value: image.id } });
  assert.deepEqual(calls.binds, [image.id]); assert.equal(host.workflowHistory().length, 0);
  const bound = structuredClone(document); bound.execution!.nodes[0].bindings.resource = { kind: 'literal', value: image.id };
  ui.render({ ...props, document: bound }); assert.equal(ui.named('select', '为图片资料入口选择图片').props.value, image.id);
  const oldBinding = ui.named('select', '为图片资料入口选择图片');
  const connected = structuredClone(bound); connected.execution!.links.push({ source: { nodeId: 'other', portId: 'text' }, target: { nodeId: 'image', portId: 'resource' } });
  ui.render({ ...props, document: connected }); assert.equal(ui.named('select', '为图片资料入口选择图片').props.disabled, true);
  oldBinding.props.onChange({ target: { value: '' } }); assert.deepEqual(calls.binds, [image.id], 'Old selector cannot override a new link');
  current = false; const count = calls.changes; ui.named('button', `撤回图片 ${image.label}`).props.onClick(); assert.equal(calls.changes, count); assert.equal(host.imageResourceSummary().length, 1);
  current = true; ui.render({ ...props, document: bound }); ui.named('button', `撤回图片 ${image.label}`).props.onClick(); ui.render(); assert.equal(host.imageResourceSummary().length, 0);

  // The chooser result cannot leak a new permission into a different run or an unmounted component.
  for (const action of ['switch', 'unmount'] as const) {
    const oldHost = makeHost(), newHost = makeHost(); const scope = harness({ ...props, host: oldHost });
    const pending = scope.named('input', '选择本地图片').props.onChange({ target: { files: [file()], value: '' } });
    if (action === 'switch') scope.render({ ...props, host: newHost }); else scope.close();
    await pending; assert.equal(oldHost.imageResourceSummary().length, 0); assert.equal(newHost.imageResourceSummary().length, 0);
    if (action === 'switch') assert.equal(scope.named('input', '选择本地图片').props.disabled, false, 'Retired loading state cannot lock the new run');
    scope.close();
  }
  // The normal canvas picker binds directly to its actual node: no second
  // resource-ID selection, plugin execution, model call or hidden image reader.
  const inlineHost = makeHost(); inlineHost.setDocument(document);
  let inlineDocument = structuredClone(document), inlineBinds = 0, inlineChanges = 0;
  const inlineErrors: string[] = [];
  const inlineProps: S2ImageMaterialsProps = { host: inlineHost, active: true, isCurrent: () => true, document: inlineDocument, selectedNodeId: 'image', compact: true, autoBind: true,
    onBind(id) { inlineBinds++; inlineDocument = structuredClone(inlineDocument); inlineDocument.execution!.nodes[0].bindings = id ? { resource: { kind: 'literal', value: id } } : {}; inlineHost.setDocument(inlineDocument); },
    onChange() { inlineChanges++; }, onError: message => inlineErrors.push(message) };
  const inline = harness(inlineProps);
  await inline.named('input', '选择本地图片').props.onChange({ target: { files: [file('画布原图.png')], value: '' } });
  inline.render({ ...inlineProps, document: inlineDocument });
  assert.equal(inlineBinds, 1); assert.equal(inlineChanges, 1); assert.equal(inlineHost.imageResourceSummary().length, 1);
  assert.ok(inline.elements().some(element => element.type === 'img' && element.props.alt === '待处理图片：画布原图.png'));
  assert.ok(!inline.elements().some(element => element.type === 'select'), 'Compact direct picker needs no extra resource selector');
  assert.equal(inlineHost.workflowHistory().length, 0); assert.equal(inlineHost.history().length, 0);
  const remove = inline.elements().find(element => element.type === 'button' && element.children[0] === '移除图片'); assert.ok(remove);
  remove.props.onClick(); inline.render({ ...inlineProps, document: inlineDocument });
  assert.equal(inlineBinds, 2); assert.equal(inlineHost.imageResourceSummary().length, 0);
  assert.ok(!inline.elements().some(element => element.type === 'img')); assert.equal(inlineHost.workflowHistory().length, 0);
  assert.deepEqual(inlineErrors, []); inline.close();

  for (const action of ['host', 'node', 'document', 'end', 'unmount', 'connected', 'binding-failed'] as const) {
    const oldHost = makeHost(), nextHost = makeHost(); oldHost.setDocument(document);
    let binds = 0; const errors: string[] = [];
    const originalProps: S2ImageMaterialsProps = { ...inlineProps, host: oldHost, document, onBind() {
      if (action === 'binding-failed') throw new Error('本次绑定已过期'); binds++;
    }, onError: message => errors.push(message), onChange() {} };
    const scope = harness(originalProps), oldPicker = scope.named('input', '选择本地图片');
    const pending = oldPicker.props.onChange({ target: { files: [file('读取期间切换.png')], value: '' } });
    if (action === 'host') scope.render({ ...originalProps, host: nextHost });
    else if (action === 'node') scope.render({ ...originalProps, selectedNodeId: 'other-image' });
    else if (action === 'document') scope.render({ ...originalProps, document: structuredClone(document) });
    else if (action === 'end') scope.render({ ...originalProps, active: false });
    else if (action === 'unmount') scope.close();
    else if (action === 'connected') {
      const next = structuredClone(document); next.execution!.links.push({ source: { nodeId: 'other', portId: 'text' }, target: { nodeId: 'image', portId: 'resource' } });
      scope.render({ ...originalProps, document: next });
      assert.equal(scope.named('input', '选择本地图片').props.disabled, true);
      await oldPicker.props.onChange({ target: { files: [file('旧选择不能覆盖连线.png')], value: '' } });
    }
    await pending; assert.equal(binds, 0, `Retired ${action} cannot bind the completed image read`);
    assert.deepEqual(oldHost.imageResourceSummary(), [], `Retired or rejected ${action} cannot retain a new image grant`);
    assert.deepEqual(nextHost.imageResourceSummary(), []); assert.equal(oldHost.workflowHistory().length, 0);
    if (action === 'binding-failed') assert.equal(errors.length, 1, 'Failed binding is visible and the new grant is withdrawn');
    scope.close();
  }
  const markup = renderToStaticMarkup(<S2ImageMaterials {...props} />);
  assert.ok(markup.includes('单张最多 1 MiB')); assert.ok(markup.includes('最多 6 张且合计 4 MiB')); assert.ok(!markup.includes('resourceId'));
  const artifact: S2Artifact = { protocolVersion: 1, id: 'image-artifact', type: { id: 'core.image', version: 1 }, complete: true, source: { sceneId: 'image-ui', runId: 'synthetic-run', nodeId: 'image', revision: 1, kind: 'user' }, payload: { kind: 'inline', value: { resourceId: 'imagefile-synthetic' } } };
  const imageMarkup = renderToStaticMarkup(<S2ArtifactView artifact={artifact} />); assert.ok(imageMarkup.includes('本局图片材料')); assert.ok(!imageMarkup.includes('imagefile-synthetic'));
  assert.equal(network, 0); ui.close();
  console.log('S2 image materials UI passed: accessible chooser/labels/previews/withdrawal, truthful limits, optional direct canvas binding with no extra selector or execution, compact removal, connected-input protection, old host/node/document/end/unmount and async read isolation, failed bind revokes new grant, friendly typed image display. Real component handlers and SSR; synthetic data, no browser/model/network.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = previousFetch; }
