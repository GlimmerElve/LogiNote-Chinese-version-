import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { collectKnowledgePoints } from '../src/services/scene/sceneKnowledgePoints';
import { listSceneCapabilities, UNIFIED_SCENE_RECIPE_DEFINITIONS } from '../src/services/scene/sceneCapabilityRegistry';

// Run the real wizard handlers with metadata promises and synthetic notes only.
globalThis.fetch = async () => assert.fail('Builder checks must not contact models or the network');
const source = ts.createSourceFile('SceneBuilderPanel.tsx', readFileSync('src/components/scene/SceneBuilderPanel.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
  .map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
const js = ts.transpileModule(`${body}\nreturn SceneBuilderPanel;`, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
} }).outputText;
type Tree = { type: unknown; props: Record<string, any> };
const React = { createElement: (type: unknown, props: any, ...children: any[]): Tree => ({ type, props: { ...props, children } }), Fragment: 'fragment' };
const all = (value: any): Tree[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(all) : [value, ...all(value.props?.children)];
const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : '';
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const manifest = (id: string, version: string, name: string) => ({ id, version, name, protocolVersion: 1,
  paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] });
const prompt = manifest('prompt-lab', '0.1.0', '提示词实验');
const arithmetic = manifest('arithmetic-lab', '1.2.0', '计算交互包');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const slots: any[] = []; let cursor = 0, live = true, writesAfterUnmount = 0;
  const pending: Array<() => void> = [], reads: ReturnType<typeof deferred>[] = [], installs: ReturnType<typeof deferred>[] = [], readOptions: any[] = [], sceneReads: ReturnType<typeof deferred>[] = [], enters: any[] = [];
  const useState = (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, (value: any) => { if (!live) writesAfterUnmount++; slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; };
  const useRef = (initial: any) => { const i = cursor++; return slots[i] ||= { current: initial }; };
  const useMemo = (fn: () => any, deps: any[]) => { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i].deps[n])) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const useEffect = (fn: () => any, deps: any[]) => { const i = cursor++; const prior = slots[i]; if (!prior || deps.some((value, n) => value !== prior.deps[n])) {
    slots[i] = { deps, cleanup: prior?.cleanup }; pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } };
  const icons = Object.fromEntries(['Layers', 'Sparkles', 'Wand2', 'PenLine', 'Trash2', 'RefreshCw', 'ArrowRight', 'ArrowLeft', 'ChevronRight', 'Check', 'FolderTree', 'SlidersHorizontal', 'ClipboardCheck'].map(name => [name, name]));
  const env = { React, ...icons, useState, useRef, useMemo, useEffect, useLayoutEffect: useEffect, H5pLibraryPanel: 'h5p-library',
    useCallback: (fn: any, deps: any[]) => useMemo(() => fn, deps), useId: () => 'pack-builder',
    SCENE_SKILL_S1: 'S1', SCENE_SKILL_S4: 'S4', collectKnowledgePoints, listSceneCapabilities, UNIFIED_SCENE_RECIPE_DEFINITIONS,
    ProjectTreePanel: 'tree', buildProjectTreeStructure: () => [], useDialog: () => {},
    listSceneInteractionPacks: (options: any) => { readOptions.push(options); const job = deferred(); reads.push(job); return job.promise; },
    importSceneInteractionPack: () => { const job = deferred(); installs.push(job); return job.promise; },
    listScenes: () => { const job = deferred(); sceneReads.push(job); return job.promise; }, deleteScene: () => assert.fail('No deletion in package selection checks'),
  };
  const Component = new Function(...Object.keys(env), js)(...Object.values(env));
  const props = { allNotes: [], onEnterScene: (request: any) => enters.push(request) };
  let nodes: Tree[] = [];
  const render = () => { cursor = 0; nodes = all(Component(props)); pending.splice(0).forEach(fn => fn()); return nodes; };
  const button = (label: string) => { const node = nodes.find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label || text(n).startsWith(label))); assert.ok(node, `button ${label}`); return node; };
  const click = (label: string) => { const node = button(label); assert.equal(Boolean(node.props.disabled), false, `${label} enabled`); node.props.onClick(); render(); };
  const choose = (value: string) => { const select = nodes.find(n => n.type === 'select' && n.props.id === 'pack-builder-interaction-pack'); assert.ok(select); assert.equal(Boolean(select.props.disabled), false); select.props.onChange({ target: { value } }); render(); };
  render(); render();
  nodes.find(n => n.type === 'input' && n.props.id === 'pack-builder-title')!.props.onChange({ target: { value: '合成场景' } }); render(); click('下一步');
  return { render, button, click, choose, reads, installs, readOptions, sceneReads, enters, get nodes() { return nodes; }, get writesAfterUnmount() { return writesAfterUnmount; },
    unmount() { live = false; slots.forEach(slot => slot?.cleanup?.()); } };
}
const ready = async (h: ReturnType<typeof harness>, packs = [prompt, arithmetic], index = 0) => {
  h.reads[index].resolve({ managed: true, packs, errors: [] }); await flush(); h.render();
};
const finish = (h: ReturnType<typeof harness>, source: string) => { h.click('下一步'); if (source === 'build' || source === 'auto') h.click('下一步'); h.click('进入场景'); };

for (const [label, kind] of [['对话场景', 'S1'], ['数理场景', 'S4']]) {
  const h = harness(); h.click(label); finish(h, 'build');
  assert.equal(h.reads.length, 0, `${kind} never discovers S2 packages`);
  assert.equal(h.enters[0].sceneSkill, kind); assert.ok(!Object.hasOwn(h.enters[0], 'interactionPack')); h.unmount();
}
for (const [label, sourceName] of [['自定义场景', 'custom'], ['搭建新场景', 'build'], ['交给 AI 判断', 'auto']]) {
  const h = harness(); h.click('通用画布'); h.click(label);
  assert.equal(h.button('下一步').props.disabled, true, `${sourceName} waits for metadata`);
  await ready(h);
  assert.equal(h.nodes.find(n => n.type === 'select')?.props.value, 'prompt-lab@0.1.0', 'first choice prefers the installed familiar package');
  assert.ok(h.nodes.some(n => n.type === 'option' && text(n).includes('arithmetic-lab@1.2.0')));
  h.choose('arithmetic-lab@1.2.0'); h.click('下一步'); if (sourceName !== 'custom') h.click('下一步');
  assert.ok(h.nodes.some(n => n.props.className === 'scene-wizard-summary-row' && text(n).includes('计算交互包（arithmetic-lab@1.2.0）')));
  h.click('进入场景'); assert.equal(h.enters[0].source, sourceName);
  assert.deepEqual(h.enters[0].interactionPack, { id: 'arithmetic-lab', version: '1.2.0' }); h.unmount();
}
const basic = harness(); basic.click('通用画布'); basic.click('自定义场景'); await ready(basic); basic.choose('');
basic.click('刷新交互包'); await ready(basic, [prompt, arithmetic], 1);
assert.equal(basic.readOptions[0], undefined); assert.deepEqual(basic.readOptions[1], { refresh: true }, 'only explicit refresh bypasses the metadata cache');
assert.equal(basic.nodes.find(n => n.type === 'select')?.props.value, '', 'refresh preserves explicit base-canvas choice');
finish(basic, 'custom'); assert.equal(basic.enters[0].interactionPack, null, 'new base canvas uses explicit null'); basic.unmount();

const removed = harness(); removed.click('通用画布'); removed.click('自定义场景'); await ready(removed); removed.choose('arithmetic-lab@1.2.0');
removed.click('刷新交互包'); await ready(removed, [prompt], 1); finish(removed, 'custom');
assert.equal(removed.enters[0].interactionPack, null, 'removed package selection returns to the base canvas without substituting another package'); removed.unmount();

const empty = harness(); empty.click('通用画布'); empty.click('自定义场景'); await ready(empty, []); finish(empty, 'custom');
assert.equal(empty.enters[0].interactionPack, null, 'no installed packages remains a usable basic canvas'); empty.unmount();
const failure = harness(); failure.click('通用画布'); failure.click('自定义场景'); failure.reads[0].reject(new Error('合成元数据读取失败')); await flush(); failure.render();
assert.ok(failure.nodes.some(n => n.props.role === 'alert' && text(n).includes('合成元数据读取失败')));
finish(failure, 'custom'); assert.equal(failure.enters[0].interactionPack, null, 'discovery errors do not strand the base canvas'); failure.unmount();

const existing = harness(); existing.click('通用画布'); existing.click('复用已有场景');
existing.sceneReads[0].resolve([{ sceneId: 'saved-s2', sceneSkill: 'S2', name: '已保存画布', subject: '合成', reuseCount: 0, knowledgePoints: [] }]); await flush(); existing.render();
assert.ok(!existing.nodes.some(n => n.type === 'select'), 'saved scenes do not expose an override selector');
existing.click('已保存画布'); finish(existing, 'existing');
assert.equal(existing.enters[0].sceneId, 'saved-s2'); assert.ok(!Object.hasOwn(existing.enters[0], 'interactionPack'), 'existing scenes keep their stored package identity'); existing.unmount();

const race = harness(); race.click('通用画布'); race.click('对话场景'); race.click('通用画布');
await ready(race, [arithmetic], 1); await ready(race, [prompt], 0);
assert.ok(race.nodes.some(n => n.type === 'option' && n.props.value === 'arithmetic-lab@1.2.0'));
assert.ok(!race.nodes.some(n => n.type === 'option' && n.props.value === 'prompt-lab@0.1.0'), 'stale discovery cannot replace the newer catalog'); race.unmount();
const gone = harness(); gone.click('通用画布'); gone.unmount(); gone.reads[0].resolve({ managed: true, packs: [prompt], errors: [] }); await flush();
assert.equal(gone.writesAfterUnmount, 0, 'late metadata never mutates an unmounted wizard');
console.log('Scene package builder checks passed: custom/build/auto exact references, explicit basic canvas, metadata-only loading/error/refresh, preserved saved-scene identity, S1/S4 isolation and stale/unmount guards.');
const importing = harness(); importing.click('通用画布'); await ready(importing);
const importButton = importing.button('导入或更新 S2 交互包');
importButton.props.onClick(); importButton.props.onClick(); importing.render();
assert.equal(importing.installs.length, 1, 'same-frame duplicate installs are locked');
assert.equal(importing.button('下一步').props.disabled, true);
const updated = manifest('arithmetic-lab', '2.0.0', '新版计算包');
importing.installs[0].resolve({ manifest: updated }); await flush(); importing.render();
await ready(importing, [prompt, arithmetic, updated], 1); await flush(); importing.render();
assert.equal(importing.nodes.find(n => n.type === 'select')?.props.value, 'arithmetic-lab@2.0.0');
assert.ok(importing.nodes.some(n => n.props.role === 'status' && text(n).includes('已有场景继续使用原版本')));
importing.click('导入或更新 S2 交互包'); importing.installs[1].resolve({ canceled: true }); await flush(); importing.render();
assert.equal(importing.nodes.find(n => n.type === 'select')?.props.value, 'arithmetic-lab@2.0.0'); importing.unmount();
const installGone = harness(); installGone.click('通用画布'); await ready(installGone);
installGone.click('导入或更新 S2 交互包'); installGone.unmount(); installGone.installs[0].resolve({ manifest: updated }); await flush();
assert.equal(installGone.writesAfterUnmount, 0);
console.log('PASS S2 import/update UI: duplicate lock, busy entry protection, refreshed new-version selection, cancellation preservation and unmount guards');
