import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';

// Execute the production toolbar with deterministic hooks and DOM focus, without IO.
const elements = (v: any): any[] => Array.isArray(v) ? v.flatMap(elements) : v?.props ? [v, ...elements(v.props.children)] : [];
const text = (v: any): string => Array.isArray(v) ? v.map(text).join('') : v?.props ? text(v.props.children) : v == null || typeof v === 'boolean' ? '' : String(v);
const mutable = (v: any): any => Array.isArray(v) ? v.map(mutable) : v?.props ? { ...v, props: { ...v.props, children: mutable(v.props.children) } } : v;
const deferred = () => { let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness() {
  const events = new Set<(e: any) => void>();
  const slots: any[] = []; let cursor = 0, changed = false, effects: Array<() => void> = [], tree: any;
  const document = { body: {}, activeElement: null as any,
    querySelectorAll() { return elements(tree).filter(e => e.type === 'button').map(e => e.dom); },
    addEventListener(_: string, fn: any) { events.add(fn); }, removeEventListener(_: string, fn: any) { events.delete(fn); } };
  class DomNode { children: DomNode[] = []; disabled = false; isConnected = true;
    tabIndex = 0; getClientRects() { return [{}]; } closest() { return null; }
    contains(node: any): boolean { return this === node || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    matches() { return this.disabled; }
    querySelectorAll() { return this.children.filter(child => !child.disabled); }
    querySelector() { return this.querySelectorAll()[0]; }
  }
  const nodes = new Map<string, DomNode>();
  const hooks = { ...React,
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next: any) => { const v = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(v, slots[i])) { slots[i] = v; changed = true; } }]; },
    useRef(initial: any) { return slots[cursor++] ||= { current: initial }; },
    useId() { return slots[cursor++] ||= 'toolbar-test'; },
    useEffect(fn: any, deps: any[]) { const i = cursor++;
      if (!slots[i] || deps.some((v, n) => !Object.is(v, slots[i].deps[n]))) {
        const old = slots[i]?.cleanup; const slot = { deps, cleanup: undefined as any }; slots[i] = slot;
        effects.push(() => { old?.(); slot.cleanup = fn(); });
      }
    },
  };
  const path = resolve('src/modules/argumentCanvas/components/Toolbar.tsx');
  const module = { exports: {} as any }, nativeRequire = createRequire(path);
  runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, document, Node: DomNode, Error,
      require(id: string) { if (id === 'react') return hooks; if (id.endsWith('.css')) return {}; return nativeRequire(id); } });
  const exports: ReturnType<typeof deferred>[] = []; let adds = 0, layouts = 0;
  const start = () => { const job = deferred(); exports.push(job); return job.promise; };
  const props = { onAddNode() { adds++; }, onAutoLayout() { layouts++; }, onExportMarkdown: start, onExportJSON: start, onExportPDF: start, onExportPNG: start };
  function render() { let rounds = 0;
    do { assert.ok(++rounds < 20); changed = false; cursor = 0; tree = mutable(module.exports.Toolbar(props));
      const all = elements(tree); const alive = new Set<DomNode>();
      for (const e of all) {
        const key = e.type === 'button' ? e.props['aria-controls'] || text(e) : e.props.role === 'menu' ? 'menu' : e === tree ? 'root' : '';
        if (!key) continue;
        const dom = nodes.get(key) || new DomNode(); nodes.set(key, dom); alive.add(dom);
        e.dom = dom; dom.isConnected = true; dom.disabled = !!e.props.disabled;
        dom.tabIndex = e.props.tabIndex ?? 0;
        if (e.props.ref) e.props.ref.current = dom;
      }
      for (const n of nodes.values()) if (!alive.has(n)) n.isConnected = false;
      if (document.activeElement?.isConnected === false) document.activeElement = document.body;
      tree.dom.children = all.filter(e => e !== tree && e.dom).map(e => e.dom);
      const menu = all.find(e => e.props.role === 'menu'); if (menu) menu.dom.children = elements(menu).filter(e => e.type === 'button').map(e => e.dom);
      const pending = effects; effects = []; for (const effect of pending) effect();
    } while (changed); return tree;
  }
  const button = (label: string) => { const e = elements(tree).find(e => e.type === 'button' && text(e) === label); assert.ok(e, label); return e; };
  const click = (label: string) => { const e = button(label); e.dom.focus(); e.props.onClick({ currentTarget: e.dom }); render(); };
  const key = (value: string) => { let prevented = false, stopped = false;
    tree.props.onKeyDown({ key: value, target: document.activeElement, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); render(); return { prevented, stopped }; };
  render();
  return { document, events, exports, button, click, key, render, nodes, DomNode,
    get tree() { return tree; }, get adds() { return adds; }, get layouts() { return layouts; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const h = harness();
h.click('新建节点'); assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 1);
const types = elements(h.tree).filter(e => e.props.role === 'menuitem'); assert.equal(h.document.activeElement, types[0].dom);
h.key('End'); assert.equal(h.document.activeElement, types.at(-1).dom);
h.key('ArrowDown'); assert.equal(h.document.activeElement, types[0].dom);
h.key('ArrowUp'); assert.equal(h.document.activeElement, types.at(-1).dom);
assert.deepEqual(h.key('Escape'), { prevented: true, stopped: true }); assert.equal(h.document.activeElement, h.button('新建节点').dom);
h.click('新建节点'); h.key('Tab'); assert.equal(h.document.activeElement, h.button('一键整理').dom);
assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 0);
h.click('新建节点'); h.click('导出'); assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 1);
assert.equal(h.button('新建节点').props['aria-expanded'], false);
const pdf = h.button('导出 PDF'); const action = pdf.props.onClick;
action({ currentTarget: pdf.dom }); action({ currentTarget: pdf.dom }); h.render(); assert.equal(h.exports.length, 1);
assert.ok(h.button('导出 PDF').props.disabled); assert.match(text(h.tree), /正在生成导出文件/);
h.exports[0].reject(new Error('测试导出失败')); await tick(); h.render();
assert.match(text(h.tree), /导出 PDF未完成。测试导出失败/); assert.equal(h.document.activeElement, h.button('导出 PDF').dom);
h.click('导出 PDF'); h.exports[1].resolve(); await tick(); h.render();
assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 0);
assert.equal(h.document.activeElement, h.button('导出').dom); assert.doesNotMatch(text(h.tree), /未完成/);
h.click('导出');
// Clicking the open trigger must not be reversed by a premature blur-close.
const menu = elements(h.tree).find(e => e.props.role === 'menu'); menu.props.onBlur({ currentTarget: menu.dom, relatedTarget: h.button('导出').dom });
h.click('导出'); assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 0);
h.click('新建节点'); h.click(text(types[0])); assert.equal(h.adds, 1);
h.click('一键整理'); assert.equal(h.layouts, 1);
h.click('导出'); const external = new h.DomNode(); for (const event of h.events) event({ target: external }); h.render();
assert.equal(elements(h.tree).filter(e => e.props.role === 'menu').length, 0);
h.click('导出'); h.click('导出 PNG'); h.document.activeElement = external;
h.exports[2].resolve(); await tick(); h.render(); assert.equal(h.document.activeElement, external, 'late export does not steal external focus');
h.click('导出'); h.click('导出 JSON'); h.unmount(); assert.equal(h.events.size, 0);
h.exports[3].reject(new Error('unmounted failure')); await tick();
const frame = readFileSync('src/components/ArgumentEditorFrame.tsx', 'utf8');
assert.match(frame, /<footer className="argument-editor-footer">[\s\S]*className="argument-editor-actions"/);
assert.match(readFileSync('src/components/ArgumentEditorFrame.css', 'utf8'), /argument-editor-actions \{ position: static;/);
assert.match(readFileSync('src/components/ArgumentEditView.tsx', 'utf8'), /<ArgumentEditorFrame/);
// Run the actual canvas key handler: selected nodes cannot hijack toolbar/side-panel input.
const canvasSource = ts.createSourceFile('canvas.tsx', readFileSync('src/modules/argumentCanvas/ArgumentCanvas.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.ArrowFunction | undefined;
function visit(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(canvasSource) === 'onKeyDown' && n.initializer && ts.isArrowFunction(n.initializer)) handler = n.initializer; ts.forEachChild(n, visit); }
visit(canvasSource); assert.ok(handler);
let mutations = 0;
const node = { id: 'selected', mainType: '推理', position: { x: 10, y: 10 } };
const state = { doc: { nodes: [node] }, addNode() { mutations++; return 'new'; }, addEdge() { mutations++; }, removeNode() { mutations++; }, removeEdges() { mutations++; }, undo() { mutations++; }, redo() { mutations++; } };
const innerTarget = { closest: () => null }, controlTarget = { closest: () => ({}) }, outsideTarget = { closest: () => null };
const canvasContext = { readOnly: false, hasActiveDialog: () => false, isActiveDialogOwner: () => false, LEGACY_TYPE_FOR_ROLE: { premise: '事实陈述', claim: '推理' }, setRelationDraft() { mutations++; },
  canvasRootRef: { current: { contains: (t: unknown) => t !== outsideTarget } }, useCanvasStore: { getState: () => state }, selectedNodeIdsRef: { current: new Set(['selected']) }, selectedEdgeIdsRef: { current: [] }, setSelectedId() {} };
const canvasHandler = runInNewContext(ts.transpileModule(`const handler = ${handler.getText(canvasSource)}; handler;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, canvasContext);
const keyEvent = (target: unknown, key: string, defaultPrevented = false) => ({ target, key, defaultPrevented, preventDefault() {}, ctrlKey: false, metaKey: false, shiftKey: false });
canvasHandler(keyEvent(outsideTarget, 'Tab')); canvasHandler(keyEvent(outsideTarget, 'Delete'));
canvasHandler(keyEvent(controlTarget, 'Tab')); canvasHandler(keyEvent(controlTarget, 'Delete'));
canvasHandler(keyEvent(innerTarget, 'Delete', true)); assert.equal(mutations, 0);
canvasHandler(keyEvent(innerTarget, 'Tab')); assert.equal(mutations, 2, 'child-node shortcut now opens relationship confirmation rather than creating an implicit edge');
canvasHandler(keyEvent(innerTarget, 'Delete')); assert.equal(mutations, 3, 'canvas still supports selected-node deletion');
canvasContext.readOnly = true;
canvasHandler(keyEvent(innerTarget, 'Tab')); canvasHandler(keyEvent(innerTarget, 'Delete'));
assert.equal(mutations, 3, 'read-only result preview cannot edit via shortcuts');
canvasContext.readOnly = false; canvasContext.hasActiveDialog = () => true;
canvasHandler(keyEvent(innerTarget, 'Delete'));
assert.equal(mutations, 3, 'relationship dialog owns keyboard events');
canvasContext.isActiveDialogOwner = () => true;
canvasContext.selectedNodeIdsRef.current = new Set(['selected']);
canvasHandler(keyEvent(innerTarget, 'Delete'));
assert.equal(mutations, 4, 'canvas embedded in the owning topmost dialog can edit');
canvasHandler({ ...keyEvent(innerTarget, 'Delete'), isComposing: true });
canvasHandler(keyEvent(controlTarget, 'Delete')); canvasHandler(keyEvent(outsideTarget, 'Delete'));
assert.equal(mutations, 4, 'IME, controls and unrelated surfaces remain protected even in the owning dialog');
console.log('PASS argument editor UI: actual toolbar menus, keyboard/focus, synchronous export lock, failure/retry, cleanup and production footer wiring');
