import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const path = resolve('src/components/ArgumentActionDialog.tsx');
const module = { exports: {} as any };
const localRequire = createRequire(path);
let dialogOpen = false;
runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText, { module, exports: module.exports, document: { body: {} }, require(id: string) {
  if (id === 'react') return { useId: () => 'argument-action', useRef: (value: any) => ({ current: value }) };
  if (id === 'react-dom') return { createPortal: (node: any) => node };
  if (id === './useDialog') return { useDialog: (open: boolean) => { dialogOpen = open; } };
  if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
  if (id.endsWith('.css')) return {};
  return localRequire(id);
} });
const Component = module.exports.ArgumentActionDialog;
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat)
  : node?.props ? [node, ...flat(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('')
  : node?.props ? text(node.props.children) : typeof node === 'string' ? node : '';
const button = (tree: any, label: string) => flat(tree).find(node => node.type === 'button' && text(node) === label);

assert.equal(Component({ request: null, onCancel() {}, onConfirm() {} }), null);
assert.equal(dialogOpen, false);
let cancels = 0, confirmed: any = null;
const base = { docId: 'graph-a', graphTitle: '条件概率论证', noteTitle: '贝叶斯定理' };
let tree = Component({ request: { ...base, kind: 'delete' }, onCancel() { cancels++; }, onConfirm(value: any) { confirmed = value; } });
assert.equal(dialogOpen, true);
assert.ok(flat(tree).find(node => node.props.role === 'alertdialog'));
assert.match(text(tree), /笔记的其他正文和其他结构图不受影响/);
button(tree, '取消').props.onClick(); assert.equal(cancels, 1);
button(tree, '确认删除').props.onClick(); assert.equal(confirmed.kind, 'delete'); assert.equal(confirmed.docId, 'graph-a');
tree = Component({ request: { ...base, kind: 'withdraw' }, onCancel() {}, onConfirm(value: any) { confirmed = value; } });
assert.match(text(tree), /结构图、草稿与质量报告仍会保留/);
button(tree, '确认撤回').props.onClick(); assert.equal(confirmed.kind, 'withdraw');

const app = readFileSync('src/App.tsx', 'utf8');
const destructiveSection = app.slice(app.indexOf('const requestArgumentAction'), app.indexOf('const saveArgumentDoc'));
assert.doesNotMatch(destructiveSection, /window\.confirm/);
assert.match(destructiveSection, /requestArgumentAction\('delete', docId\)/);
assert.match(destructiveSection, /requestArgumentAction\('withdraw', docId\)/);
assert.match(destructiveSection, /setArgumentAction\(null\)[\s\S]*?performArgumentBlockDelete/);
const css = readFileSync('src/components/ArgumentActionDialog.css', 'utf8');
assert.match(css, /min-height:\s*44px/);
assert.match(css, /var\(--ln-accent\)/);
assert.doesNotMatch(css, /#[0-9a-f]{3,8}/i);
console.log('Argument action dialog passed: frozen target, explicit scopes, themed keyboard dialog and once-only dispatch wiring.');
