import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { Sidebar, createSidebarProjection, countProjectDescendants } from '../src/components/Sidebar';
import { matchesNoteSearch } from '../src/services/noteSearch';
import type { NoteItem, VaultSettings } from '../src/types';

// Only synthetic snapshots, actual pure projection functions and actual Sidebar
// JSX/hooks. No native app, storage adapter, private vault, model or network.
const note = (id: string, patch: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, noteType: 'project',
  content: 'synthetic body', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: '', ...patch });
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
const referenceDescendants = (notes: NoteItem[], id: string) => {
  const seen = new Set<string>(), queue = [id];
  for (let i = 0; i < queue.length; i++) for (const child of notes) {
    if (child.parentId === queue[i] && child.id !== id && !seen.has(child.id)) { seen.add(child.id); queue.push(child.id); }
  }
  return seen.size;
};

{
  const project = createSidebarProjection();
  const original = [note('root', { isFavorite: true, tags: ['Math'] }), note('child', { parentId: 'root' }),
    note('knowledge', { parentId: 'child', noteType: 'knowledge' }), note('other', { title: 'root' })];
  const before = structuredClone(original), first = project(original);
  const changed = original.map((item, index) => index ? item : { ...item, content: 'fresh searchable body',
    updatedAt: 'later', aliases: ['FreshAlias'], tags: [...item.tags] });
  const second = project(changed);
  assert.equal(first, second); assert.equal(first.projectTree, second.projectTree);
  assert.equal(first.byId.get('root'), second.byId.get('root'));
  assert.equal(matchesNoteSearch(second.projectNotes[0], 'fresh searchable'), true);
  assert.equal(matchesNoteSearch(second.projectNotes[0], 'freshalias'), true);
  assert.equal(matchesNoteSearch(second.projectNotes[0], '#math'), true);
  assert.equal(first.projectTree[0].count, 2, 'tree badge counts projects only');
  assert.equal(first.descendantCounts.get('root'), 2, 'delete confirmation includes descendant knowledge notes');
  assert.deepEqual(original, before, 'indexing and source refresh cannot mutate input');
  const renamed = project(changed.map(item => item.id === 'root' ? { ...item, title: 'renamed' } : item));
  assert.notEqual(renamed, first); assert.equal(renamed.byId.get('other'), first.byId.get('other'));
  const moved = project(changed.map(item => item.id === 'child' ? { ...item, parentId: 'other' } : item));
  assert.equal(moved.projectTree[0].count, 1); assert.equal(moved.descendantCounts.get('other'), 2);
  const favorite = project(changed.map(item => item.id === 'other' ? { ...item, isFavorite: true, tags: ['NewTag'] } : item));
  assert.equal(favorite.favoriteCount, 2); assert.equal(matchesNoteSearch(favorite.byId.get('other')!, '#newtag'), true);
  const removed = project(changed.filter(item => item.id !== 'child'));
  assert.equal(removed.byId.has('child'), false); assert.equal(removed.descendantCounts.get('root'), 0);
  assert.equal(project([...changed].reverse()).projectNotes[0].id, 'other', 'source order is preserved');
  pass('body/timestamp/alias updates preserve display/tree identity while search reads fresh source; rename/move/favorite/tag/delete/order remain live');
}

{
  const notes = [note('root'), note('child', { parentId: 'root' }), note('knowledge', { parentId: 'child', noteType: 'knowledge' }),
    note('A', { parentId: 'B' }), note('B', { parentId: 'A' }), note('branch', { parentId: 'A' }),
    note('leaf', { parentId: 'branch', noteType: 'knowledge' }), note('self', { parentId: 'self' }),
    note('self-child', { parentId: 'self' }), note('orphan', { parentId: 'missing' })];
  const projection = createSidebarProjection()(notes);
  for (const id of [...notes.map(item => item.id), 'missing', 'absent']) {
    assert.equal(countProjectDescendants(notes, id), referenceDescendants(notes, id), id);
    if (projection.byId.has(id)) assert.equal(projection.descendantCounts.get(id), referenceDescendants(notes, id), `indexed ${id}`);
  }
  assert.deepEqual(projection.projectTree.map(node => node.note.id), ['root'], 'cycles/orphans retain the old roots-only tree visibility');
  const deep = Array.from({ length: 12000 }, (_, index) => note('deep-' + index, index ? { parentId: 'deep-' + (index - 1) } : {}));
  const chain = createSidebarProjection()(deep);
  assert.equal(chain.projectTree[0].count, deep.length); assert.equal(chain.descendantCounts.get('deep-0'), deep.length - 1);
  assert.equal(countProjectDescendants(deep, 'deep-0'), deep.length - 1);
  let seed = 19;
  for (let round = 0; round < 30; round++) {
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const mixed = Array.from({ length: 60 }, (_, index) => note('mixed-' + index, {
      parentId: random() % 5 ? 'mixed-' + random() % 65 : undefined,
      noteType: random() % 3 ? 'project' : 'knowledge',
    }));
    const data = createSidebarProjection()(mixed);
    for (const item of mixed) assert.equal(data.descendantCounts.get(item.id), referenceDescendants(mixed, item.id));
    const projects = mixed.filter(item => item.noteType === 'project');
    for (const root of data.projectTree) assert.equal(root.count, referenceDescendants(projects, root.note.id) + 1);
  }
  pass('all-note descendant contract matches legacy traversal, including cycles/self-cycles/orphans; 12k-deep indexing is iterative');
}

const source = readFileSync('src/components/Sidebar.tsx', 'utf8');
const ast = ts.createSourceFile('Sidebar.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
const output = ts.transpileModule(`${code}\nreturn Sidebar;`, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
} }).outputText;
function componentFixture(initial: NoteItem[]) {
  const slots: any[] = []; let cursor = 0, changed = false, pending: Array<() => void> = [], rows = 0, searches = 0;
  const hooks = {
    useState(initial: any) {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { const next = typeof value === 'function' ? value(slots[i]) : value;
        if (!Object.is(slots[i], next)) { slots[i] = next; changed = true; } }];
    },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return 'sidebar-projection-' + cursor++; },
    useEffect(effect: () => void, deps: unknown[]) {
      const i = cursor++, before = slots[i]?.deps;
      if (!before || deps.length !== before.length || deps.some((value, n) => !Object.is(value, before[n]))) {
        slots[i] = { deps }; pending.push(effect);
      }
    },
  };
  const react = { ...React, createElement(type: any, props: any, ...children: any[]) {
    if (props?.className?.startsWith('note-tree-row ') || props?.className?.startsWith('note-leaf-card ')) rows++;
    return React.createElement(type, props, ...children);
  } };
  const icons = Object.fromEntries(['FileText', 'Star', 'Folder', 'Plus', 'Trash2', 'ChevronRight', 'ChevronDown',
    'Search', 'Layers', 'X', 'PanelLeftClose', 'PanelLeftOpen'].map(name => [name, () => null]));
  const bindings = { React: react, ...hooks, useLayoutEffect: hooks.useEffect, ...icons,
    matchesNoteSearch: (...args: Parameters<typeof matchesNoteSearch>) => { searches++; return matchesNoteSearch(...args); },
    createPortal: (node: unknown) => node, useDialog() {}, window: { localStorage: { getItem: () => null, setItem() {} } } };
  const renderSidebar = new Function(...Object.keys(bindings), output)(...Object.values(bindings));
  const props: any = { notes: initial, activeNoteId: null, onSelectNote() {}, onNewNote() {}, onToggleFavorite() {},
    onDeleteProject: async () => {}, settings: {}, treeStateRef: { current: null } };
  let tree: any;
  const render = () => {
    let passes = 0;
    do { changed = false; cursor = 0; pending = []; tree = renderSidebar(props); pending.forEach(effect => effect());
      assert(++passes < 12, 'hooks settle'); } while (changed);
    return tree;
  };
  const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
  const find = (match: (node: any) => boolean) => { const node = flat(tree).find(match); assert(node, 'expected Sidebar element'); return node; };
  return { props, render, find, flat: () => flat(tree), rowCount: () => rows, searchCount: () => searches,
    button: (label: string) => find(node => node.type === 'button' && node.props['aria-label'] === label) };
}

{
  const f = componentFixture(Array.from({ length: 2000 }, (_, i) => note('root-' + i)));
  f.render(); const originalView = f.find(node => node.props.className === 'note-notebook-list');
  const original = originalView.props.children;
  const beforeRows = f.rowCount(), beforeSearches = f.searchCount(); let selectedVersion = -1, createdVersion = -1;
  for (let version = 0; version < 30; version++) {
    f.props.notes = f.props.notes.map((item: NoteItem, index: number) => index ? item : { ...item,
      content: 'fresh body ' + version, updatedAt: String(version), aliases: ['LiveAlias' + version] });
    f.props.onSelectNote = () => { selectedVersion = version; };
    f.props.onNewNote = () => { createdVersion = version; };
    f.render();
    assert.equal(f.find(node => node.props.className === 'note-notebook-list'), originalView, 'the list host itself can bail out before reconciling thousands of rows');
    assert.equal(f.find(node => node.props.className === 'note-notebook-list').props.children, original);
  }
  assert.equal(f.rowCount(), beforeRows, '30 ordinary saves create zero new row element trees');
  assert.equal(f.searchCount(), beforeSearches, 'no active query means ordinary body saves need no new filter pass');
  f.find(node => node.props.title === '打开「root-0」').props.onClick(); assert.equal(selectedVersion, 29);
  f.button('在「root-0」下新建子项目').props.onClick(); assert.equal(createdVersion, 29);
  f.render(); f.button('搜索项目笔记').props.onClick(); f.render();
  const search = () => f.find(node => node.type === 'input' && node.props['aria-label'] === '搜索项目笔记');
  search().props.onChange({ target: { value: 'fresh body 29' } }); f.render();
  assert.equal(f.flat().filter(node => node.props.className?.startsWith('note-leaf-card')).length, 1);
  const searched = f.searchCount(); f.props.onSelectNote = () => {}; f.render();
  assert.equal(f.searchCount(), searched, 'callback/status-only renders do not scan active search bodies again');
  f.props.notes = f.props.notes.map((item: NoteItem, index: number) => index ? item : { ...item, content: 'new replacement' }); f.render();
  assert.equal(f.flat().filter(node => node.props.className?.startsWith('note-leaf-card')).length, 0, 'saved search matches disappear when body changes');
  search().props.onChange({ target: { value: 'livealias29' } }); f.render();
  assert.equal(f.flat().filter(node => node.props.className?.startsWith('note-leaf-card')).length, 1);
  pass('actual Sidebar: 2k rows/30 saves reuse the exact React subtree with zero new row elements; callbacks and body/alias search stay current');
}

{
  const published = [note('published', { content: 'old published body' }), note('other')];
  let authoritative = published, reads = 0;
  const f = componentFixture(published); f.props.getNotes = () => { reads++; return authoritative; };
  f.render(); authoritative = published.map(item => item.id === 'published' ? { ...item, content: 'unbroadcast fresh draft token' } : item);
  f.props.onSelectNote = () => {}; f.render(); assert.equal(reads, 0, 'ordinary directory renders do not ask for or scan the live draft');
  f.button('搜索项目笔记').props.onClick(); f.render(); assert.equal(reads, 0);
  f.find(node => node.type === 'input').props.onChange({ target: { value: 'fresh draft token' } }); f.render();
  assert.equal(f.flat().filter(node => node.props.className?.startsWith('note-leaf-card')).length, 1);
  assert.equal(f.props.notes, published, 'fresh draft search requires no body publication');
  authoritative = authoritative.map(item => item.id === 'published' ? { ...item, content: 'replacement without matching token' } : item);
  f.props.onSelectNote = () => {}; f.render();
  assert.equal(f.flat().filter(node => node.props.className?.startsWith('note-leaf-card')).length, 0, 'same active query refresh uses the new authoritative snapshot');
  f.button('清除搜索').props.onClick(); f.render(); const afterClear = reads;
  f.props.onSelectNote = () => {}; f.render(); assert.equal(reads, afterClear);
  pass('unchanged published props + changing getNotes still search live draft bodies, with no authoritative read when query is empty');
}

{
  const f = componentFixture([note('favorite', { isFavorite: true }), note('other'), note('knowledge', { parentId: 'favorite', noteType: 'knowledge' })]);
  f.render(); f.button('搜索项目笔记').props.onClick(); f.render();
  f.find(node => node.type === 'button' && node.props.className?.includes('note-filter') && node.props.children?.some?.((v: any) => v === '收藏')).props.onClick();
  f.render(); const card = f.find(node => node.props.className?.startsWith('note-leaf-card'));
  f.props.notes = f.props.notes.map((item: NoteItem) => item.id === 'knowledge' ? { ...item, parentId: 'other' } : item); f.render();
  assert.equal(f.find(node => node.props.className?.startsWith('note-leaf-card')), card, 'unrelated knowledge movement does not redraw unchanged cards');
  f.button('删除项目「favorite」').props.onClick(); f.render();
  assert.equal(f.flat().filter(node => node.props.className === 'block mt-1 text-[var(--ln-danger)]').length, 0,
    'cached delete action consults the latest descendant index, not a captured old directory');
  let deleted = '';
  f.props.onDeleteProject = async (id: string) => { deleted = id; }; f.render();
  await f.find(node => node.type === 'button' && node.props.className === 'note-project-dialog-action is-danger').props.onClick();
  for (let i = 0; i < 5; i++) await Promise.resolve(); assert.equal(deleted, 'favorite');
  pass('cached filtered cards keep live deletion scope and latest confirmed-delete callback after hierarchy changes');
}

{
  const fixtures = [note('root'), note('child', { parentId: 'root' }), note('other')];
  const props = { notes: fixtures, activeNoteId: 'root', onSelectNote() {}, onNewNote() {}, onDeleteNote() {},
    onDeleteProject: async () => {}, onToggleFavorite() {}, onTogglePin() {}, settings: {} as VaultSettings };
  const before = renderToStaticMarkup(React.createElement(Sidebar, props));
  const after = renderToStaticMarkup(React.createElement(Sidebar, { ...props,
    notes: fixtures.map(item => ({ ...item, content: 'unrelated body replacement', updatedAt: 'new' })) }));
  assert.equal(after, before); assert(before.includes('aria-label="删除项目「root」"'));
  assert(before.includes('含自身共 2 个项目')); assert.equal(before.includes('unrelated body replacement'), false);
  pass('real React SSR preserves visible markup, counts, accessibility and source privacy across body-only saves');
}

const timings: Array<{ notes: number; ms: number; rawFields: number; descendantMs: number }> = [];
for (const size of [1000, 3000, 6000]) {
  let reads = 0;
  const notes = Array.from({ length: size }, (_, i) => new Proxy(note('wide-' + i), { get(target, key, receiver) {
    if (key === 'content') assert.fail('display indexing must not read/normalize body text');
    reads++; return Reflect.get(target, key, receiver);
  } }));
  const start = performance.now(), projection = createSidebarProjection()(notes), elapsed = performance.now() - start;
  assert.equal(projection.projectTree.length, size); assert(reads <= size * 12, 'raw-source inspection remains one bounded linear pass');
  const descendantStart = performance.now(); assert.equal(countProjectDescendants(notes, 'wide-0'), 0);
  timings.push({ notes: size, ms: elapsed, rawFields: reads, descendantMs: performance.now() - descendantStart });
}
console.log(JSON.stringify({ scope: 'synthetic actual projection/index functions; Node timing, not a browser profile', timings }));
console.log(`Sidebar projection: ${groups} groups passed; no user data or external IO.`);
