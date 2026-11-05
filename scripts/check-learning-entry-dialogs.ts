import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import RealReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RealMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { FormulaBlock } from '../src/components/textbook/FormulaBlock';

// Compile the production components and dialog hook into memory with isolated DOM primitives.
// No application bootstrap, storage, Electron bridge, LLM or network is installed.
globalThis.fetch = async () => assert.fail('Learning entry checks must never access the network');
type Tree = { type: unknown; props: Record<string, any> };
const React = {
  Fragment: Symbol('fragment'),
  createElement: (type: unknown, props: Record<string, any> | null, ...children: any[]): Tree => ({
    type, props: { ...(props || {}), children },
  }),
};
function elements(value: any): Tree[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(elements);
  return [value, ...elements(value.props?.children)];
}
function compile(path: string, environment: Record<string, unknown>, names: string[]): any {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = source.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(source)).join('\n')
    .replace(/^export\s+/gm, '');
  const output = ts.transpileModule(`${code}\nreturn { ${names.join(', ')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), output)(...Object.values(environment));
}
function emitter() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    listeners,
    addEventListener: (name: string, callback: (event: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener: (name: string, callback: (event: any) => void) => listeners.get(name)?.delete(callback),
    emit: (name: string, event: any) => [...(listeners.get(name) || [])].forEach((listener) => listener(event)),
  };
}
function hooks() {
  const slots: any[] = [];
  const pending = new Set<number>();
  let index = 0;
  const changed = (old: any[] | undefined, next: any[] | undefined) => !old || !next
    || old.length !== next.length || old.some((value, cursor) => !Object.is(value, next[cursor]));
  return {
    begin: () => { index = 0; },
    useState: (initial: any) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[slot].value, (value: any) => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }];
    },
    useRef: (initial: any) => { const slot = index++; return slots[slot] ||= { current: initial }; },
    useId: () => { const slot = index++; return slots[slot] ||= `learning-dialog-${slot}`; },
    useCallback: (callback: any, deps: any[]) => {
      const slot = index++;
      if (changed(slots[slot]?.deps, deps)) slots[slot] = { value: callback, deps };
      return slots[slot].value;
    },
    useEffect: (callback: any, deps?: any[]) => {
      const slot = index++;
      if (changed(slots[slot]?.deps, deps)) {
        slots[slot] = { ...slots[slot], callback, deps };
        pending.add(slot);
      }
    },
    flush: () => {
      for (const slot of [...pending]) {
        pending.delete(slot); slots[slot].cleanup?.(); slots[slot].cleanup = slots[slot].callback();
      }
    },
    unmount: () => { slots.forEach((slot) => slot?.cleanup?.()); pending.clear(); },
  };
}
const icon = () => null;
const icons = Object.fromEntries(['Brain', 'Clock', 'Sparkles', 'X', 'BookOpen', 'ExternalLink', 'GripVertical'].map((name) => [name, icon]));
function fixture(viewport = { width: 1024, height: 768 }) {
  const state = hooks();
  const doc = { ...emitter(), activeElement: null as any };
  const win = { ...emitter(), innerWidth: viewport.width, innerHeight: viewport.height };
  class Element {
    isConnected = true;
    controls: Element[] = [];
    constructor(public props: Record<string, any> = {}) {}
    get tabIndex() { return this.props.tabIndex ?? 0; }
    focus() { doc.activeElement = this; }
    closest(selector: string) {
      if (selector === 'button') return this.props.type === 'button' ? this : null;
      if (selector === '[data-preview-drag-handle]') return this.props['data-preview-drag-handle'] ? this : null;
      return null;
    }
    querySelectorAll() { return this.controls; }
    contains(element: Element) { return element === this || this.controls.includes(element); }
    getClientRects() { return [{}]; }
    getBoundingClientRect() {
      const width = Math.min(384, win.innerWidth - 32);
      const height = Math.min(1200, typeof this.props.style?.maxHeight === 'number' ? this.props.style.maxHeight : win.innerHeight - 32);
      return { width, height };
    }
  }
  const origin = new Element(); origin.focus();
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  class Observer {
    record: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) { this.record = { callback, disconnected: false }; observers.push(this.record); }
    observe() {}
    disconnect() { this.record.disconnected = true; }
  }
  const environment = { ...state, useLayoutEffect: state.useEffect, React, ...icons,
    document: doc, window: win, HTMLElement: Element, getComputedStyle: () => ({ visibility: 'visible' }), ResizeObserver: Observer,
    ReactMarkdown: 'markdown-preview', remarkGfm, remarkMath, FormulaBlock };
  const dialog = compile('src/components/useDialog.ts', environment, ['useDialog', 'hasActiveDialog']);
  const entry = compile('src/components/FlowEntranceModal.tsx', { ...environment, useDialog: dialog.useDialog }, ['FlowEntranceModal']);
  const preview = compile('src/components/KnowledgePreview.tsx', { ...environment, useDialog: dialog.useDialog }, ['KnowledgePreview', 'constrainKnowledgePreviewPosition']);
  let card: Element | null = null, tree: Tree | null = null;
  const render = (component: (props: any) => Tree, props: any) => {
    state.begin(); tree = component(props);
    const nodes = elements(tree);
    const root = nodes.find((node) => node.props.role === 'dialog');
    if (root) {
      if (!card) card = new Element();
      card.props = root.props;
      card.controls = nodes.filter((node) => node.type === 'button' || node.type === 'input' || node.props.tabIndex >= 0).map((node) => new Element({ type: node.type, ...node.props }));
      root.props.ref.current = card;
    }
    state.flush();
    return nodes;
  };
  return { ...state, ...entry, ...preview, ...dialog, doc, win, origin, observers, Element, render,
    card: () => card!, current: () => elements(tree) };
}
const event = (values: Record<string, any>) => ({ ...values, prevented: 0, stopped: 0,
  preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, stopImmediatePropagation() { this.stopped++; } });
const note = { id: 'preview-note', title: '学习正态分布与置信区间', content: '长内容\n'.repeat(1000), tags: ['知识点'], links: [], updatedAt: '2026-10-07T00:00:00Z' };

// Actual modal render, actual shared useDialog effect, actual input and confirmation callbacks.
const flow = fixture();
let closed = 0;
const confirmations: any[] = [];
const flowProps = { isOpen: true, note, defaultInterval: 20, onClose: () => closed++, onConfirm: (...values: any[]) => confirmations.push(values) };
let flowNodes = flow.render(flow.FlowEntranceModal, flowProps);
const flowDialog = flowNodes.find((node) => node.props.role === 'dialog')!;
assert.equal(flowDialog.props.style.overflow, 'hidden', 'the card never scrolls its footer out of view');
assert.ok(flowNodes.some((node) => node.props.className === 'flow-entrance-body'), 'entry description/settings have their own scroll area');
assert.equal(flowDialog.props['aria-modal'], 'true');
assert.ok(flowNodes.find((node) => node.props.id === flowDialog.props['aria-labelledby']));
assert.ok(flowNodes.find((node) => node.props.id === flowDialog.props['aria-describedby']));
assert.equal(flow.hasActiveDialog(), true, 'App shortcuts see the entry modal as the current keyboard owner');
assert.equal(flow.doc.activeElement, flow.card().controls[0], 'the actual dialog effect moves focus inside the entry');
const range = flowNodes.find((node) => node.type === 'input')!;
assert.ok(flowNodes.find((node) => node.type === 'label' && node.props.htmlFor === range.props.id));
assert.equal(range.props['aria-valuetext'], '每 20 分钟提醒一次');
range.props.onChange({ target: { value: '35' } });
flowNodes = flow.render(flow.FlowEntranceModal, flowProps);
assert.equal(flowNodes.find((node) => node.type === 'input')!.props['aria-valuetext'], '每 35 分钟提醒一次');
const flowButtons = flowNodes.filter((node) => node.type === 'button');
assert.ok(flowButtons.every((node) => node.props.type === 'button' && node.props.style.minHeight >= 44));
flowButtons.at(-1)!.props.onClick();
assert.deepEqual(confirmations, [[note.id, 35]], 'confirmation uses the edited interval, not a stale default');
flow.card().controls.at(-1)!.focus();
const tab = event({ key: 'Tab', shiftKey: false }); flow.doc.emit('keydown', tab);
assert.equal(tab.prevented, 1); assert.equal(flow.doc.activeElement, flow.card().controls[0]);
const backTab = event({ key: 'Tab', shiftKey: true }); flow.doc.emit('keydown', backTab);
assert.equal(flow.doc.activeElement, flow.card().controls.at(-1));
const lastTabControl = flow.card().controls.at(-1)!;
const rovingOption = new flow.Element({ type: 'button', tabIndex: -1 });
flow.card().controls.push(rovingOption);
flow.card().controls[0].focus(); flow.doc.emit('keydown', event({ key: 'Tab', shiftKey: true }));
assert.equal(flow.doc.activeElement, lastTabControl, 'negative-tabindex options stay out of the dialog Tab cycle');
flow.card().controls.pop();
const escape = event({ key: 'Escape' }); flow.doc.emit('keydown', escape);
assert.equal(closed, 1); assert.equal(escape.stopped, 1);
flow.render(flow.FlowEntranceModal, { ...flowProps, isOpen: false });
assert.equal(flow.hasActiveDialog(), false); assert.equal(flow.doc.activeElement, flow.origin);
assert.ok([...flow.doc.listeners.values()].every((listeners) => listeners.size === 0), 'closing removes dialog listeners');
const nextNote = { ...note, id: 'next-preview-note', title: '下一个学习项目' };
flowNodes = flow.render(flow.FlowEntranceModal, { ...flowProps, isOpen: true, note: nextNote, defaultInterval: 45 });
flowNodes = flow.render(flow.FlowEntranceModal, { ...flowProps, isOpen: true, note: nextNote, defaultInterval: 45 });
assert.equal(flowNodes.find((node) => node.type === 'input')!.props['aria-valuetext'], '每 45 分钟提醒一次', 'reopening for another project uses its current configured interval');
flow.render(flow.FlowEntranceModal, { ...flowProps, isOpen: false, note: nextNote, defaultInterval: 45 });
flow.unmount();

// Actual preview geometry and pointer/keyboard handlers; synthetic viewport only, no real notes.
const preview = fixture({ width: 375, height: 740 });
let edits = 0;
const focusAtEdit: any[] = [];
const previewProps = { note, darkMode: false, onClose: () => closed++, onEdit: () => { edits++; focusAtEdit.push(preview.doc.activeElement); } };
let previewNodes = preview.render(preview.KnowledgePreview, previewProps);
const previewCard = () => preview.current().find((node) => node.props.role === 'dialog')!;
const withinViewport = () => {
  const style = previewCard().props.style;
  const size = preview.card().getBoundingClientRect();
  const left = preview.win.innerWidth - style.right - size.width;
  assert.ok(left >= 16 && left + size.width <= preview.win.innerWidth - 16, 'preview width never clips the title at 375px');
  assert.ok(style.top >= 16 && style.top + size.height <= preview.win.innerHeight - 16, 'long content leaves all bottom actions inside the viewport');
};
withinViewport();
assert.ok(previewNodes.filter((node) => node.type === 'button').every((node) => node.props.style.minHeight >= 44));
assert.ok(previewNodes.some((node) => node.props.className?.includes('flex-1 overflow-y-auto') && node.props.className.includes('min-h-0')),
  'only the content scrolls while header/footer remain visible');
assert.ok(previewNodes.some((node) => node.props.role === 'region' && node.props.tabIndex === 0 && node.props['aria-label'] === '知识点正文'),
  'long note content is keyboard reachable and can scroll without moving the whole preview');
const header = () => preview.current().find((node) => node.props.onPointerDown)!;
const target = new preview.Element();
let captures = 0;
const pointerDown = event({ button: 0, pointerId: 1, clientX: 180, clientY: 100, target,
  currentTarget: { setPointerCapture: () => captures++ } });
header().props.onPointerDown(pointerDown); assert.equal(captures, 1);
preview.doc.emit('pointermove', { pointerId: 99, clientX: 10_000, clientY: 10_000 });
previewNodes = preview.render(preview.KnowledgePreview, previewProps);
assert.equal(previewCard().props.style.top, 72, 'a different pointer cannot hijack an active drag');
preview.doc.emit('pointermove', { pointerId: 1, clientX: 10_000, clientY: -10_000 });
preview.render(preview.KnowledgePreview, previewProps); withinViewport();
assert.equal(previewCard().props.style.top, 16);
preview.doc.emit('pointerup', { pointerId: 1 });
preview.doc.emit('pointermove', { pointerId: 1, clientX: -10_000, clientY: 10_000 });
preview.render(preview.KnowledgePreview, previewProps); assert.equal(previewCard().props.style.top, 16);
const grip = () => preview.current().find((node) => node.props['data-preview-drag-handle'])!;
const move = event({ key: 'ArrowDown', shiftKey: false }); grip().props.onKeyDown(move);
preview.render(preview.KnowledgePreview, previewProps); assert.equal(previewCard().props.style.top, 24);
assert.equal(move.prevented, 1); assert.equal(move.stopped, 1);

// Resizing, long note content changes and short landscape viewports keep close/open controls reachable.
preview.win.innerWidth = 1280; preview.win.innerHeight = 800; preview.win.emit('resize', {});
preview.render(preview.KnowledgePreview, previewProps); preview.observers.at(-1)!.callback();
preview.render(preview.KnowledgePreview, previewProps); withinViewport();
header().props.onPointerDown(event({ button: 0, pointerId: 2, clientX: 900, clientY: 100, target,
  currentTarget: { setPointerCapture: () => {} } }));
preview.doc.emit('pointermove', { pointerId: 2, clientX: -10_000, clientY: 10_000 });
preview.render(preview.KnowledgePreview, previewProps); withinViewport();
preview.win.innerWidth = 375; preview.win.innerHeight = 320; preview.win.emit('resize', {});
preview.render(preview.KnowledgePreview, previewProps); preview.observers.at(-1)!.callback();
preview.render(preview.KnowledgePreview, previewProps); withinViewport();
assert.equal(previewCard().props.style.top, 16);
assert.equal(previewCard().props.style.maxHeight, 288);
const posAfterResize = previewCard().props.style.top;
preview.doc.emit('pointermove', { pointerId: 2, clientX: 50, clientY: 50 });
preview.render(preview.KnowledgePreview, previewProps); assert.equal(previewCard().props.style.top, posAfterResize, 'resize cancels any in-progress drag');

// Close buttons are not drag handles, and opening a full note restores the source focus first.
const closeButton = new preview.Element({ type: 'button' });
header().props.onPointerDown(event({ button: 0, pointerId: 3, clientX: 100, clientY: 100, target: closeButton,
  currentTarget: { setPointerCapture: () => assert.fail('close must never initiate a drag') } }));
preview.current().filter((node) => node.type === 'button').at(-1)!.props.onClick();
assert.equal(edits, 1); assert.equal(focusAtEdit[0], preview.origin, 'existing onEdit source focus/return flow is preserved');
preview.unmount();
assert.equal(preview.hasActiveDialog(), false);
assert.ok([...preview.doc.listeners.values(), ...preview.win.listeners.values()].every((listeners) => listeners.size === 0));
assert.ok(preview.observers.every((observer) => observer.disconnected), 'resize observers detach on unmount');

for (const viewport of [{ width: 375, height: 740 }, { width: 1024, height: 768 }, { width: 375, height: 320 }]) {
  const size = { width: Math.min(384, viewport.width - 32), height: viewport.height - (viewport.height < 480 ? 16 : 72) - 16 };
  for (const position of [{ x: -10_000, y: -10_000 }, { x: 10_000, y: 10_000 }]) {
    const result = preview.constrainKnowledgePreviewPosition(position, viewport, size);
    const left = viewport.width - 16 - size.width + result.x;
    const top = (viewport.height < 480 ? 16 : 72) + result.y;
    assert.ok(left >= 16 && left + size.width <= viewport.width - 16);
    assert.ok(top >= 16 && top + size.height <= viewport.height - 16);
  }
}
console.log('Learning entry dialogs passed: actual focus/Escape/input/confirm, 375px and landscape bounds, pointer ownership, keyboard movement, resize cleanup and source-focus return.');

// Render real Markdown and KaTeX: math is displayed, code fences remain literal, unsafe commands fall back.
const { previewMarkdownComponents } = compile('src/components/KnowledgePreview.tsx', { React: RealReact, FormulaBlock }, ['previewMarkdownComponents']);
const markup = renderToStaticMarkup(RealReact.createElement(RealMarkdown, {
  remarkPlugins: [remarkGfm, remarkMath], components: previewMarkdownComponents,
  children: '内联 $P(A\\mid B)$\n\n$$\n\\frac{P(B\\mid A)P(A)}{P(B)}\n$$\n\n```tex\n$literal$\n```',
}));
assert.equal((markup.match(/class="katex"/gu) || []).length, 2, 'inline and display math use real KaTeX output');
assert.ok(markup.includes('<math') && markup.includes('textbook-formula-display'), 'formulas include accessible MathML');
assert.ok(markup.includes('<pre><code class="language-tex">$literal$'), 'code fences are never interpreted as formulas');
const unsafeMarkup = renderToStaticMarkup(RealReact.createElement(RealMarkdown, {
  remarkPlugins: [remarkGfm, remarkMath], components: previewMarkdownComponents,
  children: '$\\href{javascript:alert(1)}{bad}$\n\n$\\invalidPreviewCommand{x}$',
}));
assert.ok(!unsafeMarkup.includes('href="javascript:'), 'preview never trusts executable formula links');
assert.ok(unsafeMarkup.includes('textbook-formula-error') && unsafeMarkup.includes('invalidPreviewCommand'), 'invalid math stays readable instead of crashing the preview');
console.log('Knowledge preview formulas passed: real Markdown/KaTeX, inline/display MathML, literal code and non-trusting unsafe-command fallback.');
