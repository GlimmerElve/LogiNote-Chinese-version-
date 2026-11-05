import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { matchesNoteSearch } from '../src/services/noteSearch';

// Production component executed with deterministic hooks, no network or vault.
const slots: any[] = [], effects: any[] = []; let cursor = 0;
const hooks = {
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
    return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useId() { cursor++; return 'command-test'; }, useMemo: (fn: any) => fn(),
  useLayoutEffect(fn: any, deps: any[]) { const i = cursor++;
    if (!effects[i] || deps.some((v, j) => v !== effects[i].deps[j])) effects[i] = { deps, fn, pending: true }; },
};
const source = readFileSync('src/components/CommandPalette.tsx', 'utf8');
const ast = ts.createSourceFile('palette.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
const js = ts.transpileModule(`${code}\nreturn { CommandPalette, noteExcerpt };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
let dialogClose: any; const doc = { getElementById: () => null };
const icons = Object.fromEntries(['Search', 'FileText', 'Folder', 'Plus', 'Network', 'Calendar', 'X', 'ArrowUpRight'].map(name => [name, () => null]));
let searchReads = 0;
const bindings = { React, ...hooks, ...icons, document: doc,
  matchesNoteSearch: (...args: Parameters<typeof matchesNoteSearch>) => { searchReads++; return matchesNoteSearch(...args); },
  useDialog(_open: any, _ref: any, close: any) { dialogClose = close; } };
const ui = new Function(...Object.keys(bindings), js)(...Object.values(bindings));
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const events: string[] = [];
let props: any = { isOpen: false, notes: [
  { id: 'one', title: '贝叶斯定理', content: '# 先验\n基础发生率影响后验', aliases: ['Bayes'], tags: ['概率', '#MathReview'], noteType: 'knowledge' },
  { id: 'two', title: '心理学学习计划', content: '选项过多可能导致选择过载', aliases: [], noteType: 'project' },
], onClose: () => events.push('close'), onSelectNote: (id: string) => events.push('note:' + id),
  onSelectView: (view: string) => events.push('view:' + view), onNewNote: () => events.push('new') };
function render() { cursor = 0; let tree = ui.CommandPalette(props);
  let changed = false; effects.forEach(effect => { if (effect?.pending) { effect.pending = false; effect.fn(); changed = true; } });
  if (changed) { cursor = 0; tree = ui.CommandPalette(props); } return tree; }
const input = (tree: any) => flat(tree).find(node => node.props.role === 'combobox');
const options = (tree: any) => flat(tree).filter(node => node.props.role === 'option');
const active = (tree: any) => options(tree).find(node => node.props['aria-selected']);
const key = (name: string, extra: any = {}) => ({ key: name, nativeEvent: {}, preventDefault() {}, ...extra });
const search = (value: string) => { input(render()).props.onChange({ target: { value } }); return render(); };
const reopen = () => { props.isOpen = false; render(); props.isOpen = true; return render(); };
assert.equal(render(), null); assert.equal(searchReads, 0, 'closed palette must not scan saved bodies');
for (let index = 0; index < 30; index++) { props.notes = [...props.notes]; assert.equal(render(), null); }
assert.equal(searchReads, 0, 'background save snapshots do not trigger closed search/excerpt work');
props.isOpen = true; let tree = render();
assert.equal(options(tree).length, 5); assert.equal(active(tree).props.id, input(tree).props['aria-activedescendant']);
assert.match(text(active(tree)), /贝叶斯定理/); assert.equal(input(tree).props.autoFocus, undefined, 'dialog must capture source focus first');
assert.deepEqual(events, [], 'rendering cannot navigate or create notes');
tree = search('bAyEs'); assert.equal(options(tree).length, 1); assert.match(text(active(tree)), /贝叶斯定理/);
tree = search('选择过载'); assert.equal(options(tree).length, 1); assert.match(text(active(tree)), /心理学学习计划/);
for (const tagQuery of ['概率', '#概率', 'mathreview', '#MATHREVIEW']) {
  tree = search(tagQuery); assert.equal(options(tree).length, 1); assert.match(text(active(tree)), /贝叶斯定理/);
}
tree = search('计划'); assert.equal(options(tree).length, 2, 'notes and commands share search');
input(tree).props.onKeyDown(key('ArrowDown')); tree = render(); assert.match(text(active(tree)), /跳转时序计划/);
input(tree).props.onKeyDown(key('ArrowDown')); tree = render(); assert.match(text(active(tree)), /心理学学习计划/, 'wrap forward');
input(tree).props.onKeyDown(key('ArrowUp')); tree = render(); assert.match(text(active(tree)), /跳转时序计划/, 'wrap backward');
input(tree).props.onKeyDown(key('Enter', { nativeEvent: { isComposing: true } }));
input(tree).props.onKeyDown(key('Enter', { nativeEvent: { keyCode: 229 } }));
input(tree).props.onKeyDown(key('Enter', { ctrlKey: true }));
input(tree).props.onKeyDown(key('Enter', { repeat: true })); assert.deepEqual(events, [], 'composition/modifier/repeated Enter cannot activate');
input(tree).props.onKeyDown(key('Enter')); input(tree).props.onKeyDown(key('Enter')); dialogClose();
assert.deepEqual(events, ['close', 'view:timeline'], 'close precedes one guarded command dispatch');
tree = reopen(); assert.equal(input(tree).props.value, '', 'reopening clears previous query'); assert.match(text(active(tree)), /贝叶斯/);
tree = search('不存在的标题'); assert.equal(options(tree).length, 0); assert.equal(input(tree).props['aria-activedescendant'], undefined);
input(tree).props.onKeyDown(key('Enter')); input(tree).props.onKeyDown(key('ArrowUp')); assert.equal(events.length, 2);
flat(tree).find(node => node.props['aria-label'] === '清除搜索内容').props.onClick(); tree = render(); assert.equal(options(tree).length, 5);
input(tree).props.onKeyDown(key('ArrowDown')); tree = render(); assert.match(text(active(tree)), /心理学/);
props.notes = [...props.notes].reverse(); tree = render(); assert.match(text(active(tree)), /心理学/, 'stable identity after reorder');
props.notes = props.notes.filter((note: any) => note.id !== 'two'); tree = render(); assert.match(text(active(tree)), /贝叶斯/, 'removed target cannot leave stale selection');
options(tree)[0].props.onClick(); assert.deepEqual(events.slice(-2), ['close', 'note:one']);
tree = reopen(); tree = search('新建'); assert.equal(options(tree).length, 1); options(tree)[0].props.onClick(); assert.deepEqual(events.slice(-2), ['close', 'new']);
tree = reopen(); tree = search('graph'); options(tree)[0].props.onClick(); assert.deepEqual(events.slice(-2), ['close', 'view:graph']);
tree = reopen(); const overlay = tree;
overlay.props.onPointerDown({ target: 'inside', currentTarget: 'outside' }); overlay.props.onClick({ target: 'outside', currentTarget: 'outside' });
assert.notEqual(events.at(-1), 'close', 'dragging out of the dialog is not a backdrop dismissal');
overlay.props.onPointerDown({ target: 'outside', currentTarget: 'outside' }); overlay.props.onClick({ target: 'outside', currentTarget: 'outside' });
assert.equal(events.at(-1), 'close'); const count = events.length; dialogClose(); assert.equal(events.length, count);
assert.match(ui.noteExcerpt('prefix '.repeat(20) + 'needle then tail', 'needle'), /needle/);
assert.doesNotMatch(source, /comic-|playful-|blue-|text-\[10px\]/, 'palette stays in the established semantic theme');
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /isOpen: isCommandPaletteOpen && !reviewExitGuard.locked && !sceneGuard.locked/);
assert.match(app, /onSelectNote: handleSelectNote, onNewNote: handleNewNote, onSelectView: setCurrentView/);
assert.match(app, /notes: isCommandPaletteOpen \? notesRef.current : notes/,
  'opening search reads authoritative body-only drafts without requiring a global publication');
console.log('PASS command palette: real note/command filtering, keyboard/wrap/IME, canonical IDs, stale selection, once-only dispatch, fresh reopen, explicit close and guarded App wiring. No IO.');
