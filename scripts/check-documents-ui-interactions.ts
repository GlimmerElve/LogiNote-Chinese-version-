import assert from 'node:assert/strict';
import nodeProcess from 'node:process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type { DocumentPreview, UploadedDocument } from '../src/types';
import type { NodeSourceRepairProposal } from '../src/services/documentGraphNodeRepair';

// Run the real UI event handlers against in-memory fixtures. Every service import
// is replaced before evaluating the component: no Electron API, vault, files,
// network, embeddings, or LLM is reachable from this check.
type Element = { type: unknown; props: Record<string, any> };
const componentPath = resolve('src/components/DocumentsView.tsx');
const moduleRequire = createRequire(componentPath);
const source = ts.transpileModule(readFileSync(componentPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
let harnessId = 0;
const deferred = <T,>() => {
  let resolveValue!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveValue = resolvePromise; reject = rejectPromise; });
  return { promise, resolve: resolveValue, reject };
};
const drain = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const fixture = (id: string, status: UploadedDocument['status'] = 'ready'): UploadedDocument => ({
  id, fileName: `${id}.pdf`, fileType: 'pdf', extension: '.pdf', indexable: true, size: 1024,
  status, chunkCount: status === 'ready' ? 2 : 0, totalChars: 50, uploadAt: '2026-10-06T08:00:00Z',
  knowledgeStatus: 'disabled',
});
const previewFor = (document: UploadedDocument): DocumentPreview => ({
  document, chunks: [{ id: `${document.id}#0`, index: 0, sectionPath: '合成段落', content: '只存在于内存的合成索引文本。' }],
  totalChunkCount: 1, truncated: false,
});

function services(initialDocuments = [fixture('alpha'), fixture('beta', 'failed')]) {
  let documents = initialDocuments;
  const calls = { choose: 0, upload: 0, delete: 0, retry: 0, open: 0, preview: 0, settings: 0, process: 0, knowledgeRetry: 0, list: 0, category: 0 };
  const documentApi = {
    isDocumentRagAvailable: () => true,
    listDocuments: async () => { calls.list += 1; return documents; },
    chooseDocumentFiles: async () => { calls.choose += 1; return []; },
    uploadDocuments: async (_files: string[]) => { calls.upload += 1; return []; },
    setDocumentCategory: async (id: string, category?: string) => { calls.category += 1; documents = documents.map((item) => item.id === id ? { ...item, category } : item); },
    deleteDocument: async (id: string) => { calls.delete += 1; documents = documents.filter((item) => item.id !== id); },
    retryDocument: async (_id: string) => { calls.retry += 1; },
    openDocument: async (_id: string) => { calls.open += 1; },
    previewDocument: async (id: string) => { calls.preview += 1; return previewFor(documents.find((item) => item.id === id)!); },
    subscribeDocumentChanges: (_callback: () => void) => () => {},
  };
  const knowledgeApi = {
    isKnowledgeRagAvailable: () => true,
    getKnowledgeSettings: async () => ({ enabled: false, processingMode: 'local-only' }),
    setKnowledgeSettings: async (settings: any) => { calls.settings += 1; return settings; },
    retryKnowledgeDocument: async (_id: string) => { calls.knowledgeRetry += 1; },
  };
  const extractionApi = {
    processNextDocumentGraphBatch: async (_documents: UploadedDocument[],_progress:(text:string)=>void,_signal?:AbortSignal,_confirm?:(proposal:NodeSourceRepairProposal)=>Promise<boolean>) => { calls.process += 1; return { completed:0,done:0,total:0,requests:0,fileName:'' }; },
  };
  return { documentApi, knowledgeApi, extractionApi, calls, setDocuments(value: UploadedDocument[]) { documents = value; } };
}

function harness(exportName: string, mockedServices = services(), props: Record<string, any> = {}) {
  const instanceId = ++harnessId;
  const slots: any[] = [];
  const cleanups = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let cursor = 0;
  let changed = false;
  let unmounted = false;
  let updatesAfterUnmount = 0;
  let effects: { index: number; effect: () => void | (() => void) }[] = [];
  let tree: Element;
  const dialogs: { open: boolean; close?: () => void; priority: number }[] = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => {
        if (unmounted) updatesAfterUnmount += 1;
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; changed = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useId() { return `document-${instanceId}-${cursor++}`; },
    useCallback(callback: (...args: any[]) => any, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { deps, value: callback };
      return slots[index].value;
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) { slots[index] = { deps }; effects.push({ index, effect }); }
    },
  };
  const module = { exports: {} as Record<string, any> };
  runInNewContext(source, {
    exports: module.exports, module,
    require(id: string) {
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime' || id === 'lucide-react') return moduleRequire(id);
      if (id === '../services/documentRagClient') return mockedServices.documentApi;
      if (id === './DocumentProjectBindingSection') return { DocumentProjectBindingSection: function DocumentProjectBindingSection() { return null; } };
      if (id === '../services/knowledgeRagClient') return mockedServices.knowledgeApi;
      if (id === '../services/documentGraphExtractionService') return mockedServices.extractionApi;
      if (id === '../services/documentBackgroundJobs') return { documentBackgroundJobs: { getSnapshot: () => [], subscribe: () => () => {}, cancel: () => {} }, startDocumentGraphBackgroundJob: async () => {} };
      if (id === '../services/documentBackgroundQueue' || id === '../services/documentProcessingActions') return moduleRequire(id);
      if (id === '../services/llmStorage') return { ensureLlmSettingsLoaded: async () => {} };
      if (id === '../services/llmService') return { resolveProvider: () => ({ selectedModel: 'fixture' }) };
      if (id === './DocumentArgumentGraphDialog') return { DocumentArgumentGraphDialog: () => null };
      if (id === './ReferenceArgumentStatus') return {
        ReferenceArgumentStatus: function ReferenceArgumentStatus() {
          return React.createElement('span', { role: 'status' }, '参考论证需桌面版支持');
        },
      };
      if (id === './useDialog') return { useDialog(open: boolean, _ref: unknown, close?: () => void, priority = 50) { dialogs.push({ open, close, priority }); } };
      throw new Error(`Unmocked import is forbidden in this UI check: ${id}`);
    },
    Date, Error, Set, Map, Math, Number, String, Boolean, Promise, URL, AbortController,
    setInterval(callback: () => void) { const id = intervals.size + 1; intervals.set(id, callback); return id; },
    clearInterval(id: number) { intervals.delete(id); },
  });
  const render = () => {
    let passes = 0;
    do {
      changed = false; cursor = 0; effects = []; dialogs.length = 0;
      tree = module.exports[exportName](props);
      effects.forEach(({ index, effect }) => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup); });
      assert.ok(++passes < 12, 'synthetic UI hooks must settle');
    } while (changed);
    return tree;
  };
  render();
  return { props, render, dialogs, tick: () => intervals.forEach((callback) => callback()),
    unmount() { unmounted = true; cleanups.forEach((cleanup) => cleanup()); },
    get updatesAfterUnmount() { return updatesAfterUnmount; }, get tree() { return tree; } };
}

function all(element: unknown): Element[] {
  if (Array.isArray(element)) return element.flatMap(all);
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element;
  return [node, ...all(node.props.children)];
}
const textContent = (node: any): string => Array.isArray(node) ? node.map(textContent).join('')
  : node && typeof node === 'object' && node.props ? textContent(node.props.children)
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
function find(tree: Element, predicate: (node: Element) => boolean) {
  const match = all(tree).find(predicate);
  assert.ok(match, 'expected UI control was not found');
  return match;
}
const byText = (tree: Element, type: string, value: string) => find(tree, (node) => node.type === type && textContent(node) === value);
const byLabel = (tree: Element, value: string) => find(tree, (node) => node.props['aria-label'] === value);
const component = (tree: Element, name: string) => find(tree, (node) => typeof node.type === 'function' && node.type.name === name);
const row = (tree: Element, id: string) => find(tree, (node) => node.props['data-document-id'] === id);

const basicServices = services();
const basic = harness('DocumentsView', basicServices);
assert.ok(textContent(basic.tree).includes('正在读取资料列表…'), 'initial read has a loading state, never a false empty state');
assert.ok(!textContent(basic.tree).includes('还没有上传资料'));
await drain(); basic.render();
assert.equal(basicServices.calls.process, 0, 'opening Documents never sends text to an LLM');
assert.equal(basicServices.calls.settings, 0, 'opening Documents never changes cloud consent');
const filter = byText(basic.tree, 'button', '仅保存 0');
assert.equal(filter.props['aria-pressed'], false);
filter.props.onClick(); basic.render();
assert.ok(textContent(basic.tree).includes('当前状态下没有资料'));
assert.ok(!textContent(basic.tree).includes('还没有上传资料'));
byText(basic.tree, 'button', '查看全部资料').props.onClick(); basic.render();
assert.equal(byText(basic.tree, 'button', '全部 2').props['aria-pressed'], true);
for (const button of all(basic.tree).filter((node) => node.type === 'button')) {
  assert.equal(button.props.type, 'button');
  assert.ok(button.props['aria-label'] || textContent(button), 'every control has a meaningful name');
  assert.ok(button.props.className.includes('focus-visible'), 'every control has a visible keyboard focus style');
}

// A category is an explicit metadata write: the row moves groups without touching indexing.
byLabel(basic.tree, '整理分类：alpha.pdf').props.onClick(); basic.render();
const categoryDialog = component(basic.tree, 'DocumentCategoryDialog');
assert.equal(categoryDialog.props.document.id, 'alpha');
await categoryDialog.props.onSave('研究论文'); basic.render();
assert.equal(basicServices.calls.category, 1);
assert.ok(textContent(basic.tree).includes('已将“alpha.pdf”归入“研究论文”'));
assert.ok(textContent(basic.tree).includes('研究论文1'));
assert.equal(basicServices.calls.retry, 0, 'moving a category never rebuilds the document index');

// The same organizer exposes independent project bindings without inferring them
// from category names or triggering any write while opening the panel.
let bindingWrites = 0;
const bindingServices = services();
const bindingProject = { id: 'project-fixture', title: '概率论', noteType: 'project', resources: [{ documentId: 'alpha' }] };
const bindingsPage = harness('DocumentsView', bindingServices, { notes: [bindingProject], getBindingScope: async () => 'fixture-scope',
  onSaveDocumentBindings: async () => { bindingWrites++; } });
await drain(); bindingsPage.render();
assert.ok(textContent(bindingsPage.tree).includes('已绑定 1 个项目 · 子项目继承'));
assert.ok(textContent(bindingsPage.tree).includes('直接绑定：概率论'));
assert.ok(textContent(bindingsPage.tree).includes('未绑定项目 · 点击绑定'));
byLabel(bindingsPage.tree, '管理项目绑定：alpha.pdf').props.onClick(); bindingsPage.render();
const organizer = component(bindingsPage.tree, 'DocumentCategoryDialog');
assert.equal(organizer.props.bindingSection.props.document.id, 'alpha');
assert.equal(bindingWrites, 0);
await organizer.props.onSave('教材'); bindingsPage.render();
assert.equal(bindingServices.calls.category, 1);
assert.equal(bindingWrites, 0, 'saving a category never changes project bindings');
assert.equal(component(bindingsPage.tree, 'DocumentCategoryDialog').props.document.category, '教材');
bindingsPage.unmount();

if (nodeProcess.argv.includes('--bindings-only')) {
  const panel = harness('DocumentCategoryDialog', services(), { document: fixture('organizer'), categories: ['教材'], busy: false,
    bindingSection: React.createElement('div', { 'data-binding-section': true }, '项目绑定'), onClose() {}, onSave() {} });
  assert.ok(panel.dialogs.some(dialog => dialog.open && dialog.priority === 90 && dialog.close));
  assert.equal(find(panel.tree, node => node.props.role === 'dialog').props['aria-modal'], 'true');
  assert.ok(textContent(panel.tree).includes('分类与项目绑定分别保存'));
  assert.ok(all(panel.tree).some(node => node.props['data-binding-section']));
  panel.props.busy = true; panel.render();
  assert.ok(all(panel.tree).filter(node => node.type === 'button' || node.type === 'input').every(node => node.props.disabled));
  assert.ok(panel.dialogs.every(dialog => !dialog.close), 'saving prevents Escape from dropping pending changes');
  console.log('Documents organizer UI checks passed: cards/status, category isolation, accessible dialog and busy controls.');
  nodeProcess.exit(0);
}

// Import cancellation, double click protection, error recovery and honest status.
const choose = deferred<string[]>();
basicServices.documentApi.chooseDocumentFiles = () => { basicServices.calls.choose += 1; return choose.promise; };
const uploadButton = byText(basic.tree, 'button', '上传资料');
const cancelledUpload = uploadButton.props.onClick();
uploadButton.props.onClick();
assert.equal(basicServices.calls.choose, 1, 'two immediate clicks open only one file picker');
basic.render();
assert.equal(byText(basic.tree, 'button', '正在选择…').props.disabled, true);
choose.resolve([]); await cancelledUpload; basic.render();
assert.equal(basicServices.calls.upload, 0, 'cancelling selection writes nothing');
assert.ok(textContent(basic.tree).includes('已取消选择资料'));
basicServices.documentApi.chooseDocumentFiles = async () => ['memory://fixture.pdf'];
basicServices.documentApi.uploadDocuments = async () => { throw new Error('合成导入失败'); };
await byText(basic.tree, 'button', '上传资料').props.onClick(); basic.render();
assert.equal(textContent(find(basic.tree, (node) => node.props.role === 'alert')), '合成导入失败');
basicServices.documentApi.uploadDocuments = async () => [fixture('imported', 'pending')];
await byText(basic.tree, 'button', '上传资料').props.onClick(); basic.render();
assert.ok(textContent(basic.tree).includes('已接收 1 份资料；可解析格式会在独立后台进程建立索引，可以离开本页。'));

// A row operation locks synchronously and unlocks after failure for a retry.
const retry = deferred<void>();
basicServices.documentApi.retryDocument = () => { basicServices.calls.retry += 1; return retry.promise; };
const retryButton = byLabel(basic.tree, '重试解析 beta.pdf');
const waitingRetry = retryButton.props.onClick(); retryButton.props.onClick();
assert.equal(basicServices.calls.retry, 1);
basic.render();
assert.equal(row(basic.tree, 'beta').props['aria-busy'], true);
assert.ok(all(row(basic.tree, 'beta')).filter((node) => node.type === 'button').every((node) => node.props.disabled), 'all conflicting row actions are disabled');
retry.reject(new Error('合成解析重试失败')); await waitingRetry; basic.render();
assert.equal(byLabel(basic.tree, '重试解析 beta.pdf').props.disabled, false);
assert.ok(textContent(basic.tree).includes('合成解析重试失败'));

// The latest preview wins, and cancelled or unmounted requests stay cancelled.
const firstPreview = deferred<DocumentPreview>();
const secondPreview = deferred<DocumentPreview>();
let alphaFocus = 0;
let betaFocus = 0;
const alphaOrigin = { isConnected: true, disabled: false, closest: () => null, focus: () => { alphaFocus += 1; } };
const betaOrigin = { isConnected: true, disabled: false, closest: () => null, focus: () => { betaFocus += 1; } };
basicServices.documentApi.previewDocument = (id: string) => id === 'alpha' ? firstPreview.promise : secondPreview.promise;
const firstRequest = byLabel(basic.tree, '查看 alpha.pdf 的资料详情与索引内容').props.onClick({ currentTarget: alphaOrigin });
const secondRequest = byLabel(basic.tree, '查看 beta.pdf 的资料详情与索引内容').props.onClick({ currentTarget: betaOrigin });
secondPreview.resolve(previewFor(fixture('beta', 'failed'))); await secondRequest; basic.render();
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.preview.document.id, 'beta');
firstPreview.resolve(previewFor(fixture('alpha'))); await firstRequest; basic.render();
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.preview.document.id, 'beta', 'an old preview cannot replace a newer selection');
component(basic.tree, 'DocumentPreviewDialog').props.onClose(); basic.render();
assert.equal(betaFocus, 1, 'closing an async preview restores its accepted row trigger, not the document body');
assert.equal(alphaFocus, 0, 'an obsolete preview never steals focus from the latest selection');
const cancelledPreview = deferred<DocumentPreview>();
basicServices.documentApi.previewDocument = () => cancelledPreview.promise;
const cancelRequest = byLabel(basic.tree, '查看 alpha.pdf 的资料详情与索引内容').props.onClick({ currentTarget: alphaOrigin }); basic.render();
byText(basic.tree, 'button', '取消查看').props.onClick(); basic.render();
assert.equal(alphaFocus, 1, 'cancelling a pending preview returns to its row after loading unlocks');
cancelledPreview.resolve(previewFor(fixture('alpha'))); await cancelRequest; basic.render();
assert.equal(alphaFocus, 1, 'a cancelled late response cannot move focus again');
assert.ok(!all(basic.tree).some((node) => typeof node.type === 'function' && node.type.name === 'DocumentPreviewDialog'));
const unmountServices = services();
const unmountView = harness('DocumentsView', unmountServices); await drain(); unmountView.render();
const unmountedPreview = deferred<DocumentPreview>();
unmountServices.documentApi.previewDocument = () => unmountedPreview.promise;
const unmountRequest = byLabel(unmountView.tree, '查看 alpha.pdf 的资料详情与索引内容').props.onClick();
unmountView.unmount();
unmountedPreview.resolve(previewFor(fixture('alpha'))); await unmountRequest;
assert.equal(unmountView.updatesAfterUnmount, 0, 'a late preview cannot update an unmounted view');

// Errors from a preview action are visible inside the overlay, not behind it.
basicServices.documentApi.previewDocument = async () => previewFor(fixture('alpha'));
await byLabel(basic.tree, '查看 alpha.pdf 的资料详情与索引内容').props.onClick(); basic.render();
const open = deferred<void>();
basicServices.documentApi.openDocument = () => { basicServices.calls.open += 1; return open.promise; };
const previewProps = component(basic.tree, 'DocumentPreviewDialog').props;
previewProps.onOpen(); previewProps.onOpen();
assert.equal(basicServices.calls.open, 1);
basic.render();
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.busy, true);
open.reject(new Error('合成原文件打开失败')); await drain(); basic.render();
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.error, '合成原文件打开失败');
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.busy, false);

// Reindex confirmation overlays the preview and blocks double submission.
component(basic.tree, 'DocumentPreviewDialog').props.onReindex(); basic.render();
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.backgroundInert, true);
const confirmationProps = component(basic.tree, 'DocumentConfirmationDialog').props;
assert.equal(confirmationProps.confirmation.kind, 'body');
const reindex = deferred<void>();
basicServices.documentApi.retryDocument = () => { basicServices.calls.retry += 1; return reindex.promise; };
const retryCount = basicServices.calls.retry;
const waitingReindex = confirmationProps.onConfirm(); confirmationProps.onConfirm();
assert.equal(basicServices.calls.retry, retryCount + 1);
basic.render();
assert.equal(component(basic.tree, 'DocumentConfirmationDialog').props.busy, true);
component(basic.tree, 'DocumentConfirmationDialog').props.onClose(); basic.render();
assert.ok(component(basic.tree, 'DocumentConfirmationDialog'), 'pending confirmation cannot dismiss');
reindex.reject(new Error('合成重建失败')); await waitingReindex; basic.render();
assert.equal(component(basic.tree, 'DocumentConfirmationDialog').props.error, '合成重建失败');
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.preview.chunks.length, 1, 'a rejected reindex preserves the existing preview');
basicServices.documentApi.retryDocument = async () => {};
await component(basic.tree, 'DocumentConfirmationDialog').props.onConfirm(); basic.render();
assert.ok(!all(basic.tree).some((node) => typeof node.type === 'function' && node.type.name === 'DocumentConfirmationDialog'));
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.preview.document.status, 'pending');
assert.equal(component(basic.tree, 'DocumentPreviewDialog').props.preview.chunks.length, 0, 'successful submission does not pretend the new index is ready');
component(basic.tree, 'DocumentPreviewDialog').props.onClose(); basic.render();

// Delete requires explicit confirmation; errors preserve the target for retry.
byLabel(basic.tree, '删除资料 alpha.pdf').props.onClick(); basic.render();
assert.equal(basicServices.calls.delete, 0);
component(basic.tree, 'DocumentConfirmationDialog').props.onClose(); basic.render();
assert.equal(basicServices.calls.delete, 0, 'cancel never invokes the destructive service');
byLabel(basic.tree, '删除资料 alpha.pdf').props.onClick(); basic.render();
const deletion = deferred<void>();
basicServices.documentApi.deleteDocument = () => { basicServices.calls.delete += 1; return deletion.promise; };
const deleteProps = component(basic.tree, 'DocumentConfirmationDialog').props;
const waitingDelete = deleteProps.onConfirm(); deleteProps.onConfirm();
assert.equal(basicServices.calls.delete, 1);
deletion.reject(new Error('合成删除失败')); await waitingDelete; basic.render();
assert.equal(component(basic.tree, 'DocumentConfirmationDialog').props.error, '合成删除失败');
assert.ok(row(basic.tree, 'alpha'), 'failed deletion keeps the item visible');
basicServices.documentApi.deleteDocument = async () => { basicServices.calls.delete += 1; basicServices.setDocuments([fixture('beta', 'failed')]); };
await component(basic.tree, 'DocumentConfirmationDialog').props.onConfirm(); basic.render();
assert.equal(basicServices.calls.delete, 2);
assert.ok(!all(basic.tree).some((node) => node.props['data-document-id'] === 'alpha'));

// A list read that started before a mutation cannot resurrect deleted items.
const staleServices = services([fixture('stale')]);
const staleView = harness('DocumentsView', staleServices); await drain(); staleView.render();
const oldList = deferred<UploadedDocument[]>();
staleServices.documentApi.listDocuments = () => oldList.promise;
staleView.tick();
byLabel(staleView.tree, '删除资料 stale.pdf').props.onClick(); staleView.render();
staleServices.documentApi.listDocuments = async () => [];
await component(staleView.tree, 'DocumentConfirmationDialog').props.onConfirm(); staleView.render();
oldList.resolve([fixture('stale')]); await drain(); staleView.render();
assert.ok(!all(staleView.tree).some((node) => node.props['data-document-id'] === 'stale'));

// Load failure is recoverable and must never claim the library is empty.
const failedServices = services();
failedServices.documentApi.listDocuments = async () => { throw new Error('合成列表读取失败'); };
const failedView = harness('DocumentsView', failedServices); await drain(); failedView.render();
assert.ok(textContent(failedView.tree).includes('未能读取资料列表。合成列表读取失败'));
assert.ok(!textContent(failedView.tree).includes('还没有上传资料'));
failedServices.documentApi.listDocuments = async () => [fixture('recovered')];
await byText(failedView.tree, 'button', '重新读取').props.onClick(); failedView.render();
assert.ok(row(failedView.tree, 'recovered'));
assert.ok(!textContent(failedView.tree).includes('合成列表读取失败'));

// Unsupported web runtime is explicit and performs no backend requests.
const webServices = services(); webServices.documentApi.isDocumentRagAvailable = () => false;
const webView = harness('DocumentsView', webServices); await drain(); webView.render();
assert.equal(byText(webView.tree, 'button', '上传资料').props.disabled, true);
assert.ok(textContent(webView.tree).includes('资料文档功能仅在桌面版可用'));
assert.equal(webServices.calls.list, 0);
assert.equal(webServices.calls.settings, 0);

// Validate the actual dialog JSX, including stacked keyboard ownership and
// keeping Escape/backdrop/close disabled until the service settles.
const noop = () => {};
const details = harness('DocumentPreviewDialog', services(), {
  preview: previewFor(fixture('dialog')), onClose: noop, onOpen: noop, onReindex: noop,
  error: '合成详情错误', busy: false,
});
assert.ok(details.dialogs.some((dialog) => dialog.open && dialog.priority === 80 && dialog.close));
assert.equal(find(details.tree, (node) => node.props.role === 'dialog').props['aria-modal'], 'true');
assert.equal(textContent(find(details.tree, (node) => node.props.role === 'alert')), '合成详情错误');
details.props.busy = true; details.render();
assert.ok(details.dialogs.some((dialog) => dialog.priority === 80 && !dialog.close));
assert.ok(all(details.tree).filter((node) => node.type === 'button').every((node) => node.props.disabled));
const zeroDetails = harness('DocumentPreviewDialog', services(), {
  preview: { ...previewFor(fixture('empty-index')), chunks: [], totalChunkCount: 0 }, onClose: noop, onOpen: noop, onReindex: noop,
});
assert.ok(textContent(zeroDetails.tree).includes('索引已完成，但当前没有可展示的文本分块。'));
assert.notEqual(find(details.tree, (node) => node.props.role === 'dialog').props['aria-labelledby'],
  find(zeroDetails.tree, (node) => node.props.role === 'dialog').props['aria-labelledby'], 'concurrent document previews keep distinct accessible titles');
let restoredFocus = 0;
const reindexControl = byText(zeroDetails.tree, 'button', '重新建立索引');
reindexControl.props.ref.current = { focus() { restoredFocus += 1; } };
zeroDetails.props.backgroundInert = true; zeroDetails.render();
zeroDetails.props.backgroundInert = false; zeroDetails.render();
assert.equal(restoredFocus, 1, 'closing a stacked confirmation restores focus into its preview');
const confirmDialog = harness('DocumentConfirmationDialog', services(), {
  confirmation: { kind: 'delete', document: fixture('confirm') }, busy: false, error: null, onClose: noop, onConfirm: noop,
});
assert.ok(confirmDialog.dialogs.some((dialog) => dialog.priority === 90 && dialog.close));
const alertDialog = find(confirmDialog.tree, (node) => node.props.role === 'alertdialog');
assert.equal(alertDialog.props['aria-modal'], 'true');
assert.equal(all(alertDialog).find((node) => node.type === 'button')?.props.children, '取消', 'initial dialog focus goes to the non-destructive action');
confirmDialog.props.busy = true; confirmDialog.render();
assert.ok(confirmDialog.dialogs.some((dialog) => dialog.priority === 90 && !dialog.close));
assert.ok(all(confirmDialog.tree).filter((node) => node.type === 'button').every((node) => node.props.disabled));

// Knowledge mode remains explicit, locks synchronously, and never processes on
// selection alone. Processing uses the existing batch size and reports results.
const knowledgeServices = services();
const knowledge = harness('DocumentsView', knowledgeServices); await drain(); knowledge.render();
assert.equal(byText(knowledge.tree, 'button', '关闭').props['aria-pressed'], true);
const setting = deferred<any>();
knowledgeServices.knowledgeApi.setKnowledgeSettings = (value: any) => { knowledgeServices.calls.settings += 1; assert.equal(value.processingMode, 'allow-cloud'); return setting.promise; };
const cloudButton = byText(knowledge.tree, 'button', '允许云端');
const waitingSetting = cloudButton.props.onClick(); cloudButton.props.onClick();
assert.equal(knowledgeServices.calls.settings, 1);
assert.equal(knowledgeServices.calls.process, 0);
setting.resolve({ enabled: true, processingMode: 'allow-cloud' }); await waitingSetting; knowledge.render();
assert.equal(byText(knowledge.tree, 'button', '允许云端').props['aria-pressed'], true);
const batch = deferred<any>();
knowledgeServices.extractionApi.processNextDocumentGraphBatch = (docs:UploadedDocument[],progress,signal) => { knowledgeServices.calls.process += 1; assert.equal(docs[0].id,'alpha'); assert(signal);progress('合成资料：3/5 带原文复核');return batch.promise; };
const process = byText(knowledge.tree, 'button', '处理下一批图谱');
const waitingProcess = process.props.onClick(); process.props.onClick();
await drain();
assert.equal(knowledgeServices.calls.process, 1);
knowledge.render();
assert.equal(byText(knowledge.tree, 'button', '允许云端').props.disabled, true);
batch.resolve({ completed:5,done:5,total:8,requests:4,fileName:'合成资料' }); await waitingProcess; knowledge.render();
assert.ok(textContent(knowledge.tree).includes('已保存 5/8 个窗口'));

// Source repair is explicit and cancellable; closing the view must resolve the
// pending confirmation without updating unmounted React state.
const repairProposal:NodeSourceRepairProposal={nodeCount:2,validNodeCount:1,canConfirm:true,issues:[{
  nodeId:'N2',sourceIndex:0,window:'W2',quote:'原文多走一个字',reason:'missing_quote',
  candidates:[{start:0,end:6,quote:'原文多一个字',method:'single_edit'}],
}]};
let repairAccepted:boolean|undefined;
knowledgeServices.extractionApi.processNextDocumentGraphBatch=async(_docs,_progress,signal,confirm)=>{
  knowledgeServices.calls.process++;assert(signal&&confirm);
  repairAccepted=await confirm(repairProposal);
  if(!repairAccepted)throw new Error('引文待确认，当前会话已保留响应');
  return {completed:5,done:5,total:8,requests:3,fileName:'合成资料'};
};
const pauseRepair=byText(knowledge.tree,'button','处理下一批图谱').props.onClick();await drain();knowledge.render();
component(knowledge.tree,'DocumentSourceRepairDialog').props.onClose();await pauseRepair;knowledge.render();
assert.equal(repairAccepted,false);assert.equal(knowledgeServices.calls.process,2);
assert.ok(textContent(knowledge.tree).includes('当前会话已保留响应'));
const acceptRepair=byText(knowledge.tree,'button','处理下一批图谱').props.onClick();await drain();knowledge.render();
component(knowledge.tree,'DocumentSourceRepairDialog').props.onConfirm();await acceptRepair;knowledge.render();
assert.equal(repairAccepted,true);assert.equal(knowledgeServices.calls.process,3);
const repairDialog=harness('DocumentSourceRepairDialog',services(),{proposal:repairProposal,onClose:()=>{},onConfirm:()=>{}});
assert.equal(String(find(repairDialog.tree,n=>n.props.role==='alertdialog').props['aria-modal']),'true');
assert.ok(repairDialog.dialogs.some(d=>d.open&&d.priority===100&&d.close));
assert.equal(all(repairDialog.tree).find(n=>n.type==='button')?.props.children,'暂缓，保留响应');
assert.equal(byText(repairDialog.tree,'button','按原文修订并继续').props.disabled,false);
repairDialog.props.proposal={...repairProposal,canConfirm:false};repairDialog.render();
assert.equal(byText(repairDialog.tree,'button','按原文修订并继续').props.disabled,true);
const abandonRepair=byText(knowledge.tree,'button','处理下一批图谱').props.onClick();await drain();knowledge.render();
assert.ok(component(knowledge.tree,'DocumentSourceRepairDialog'));knowledge.unmount();await abandonRepair;
assert.equal(repairAccepted,false);assert.equal(knowledge.updatesAfterUnmount,0);

// Unknown settings are not an implicit opt-out or permission to overwrite.
const unreadServices = services();
let knowledgeReads = 0;
unreadServices.knowledgeApi.getKnowledgeSettings = async () => {
  knowledgeReads += 1;
  throw new Error('合成知识设置读取失败');
};
const unread = harness('DocumentsView', unreadServices);
await drain(); unread.render();
for (const label of ['关闭', '仅本地', '允许云端']) {
  const control = byText(unread.tree, 'button', label);
  assert.equal(control.props['aria-pressed'], false, 'unknown settings never claim a selected mode');
  assert.equal(control.props.disabled, true);
  await control.props.onClick();
}
assert.equal(unreadServices.calls.settings, 0, 'unknown settings cannot be overwritten even through stale handlers');
assert.equal(unreadServices.calls.process, 0);
await byLabel(row(unread.tree, 'alpha'), `用系统默认应用打开 ${fixture('alpha').fileName}`).props.onClick(); unread.render();
assert.ok(textContent(unread.tree).includes('合成知识设置读取失败'), 'unrelated successful document actions cannot hide the settings error');
const settingsRead = deferred<any>();
unreadServices.knowledgeApi.getKnowledgeSettings = () => { knowledgeReads += 1; return settingsRead.promise; };
const readAgain = byText(unread.tree, 'button', '重试读取设置');
readAgain.props.onClick(); readAgain.props.onClick(); unread.render();
assert.equal(knowledgeReads, 2, 'retry is one read, not a mutation or duplicate request');
assert.ok(textContent(unread.tree).includes('正在读取知识层设置…'));
assert.equal(byText(unread.tree, 'button', '仅本地').props.disabled, true);
settingsRead.resolve({ enabled: true, processingMode: 'local-only' }); await drain(); unread.render();
assert.equal(byText(unread.tree, 'button', '仅本地').props['aria-pressed'], true);
assert.equal(byText(unread.tree, 'button', '仅本地').props.disabled, false);
assert.ok(!textContent(unread.tree).includes('合成知识设置读取失败'));
assert.equal(unreadServices.calls.settings, 0);
assert.equal(unreadServices.calls.process, 0);
const unsupportedServices = services();
unsupportedServices.knowledgeApi.isKnowledgeRagAvailable = () => false;
unsupportedServices.knowledgeApi.getKnowledgeSettings = async () => { throw new Error('must not read unavailable knowledge API'); };
const unsupported = harness('DocumentsView', unsupportedServices); await drain(); unsupported.render();
assert.ok(textContent(unsupported.tree).includes('当前环境无法读取知识层设置'));
assert.equal(byText(unsupported.tree, 'button', '关闭').props['aria-pressed'], false);
assert.equal(byText(unsupported.tree, 'button', '关闭').props.disabled, true);
const lifecycleServices = services();
let bridgeAvailable = true;
let lifecycleReads = 0;
const oldSettingsRead = deferred<any>();
const newSettingsRead = deferred<any>();
lifecycleServices.knowledgeApi.isKnowledgeRagAvailable = () => bridgeAvailable;
lifecycleServices.knowledgeApi.getKnowledgeSettings = () => (++lifecycleReads === 1 ? oldSettingsRead.promise : newSettingsRead.promise);
const lifecycle = harness('DocumentsView', lifecycleServices); await drain(); lifecycle.render();
bridgeAvailable = false; lifecycle.render();
assert.equal(byText(lifecycle.tree, 'button', '允许云端').props['aria-pressed'], false);
bridgeAvailable = true; lifecycle.render();
assert.equal(lifecycleReads, 2, 'a new bridge lifecycle starts a fresh read, not the prior pending request');
oldSettingsRead.resolve({ enabled: true, processingMode: 'allow-cloud' }); await drain(); lifecycle.render();
assert.equal(byText(lifecycle.tree, 'button', '允许云端').props['aria-pressed'], false, 'old lifecycle response cannot authorize a new bridge');
assert.equal(byText(lifecycle.tree, 'button', '仅本地').props.disabled, true, 'old finally cannot release the new read lock');
newSettingsRead.resolve({ enabled: true, processingMode: 'local-only' }); await drain(); lifecycle.render();
assert.equal(byText(lifecycle.tree, 'button', '仅本地').props['aria-pressed'], true);
assert.equal(byText(lifecycle.tree, 'button', '仅本地').props.disabled, false);

// Exercise the real shared focus hook against a tiny DOM model, not the
// registration mock above. This proves which physical layer owns Tab/Escape
// when preview (80) and confirmation (90) are mounted at the same time.
function checkPhysicalDialogFocus() {
  type Listener = (event: any) => void;
  const listeners = new Map<string, Listener[]>();
  const fakeDocument = {
    activeElement: null as FakeElement | null,
    addEventListener(type: string, callback: Listener) { listeners.set(type, [...listeners.get(type) || [], callback]); },
    removeEventListener(type: string, callback: Listener) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== callback)); },
  };
  const dispatch = (type: string, event: any) => {
    let stopped = false;
    const originalStop = event.stopImmediatePropagation;
    event.stopImmediatePropagation = () => { stopped = true; originalStop?.(); };
    for (const callback of listeners.get(type) || []) { callback(event); if (stopped) break; }
  };
  class FakeElement {
    parent: FakeElement | null = null;
    children: FakeElement[] = [];
    inert = false;
    isConnected = true;
    disabled = false;
    tabIndex = 0;
    constructor(readonly name: string, readonly button = false) {}
    add(...children: FakeElement[]) { children.forEach((child) => { child.parent = this; this.children.push(child); }); return this; }
    closest(selector: string): FakeElement | null { return selector === '[inert]' ? this.inert ? this : this.parent?.closest(selector) || null : null; }
    querySelectorAll() { return this.children.flatMap((child): FakeElement[] => [child, ...child.querySelectorAll()]).filter((child) => child.button && !child.disabled); }
    getClientRects() { return [1]; }
    contains(target: FakeElement | null): boolean { return Boolean(target && (target === this || this.children.some((child) => child.contains(target)))); }
    focus() { fakeDocument.activeElement = this; dispatch('focusin', { target: this }); }
  }
  let activeSlots: any[] = [];
  let cursor = 0;
  let pendingEffects: { index: number; effect: () => () => void }[] = [];
  const hookModule = { exports: {} as Record<string, any> };
  const hookSource = ts.transpileModule(readFileSync(resolve('src/components/useDialog.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(hookSource, {
    exports: hookModule.exports, module: hookModule,
    require(id: string) {
      assert.equal(id, 'react');
      return {
        useRef(value: unknown) { const index = cursor++; return activeSlots[index] ||= { current: value }; },
        useCallback(callback: () => void, deps: unknown[]) {
          const index = cursor++;
          if (!activeSlots[index]) activeSlots[index] = { value: callback, deps };
          return activeSlots[index].value;
        },
        useLayoutEffect(effect: () => () => void, deps: unknown[]) {
          const index = cursor++;
          if (!activeSlots[index] || !sameDeps(activeSlots[index].deps, deps)) { activeSlots[index] = { deps }; pendingEffects.push({ index, effect }); }
        },
      };
    },
    document: fakeDocument, HTMLElement: FakeElement,
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
  const mount = (element: FakeElement, initialClose: (() => void) | undefined, priority: number) => {
    const slots: any[] = [];
    const cleanups = new Map<number, () => void>();
    const ref = { current: element };
    const render = (onClose: (() => void) | undefined) => {
      activeSlots = slots; cursor = 0; pendingEffects = [];
      hookModule.exports.useDialog(true, ref, onClose, priority);
      pendingEffects.forEach(({ index, effect }) => { cleanups.get(index)?.(); cleanups.set(index, effect()); });
    };
    render(initialClose);
    return { render, unmount: () => cleanups.forEach((cleanup) => cleanup()) };
  };
  const key = (value: string, shiftKey = false) => {
    let prevented = false;
    dispatch('keydown', { key: value, shiftKey, preventDefault() { prevented = true; } });
    return prevented;
  };
  const origin = new FakeElement('row-trigger', true);
  const previewOverlay = new FakeElement('preview-overlay');
  const close = new FakeElement('close-preview', true);
  const reindex = new FakeElement('reindex', true);
  const open = new FakeElement('open-file', true);
  const previewElement = new FakeElement('preview').add(close, reindex, open);
  previewOverlay.add(previewElement);
  origin.focus();
  let previewCloses = 0;
  const previewLayer = mount(previewElement, () => { previewCloses += 1; }, 80);
  assert.equal(fakeDocument.activeElement, close);
  assert.ok(key('Tab', true)); assert.equal(fakeDocument.activeElement, open, 'Shift+Tab wraps inside the preview');
  assert.ok(key('Tab')); assert.equal(fakeDocument.activeElement, close);
  origin.focus(); assert.equal(fakeDocument.activeElement, close, 'programmatic background focus is reclaimed by the dialog');
  reindex.focus(); previewOverlay.inert = true;
  const cancel = new FakeElement('cancel', true);
  const confirm = new FakeElement('confirm', true);
  const confirmElement = new FakeElement('confirmation').add(cancel, confirm);
  let confirmationCloses = 0;
  const confirmationLayer = mount(confirmElement, () => { confirmationCloses += 1; }, 90);
  assert.equal(fakeDocument.activeElement, cancel);
  key('Escape');
  assert.equal(confirmationCloses, 1); assert.equal(previewCloses, 0, 'one Escape dismisses only the top physical layer');
  cancel.disabled = true; confirm.disabled = true;
  confirmationLayer.render(undefined);
  assert.ok(key('Escape')); assert.equal(confirmationCloses, 1, 'pending confirmation still owns Escape without closing');
  assert.ok(key('Tab')); assert.equal(fakeDocument.activeElement, confirmElement, 'a busy dialog with no enabled buttons keeps focus');
  cancel.disabled = false; confirm.disabled = false;
  confirmationLayer.render(() => { confirmationCloses += 1; });
  previewOverlay.inert = false;
  confirmElement.isConnected = false;
  confirmationLayer.unmount();
  assert.equal(fakeDocument.activeElement, reindex, 'closing the top layer returns focus to its preview trigger');
  assert.ok(key('Escape')); assert.equal(previewCloses, 1, 'the underlying preview resumes keyboard ownership');
  previewLayer.unmount();
  assert.equal(fakeDocument.activeElement, origin, 'closing the preview restores the original document control');
}
checkPhysicalDialogFocus();

console.log('Documents UI interactions passed: loading and filter states, import cancel/retry, operation locks, preview race/cancel, local errors, explicit delete/reindex confirmation, stale-read protection, dialog ownership, explicit knowledge processing. All services are memory mocks.');
