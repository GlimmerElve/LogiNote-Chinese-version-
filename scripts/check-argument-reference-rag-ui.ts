import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { expectedNoteArgumentReference } from '../src/services/argumentContext/referenceBuildClient.ts';
import { argumentReferenceRagBuildReasonLabel, type PreparedReferenceRagBuild } from '../src/services/argumentContext/referenceRagBuildClient.ts';
import type { NoteItem } from '../src/types.ts';

// Actual React component handlers and shared useDialog execute against isolated
// hook/DOM fixtures. This is not a real Electron or desktop visual acceptance.
globalThis.fetch = async () => assert.fail('Network forbidden in combined reference UI checks');
type Element = { type: unknown; props: Record<string, any> };
const path = resolve('src/components/ReferenceArgumentStatus.tsx'), moduleRequire = createRequire(path);
const compile = (file: string) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
const source = compile(path), dialogSource = compile('src/components/useDialog.ts');
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const note: NoteItem = { id: 'synthetic-rag-ui-note', noteType: 'knowledge', title: '合成知识点', content: '在条件B下，A可能导致C。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
  referenceSources: [{ type: 'web', title: '合成测试出处', url: 'https://example.org/synthetic' }] };
const expected = await expectedNoteArgumentReference(note), counts = { nodes: 3, relations: 2, groups: 0, scopes: 1 };
const baseTicket: PreparedReferenceRagBuild = { status: 'prepared', environmentId: 'synthetic-rag-environment', ticketId: 'synthetic-rag-ticket',
  expiresAt: '2026-10-07T03:00:00.000Z', summary: { sourceKind: 'knowledge-note', entityId: note.id, sourceVersion: expected.version,
    contentHash: expected.contentHash, characters: note.content.length, chunks: 1, sentences: 1,
    providerLabel: 'Synthetic provider', modelName: 'synthetic-model', isRemote: true, stage: 'structure-and-propositions',
    maximumModelRequests: 5, reviewBudget: 'checked-after-extraction' } };
function mockApi() {
  const calls = { status: 0, prepare: 0, run: 0, runReturned: 0, cancel: 0, invalidate: 0, legacy: 0 };
  let status: any = { status: 'missing', source: expected, sourceQualification: 'unassessed', reasonCode: 'review_incomplete' };
  let ticket: any = structuredClone(baseTicket), prepareGate: ReturnType<typeof deferred<any>> | undefined;
  const runGate = deferred<any>(), changed = new Set<() => void>(), invalidated = new Set<() => void>();
  return { calls,
    client: { status: async () => { calls.status++; return structuredClone(status); },
      prepare: async () => { calls.prepare++; return prepareGate ? prepareGate.promise : structuredClone(ticket); },
      run: async () => { calls.run++; const result = await runGate.promise; calls.runReturned++; return result; },
      cancel: async () => { calls.cancel++; return { status: 'cancelled' }; }, invalidate: () => { calls.invalidate++; } },
    getApi: () => ({ onChanged(callback: () => void) { changed.add(callback); return () => changed.delete(callback); },
      onInvalidated(callback: () => void) { invalidated.add(callback); return () => invalidated.delete(callback); } }),
    setStatus: (value: any) => { status = value; }, setTicket: (value: any) => { ticket = value; },
    delayPrepare: () => { prepareGate = deferred<any>(); return prepareGate; },
    releaseRun: (value: any = { status: 'published', counts, propositionCount: 4 }) => runGate.resolve(value),
    changed: () => changed.forEach(callback => callback()), invalidated: () => invalidated.forEach(callback => callback()),
  };
}
function all(element: unknown): Element[] {
  if (Array.isArray(element)) return element.flatMap(all);
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element; return [node, ...all(node.props.children)];
}
function text(element: unknown): string {
  if (Array.isArray(element)) return element.map(text).join('');
  if (!element || typeof element !== 'object') return String(element ?? '');
  return 'props' in element ? text((element as Element).props.children) : '';
}
function harness(mock = mockApi(), props: Record<string, any> = { source: { kind: 'knowledge-note', entityId: note.id },
  note: structuredClone(note), disabled: false, disabledBehavior: 'hold' }) {
  type HookState = { slots: any[]; cleanups: Map<number, () => void>; effects: { index: number; effect: () => void | (() => void) }[] };
  const fresh = (): HookState => ({ slots: [], cleanups: new Map(), effects: [] });
  const parent = fresh(), dialog = fresh();
  let active = parent, cursor = 0, changed = false, unmounted = false, tree: Element, pendingReadOnly = 0, dialogMounted = false;
  const listeners = new Map<string, Set<(event: any) => void>>();
  const doc = { body: {}, activeElement: null as any,
    addEventListener: (name: string, fn: (event: any) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener: (name: string, fn: (event: any) => void) => { listeners.get(name)?.delete(fn); } };
  class DomElement {
    isConnected = true;
    tabIndex = 0;
    controls: DomElement[] = [];
    focus() { doc.activeElement = this; }
    closest() { return null; }
    querySelectorAll() { return this.controls; }
    getClientRects() { return [{}]; }
    contains(value: DomElement) { return value === this || this.controls.includes(value); }
  }
  const origin = new DomElement(); origin.focus(); let card: DomElement | undefined;
  const cleanup = (state: HookState) => { state.cleanups.forEach(fn => fn()); state.cleanups.clear(); };
  const hooks = { ...React,
    useState(initial: any) { const state = active, index = cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [state.slots[index], (value: any) => { assert.equal(unmounted, false, 'no update after unmount');
        const next = typeof value === 'function' ? value(state.slots[index]) : value;
        if (!Object.is(next, state.slots[index])) { state.slots[index] = next; changed = true; } }]; },
    useRef(initial: any) { const index = cursor++; return active.slots[index] ||= { current: initial }; },
    useId() { const index = cursor++; return active.slots[index] ||= `synthetic-dialog-${index}`; },
    useCallback(fn: any, deps: unknown[]) { const index = cursor++;
      if (!active.slots[index] || !sameDeps(active.slots[index].deps, deps)) active.slots[index] = { fn, deps }; return active.slots[index].fn; },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) { const index = cursor++;
      if (!active.slots[index] || !sameDeps(active.slots[index].deps, deps)) { active.slots[index] = { deps }; active.effects.push({ index, effect }); } },
  };
  const hookWithLayout = { ...hooks, useLayoutEffect: hooks.useEffect };
  const dialogModule = { exports: {} as Record<string, any> };
  runInNewContext(dialogSource, { module: dialogModule, exports: dialogModule.exports,
    require: (id: string) => { assert.equal(id, 'react'); return hookWithLayout; },
    document: doc, HTMLElement: DomElement, getComputedStyle: () => ({ visibility: 'visible' }), Symbol });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(source, { module, exports: module.exports, require(id: string) {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime' || id === 'lucide-react') return moduleRequire(id);
    if (id === 'react-dom') return { createPortal: (element: unknown) => element };
    if (id === './useDialog') return dialogModule.exports;
    if (id === '../services/argumentContext/referenceBuildClient') return {
      argumentReferenceBuildClient: { status: async () => { mock.calls.legacy++; assert.fail('legacy fallback forbidden'); },
        prepare: async () => { mock.calls.legacy++; assert.fail('legacy fallback forbidden'); },
        run: async () => { mock.calls.legacy++; assert.fail('legacy fallback forbidden'); }, cancel: async () => { mock.calls.legacy++; }, invalidate: () => {} },
      getArgumentReferenceBuildApi: () => ({}), argumentReferenceBuildReasonLabel: argumentReferenceRagBuildReasonLabel,
      expectedNoteArgumentReference: async (captured: NoteItem) => { pendingReadOnly++; try { return await expectedNoteArgumentReference(captured); } finally { pendingReadOnly--; } },
    };
    if (id === '../services/argumentContext/referenceRagBuildClient') return {
      argumentReferenceRagBuildClient: { ...mock.client, status: async () => { pendingReadOnly++; try { return await mock.client.status(); } finally { pendingReadOnly--; } } },
      getArgumentReferenceRagBuildApi: mock.getApi, argumentReferenceRagBuildReasonLabel,
    };
    throw new Error(`Unmocked import forbidden: ${id}`);
  }, document: doc, structuredClone, Date, Error, JSON, Set, Map, Promise, Number, String, Boolean, Math });
  const flushEffects = (state: HookState) => { const effects = state.effects.splice(0); effects.forEach(({ index, effect }) => {
    state.cleanups.get(index)?.(); const fn = effect(); if (fn) state.cleanups.set(index, fn); else state.cleanups.delete(index);
  }); };
  const render = () => {
    let passes = 0;
    do { changed = false; active = parent; cursor = 0; tree = module.exports.ReferenceArgumentStatus(props); flushEffects(parent);
      assert.ok(++passes < 12, 'fixture settles');
    } while (changed);
    if (!all(tree).some(node => typeof node.type === 'function' && node.type.name === 'ReferenceProcessingConfirmation') && dialogMounted) {
      cleanup(dialog); dialogMounted = false;
    }
    return tree;
  };
  render();
  return { mock, props, render, flush: () => unmounted ? tree : render(), get tree() { return tree; }, get pendingReadOnly() { return pendingReadOnly; },
    renderConfirmation() {
      const child = all(tree).find(node => typeof node.type === 'function' && node.type.name === 'ReferenceProcessingConfirmation'); assert.ok(child);
      active = dialog; cursor = 0; const modal = (child.type as (props: any) => Element)(child.props);
      const root = all(modal).find(node => node.props.role === 'dialog')!; assert.ok(root);
      card ||= new DomElement(); card.controls = all(modal).filter(node => node.type === 'button').map(() => new DomElement());
      root.props.ref.current = card; flushEffects(dialog); dialogMounted = true; active = parent;
      return { modal, root, card, origin, doc, emit: (name: string, value: any) => listeners.get(name)?.forEach(fn => fn(value)) };
    },
    unmount() { unmounted = true; cleanup(parent); cleanup(dialog); },
  };
}
function button(ui: ReturnType<typeof harness>, label: string): Element {
  const node = all(ui.tree).find(value => value.type === 'button' && text(value.props.children) === label); assert.ok(node, `missing ${label}`); return node;
}
function confirmation(ui: ReturnType<typeof harness>) {
  return all(ui.tree).find(node => typeof node.type === 'function' && node.type.name === 'ReferenceProcessingConfirmation');
}
async function waitFor(ui: ReturnType<typeof harness>, label: string, ready: () => boolean = () => true) {
  const deadline = performance.now() + 10_000;
  do { await new Promise<void>(done => setTimeout(done, 1)); ui.flush(); if (!ui.pendingReadOnly && ready()) return; } while (performance.now() < deadline);
  assert.fail(`Timed out ${label}; UI=${text(ui.tree)}`);
}
async function prepare(ui: ReturnType<typeof harness>, label = '建立参考论证') {
  await waitFor(ui, 'status'); button(ui, label).props.onClick(); await waitFor(ui, 'confirmation', () => Boolean(confirmation(ui)));
}

const initial = harness(); await waitFor(initial, 'mount');
assert.equal(initial.mock.calls.prepare, 0); assert.equal(initial.mock.calls.run, 0); assert.equal(initial.mock.calls.legacy, 0);
assert.ok(all(initial.tree).some(node => node.props.role === 'status' && node.props['aria-live'] === 'polite'));
pass('new bridge is preferred; mount/status only read and live region announces state');
await prepare(initial); const modal = initial.renderConfirmation();
assert.match(text(modal.modal), /最多 5 次请求/); assert.match(text(modal.modal), /再提取并独立审核关键命题/);
assert.match(text(modal.modal), /不修改原文、个人认知或掌握度分数/); assert.equal(modal.root.props['aria-modal'], 'true');
assert.ok(all(modal.modal).find(node => node.props.id === modal.root.props['aria-labelledby']));
assert.equal(modal.doc.activeElement, modal.card.controls[0]);
modal.card.controls.at(-1)!.focus(); const tab = { key: 'Tab', shiftKey: false, prevented: 0, preventDefault() { this.prevented++; } };
modal.emit('keydown', tab); assert.equal(tab.prevented, 1); assert.equal(modal.doc.activeElement, modal.card.controls[0]);
const escape = { key: 'Escape', prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } };
modal.emit('keydown', escape); await waitFor(initial, 'Escape closes', () => !confirmation(initial));
assert.equal(escape.stopped, 1); assert.equal(initial.mock.calls.cancel, 1); assert.equal(initial.mock.calls.run, 0); assert.equal(modal.doc.activeElement, modal.origin);
pass('single consent explains five stages; actual useDialog traps Tab, cancels on Escape and restores focus');

const running = harness(); await prepare(running); const confirm = confirmation(running)!.props.onConfirm; confirm(); confirm();
await waitFor(running, 'run', () => running.mock.calls.run === 1);
for (const disabled of [true, false, true, false]) { running.props.disabled = disabled; running.render(); running.mock.changed(); await waitFor(running, 'unrelated saving'); }
assert.equal(running.mock.calls.cancel, 0); assert.equal(running.mock.calls.run, 1); assert.equal(running.mock.calls.legacy, 0);
running.mock.releaseRun(); await waitFor(running, 'whole ready', () => /4 个关键命题/u.test(text(running.tree)));
assert.match(text(running.tree), /参考论证已发布/); assert.equal(all(running.tree).some(node => node.type === 'button' && /建立|完善/u.test(text(node.props.children))), false);
pass('double confirmation and unrelated save acknowledgements preserve exactly one combined run');

const partial = harness(); await prepare(partial); confirmation(partial)!.props.onConfirm();
await waitFor(partial, 'partial run', () => partial.mock.calls.run === 1);
partial.mock.releaseRun({ status: 'held', reasonCode: 'proposition_review_held', structureStatus: 'published', counts });
await waitFor(partial, 'partial held', () => /结构已保存/u.test(text(partial.tree)));
assert.doesNotMatch(text(partial.tree), /已发布|已就绪/u); assert.ok(button(partial, '完善参考论证')); assert.equal(partial.mock.calls.legacy, 0);
pass('failed proposition audit retains visible stored structure without claiming overall success or old fallback');

const completionMock = mockApi(); completionMock.setStatus({ status: 'missing', source: expected, sourceQualification: 'eligible', reasonCode: 'propositions_missing', counts });
completionMock.setTicket({ ...baseTicket, summary: { ...baseTicket.summary, stage: 'propositions', maximumModelRequests: 2 } });
const completion = harness(completionMock); await prepare(completion, '完善参考论证'); const completionModal = completion.renderConfirmation();
assert.match(text(completionModal.modal), /最多 2 次请求/); assert.match(text(completionModal.modal), /复用已审核的论证结构/);
assert.doesNotMatch(text(completionModal.modal), /最多 5|最多 3/u); assert.equal(completion.mock.calls.run, 0);
confirmation(completion)!.props.onClose(); await waitFor(completion, 'close two-stage confirmation');
pass('a saved structure receives one explicit two-request completion confirmation, not a hidden extra authorization');

const availableMock = mockApi(); availableMock.setStatus({ status: 'available', source: expected, sourceQualification: 'eligible', counts, propositionCount: 4 });
const available = harness(availableMock); await waitFor(available, 'already ready', () => /已就绪/u.test(text(available.tree)));
available.mock.changed(); await waitFor(available, 'ready refresh'); assert.equal(available.mock.calls.prepare, 0); assert.equal(available.mock.calls.run, 0);
assert.equal(all(available.tree).some(node => node.type === 'button'), false);
pass('existing structure plus propositions stays ready after read-only refresh with zero model preparation/run');

const heldMock = mockApi(); heldMock.setStatus({ status: 'held', reasonCode: 'proposition_storage_unavailable' });
heldMock.setTicket({ status: 'held', reasonCode: 'proposition_storage_unavailable' });
const held = harness(heldMock); await waitFor(held, 'new API held'); button(held, '建立参考论证').props.onClick();
await waitFor(held, 'held prepare', () => held.mock.calls.prepare === 1); assert.equal(held.mock.calls.run, 0); assert.equal(held.mock.calls.legacy, 0);
assert.equal(confirmation(held), undefined); assert.match(text(held.tree), /未能安全保存/u);
pass('new bridge failures never fall back to the old three-request workflow');

const edited = harness(); await prepare(edited); confirmation(edited)!.props.onConfirm(); await waitFor(edited, 'before edit', () => edited.mock.calls.run === 1);
edited.props.note = { ...edited.props.note, content: '真正改动的合成正文' }; edited.render(); await waitFor(edited, 'source edit', () => edited.mock.calls.cancel === 1);
edited.mock.releaseRun(); await waitFor(edited, 'late completion', () => edited.mock.calls.runReturned === 1); assert.doesNotMatch(text(edited.tree), /已发布/u);
pass('source identity changes cancel work and reject late ready receipts');

const late = harness(), gate = late.mock.delayPrepare(); await waitFor(late, 'before delayed prepare'); button(late, '建立参考论证').props.onClick();
await waitFor(late, 'prepare issued', () => late.mock.calls.prepare === 1); late.props.note = { ...late.props.note, title: '改变标题' }; late.render(); gate.resolve(baseTicket);
await waitFor(late, 'cancel obsolete ticket', () => late.mock.calls.cancel === 1); assert.equal(confirmation(late), undefined); assert.equal(late.mock.calls.run, 0);
pass('late prepared tickets for obsolete source keys cannot reopen consent');

const invalidated = harness(); await prepare(invalidated); invalidated.mock.invalidated();
await waitFor(invalidated, 'host invalidation', () => invalidated.mock.calls.cancel === 1); assert.equal(confirmation(invalidated), undefined);
assert.equal(invalidated.mock.calls.invalidate, 1); assert.equal(invalidated.mock.calls.run, 0);
pass('model/root/navigation invalidation clears the combined lease and confirmation without running');

const mismatchMock = mockApi(); mismatchMock.setTicket({ ...baseTicket, summary: { ...baseTicket.summary, sourceVersion: 'obsolete' } });
const mismatch = harness(mismatchMock); await waitFor(mismatch, 'before mismatch prepare'); button(mismatch, '建立参考论证').props.onClick();
await waitFor(mismatch, 'mismatch notice', () => mismatch.mock.calls.cancel === 1); assert.equal(confirmation(mismatch), undefined); assert.equal(mismatch.mock.calls.run, 0);
assert.match(text(mismatch.tree), /尚未保存/u);
pass('renderer saved-source freshness rejects mismatched prepared identities before consent');

const unmounted = harness(); await prepare(unmounted); confirmation(unmounted)!.props.onConfirm(); await waitFor(unmounted, 'before unmount', () => unmounted.mock.calls.run === 1);
unmounted.unmount(); assert.equal(unmounted.mock.calls.cancel, 1); unmounted.mock.releaseRun(); await waitFor(unmounted, 'late unmounted reply', () => unmounted.mock.calls.runReturned === 1);
pass('unmount cancels work and refuses late state changes');

const pending = harness(mockApi(), { source: { kind: 'knowledge-note', entityId: note.id }, note: structuredClone(note), disabled: true, disabledBehavior: 'hold' });
await waitFor(pending, 'waiting for save'); assert.equal(all(pending.tree).some(node => node.type === 'button'), false);
pending.props.disabled = false; pending.render(); await waitFor(pending, 'save acknowledged');
assert.ok(button(pending, '建立参考论证')); assert.equal(pending.mock.calls.prepare, 0); assert.equal(pending.mock.calls.run, 0);
pass('saved-body gating hides the entry until acknowledgement but never automatically prepares/runs');

const preserved = harness(); await prepare(preserved); preserved.props.disabled = true; preserved.render(); preserved.mock.changed();
await waitFor(preserved, 'unchanged source confirmation', () => Boolean(confirmation(preserved)));
assert.equal(preserved.mock.calls.cancel, 0); confirmation(preserved)!.props.onClose(); await waitFor(preserved, 'close preserved confirmation');
assert.equal(preserved.mock.calls.cancel, 1); assert.equal(preserved.mock.calls.run, 0);
pass('hold preserves one unchanged-source consent dialog across global saving and change notifications');

const document = harness(mockApi(), { source: { kind: 'uploaded-document', entityId: 'synthetic-document' }, disabled: false });
await prepare(document); document.props.disabled = true; document.render(); await waitFor(document, 'document invalidated', () => document.mock.calls.cancel === 1);
assert.equal(confirmation(document), undefined); assert.equal(document.mock.calls.run, 0);
pass('uploaded document parse/save invalidation still cancels consent rather than reusing a stale source');

const activity = harness(); await prepare(activity); confirmation(activity)!.props.onConfirm(); await waitFor(activity, 'before activity edit', () => activity.mock.calls.run === 1);
activity.props.note = { ...activity.props.note, updatedAt: '2026-10-07T06:00:00.000Z', lastReferencedAt: '2026-10-07T06:00:00.000Z',
  flowSummary: '个人活动记录不属于参考正文' };
activity.props.disabled = true; activity.render(); await waitFor(activity, 'activity metadata update');
assert.equal(activity.mock.calls.cancel, 0); activity.mock.releaseRun(); await waitFor(activity, 'activity-preserved completion', () => /已发布/u.test(text(activity.tree)));
pass('personal activity metadata never changes the reference source key or becomes reference input');

const stopped = harness(); await prepare(stopped); confirmation(stopped)!.props.onConfirm(); await waitFor(stopped, 'before explicit stop', () => stopped.mock.calls.run === 1);
button(stopped, '停止处理').props.onClick(); assert.equal(stopped.mock.calls.cancel, 1); assert.match(text(stopped.flush()), /正在停止处理/u);
stopped.mock.releaseRun({ status: 'held', reasonCode: 'cancelled' }); await waitFor(stopped, 'stopped receipt', () => /本次处理已停止/u.test(text(stopped.tree)));
assert.equal(stopped.mock.calls.run, 1); assert.doesNotMatch(text(stopped.tree), /已发布|已就绪/u);
pass('explicit stop cancels the original combined ticket without a replay or false success');

const changedBadgeMock = mockApi(); changedBadgeMock.setStatus({ status: 'available', source: expected, sourceQualification: 'eligible', counts, propositionCount: 4 });
const changedBadge = harness(changedBadgeMock); await waitFor(changedBadge, 'before source dependency change', () => /已就绪/u.test(text(changedBadge.tree)));
changedBadgeMock.setStatus({ status: 'missing', source: expected, sourceQualification: 'eligible', counts, reasonCode: 'propositions_missing' }); changedBadgeMock.changed();
await waitFor(changedBadge, 'changed active dependency', () => /关键命题尚待审核/u.test(text(changedBadge.tree)));
assert.ok(button(changedBadge, '完善参考论证')); assert.equal(changedBadgeMock.calls.prepare, 0); assert.equal(changedBadgeMock.calls.run, 0);
pass('idle dependency changes remove the ready badge and expose only explicit completion');
for (const ui of [initial, running, partial, completion, available, held, edited, late, invalidated, mismatch, pending, preserved, document, activity, stopped, changedBadge]) ui.unmount();
console.log(`Argument reference RAG UI checks passed (${checks} groups; actual React handlers/shared dialog; zero model/network/production writes).`);
