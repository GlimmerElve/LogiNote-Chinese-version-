import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';

// Execute the production components and dialog hook. Only DOM / native IO / model boundaries are synthetic.
const source = (path: string) => readFileSync(path, 'utf8');
function compile(path: string, bindings: Record<string, any>, names: string[]) {
  const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join('\n').replace(/^export\s+/gm, '');
  const code = ts.transpileModule(`${body}\nreturn {${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
function runtime() {
  const slots: any[] = [], effects: any[] = []; let cursor = 0;
  const changed = (a: any[], b: any[]) => !a || b.some((v, i) => v !== a[i]);
  const effect = (fn: any, deps: any[]) => { const i = cursor++; if (changed(effects[i]?.deps, deps)) effects[i] = { fn, deps, pending: true, cleanup: effects[i]?.cleanup }; };
  return {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return `secondary-${cursor++}`; },
    useCallback(fn: any, deps: any[]) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect: effect, useLayoutEffect: effect,
    begin() { cursor = 0; }, flush() { effects.forEach(e => { if (e?.pending) { e.pending = false; e.cleanup?.(); e.cleanup = e.fn(); } }); },
    unmount() { effects.forEach(e => e?.cleanup?.()); },
  };
}
const flat = (n: any): any[] => Array.isArray(n) ? n.flatMap(flat) : n?.props ? [n, ...flat(n.props.children)] : [];
const text = (n: any): string => Array.isArray(n) ? n.map(text).join('') : n?.props ? text(n.props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
const button = (tree: any, label: string) => { const node = flat(tree).find(n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label)); assert.ok(node, label); return node; };
const icons = Object.fromEntries(['ShieldCheck','X','Lock','Database','Server','Sparkles','Loader2','AlertTriangle','BookOpen','TrendingUp','Brain','Link2','MessageCircle','Download','Check'].map(n => [n, () => null]));
const listeners = new Map<string, Set<(event: any) => void>>();
const dom: any = { body: {}, activeElement: null,
  addEventListener(name: string, fn: any) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
  removeEventListener(name: string, fn: any) { listeners.get(name)?.delete(fn); },
};
const emit = (name: string, event: any) => { for (const listener of [...listeners.get(name) || []]) listener(event); };
class Element {
  isConnected = true; tabIndex = 0; disabled = false; items: Element[] = [];
  constructor(public name = '') {}
  closest() { return null; } getClientRects() { return [{}]; }
  contains(target: Element) { return target === this || this.items.includes(target); }
  querySelectorAll() { return this.items.filter(i => !i.disabled); }
  focus() { dom.activeElement = this; emit('focusin', { target: this }); }
}
const key = (value: string, extras: any = {}) => {
  const event = { key: value, defaultPrevented: false, isComposing: false, keyCode: 0,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...extras };
  emit('keydown', event); return event;
};
function modalHarness(path: string, exported: string) {
  const hooks = runtime();
  const dialog = compile('src/components/useDialog.ts', { ...hooks, document: dom, HTMLElement: Element, getComputedStyle: () => ({ visibility: 'visible' }) }, ['useDialog','hasActiveDialog']);
  const component = compile(path, { React, ...hooks, ...icons, ...dialog, document: dom, createPortal: (n: any) => n }, [exported])[exported];
  let container: Element, items: Element[] = [], tree: any;
  const render = (props: any) => {
    hooks.begin(); tree = component(props);
    const root = flat(tree).find(n => n.props.role === 'dialog' || n.props.role === 'alertdialog');
    if (root) {
      container ||= new Element('dialog');
      items = flat(root).filter(n => n.type === 'button' || n.props.role === 'region').map((n, i) => {
        const item = container.items[i] || new Element(text(n) || n.props['aria-label']); item.disabled = Boolean(n.props.disabled); return item;
      });
      container.items = items; root.props.ref.current = container;
    }
    hooks.flush(); return tree;
  };
  return { render, hooks, dialog, items: () => items, tree: () => tree };
}

// Clear confirmation: safe initial focus, Tab/Shift+Tab, IME, escape, shortcut ownership and restoration.
const clear = modalHarness('src/components/AgentClearConfirmation.tsx', 'AgentClearConfirmation');
const origin = new Element('clear trigger'); origin.focus();
let canceled = 0, confirmed = 0;
let clearProps = { open: true, disabled: false, onCancel: () => { canceled++; }, onConfirm: () => { confirmed++; } };
let tree = clear.render(clearProps);
assert.equal(dom.activeElement, clear.items()[0]); assert.equal(clear.dialog.hasActiveDialog(), true);
assert.equal(flat(tree).find(n => n.props.role === 'alertdialog')!.props['aria-modal'], 'true');
clear.items()[1].focus(); assert.equal(key('Tab').defaultPrevented, true); assert.equal(dom.activeElement, clear.items()[0]);
key('Tab', { shiftKey: true }); assert.equal(dom.activeElement, clear.items()[1]);
new Element('background').focus(); assert.equal(dom.activeElement, clear.items()[0]);
key('Escape', { isComposing: true }); key('Escape', { keyCode: 229 }); assert.equal(canceled, 0);
key('Escape'); assert.equal(canceled, 1);
clear.render({ ...clearProps, open: false }); assert.equal(dom.activeElement, origin); assert.equal(clear.dialog.hasActiveDialog(), false);
tree = clear.render({ ...clearProps, disabled: true }); button(tree, '清空').props.onClick(); assert.equal(confirmed, 0);
tree = clear.render(clearProps); button(tree, '清空').props.onClick(); assert.equal(confirmed, 1);
clear.render({ ...clearProps, open: false }); clear.hooks.unmount();
const agent = source('src/components/AgentPanel.tsx');
assert.match(agent, /AgentClearConfirmation open=\{open && clearConfirmOpen && !auditOpen\}/);
assert.match(agent, /if \(!open \|\| auditOpen \|\| busy \|\| pendingApproval\) setClearConfirmOpen\(false\)/);
assert.match(agent, /event\.isComposing \|\| event\.keyCode === 229/);
assert.match(source('src/App.tsx'), /!e\.defaultPrevented && !hasActiveDialog\(\)/);

// Privacy: actual reading surface is focusable; all closing routes restore the source without IO.
const privacy = modalHarness('src/components/PrivacyPolicyModal.tsx', 'PrivacyPolicyModal');
let closes = 0; const privacyOrigin = new Element('privacy trigger'); privacyOrigin.focus();
const privacyProps = { isOpen: true, onClose: () => { closes++; } };
for (const route of ['Escape', 'backdrop', '关闭隐私说明', '我知道了']) {
  tree = privacy.render(privacyProps);
  assert.equal(privacy.items().length, 3); privacy.items()[0].focus(); key('Tab', { shiftKey: true }); assert.equal(dom.activeElement, privacy.items()[2]);
  privacy.items()[1].focus(); assert.equal(dom.activeElement, privacy.items()[1]);
  const region = flat(tree).find(n => n.props.role === 'region'); assert.equal(region.props.tabIndex, 0);
  assert.match(text(tree), /当前没有云端笔记同步/); assert.match(text(tree), /相关笔记、学习记录或个人画像/);
  assert.doesNotMatch(text(tree), /同意协议|合规协议|不保留临时会话日志|服务端代理|独占离线数据库/);
  if (route === 'Escape') key('Escape'); else if (route === 'backdrop') tree.props.onClick(); else button(tree, route).props.onClick();
  privacy.render({ ...privacyProps, isOpen: false }); assert.equal(dom.activeElement, privacyOrigin);
}
assert.equal(closes, 4); privacy.hooks.unmount();

// Flow: render real related-knowledge controls and execute real export branches with memory IPC only.
const flowHooks = runtime(); let selected = '', modelCalls = 0, exportCalls = 0;
let reply: any = { ok: true, path: 'C:/synthetic/' + 'very-long-path/'.repeat(20) + 'report.md' };
const api = { analysis: { exportReport: async (markdown: string) => { exportCalls++; assert.match(markdown, /合成报告/); return reply; } } };
const flow = compile('src/components/FlowAnalysisPanel.tsx', { React, ...flowHooks, ...icons, window: { electronAPI: api },
  runFlowAnalysis: () => { modelCalls++; throw Error('Model access forbidden in UI check'); } }, ['FlowAnalysisPanel', 'SectionRenderer']);
const report = { clarityScore: 75, sections: [{ kind: 'relatedKnowledge', title: '相关知识', items: [
  { term: '条件概率', relation: '合成关系', suggestedWikiLink: '合成报告' }, { term: '静态知识', relation: '暂无可打开的目标' },
] }] };
const props = { speakingContent: '合成复述', noteTitle: '合成报告', allNotes: [], autoRun: false, initialReport: report, onClose() {}, onSelectNoteByTitle: (value: string) => { selected = value; } };
const renderFlow = () => { flowHooks.begin(); const n = flow.FlowAnalysisPanel(props); flowHooks.flush(); return n; };
tree = renderFlow(); tree = renderFlow(); assert.ok(button(tree, '关闭复盘分析'));
const knowledge = flow.SectionRenderer({ section: report.sections[0], onSelectNoteByTitle: props.onSelectNoteByTitle });
const linked = flat(knowledge).filter(n => n.type === 'button'); assert.equal(linked.length, 1);
assert.match(text(linked[0]), /→ \[\[合成报告\]\]/); linked[0].props.onClick(); assert.equal(selected, '合成报告');
assert.equal(flat(flow.SectionRenderer({ section: report.sections[0] })).filter(n => n.type === 'button').length, 0);
await button(tree, '导出复盘报告').props.onClick(); tree = renderFlow(); assert.match(text(tree), /已导出：C:\/synthetic/);
reply = { error: '已取消' }; await button(tree, '导出复盘报告').props.onClick(); tree = renderFlow(); assert.doesNotMatch(text(tree), /已导出：/);
reply = { error: '合成导出失败' }; await button(tree, '导出复盘报告').props.onClick(); tree = renderFlow(); assert.match(text(tree), /合成导出失败/);
assert.equal(exportCalls, 3); assert.equal(modelCalls, 0);
const css = source('src/index.css'); const flowStart = css.indexOf('/* ===== Flow Analysis Panel');
const flowCss = css.slice(flowStart, css.indexOf('Playful Illustration', flowStart));
assert.match(flowCss, /overflow-wrap: anywhere/); assert.match(flowCss, /width: 44px/); assert.match(flowCss, /height: 44px/);
assert.doesNotMatch(flowCss, /#[0-9a-f]{3,8}\b/i); assert.match(flowCss, /:focus-visible/);
console.log('Secondary pages UI passed: real dialog keyboard ownership/restore, truthful readable privacy, conditional native knowledge links, named 44px controls, themed wrapping and memory-only export success/cancel/failure.');
