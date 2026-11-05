import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { applyCognitionMutation, emptyCognitionFile } from '../src/services/cognition/core';
import { cognitionCandidateId } from '../src/services/cognition/observations';
import type { CognitionFile, CognitionMutation } from '../src/services/cognition/types';
import { createCognitionLeaveRegistry } from '../src/services/ui/cognitionLeave';

// Execute the actual components and write hook, replacing only React's render scheduling
// and the IO boundary. No real window, storage, vault, network or model is available.
type Element = { type: any; props: Record<string, any>; key?: string | null };
const all = (value: any): Element[] => Array.isArray(value) ? value.flatMap(all)
  : value?.props ? [value, ...all(value.props.children)] : [];
const content = (value: any): string => Array.isArray(value) ? value.map(content).join('')
  : value?.props ? content(value.props.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const find = (tree: Element, match: (node: Element) => boolean) => {
  const node = all(tree).find(match); assert.ok(node, 'actual rendered control missing'); return node;
};
const button = (tree: Element, text: string) => find(tree, n => n.type === 'button' && content(n) === text);
const sameDeps = (a?: any[], b?: any[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function api() {
  const leave = createCognitionLeaveRegistry();
  const writes: Array<{ input: CognitionMutation } & ReturnType<typeof deferred<CognitionFile>>> = [];
  const reads: ReturnType<typeof deferred<CognitionFile>>[] = [];
  const subscribers = new Set<() => void>();
  return { writes, reads, subscribers, leave,
    savePersonalCognition(input: CognitionMutation) { const pending = { input, ...deferred<CognitionFile>() }; writes.push(pending); return pending.promise; },
    loadPersonalCognition() { const pending = deferred<CognitionFile>(); reads.push(pending); return pending.promise; },
    subscribePersonalCognition(fn: () => void) { subscribers.add(fn); return () => subscribers.delete(fn); },
    emit() { for (const fn of subscribers) fn(); },
  };
}
function harness(path: string, name: string, initialProps: any, store = api()) {
  const events = new Map<string, Set<(event: any) => void>>();
  const slots: any[] = []; let cursor = 0, changed = false, effects: (() => void)[] = [], tree!: Element, live = true;
  const hooks = { ...React,
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { const value = typeof next === 'function' ? next(slots[i]) : next;
        if (!Object.is(value, slots[i])) { slots[i] = value; changed = true; } }]; },
    useRef(initial: any) { return slots[cursor++] ||= { current: initial }; },
    useId() { const i = cursor++; return slots[i] ||= `cognition-check-${i}`; },
    useMemo(fn: () => any, deps?: any[]) { const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn: () => void | (() => void), deps?: any[]) { const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) { const old = slots[i]?.cleanup;
        const slot = { deps, cleanup: undefined as any }; slots[i] = slot;
        effects.push(() => { old?.(); slot.cleanup = fn(); }); } },
  };
  const cache = new Map<string, any>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file);
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('CognitionCandidateInbox.tsx')) source += '\nexport { CandidateCard as __testCandidateCard };';
    if (file.endsWith('AgentCognitionReferences.tsx')) source += '\nexport { CurrentReferences as __testCurrentReferences };';
    const module = { exports: {} as any }; cache.set(file, module.exports);
    const require = createRequire(file);
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    runInNewContext(code, { module, exports: module.exports, Date, JSON, String, Error,
      window: { addEventListener(name: string, callback: any) { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(callback); },
        removeEventListener(name: string, callback: any) { events.get(name)?.delete(callback); } },
      require(id: string) {
        if (id === 'react') return hooks;
        if (id.endsWith('.css')) return {};
        if (id === '../services/cognition/store') return store;
        if (id === '../services/ui/cognitionLeave') return { cognitionLeaveRegistry: store.leave, allowCognitionLeave: () => store.leave.allow() };
        if (id.startsWith('./') && /Cognition/.test(id)) return load(resolve(file, '..', `${id}.${id.startsWith('./use') ? 'ts' : 'tsx'}`));
        if (id.includes('/services/') && !/cognition\/(core|types|roles)$|argumentDoc\/(types|flowStructure)$/.test(id)) throw new Error(`Forbidden IO dependency: ${id}`);
        return require(id);
      },
    });
    return module.exports;
  }
  const Component = load(resolve(path))[name]; assert.equal(typeof Component, 'function'); let props = initialProps;
  function render() { assert.ok(live); let count = 0;
    do { assert.ok(++count < 30, 'render did not settle'); changed = false; cursor = 0; tree = Component(props);
      const pending = effects; effects = []; for (const effect of pending) effect(); } while (changed); return tree; }
  render();
  return { store, events, get tree() { return tree; }, render,
    update(next: any) { props = { ...props, ...next }; return render(); },
    unmount() { live = false; for (const slot of slots) slot?.cleanup?.(); },
    change(node: Element, value: string, bubble = false) {
      node.props.onChange({ target: { value } });
      if (bubble) find(tree, n => n.type === 'fieldset').props.onChange({ target: { hasAttribute: () => false } });
      return render();
    },
  };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
// The searchable endpoint control chooses exact identities even when labels collide.
let chosenEndpoint = '';
const picker = harness('src/components/CognitionNodePicker.tsx', 'CognitionNodePicker', {
  label: '关系终点', value: '', nodes: [{ id: 'node-one', title: '同名主题', text: '同一句认识' }, { id: 'node-two', title: '同名主题', text: '同一句认识' }],
  onChange(id: string) { chosenEndpoint = id; },
});
find(picker.tree, n => n.type === 'input').props.onFocus(); picker.render();
picker.change(find(picker.tree, n => n.type === 'input'), '同一句');
assert.equal(chosenEndpoint, '', 'typing/search never changes the current endpoint');
const endpointOptions = all(picker.tree).filter(n => n.props.role === 'option');
assert.equal(endpointOptions.length, 2); endpointOptions[1].props.onClick(); picker.render();
assert.equal(chosenEndpoint, 'node-two', 'duplicate text never replaces a selected stable identity'); picker.unmount();
const node = (id: string, text: string) => ({ id, text, mainType: '假设' as const, position: { x: 0, y: 0 } });
const doc = { doc_id: 'synthetic-a', title: '条件与结果', nodes: [node('a', '条件 A'), node('b', '结果 B')], edges: [] };
const seed = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', expectedRevision: 0, confirmed: true,
  operation: 'initial', reason: '', stance: 'tentative', authorship: 'own_expression', doc }, { id: 'seed-a', at: '2026-10-07T00:00:00Z' });
const seeded = applyCognitionMutation(seed, { kind: 'confirm', expectedRevision: seed.revision, confirmed: true,
  operation: 'initial', reason: '', stance: 'tentative', authorship: 'own_expression', doc: { ...doc, doc_id: 'synthetic-b', title: '另一份理解' } }, { id: 'seed-b', at: '2026-10-07T00:00:00Z' });
const formPath = 'src/components/CognitionEditForm.tsx';
// Leave protection prefers the editable draft over an earlier Reload button.
const focusGuard = harness('src/components/useCognitionLeaveProtection.ts', 'useCognitionLeaveProtection', false);
let draftFocus = 0, reloadFocus = 0, draftScroll = 0;
const draftDisclosure = { tagName: 'DETAILS', open: false, parentElement: null };
const draftTarget = { parentElement: draftDisclosure, focus() { draftFocus++; }, scrollIntoView() { draftScroll++; } }, reloadTarget = { focus() { reloadFocus++; }, scrollIntoView() {} };
(focusGuard.tree as any).root.current = { closest: () => null, parentElement: null, scrollIntoView() {},
  querySelector(selector: string) { return selector === 'textarea:not(:disabled)' ? draftTarget : reloadTarget; } };
(focusGuard.tree as any).setDirty(true); focusGuard.render();
assert.equal(focusGuard.store.leave.allow(), false); focusGuard.render();
assert.equal(draftFocus, 1); assert.equal(reloadFocus, 0); assert.equal(draftScroll, 1);
assert.equal(draftDisclosure.open, true, 'blocked leaving reveals optional draft fields inside collapsed disclosures'); focusGuard.unmount();
// No draft text is handed to the registry: only status and UI callbacks.
const scopes = createCognitionLeaveRegistry();
const elementA = {} as HTMLElement, elementB = {} as HTMLElement;
let notifications = 0;
const offScope = scopes.register({ element: () => elementA, blocked: () => true, notify: () => notifications++ });
assert.equal(scopes.allow({ contains: (node: unknown) => node === elementB } as HTMLElement), true);
assert.equal(scopes.allow({ contains: (node: unknown) => node === elementA } as HTMLElement), false);
assert.equal(notifications, 1); offScope(); assert.equal(scopes.allow(), true);
let cancelled = 0, revealed = 0;
const guarded = harness(formPath, 'CognitionEditForm', { file: seed, onSaved() {},
  onCancel: () => cancelled++, onLeaveBlocked: () => revealed++ });
assert.equal(guarded.store.leave.allow(), true, 'an untouched editor does not prevent navigation');
guarded.change(find(guarded.tree, n => n.type === 'textarea'), '离开前保留的草稿', true);
assert.equal(guarded.store.leave.allow(), false); guarded.render();
assert.match(content(guarded.tree), /先保存或取消编辑/); assert.equal(revealed, 1);
let preventedUnload = 0;
const unloading = { returnValue: undefined, preventDefault() { preventedUnload++; } };
for (const handler of guarded.events.get('beforeunload')!) handler(unloading);
assert.equal(preventedUnload, 1); assert.equal(unloading.returnValue, '');
button(guarded.tree, '取消编辑').props.onClick(); guarded.render();
assert.equal(cancelled, 1); assert.equal(guarded.store.leave.allow(), true);
// Saving is a synchronous lock, even for an unchanged form before React's next render.
const cancelBeforeRender = button(guarded.tree, '取消编辑').props.onClick;
button(guarded.tree, '确认更新理解').props.onClick();
assert.equal(guarded.store.leave.allow(), false, 'same-frame saving cannot be closed');
cancelBeforeRender(); assert.equal(cancelled, 1, 'same-frame cancel cannot unmount an accepted write');
guarded.render(); assert.match(content(guarded.tree), /等结果返回/);
guarded.store.writes[0].reject(new Error('模拟保存失败')); await tick(); guarded.render();
assert.doesNotMatch(content(guarded.tree), /等结果返回/, 'a failed save cannot retain an obsolete saving notice');
guarded.change(find(guarded.tree, n => n.type === 'textarea'), '失败后仍保留的草稿', true);
assert.equal(guarded.store.leave.allow(), false);
button(guarded.tree, '确认更新理解').props.onClick();
guarded.store.writes[1].resolve(seed); await tick(); guarded.render();
assert.equal(guarded.store.leave.allow(), true, 'confirmed success unlocks navigation');
guarded.unmount(); assert.equal(guarded.events.get('beforeunload')?.size, 0);
assert.equal(guarded.store.leave.blocked().length, 0, 'unmounted editors cannot leave phantom navigation locks');
let saved = 0;
const edit = harness(formPath, 'CognitionEditForm', { file: seed, onSaved: () => saved++ });
edit.change(find(edit.tree, n => n.type === 'textarea'), '保留这个未保存草稿', true);
const original = find(edit.tree, n => n.type === 'select' && 'data-cognition-nonedit' in n.props);
const second = all(original).filter(n => n.type === 'option')[2].props.value;
edit.change(original, second);
assert.equal(find(edit.tree, n => n.type === 'textarea').props.value, '保留这个未保存草稿');
assert.ok(button(edit.tree, '确认更新理解').props.disabled);
button(edit.tree, '继续编辑当前主张').props.onClick(); edit.render();
assert.equal(find(edit.tree, n => n.type === 'textarea').props.value, '保留这个未保存草稿');
edit.change(find(edit.tree, n => n.type === 'select' && 'data-cognition-nonedit' in n.props), second);
button(edit.tree, '切换并放弃修改').props.onClick(); edit.render();
assert.equal(find(edit.tree, n => n.type === 'textarea').props.value, '结果 B');
edit.change(find(edit.tree, n => n.type === 'textarea'), '结果 B 的修订', true);
const submit = button(edit.tree, '确认更新理解').props.onClick; submit(); submit(); edit.render();
assert.equal(edit.store.writes.length, 1, 'same-frame double click writes once');
edit.store.writes[0].reject(new Error('合成写入失败')); await tick(); edit.render();
assert.equal(find(edit.tree, n => n.type === 'textarea').props.value, '结果 B 的修订');
assert.match(content(edit.tree), /草稿已保留.*合成写入失败/);
button(edit.tree, '确认更新理解').props.onClick();
edit.store.writes[1].resolve(seed); await tick(); edit.render(); assert.equal(saved, 1);
edit.update({ file: { ...seed, revision: 99 } });
assert.ok(button(edit.tree, '确认更新理解').props.disabled);
button(edit.tree, '加载最新版本并重新核对').props.onClick(); edit.render();
assert.equal(find(edit.tree, n => n.type === 'textarea').props.value, '结果 B 的修订', 'rebase retains the typed draft');

// A canvas-selected block has no target picker or metadata questionnaire.
const crowded = structuredClone(seed);
crowded.records[0].revisions[0].branches[0].graph.nodes.push(...Array.from({ length: 6 }, (_, i) => node(`extra-${i}`, `其他认识 ${i}`)));
function updateBlock(file: CognitionFile, nodeId: string, text: string, id: string, operation: 'revise' | 'supplement' = 'revise', branchId = 'primary') {
  return applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true,
    target: { recordId: 'synthetic-a', revisionId: file.records[0].revisions.at(-1)!.id, branchId, nodeId, operation, reason: '合成修改' },
    text, stance: 'tentative', authorship: 'own_expression',
  }, { id, at: '2026-10-22T00:00:00Z' });
}
let history = updateBlock(crowded, 'b', '第二版结果 B', 'second-b');
history = updateBlock(history, 'b', '当前第三版结果 B', 'third-b');
const fixed = harness(formPath, 'CognitionEditForm', { file: history, recordId: 'synthetic-a', initialTarget: { branchId: 'primary', nodeId: 'b' }, onSaved() {} });
assert.doesNotMatch(content(fixed.tree), /查找原认知|原认知|认同状态|表述来源|自己的表述|参考后采纳/);
assert.equal(all(fixed.tree).filter(n => n.type === 'select').length, 2, 'only operation and argument role remain selectable');
const operationSelect = find(fixed.tree, n => n.props['aria-label'] === '如何更新');
assert.ok(all(operationSelect).filter(n => n.type === 'option').every(n => !['certainty', 'qualify'].includes(n.props.value)), 'obsolete overlapping operations are not offered');
assert.equal(find(fixed.tree, n => n.type === 'details' && content(n).startsWith('特殊更新方式')).props.open, undefined);
assert.equal(find(fixed.tree, n => n.props['aria-label'] === '首次记录原文').props.children, '结果 B', 'original is the exact node first snapshot, not the last baseline or first node');
assert.equal(find(fixed.tree, n => n.type === 'textarea').props.value, '当前第三版结果 B');
assert.equal(find(fixed.tree, n => n.type === 'details' && content(n).startsWith('查看首次记录')).props.open, undefined, 'original starts collapsed');
fixed.change(find(fixed.tree, n => n.type === 'textarea'), '本次新理解', true);
button(fixed.tree, '确认更新理解').props.onClick(); fixed.render();
const fixedMutation = fixed.store.writes[0].input as Extract<CognitionMutation, { kind: 'update_cognition' }>;
assert.equal(fixedMutation.target.nodeId, 'b'); assert.equal(fixedMutation.target.revisionId, 'third-b');
assert.equal(fixedMutation.stance, 'tentative', 'ordinary editing never rewrites historical stance as endorsement or reinforcement');
assert.equal(fixedMutation.authorship, 'own_expression');
assert.equal(crowded.records[0].revisions[0].branches[0].graph.nodes[1].text, '结果 B');
fixed.store.writes[0].reject(new Error('synthetic cleanup')); await tick(); fixed.render();
const removed = structuredClone(history); removed.revision++;
removed.records[0].revisions.at(-1)!.branches[0].graph.nodes = removed.records[0].revisions.at(-1)!.branches[0].graph.nodes.filter(n => n.id !== 'b');
fixed.update({ file: removed });
button(fixed.tree, '加载最新版本并重新核对').props.onClick(); fixed.render();
assert.equal(find(fixed.tree, n => n.type === 'textarea').props.value, '本次新理解');
assert.match(content(fixed.tree), /不会改为其他认知块/); assert.ok(button(fixed.tree, '确认更新理解').props.disabled);
fixed.unmount();
const supplemented = updateBlock(history, 'a', '后续补充的原话', 'append-b', 'supplement');
const appendedHistory = updateBlock(supplemented, 'change:append-b', '补充块当前理解', 'append-revised');
const appended = harness(formPath, 'CognitionEditForm', { file: appendedHistory, recordId: 'synthetic-a', initialTarget: { branchId: 'primary', nodeId: 'change:append-b' }, onSaved() {} });
assert.equal(find(appended.tree, n => n.props['aria-label'] === '首次记录原文').props.children, '后续补充的原话', 'appended blocks use their own first appearance, not the record initial source');
appended.unmount();
const supplementForm = harness(formPath, 'CognitionEditForm', { file: seed, recordId: 'synthetic-a', initialTarget: { branchId: 'primary', nodeId: 'a' }, onSaved() {} });
supplementForm.change(find(supplementForm.tree, n => n.props['aria-label'] === '如何更新'), 'supplement', true);
assert.equal(find(supplementForm.tree, n => n.type === 'textarea').props.value, '', 'supplement starts with new text, not a duplicate of the original block');
supplementForm.change(find(supplementForm.tree, n => n.type === 'textarea'), '保留手写的新内容', true);
supplementForm.change(find(supplementForm.tree, n => n.props['aria-label'] === '如何更新'), 'revise', true);
assert.equal(find(supplementForm.tree, n => n.type === 'textarea').props.value, '保留手写的新内容', 'operation changes do not discard a nonempty draft');
supplementForm.unmount();
const ambiguous = harness(formPath, 'CognitionEditForm', { file: seeded, initialTarget: { branchId: 'primary', nodeId: 'a' }, onSaved() {} });
assert.ok(button(ambiguous.tree, '确认更新理解').props.disabled, 'ambiguous pointer cannot silently choose the first record'); ambiguous.unmount();
console.log('PASS compact block editor: fixed identity, immutable first snapshot, appended-block origin, collapsed comparisons, removed questionnaire, preserved metadata, no fallback after removal');

// Frozen condition baselines must change only on the explicit reload, never on subscription.
const conditionSeed = structuredClone(seed);
Object.assign(conditionSeed.records[0].revisions[0].branches[0].graph.nodes[0], { text: '条件 A 时结果 B 成立。', conditions: ['条件 A'] });
const conditionEdit = harness(formPath, 'CognitionEditForm', { file: conditionSeed, initialTarget: { branchId: 'primary', nodeId: 'a' }, onSaved() {} });
const labelled = (label: string) => find(conditionEdit.tree, n => n.props['aria-label'] === label);
conditionEdit.change(labelled('如何更新'), 'replace_conditions', true);
conditionEdit.change(labelled('要移除或替换的原条件'), '0', true);
conditionEdit.change(labelled('新条件'), '条件 C', true);
const draftText = () => all(conditionEdit.tree).filter(n => n.type === 'textarea').at(-1)!;
button(conditionEdit.tree, '替换正文中的原条件').props.onClick(); conditionEdit.render();
assert.equal(draftText().props.value, '条件 C 时结果 B 成立。', 'one explicit click inserts the condition into the body draft');
assert.equal(conditionEdit.store.writes.length, 0, 'insertion is draft editing, not an implicit save');
const conditionLatest = applyCognitionMutation(conditionSeed, { kind: 'edit_graph', expectedRevision: conditionSeed.revision, confirmed: true, edit: {
  action: 'update_node', target: { recordId: 'synthetic-a', revisionId: 'seed-a', branchId: 'primary', nodeId: 'a' }, operation: 'add_conditions',
  reason: '另一窗口新增条件', text: '条件 A 且条件 D 时结果 B 成立。', mainType: '假设', stance: 'tentative',
  meaning: { interpretation: '保留 A，新增 D', preserved: [], conditions: { before: ['条件 A'], changes: [{ kind: 'add', after: '条件 D' }] } },
} }, { id: 'condition-latest', at: '2026-10-20T00:00:00Z' });
conditionEdit.update({ file: conditionLatest });
assert.equal(labelled('原条件（每行一项）').props.value, '条件 A', 'subscription cannot silently rebase the reviewed conditions');
assert.ok(button(conditionEdit.tree, '确认更新理解').props.disabled);
button(conditionEdit.tree, '加载最新版本并重新核对').props.onClick(); conditionEdit.render();
assert.equal(labelled('原条件（每行一项）').props.value, '条件 A\n条件 D', 'explicit reload must display the actual current condition baseline');
assert.equal(labelled('原条件（每行一项）').props.readOnly, true);
assert.equal(labelled('新条件').props.value, '条件 C', 'reload retains the replacement draft');
assert.equal(draftText().props.value, '条件 C 时结果 B 成立。', 'reload retains the proposition draft, not silently overwriting it');
conditionEdit.change(draftText(), '条件 C 且条件 D 时结果 B 成立。', true);
assert.equal(button(conditionEdit.tree, '确认更新理解').props.disabled, false);
button(conditionEdit.tree, '确认更新理解').props.onClick(); conditionEdit.render();
const reloadedMutation = conditionEdit.store.writes[0].input;
assert.equal(reloadedMutation.kind, 'update_cognition');
if (reloadedMutation.kind !== 'update_cognition') assert.fail('expected exact node update');
assert.equal(reloadedMutation.target.revisionId, 'condition-latest');
assert.deepEqual(Array.from(reloadedMutation.meaning?.conditions?.before || []), ['条件 A', '条件 D']);
const reloadedSaved = applyCognitionMutation(conditionLatest, reloadedMutation, { id: 'condition-saved', at: '2026-10-20T00:01:00Z' });
conditionEdit.store.writes[0].resolve(reloadedSaved); await tick(); conditionEdit.render(); conditionEdit.unmount();

// Saved conditions are opaque strings, not a newline-delimited editing format.
const multilineSeed = structuredClone(conditionSeed);
Object.assign(multilineSeed.records[0].revisions[0].branches[0].graph.nodes[0], { text: '条件 A\n且条件 D 时结果 B 成立。', conditions: ['条件 A\n且条件 D'] });
const multiline = harness(formPath, 'CognitionEditForm', { file: multilineSeed, initialTarget: { branchId: 'primary', nodeId: 'a' }, onSaved() {} });
multiline.change(find(multiline.tree, n => n.props['aria-label'] === '如何更新'), 'add_conditions', true);
multiline.change(find(multiline.tree, n => n.props['aria-label'] === '新条件'), '条件 E', true);
multiline.change(all(multiline.tree).filter(n => n.type === 'textarea').at(-1)!, '条件 A\n且条件 D 且条件 E 时结果 B 成立。', true);
assert.equal(button(multiline.tree, '确认更新理解').props.disabled, false, 'multiline saved conditions must not be split into different conditions');
button(multiline.tree, '确认更新理解').props.onClick(); multiline.render();
assert.deepEqual(Array.from((multiline.store.writes[0].input as Extract<CognitionMutation, { kind: 'update_cognition' }>).meaning?.conditions?.before || []), ['条件 A\n且条件 D']);
multiline.store.writes[0].reject(new Error('synthetic cleanup')); await tick(); multiline.unmount();

for (const newline of ['\n', '\r\n']) for (const operation of ['replace_conditions', 'remove_conditions'] as const) {
  const originalCondition = `条件 A${newline}且条件 D`, replacement = '条件 C\n且条件 E';
  const file = structuredClone(conditionSeed);
  Object.assign(file.records[0].revisions[0].branches[0].graph.nodes[0], { text: `${originalCondition}时结果 B 成立。`, conditions: [originalCondition] });
  const form = harness(formPath, 'CognitionEditForm', { file, initialTarget: { branchId: 'primary', nodeId: 'a' }, onSaved() {} });
  form.change(find(form.tree, n => n.props['aria-label'] === '如何更新'), operation, true);
  const originalSelect = find(form.tree, n => n.props['aria-label'] === '要移除或替换的原条件');
  assert.equal(originalSelect.type, 'select', 'old conditions must be selected without DOM input newline normalization');
  form.change(originalSelect, '0', true);
  if (operation === 'replace_conditions') {
    const newInput = find(form.tree, n => n.props['aria-label'] === '新条件');
    assert.equal(newInput.type, 'textarea'); form.change(newInput, replacement, true);
  }
  form.change(all(form.tree).filter(n => n.type === 'textarea').at(-1)!, `${operation === 'replace_conditions' ? replacement + '时' : ''}结果 B 成立。`, true);
  assert.equal(button(form.tree, '确认更新理解').props.disabled, false);
  button(form.tree, '确认更新理解').props.onClick(); form.render();
  const mutation = form.store.writes[0].input as Extract<CognitionMutation, { kind: 'update_cognition' }>;
  const conditionChange = mutation.meaning?.conditions?.changes[0];
  assert.ok(conditionChange && conditionChange.kind !== 'add');
  assert.equal(conditionChange.before, originalCondition);
  const next = applyCognitionMutation(file, mutation, { id: `multiline-${operation}`, at: '2026-10-20T00:02:00Z' });
  assert.deepEqual(next.records[0].revisions.at(-1)!.branches[0].graph.nodes[0].conditions, operation === 'replace_conditions' ? [replacement] : []);
  form.store.writes[0].resolve(next); await tick(); form.unmount();
}

let late = 0;
const abandoned = harness(formPath, 'CognitionEditForm', { file: seed, onSaved: () => late++ });
button(abandoned.tree, '确认更新理解').props.onClick(); abandoned.unmount();
abandoned.store.writes[0].resolve(seed); await tick(); assert.equal(late, 0, 'unmounted form cannot close or update another editor');
const lock = { current: false }, sharedApi = api();
let ownerBusy = false;
const first = harness(formPath, 'CognitionEditForm', { file: seed, onSaved() {}, writeLock: lock, onBusyChange(value: boolean) { ownerBusy = value; } }, sharedApi);
const other = harness(formPath, 'CognitionEditForm', { file: seed, onSaved() {}, writeLock: lock }, sharedApi);
button(first.tree, '确认更新理解').props.onClick(); button(other.tree, '确认更新理解').props.onClick();
assert.equal(sharedApi.writes.length, 1, 'shared view lock also protects different cards before re-render');
first.unmount(); assert.ok(lock.current, 'unmount cannot unlock an unfinished accepted write');
assert.equal(ownerBusy, true);
sharedApi.writes[0].resolve(seed); await tick(); assert.equal(lock.current, false);
assert.equal(ownerBusy, false, 'candidate removed by an early store event cannot leave the owner permanently busy');

const profile = harness('src/components/PersonalCognitionProfile.tsx', 'PersonalCognitionProfile', {});
profile.store.reads[0].resolve(seeded); await tick(); profile.render();
button(profile.tree, '更新这份理解').props.onClick(); profile.render();
profile.change(find(profile.tree, n => n.type === 'input'), '另一份理解');
assert.equal(all(profile.tree).filter(n => n.type === 'details' && n.props.className === 'cognition-card').length, 2);
assert.ok(button(profile.tree, '更新这份理解').props.disabled, 'another record cannot replace the draft');
find(profile.tree, n => n.type?.name === 'CognitionEditForm').props.onCancel(); profile.render();
profile.change(find(profile.tree, n => n.type === 'input'), '');
button(profile.tree, '忘记这份认知记录…').props.onClick(); profile.render();
const forget = button(profile.tree, '确认忘记').props.onClick; forget(); forget(); profile.render();
assert.equal(profile.store.writes.length, 1);
profile.store.writes[0].reject(new Error('合成删除失败')); await tick(); profile.render();
assert.match(content(profile.tree), /记录与确认区域均已保留/); assert.ok(button(profile.tree, '确认忘记'));
profile.store.emit(); profile.store.reads[1].resolve({ ...seeded, revision: 50 }); await tick(); profile.render();
assert.ok(button(profile.tree, '确认忘记').props.disabled, 'destructive confirmation freezes the reviewed revision');
button(profile.tree, '取消').props.onClick(); profile.render();
profile.store.emit(); // Delayed read starts before a newer accepted write.
find(profile.tree, n => n.type?.name === 'CognitionCandidateInbox').props.onSaved({ ...seeded, revision: 51 }); profile.render();
profile.store.reads[2].resolve(seed); await tick(); profile.render();
assert.match(content(profile.tree), /2 份认知记录/, 'old read cannot replace the saved result');

const candidate = { id: 'candidate-a', status: 'pending' as const, capturedAt: '2026-10-07T00:00:00Z',
  observation: { activityKind: 'review' as const, activityId: 'synthetic-review', messageId: 'synthetic-answer', role: 'user' as const,
    answer: '这是合成的个人理解草稿', question: '你如何理解？', observedAt: '2026-10-07T00:00:00Z', noteTitle: '候选理解', hintLevel: 0 as const,
    consultedMaterialIds: [], targetKnowledgeNames: [] } };
const candidateFile = { ...seed, candidates: [candidate] };
for (const assisted of [false, true]) {
  const candidateInput = { ...candidate, observation: { ...candidate.observation, consultedMaterialIds: assisted ? ['synthetic-material'] : [] } };
  candidateInput.id = cognitionCandidateId(candidateInput.observation);
  const candidateFormFile = { ...seed, candidates: [candidateInput] };
  const form = harness(formPath, 'CognitionEditForm', { file: candidateFormFile, candidate: candidateInput, onSaved() {} });
  assert.doesNotMatch(content(form.tree), /认同状态|表述来源/);
  assert.equal(button(form.tree, '确认新增理解').props.disabled, false, content(form.tree));
  button(form.tree, '确认新增理解').props.onClick(); form.render();
  const mutation = form.store.writes[0].input as Extract<CognitionMutation, { kind: 'accept_candidate' }>;
  assert.equal(mutation.stance, 'endorsed', 'new user expressions do not require an endorsement questionnaire');
  assert.equal(mutation.authorship, assisted ? 'adopted_with_assistance' : 'own_expression', 'removing the selector does not falsify assisted provenance');
  const next = applyCognitionMutation(candidateFormFile, mutation, { id: 'compact-candidate', at: '2026-10-22T00:00:00Z' });
  form.store.writes[0].resolve(next); await tick(); form.unmount();
}
const card = harness('src/components/CognitionCandidateInbox.tsx', '__testCandidateCard', { file: candidateFile, candidate, onSaved() {}, writeLock: { current: false } });
button(card.tree, '忽略候选…').props.onClick(); card.render();
const dismiss = button(card.tree, '确认忽略').props.onClick; dismiss(); dismiss(); card.render(); assert.equal(card.store.writes.length, 1);
card.store.writes[0].reject(new Error('合成忽略失败')); await tick(); card.render();
assert.match(content(card.tree), /候选与确认区域均已保留/);
card.update({ file: { ...candidateFile, revision: 80 } }); assert.ok(button(card.tree, '确认忽略').props.disabled);
button(card.tree, '取消').props.onClick(); card.render();
const detail = find(card.tree, n => n.type === 'details' && n.props.className === 'cognition-card');
const target = { open: true }; detail.props.onToggle({ target, currentTarget: target }); card.render();
find(card.tree, n => n.type?.name === 'CognitionEditForm').props.onBusyChange(true); card.render();
assert.ok(button(card.tree, '忽略候选…').props.disabled, 'accepting and dismissing one candidate cannot run together');
find(card.tree, n => n.type?.name === 'CognitionEditForm').props.onBusyChange(false); card.render();
button(card.tree, '忽略候选…').props.onClick(); card.render();
find(card.tree, n => n.type?.name === 'CognitionEditForm').props.onLeaveBlocked(); card.render();
assert.equal(find(card.tree, n => n.type === 'div' && 'hidden' in n.props).props.hidden, false,
  'blocked navigation reveals a draft hidden by candidate dismissal confirmation');
find(card.tree, n => n.type?.name === 'CognitionEditForm').props.onCancel(); card.render();
button(card.tree, '整理这份回答').props.onClick(); card.render();
assert.ok(find(card.tree, n => n.type?.name === 'CognitionEditForm'));
const inbox = harness('src/components/CognitionCandidateInbox.tsx', 'CognitionCandidateInbox', { file: candidateFile, onSaved() {} });
find(inbox.tree, n => n.type?.name === 'CandidateCard').props.onSaved({ ...candidateFile, candidates: [{ id: candidate.id, status: 'dismissed' }] }); inbox.render();
assert.match(content(inbox.tree), /未新增或修改你的理解/);

const panel = harness('src/components/PersonalCognitionPanel.tsx', 'PersonalCognitionPanel', { doc });
panel.store.emit(); panel.store.reads[1].resolve(seed); await tick(); panel.render();
panel.store.reads[0].resolve(emptyCognitionFile()); await tick(); panel.render();
assert.equal(button(panel.tree, '重新加载认知记录').props.disabled, false);
assert.match(content(panel.tree), /已保存的当前理解/);
assert.doesNotMatch(content(panel.tree), /认同状态|表述来源|调整确定程度|调整适用条件/);
assert.equal(button(panel.tree, '保存到个人认知库').props.disabled, false, 'ordinary save needs no handwritten change reason');
const panelOperation = find(panel.tree, n => n.type === 'select' && n.props.id.endsWith('-operation'));
panel.change(panelOperation, 'contextual');
assert.ok(button(panel.tree, '保存到个人认知库').props.disabled, 'a real parallel context must still be stated');
panel.change(find(panel.tree, n => n.type === 'select' && n.props.id.endsWith('-operation')), 'supplement');
panel.change(find(panel.tree, n => n.type === 'textarea'), '本次补充说明');
assert.equal(all(panel.tree).some(n => n.type === 'input' && n.props.type === 'checkbox'), false, 'saving no longer needs a second confirmation');
const savePanel = button(panel.tree, '保存到个人认知库').props.onClick; savePanel(); savePanel(); panel.render();
assert.equal(panel.store.writes.length, 1);
panel.update({ doc: { ...doc, title: '提交后变更的画布' } });
panel.store.writes[0].resolve(seed); await tick(); panel.render();
assert.equal(find(panel.tree, n => n.type === 'textarea').props.value, '本次补充说明');
assert.match(content(panel.tree), /后续变化尚未写入/);
assert.equal(panel.store.leave.allow(), false); panel.render();
panel.store.emit(); panel.store.reads[2].reject(new Error('合成重新读取失败')); await tick(); panel.render();
assert.ok(find(panel.tree, n => n.type === 'fieldset').props.disabled);
assert.equal(button(panel.tree, '取消本次认知整理').props.disabled, false, 'read failures do not trap dirty input behind a disabled fieldset');
button(panel.tree, '取消本次认知整理').props.onClick(); panel.render();
assert.equal(panel.store.leave.allow(), true); assert.equal(find(panel.tree, n => n.type === 'textarea').props.value, '');

const annotatedSeed = structuredClone(seed), annotatedRevision = annotatedSeed.records[0].revisions[0];
annotatedRevision.branches[0].graph.nodes[0].text = '条件 A\n且条件 D 时结果 B 成立。';
annotatedRevision.branches[0].graph.nodes[0].conditions = ['条件 A\n且条件 D'];
annotatedRevision.branches[0].graph.nodes[1].conditions = [];
annotatedRevision.branches[0].graph.edges.push({ id: 'reason', source: 'a', target: 'b', relation: 'support', reason: '仅作本情境下的支持\n不视为无条件证明。' });
const historical = harness('src/components/PersonalCognitionPanel.tsx', 'CognitionRevisionContent', { revision: annotatedRevision });
assert.match(content(historical.tree), /已记录条件（1）条件 A\n且条件 D/);
assert.match(content(historical.tree), /已记录条件（0）尚无已标注条件，不代表/);
assert.match(content(historical.tree), /关系说明：仅作本情境下的支持\n不视为无条件证明。/);
historical.unmount();
const canvasWithoutAnnotations = { ...doc, nodes: doc.nodes.map(node => ({ ...node,
  text: annotatedRevision.branches[0].graph.nodes.find(item => item.id === node.id)!.text })),
  edges: annotatedRevision.branches[0].graph.edges.map(({ reason, ...edge }) => edge) };
const guardedCanvas = harness('src/components/PersonalCognitionPanel.tsx', 'PersonalCognitionPanel', { doc: canvasWithoutAnnotations });
guardedCanvas.store.reads[0].resolve(annotatedSeed); await tick(); guardedCanvas.render();
guardedCanvas.change(find(guardedCanvas.tree, n => n.type === 'select' && n.props.id.endsWith('-operation')), 'revise', true);
guardedCanvas.change(find(guardedCanvas.tree, n => n.type === 'textarea'), '只重新确认，不移除已有条件', true);
let canvasPreview = all(guardedCanvas.tree).find(n => n.type?.name === 'CognitionRevisionContent' && n.props.revision.id === 'preview');
assert.ok(canvasPreview);
assert.deepEqual(Array.from(canvasPreview.props.revision.branches[0].graph.nodes[0].conditions), ['条件 A\n且条件 D']);
assert.equal(button(guardedCanvas.tree, '保存到个人认知库').props.disabled, false);
guardedCanvas.update({ doc }); // The canvas removed the conditions from the actual body.
assert.equal(button(guardedCanvas.tree, '保存到个人认知库').props.disabled, true);
assert.match(content(guardedCanvas.tree), /不能静默移除或改写已记录条件/);
assert.equal(find(guardedCanvas.tree, n => n.type === 'textarea').props.value, '只重新确认，不移除已有条件');
assert.equal(guardedCanvas.store.writes.length, 0, 'invalid canvas previews never enter a storage write or automatically confirm');
guardedCanvas.unmount();
// Run the actual focus effects at their DOM boundary; do not reimplement their rules.
function focusEffect(path: string, contains: string) {
  const source = readFileSync(path, 'utf8'), ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let effect: ts.Node | undefined;
  function walk(n: ts.Node) { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect' && n.arguments[0].getText(ast).includes(contains)) effect = n.arguments[0]; ts.forEachChild(n, walk); }
  walk(ast); assert.ok(effect);
  return ts.transpileModule(`return (${effect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
let focused = '';
const pendingButton = { current: { focus() { focused = 'safe-choice'; } } }, targetSelect = { current: { focus() { focused = 'target'; } } }, wasPending = { current: false };
const targetEffect = focusEffect(formPath, 'wasPending.current');
const focusTarget = (pendingTarget: string | null) => new Function('pendingTarget', 'pendingButton', 'targetSelect', 'wasPending', targetEffect)(pendingTarget, pendingButton, targetSelect, wasPending)();
focusTarget(second); assert.equal(focused, 'safe-choice'); focusTarget(null); assert.equal(focused, 'target');
const origin = { isConnected: true, matches: () => false, focus() { focused = 'submit'; } };
const focusDocument = { body: {}, documentElement: {}, activeElement: {} };
const pendingFocus = { current: origin as any }, lifetime = { current: { active: true } };
const restoreEffect = focusEffect('src/components/useCognitionWrite.ts', 'pendingFocus.current');
const restore = (busy: boolean) => new Function('busy', 'pendingFocus', 'lifetime', 'document', restoreEffect)(busy, pendingFocus, lifetime, focusDocument)();
focused = ''; focusDocument.activeElement = focusDocument.body; restore(true); assert.equal(focused, ''); assert.ok(pendingFocus.current);
restore(false); assert.equal(focused, 'submit');
pendingFocus.current = origin; focusDocument.activeElement = {}; focused = ''; restore(false); assert.equal(focused, '', 'an active input elsewhere keeps focus');
pendingFocus.current = { ...origin, isConnected: false }; focusDocument.activeElement = focusDocument.body; restore(false); assert.equal(focused, '');
const css = readFileSync('src/components/PersonalCognition.css', 'utf8');
for (const token of ['--ln-accent', '--ln-input-bg', '--ln-text-primary', '--ln-border']) assert.ok(css.includes(token));
assert.match(css, /focus-visible/); assert.match(css, /min-height: 44px/);
const referenceRecord = seeded.records[0], referenceRevision = referenceRecord.revisions.at(-1)!;
const referenceBranch = referenceRevision.branches[0];
const references = referenceBranch.graph.nodes.map(n => ({ recordId: referenceRecord.id, revisionId: referenceRevision.id,
  branchId: referenceBranch.id, nodeId: n.id }));
const referenceEntry = harness('src/components/AgentCognitionReferences.tsx', 'AgentCognitionReferences', { references });
const outerDetails = find(referenceEntry.tree, n => n.type === 'details'), openedTarget = { open: true };
outerDetails.props.onToggle({ target: openedTarget, currentTarget: openedTarget }); referenceEntry.render();
const originalSubtree = find(referenceEntry.tree, n => n.type?.name === 'CurrentReferences');
referenceEntry.update({ references: [] });
const retainedSubtree = find(referenceEntry.tree, n => n.type?.name === 'CurrentReferences');
assert.equal(retainedSubtree.type, originalSubtree.type); assert.equal(retainedSubtree.key, originalSubtree.key);
assert.equal(retainedSubtree.key, 'current-references', 'the actual outer entry retains the editor subtree when all pointers disappear');
assert.match(content(referenceEntry.tree), /引用列表已变化/);
const emptyEntry = harness('src/components/AgentCognitionReferences.tsx', 'AgentCognitionReferences', { references: [] });
assert.equal(emptyEntry.tree, null, 'an empty unopened reference entry remains hidden');
const refs = harness('src/components/AgentCognitionReferences.tsx', '__testCurrentReferences', { references });
refs.store.reads[0].resolve(seeded); await tick(); refs.render();
button(refs.tree, '更新这条理解').props.onClick(); refs.render();
assert.ok(button(refs.tree, '更新这条理解').props.disabled, 'another agent reference cannot replace an open draft');
let referenceForm = find(refs.tree, n => n.type?.name === 'CognitionEditForm');
assert.equal(find(refs.tree, n => n.key === 'editor').key, 'editor');
assert.equal(referenceForm.props.writeLock.current, false); referenceForm.props.onBusyChange(true); refs.render();
refs.store.emit(); refs.store.reads[1].reject(new Error('synthetic read failure')); await tick(); refs.render();
assert.ok(find(refs.tree, n => n.type?.name === 'CognitionEditForm'), 'a failed read preserves the mounted editor');
assert.match(content(refs.tree), /编辑草稿仍保留/);
referenceForm.props.onBusyChange(false); refs.render();
button(refs.tree, '重试读取').props.onClick(); refs.render();
refs.store.reads[2].resolve({ ...seeded, revision: seeded.revision + 1, records: [] }); await tick(); refs.render();
referenceForm = find(refs.tree, n => n.type?.name === 'CognitionEditForm');
assert.equal(find(refs.tree, n => n.key === 'editor').key, 'editor', 'the editor keeps its React key when the current target disappears');
assert.match(content(refs.tree), /未保存草稿仍保留/, 'removed target is reported without removing the draft');
refs.update({ references: [] });
assert.ok(find(refs.tree, n => n.type?.name === 'CognitionEditForm'), 'an updated reference list preserves the active editor');
refs.store.emit(); // A read starts before the save receipt is delivered.
referenceForm.props.onSaved({ ...seeded, revision: 80 }); refs.render();
refs.store.reads[3].resolve(emptyCognitionFile()); await tick(); refs.render();
refs.update({ references });
assert.match(content(refs.tree), /条件 A/, 'a delayed agent-reference read cannot overwrite the newer save result');
assert.match(content(refs.tree), /已保存你确认的更新/);
refs.unmount();
console.log('PASS cognition UI: draft/target preservation, duplicate and shared write locks, unmount/read ownership, retry, frozen destructive confirmation, truthful candidate outcome, agent-reference draft ownership and themed controls');
await import('./check-cognition-leave-navigation');
