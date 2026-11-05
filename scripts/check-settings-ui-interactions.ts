import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type { LlmProvider, LlmSettings } from '../src/types';
import { createSettingsHydration } from '../src/services/ui/settingsHydration';
import { createSettingsPersistence } from '../src/services/ui/settingsPersistence';
import { agentExecutionModeSummary } from '../src/services/agent/executionPolicy';
import * as learningCapacity from '../src/services/learningCapacity';
import { normalizeMasteryTimeline } from '../src/services/learningAbility/timelineCompatibility';
import * as newProviderDraft from '../src/services/ui/newLlmProviderDraft';
import * as resourceCuration from '../src/services/resourceCuration';

// Run real handlers with synthetic hooks and isolated IPC/storage doubles.
// Never open a browser, load a real vault, contact a model, or write user data.
type Element = { type: unknown; props: Record<string, any> };
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
const nativeRequire = createRequire(import.meta.url);
function moduleFromSource(path: string, replacements: Record<string, any>, globals: Record<string, any> = {}) {
  const source = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  runInNewContext(source, {
    exports: module.exports, module, Date, Error, Set, Map, Math, Number, String, Boolean, Promise, structuredClone,
    require(id: string) {
      if (id in replacements) return replacements[id];
      if (id === '../services/agent/executionPolicy') return { agentExecutionModeSummary };
      if (id === './LearningCapacitySettings') return { LearningCapacitySettings: () => null }; // Tested with real isolated handlers below.
      if (id === './AgentExecutionSettings') return { AgentExecutionSettings: () => null }; // Actual slider is covered by the dedicated browser check.
      if (id === '../services/learningCapacity') return learningCapacity;
      if (id === '../services/resourceCuration') return resourceCuration;
      if (id === '../services/ui/newLlmProviderDraft') return newProviderDraft;
      if (id === '../services/llmStorage') return { hasUnsavedLlmSettings: () => false, flushLlmSettingsWrites: async () => {} };
      if (id === './NoteBackupPanel') return { NoteBackupPanel: () => null }; // Dedicated backup checks cover this real panel.
      if (id === 'react/jsx-runtime' || id === 'lucide-react') return nativeRequire(id);
      throw new Error(`Unexpected dependency in isolated settings check: ${id}`);
    },
    ...globals,
  });
  return module.exports;
}
function harness(path: string, exportName: string, props: Record<string, any>, replacements: Record<string, any>, windowDouble: Record<string, any>, globals: Record<string, any> = {}) {
  const originalModels = replacements['../services/llmStorage'];
  let modelCache: any = null;
  const modelWrites = originalModels && createSettingsPersistence(value => { modelCache = value; }, value => originalModels.saveLlmSettings(value));
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let effects: (() => void)[] = [];
  let tree: Element;
  const dialogs: { open: boolean; close?: () => void; priority: number }[] = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; changed = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(effect: () => void, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) { slots[index] = { deps }; effects.push(effect); }
    },
  };
  const module = moduleFromSource(path, {
    react: hooks,
    './useDialog': { useDialog(open: boolean, _ref: unknown, close?: () => void, priority = 50) { dialogs.push({ open, close, priority }); } },
    './AppSettingsFeedback': { AppSettingsFeedback: () => null },
    ...replacements,
    ...(replacements['../services/llmStorage'] ? { '../services/llmStorage': {
      getLlmSettingsLoadState: () => ({ status: 'ready', error: '' }), subscribeLlmSettingsLoad: () => () => {},
      ensureLlmSettingsLoaded: async () => replacements['../services/llmStorage'].loadLlmSettings(),
      retryLlmSettingsLoad: async () => replacements['../services/llmStorage'].loadLlmSettings(),
      ...originalModels,
      loadLlmSettings: () => modelWrites.getDraft() || modelCache || originalModels.loadLlmSettings(),
      saveLlmSettings: modelWrites.write, getLlmSettingsSaveState: modelWrites.getSnapshot,
      subscribeLlmSettingsSave: modelWrites.subscribe, retryLlmSettingsSave: modelWrites.retry,
    } } : {}),
  }, { window: windowDouble, document: { activeElement: null, body: {} }, ...globals });
  const render = () => {
    let passes = 0;
    do {
      changed = false; cursor = 0; effects = []; dialogs.length = 0;
      tree = module[exportName](props);
      effects.forEach((effect) => effect());
      assert.ok(++passes < 12, 'synthetic hooks must settle');
    } while (changed);
    return tree;
  };
  render();
  return { render, props, dialogs, get tree() { return tree; } };
}
function all(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...all(node.props.children)];
}
const textContent = (node: any): string => Array.isArray(node) ? node.map(textContent).join('')
  : node && typeof node === 'object' && node.props ? textContent(node.props.children)
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
function find(tree: Element, predicate: (node: Element) => boolean) {
  const match = all(tree).find(predicate);
  assert.ok(match, 'expected rendered control was not found');
  return match;
}
const button = (tree: Element, label: string) => find(tree, (node) => node.type === 'button' && textContent(node) === label);
const labelled = (tree: Element, label: string) => find(tree, (node) => node.props['aria-label'] === label);
const dialog = (tree: Element) => find(tree, (node) => node.props.role === 'dialog');
const hasDialog = (tree: Element) => all(tree).some((node) => node.props.role === 'dialog');
const event = (value = '') => ({ target: { value }, preventDefault() {}, stopPropagation() {} });
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
function deferred<T>() {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveValue = resolvePromise; rejectValue = rejectPromise; });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
const model: LlmProvider = { id: 'deepseek-default', name: '合成默认模型', apiType: 'openai-compatible', baseUrl: 'https://example.invalid', apiKey: '', models: ['synthetic'], selectedModel: 'synthetic', enabled: true, createdAt: '2026-10-06' };
const initialLlm = { providers: [model], defaultProviderId: model.id, workflowBinding: {} };
const container = { id: 'synthetic-auth', name: '合成网站', origin: 'https://example.invalid', partition: 'memory-only', createdAt: '2026-10-06', lastUsedAt: '2026-10-06' };
let chooser = deferred<string | null>();
let chooserCalls = 0;
let rootWrite = deferred<{ ok: boolean; error?: string }>();
const rootWrites: [string, boolean][] = [];
let resets = 0;
let removals = 0;
let removeResult = false;
let checkCalls = 0;
let check = deferred<{ ok: boolean; message?: string }>();
let downloadCalls = 0;
let download = deferred<{ ok: boolean; message?: string }>();
let installCalls = 0;
let installFailure = false;
let updaterPush: (value: any) => void = () => {};
let llmSaves = 0;
let save = deferred<void>();
let directoryCalls = 0;
let openDirectory = deferred<void>();
let recoveryCalls = 0;
let recovery = deferred<{ ok: boolean; recovered?: number; skipped?: number; canceled?: boolean; error?: string }>();
const MockLlmPanel = () => null;
const desktopWindow = { electronAPI: {
  storage: {
    recoverDocuments() { recoveryCalls++; return recovery.promise; },
    getRoot: async () => ({ root: 'C:\\synthetic-current', custom: false }),
    chooseFolder() { chooserCalls += 1; return chooser.promise; },
    setRoot(folder: string, migrate: boolean) { rootWrites.push([folder, migrate]); return rootWrite.promise; },
    reset: async () => { resets += 1; return { ok: true }; },
  },
  resourceBrowser: {
    listAuthContainers: async () => removals > 1 ? [] : [container],
    openAuthContainer: async () => ({ ok: true }),
    removeAuthContainer: async () => { removals += 1; return removeResult; },
  },
  updater: {
    getVersion: async () => 'synthetic',
    onStatus(callback: (payload: unknown) => void) { updaterPush = callback; return () => {}; },
    check() { checkCalls += 1; return check.promise; },
    download() { downloadCalls += 1; return download.promise; },
    quitAndInstall() { installCalls += 1; if (installFailure) throw new Error('合成重启失败'); },
  },
} };
{
  let current = structuredClone(initialLlm), saves = 0;
  let pending = deferred<typeof initialLlm>();
  const hydration = createSettingsHydration(() => pending.promise, value => { current = value; }, () => current);
  const loadingPage = harness('src/components/SettingsModal.tsx', 'SettingsModal', {
    settings: { fontSize: 16, resourceCollectionMode: 'review' }, notes: [],
    syncStatus: { statusText: '', isSyncing: false }, onUpdateSettings() {}, onTriggerSync() {},
  }, {
    './LlmSettingsPanel': { LlmSettingsPanel: MockLlmPanel },
    '../services/llmStorage': { loadLlmSettings: () => current, saveLlmSettings: async () => { saves++; },
      getLlmSettingsLoadState: hydration.getSnapshot, subscribeLlmSettingsLoad: hydration.subscribe,
      ensureLlmSettingsLoaded: () => hydration.load(), retryLlmSettingsLoad: () => hydration.load(true) },
  }, {}, { document: { activeElement: null, body: {} } });
  assert.ok(textContent(loadingPage.tree).includes('正在读取模型配置'));
  const locked = find(loadingPage.tree, node => node.type === 'fieldset' && all(node).some(child => child.type === MockLlmPanel));
  assert.equal(locked.props.disabled, true);
  await find(loadingPage.tree, node => node.type === MockLlmPanel).props.onUpdate(initialLlm);
  assert.equal(saves, 0, 'even a stale handler cannot write before hydration');
  pending.reject(new Error('synthetic read denied')); await tick(); loadingPage.render();
  assert.ok(all(loadingPage.tree).some(node => node.props.role === 'alert' && textContent(node).includes('无法读取模型配置')));
  assert.ok(button(loadingPage.tree, '重新读取模型配置'));
  pending = deferred();
  button(loadingPage.tree, '重新读取模型配置').props.onClick(); loadingPage.render();
  assert.ok(textContent(loadingPage.tree).includes('正在读取模型配置'));
  pending.resolve({ ...initialLlm, providers: [{ ...model, name: '读取后的合成模型' }] });
  await tick(); loadingPage.render();
  const panel = find(loadingPage.tree, node => node.type === MockLlmPanel);
  assert.equal(panel.props.llmSettings.providers[0].name, '读取后的合成模型');
  assert.equal(find(loadingPage.tree, node => node.type === 'fieldset' && all(node).some(child => child.type === MockLlmPanel)).props.disabled, false);
  await panel.props.onUpdate(current); assert.equal(saves, 1);
}
let appearanceUpdate: Record<string, unknown> | null = null;
const settingsPage = harness('src/components/SettingsModal.tsx', 'SettingsModal', {
  settings: { fontSize: 16, resourceCollectionMode: 'review' }, notes: [], syncStatus: { statusText: '', isSyncing: false },
  onUpdateSettings(value: Record<string, unknown>) { appearanceUpdate = value; }, onTriggerSync() { directoryCalls += 1; return openDirectory.promise; },
}, {
  './LlmSettingsPanel': { LlmSettingsPanel: MockLlmPanel },
  '../services/llmStorage': { loadLlmSettings: () => structuredClone(initialLlm), saveLlmSettings() { llmSaves += 1; return save.promise; } },
}, desktopWindow);
await tick(); settingsPage.render();
assert.equal(llmSaves, 0, 'opening settings is read-only');
assert.ok(!textContent(settingsPage.tree).includes('返回计划草稿'), 'ordinary settings visits do not invent a plan origin');
let returnedToPlan = 0;
settingsPage.props.onBack = () => returnedToPlan++;
settingsPage.props.backLabel = '返回计划草稿';
settingsPage.render();
button(settingsPage.tree, '返回计划草稿').props.onClick();
assert.equal(returnedToPlan, 1, 'the explicit return action preserves the caller-owned plan identity');
const fontInput = find(settingsPage.tree, (node) => node.props.id === 'settings-font-size');
const resourcePreference = find(settingsPage.tree, node => node.props.id === 'resource-format-preference');
assert.equal(resourcePreference.props.value, 'adaptive');
assert.ok(all(settingsPage.tree).some(node => node.type === 'label' && node.props.htmlFor === resourcePreference.props.id));
resourcePreference.props.onChange({ target: { value: 'video' } });
assert.equal(appearanceUpdate?.resourceFormatPreference, 'video');
resourcePreference.props.onChange({ target: { value: 'invalid' } });
assert.equal(appearanceUpdate?.resourceFormatPreference, 'adaptive');
assert.ok(all(settingsPage.tree).some((node) => node.type === 'label' && node.props.htmlFor === fontInput.props.id));
const accentInputs = all(settingsPage.tree).filter((node) => node.type === 'input' && node.props.name === 'settings-accent');
assert.equal(accentInputs.length, 8, 'all supported theme colors are user-selectable');
assert.equal(accentInputs.find((node) => node.props.value === 'emerald')?.props.checked, true, 'missing legacy accent falls back visibly to the default green');
accentInputs.find((node) => node.props.value === 'emerald')?.props.onChange();
assert.equal(appearanceUpdate?.accentColor, 'emerald', 'the green theme can be restored without the Agent');
const customAccentInput = find(settingsPage.tree, node => node.props.id === 'settings-custom-accent');
assert.equal(customAccentInput.props.type, 'color');
assert.ok(all(settingsPage.tree).some(node => node.type === 'label' && node.props.htmlFor === customAccentInput.props.id));
customAccentInput.props.onChange({ target: { value: '#aabbcc' } });
assert.equal(appearanceUpdate?.accentColor, '#AABBCC', 'custom colors use the same persisted settings update as presets and Agent changes');
settingsPage.props.settings = { ...settingsPage.props.settings, accentColor: '#AABBCC' };
settingsPage.render();
assert.equal(find(settingsPage.tree, node => node.props.id === 'settings-custom-accent').props.value, '#AABBCC');
settingsPage.props.appSettingsState = { loadState: 'error', saveState: 'idle', loadError: 'denied', saveError: '' };
settingsPage.render();
const lockedPreferences = find(settingsPage.tree, node => node.type === 'fieldset' && Boolean(node.props.disabled));
assert.ok(all(lockedPreferences).some(node => node.props.id === 'settings-font-size'));
assert.ok(all(lockedPreferences).some(node => node.props.name === 'settings-resource-mode'), 'resource authorization cannot change before settings load');
settingsPage.props.appSettingsState = { loadState: 'ready', saveState: 'saving', loadError: '', saveError: '' };
settingsPage.render();
assert.equal(button(settingsPage.tree, '选择存储文件夹').props.disabled, true);
await button(settingsPage.tree, '选择存储文件夹').props.onClick(); assert.equal(chooserCalls, 0);
button(settingsPage.tree, '清空所有数据（恢复初始化）').props.onClick(); settingsPage.render(); assert.equal(hasDialog(settingsPage.tree), false);
settingsPage.props.appSettingsState = undefined; settingsPage.render();
assert.equal(all(settingsPage.tree).filter((node) => node.type === 'input' && node.props.name === 'settings-resource-mode').length, 2, 'resource selection uses native keyboard-operable radio inputs');

let chooseButton = button(settingsPage.tree, '选择存储文件夹');
let pickerFocus = 0;
const pickerOrigin = { isConnected: true, disabled: false, closest: () => null, focus: () => { pickerFocus += 1; } };
const pendingChoice = chooseButton.props.onClick({ currentTarget: pickerOrigin }); chooseButton.props.onClick();
assert.equal(chooserCalls, 1, 'folder picker locks before its first await');
settingsPage.render();
assert.equal(button(settingsPage.tree, '正在选择文件夹…').props.disabled, true);
chooser.resolve(null); await pendingChoice; settingsPage.render();
assert.equal(pickerFocus, 1, 'native picker cancellation restores its trigger after loading unlocks');
assert.equal(rootWrites.length, 0); assert.ok(!hasDialog(settingsPage.tree), 'picker cancellation does not mutate the root');
chooser = deferred(); chooser.resolve('D:\\synthetic-target');
await button(settingsPage.tree, '选择存储文件夹').props.onClick({ currentTarget: pickerOrigin }); settingsPage.render();
assert.equal(dialog(settingsPage.tree).props['aria-modal'], 'true');
assert.ok(settingsPage.dialogs.some((item) => item.open && item.close && item.priority === 60));
assert.ok(all(settingsPage.tree).some((node) => node.props.inert === true));
button(dialog(settingsPage.tree), '取消').props.onClick(); settingsPage.render();
assert.equal(pickerFocus, 2, 'closing an async storage confirmation restores the picker trigger');
assert.equal(rootWrites.length, 0, 'Cancel never selects the no-migration branch');
await button(settingsPage.tree, '选择存储文件夹').props.onClick(); settingsPage.render();
settingsPage.dialogs.find((item) => item.open)!.close!(); settingsPage.render();
assert.equal(rootWrites.length, 0, 'Escape cancellation is also read-only');
await button(settingsPage.tree, '选择存储文件夹').props.onClick(); settingsPage.render();
const confirm = button(dialog(settingsPage.tree), '确认更改路径');
const pendingRoot = confirm.props.onClick(); confirm.props.onClick();
assert.equal(rootWrites.length, 1); assert.deepEqual(rootWrites[0], ['D:\\synthetic-target', true]);
settingsPage.render();
assert.equal(dialog(settingsPage.tree).props['aria-busy'], true);
assert.equal(button(dialog(settingsPage.tree), '取消').props.disabled, true);
assert.ok(settingsPage.dialogs.some((item) => item.open && !item.close), 'pending write owns Escape without dismissal');
const backdrop = find(settingsPage.tree, (node) => node.props.className?.includes('settings-confirmation-backdrop'));
backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop }); settingsPage.render();
assert.ok(hasDialog(settingsPage.tree), 'pending write cannot be dismissed via the backdrop');
rootWrite.resolve({ ok: false, error: '合成迁移失败' }); await pendingRoot; settingsPage.render();
assert.ok(textContent(dialog(settingsPage.tree)).includes('D:\\synthetic-target'));
assert.equal(textContent(find(dialog(settingsPage.tree), (node) => node.props.role === 'alert')), '合成迁移失败');
find(dialog(settingsPage.tree), (node) => node.type === 'input' && node.props.name === 'storage-migration' && !node.props.checked).props.onChange();
settingsPage.render(); rootWrite = deferred();
const retriedRoot = button(dialog(settingsPage.tree), '重试').props.onClick();
assert.deepEqual(rootWrites[1], ['D:\\synthetic-target', false], 'no migration requires an explicit option and confirmation');
rootWrite.resolve({ ok: true }); await retriedRoot; settingsPage.render();
assert.ok(!hasDialog(settingsPage.tree));
assert.ok(textContent(settingsPage.tree).includes('当前路径：C:\\synthetic-current'));
assert.ok(textContent(settingsPage.tree).includes('下次启动使用：D:\\synthetic-target'), 'active and next-start paths are not confused');

button(settingsPage.tree, '清空所有数据（恢复初始化）').props.onClick(); settingsPage.render();
button(dialog(settingsPage.tree), '取消').props.onClick(); settingsPage.render(); assert.equal(resets, 0);
button(settingsPage.tree, '清空所有数据（恢复初始化）').props.onClick(); settingsPage.render();
const resetButton = button(dialog(settingsPage.tree), '确认清空所有数据');
const pendingReset = resetButton.props.onClick(); resetButton.props.onClick();
await pendingReset; settingsPage.render(); assert.equal(resets, 1, 'reset confirmation submits one synthetic write');
labelled(settingsPage.tree, '删除 合成网站 的登录数据').props.onClick(); settingsPage.render();
button(dialog(settingsPage.tree), '取消').props.onClick(); settingsPage.render(); assert.equal(removals, 0);
labelled(settingsPage.tree, '删除 合成网站 的登录数据').props.onClick(); settingsPage.render();
await button(dialog(settingsPage.tree), '确认删除登录数据').props.onClick(); settingsPage.render();
assert.ok(hasDialog(settingsPage.tree), 'failed login-data removal leaves confirmation available');
removeResult = true; await button(dialog(settingsPage.tree), '重试').props.onClick(); settingsPage.render();
assert.ok(!hasDialog(settingsPage.tree));

const directoryButton = button(settingsPage.tree, '打开目录');
const directoryPending = directoryButton.props.onClick(); directoryButton.props.onClick(); assert.equal(directoryCalls, 1);
openDirectory.reject(new Error('合成目录打开失败')); await directoryPending; settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('合成目录打开失败'));
openDirectory = deferred(); const directoryRetry = button(settingsPage.tree, '打开目录').props.onClick();
settingsPage.props.syncStatus = { statusText: '打开数据目录失败', isSyncing: false };
openDirectory.resolve(); await directoryRetry; settingsPage.render();
assert.ok(all(settingsPage.tree).some((node) => node.props.role === 'alert' && textContent(node) === '打开数据目录失败'), 'parent status remains visible when its callback handles the rejection itself');

const recoveryButton = button(settingsPage.tree, '扫描并恢复');
const recoveryPending = recoveryButton.props.onClick(); recoveryButton.props.onClick();
assert.equal(recoveryCalls, 1, 'repeated clicks never launch duplicate recovery IPC');
settingsPage.render();
assert.equal(button(settingsPage.tree, '正在扫描或补录…').props['aria-busy'], true);
assert.equal(button(settingsPage.tree, '选择存储文件夹').props.disabled, true);
assert.equal(button(settingsPage.tree, '清空所有数据（恢复初始化）').props.disabled, true);
recovery.resolve({ ok: true, canceled: true }); await recoveryPending; settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('已取消，未修改资料清单'));
recovery = deferred(); const recoveryRetry = button(settingsPage.tree, '扫描并恢复').props.onClick();
recovery.resolve({ ok: false, error: '合成清单损坏，未覆盖' }); await recoveryRetry; settingsPage.render();
assert.ok(all(settingsPage.tree).some(node => node.props.role === 'alert' && textContent(node).includes('合成清单损坏')));
recovery = deferred(); const recoverySuccess = button(settingsPage.tree, '扫描并恢复').props.onClick();
recovery.resolve({ ok: true, recovered: 2 }); await recoverySuccess; settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('已补录 2 个文件'));
assert.ok(textContent(settingsPage.tree).includes('索引未自动启动'));
assert.ok(textContent(settingsPage.tree).includes('rag-index/'));
assert.equal(button(settingsPage.tree, '扫描并恢复').props.disabled, false);

const checkButton = button(settingsPage.tree, '检查更新');
const pendingCheck = checkButton.props.onClick(); checkButton.props.onClick(); assert.equal(checkCalls, 1);
check.reject(new Error('合成更新检查失败')); await pendingCheck; settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('合成更新检查失败'));
check = deferred(); const retryCheck = button(settingsPage.tree, '检查更新').props.onClick();
check.resolve({ ok: true, message: '合成检查完成' }); await retryCheck; settingsPage.render();
assert.equal(button(settingsPage.tree, '检查更新').props.disabled, false, 'a successful check can settle even without an IPC status push');
updaterPush({ state: 'available', version: 'synthetic-next' }); settingsPage.render();
const downloadButton = button(settingsPage.tree, '下载更新');
const pendingDownload = downloadButton.props.onClick(); downloadButton.props.onClick(); assert.equal(downloadCalls, 1);
download.reject(new Error('合成下载失败')); await pendingDownload; settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('合成下载失败'));
updaterPush({ state: 'downloaded' }); settingsPage.render();
installFailure = true; await button(settingsPage.tree, '重启安装').props.onClick(); settingsPage.render();
assert.ok(textContent(settingsPage.tree).includes('合成重启失败'));
assert.equal(button(settingsPage.tree, '重启安装').props.disabled, false, 'installation failure keeps the downloaded update available for retry');
installFailure = false;
const installButton = button(settingsPage.tree, '重启安装');
await installButton.props.onClick(); await installButton.props.onClick(); assert.equal(installCalls, 2);

const nextLlm = { ...initialLlm, providers: [{ ...model, selectedModel: '保留输入' }] };
const panel = find(settingsPage.tree, (node) => node.type === MockLlmPanel);
const pendingLlm = panel.props.onUpdate(nextLlm); settingsPage.render();
assert.equal(labelled(settingsPage.tree, 'AI 模型配置').props['aria-busy'], true);
assert.equal(button(settingsPage.tree, '清空所有数据（恢复初始化）').props.disabled, true, 'reset cannot race an in-flight model file save');
button(settingsPage.tree, '清空所有数据（恢复初始化）').props.onClick(); settingsPage.render();
assert.ok(!hasDialog(settingsPage.tree), 'the pending-save guard also protects a stale click handler');
save.reject(new Error('合成写盘失败')); await pendingLlm; settingsPage.render();
assert.equal(find(settingsPage.tree, (node) => node.type === MockLlmPanel).props.llmSettings.providers[0].selectedModel, '保留输入');
assert.ok(textContent(settingsPage.tree).includes('模型配置未能保存'));
save = deferred(); const llmRetry = button(settingsPage.tree, '重试保存模型配置').props.onClick();
save.resolve(); await llmRetry; settingsPage.render(); assert.equal(llmSaves, 2);
assert.ok(textContent(settingsPage.tree).includes('模型配置已保存到本机'));
const olderSave = deferred<void>(); save = olderSave;
const olderPending = find(settingsPage.tree, (node) => node.type === MockLlmPanel).props.onUpdate(nextLlm);
await tick();
const newerSave = deferred<void>(); save = newerSave;
const latestLlm = { ...nextLlm, providers: [{ ...model, selectedModel: '较新的输入' }] };
const newerPending = find(settingsPage.tree, (node) => node.type === MockLlmPanel).props.onUpdate(latestLlm);
olderSave.reject(new Error('过期的保存错误')); await olderPending; settingsPage.render();
assert.ok(!textContent(settingsPage.tree).includes('过期的保存错误'), 'older outcomes cannot replace the current saving feedback');
newerSave.resolve(); await newerPending; settingsPage.render();
assert.equal(find(settingsPage.tree, (node) => node.type === MockLlmPanel).props.llmSettings.providers[0].selectedModel, '较新的输入');

// A newly mounted settings panel must recover the in-progress form, without
// committing its incomplete provider or adding another credential cache.
newProviderDraft.clearNewLlmProviderDraft();
let incompleteProviderWrites = 0, draftStorageWrites = 0;
const draftWindow = { localStorage: { setItem() { draftStorageWrites++; } }, sessionStorage: { setItem() { draftStorageWrites++; } } };
const draftProps = { llmSettings: structuredClone(initialLlm), onUpdate() { incompleteProviderWrites++; } };
const draftPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', draftProps, {}, draftWindow);
button(draftPanel.tree, '添加供应商').props.onClick(); draftPanel.render();
for (const [id, value] of [['llm-new-name', '切页中的模型草稿'], ['llm-new-url', 'https://draft.invalid/v1'], ['llm-new-model', 'Draft-Model'], ['llm-new-key', 'synthetic-unsaved-key']]) {
  find(draftPanel.tree, node => node.props.id === id).props.onChange(event(value)); draftPanel.render();
}
find(draftPanel.tree, node => node.props.id === 'llm-context-new').props.onChange(event('409')); draftPanel.render();
const returnedPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', draftProps, {}, draftWindow);
for (const [id, value] of [['llm-new-name', '切页中的模型草稿'], ['llm-new-url', 'https://draft.invalid/v1'], ['llm-new-model', 'Draft-Model'], ['llm-new-key', 'synthetic-unsaved-key'], ['llm-context-new', '409']]) {
  assert.equal(find(returnedPanel.tree, node => node.props.id === id).props.value, value, 'new panel restores the same unfinished field: ' + id);
}
assert.equal(incompleteProviderWrites, 0, 'navigation cannot activate or save an incomplete model route');
assert.equal(draftStorageWrites, 0, 'unsubmitted keys never enter localStorage or sessionStorage');
button(returnedPanel.tree, '取消').props.onClick(); returnedPanel.render();
assert.equal(newProviderDraft.readNewLlmProviderDraft().open, false);
assert.equal(newProviderDraft.readNewLlmProviderDraft().provider.apiKey, undefined);
const cancelledPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', draftProps, {}, draftWindow);
assert.ok(!all(cancelledPanel.tree).some(node => node.props['aria-label'] === '添加模型供应商'), 'explicit cancel removes the session draft');
button(cancelledPanel.tree, '添加供应商').props.onClick(); cancelledPanel.render();
assert.equal(find(cancelledPanel.tree, node => node.props.id === 'llm-new-key').props.value, '');
assert.equal(find(cancelledPanel.tree, node => node.props.id === 'llm-context-new').props.value, '');
button(cancelledPanel.tree, '取消').props.onClick(); cancelledPanel.render();

const staleDraftModels = deferred<{ ok: boolean; models: string[] }>();
const currentDraftModels = deferred<{ ok: boolean; models: string[] }>();
let draftModelCalls = 0;
const discoveryDraft = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', draftProps, {}, {
  electronAPI: { llm: { models() { return ++draftModelCalls === 1 ? staleDraftModels.promise : currentDraftModels.promise; } } },
});
const fillDiscoveryDraft = () => {
  button(discoveryDraft.tree, '添加供应商').props.onClick(); discoveryDraft.render();
  for (const [id, value] of [['llm-new-name', '同地址重填'], ['llm-new-url', 'https://same-draft.invalid'], ['llm-new-key', 'same-synthetic-key']]) {
    find(discoveryDraft.tree, node => node.props.id === id).props.onChange(event(value)); discoveryDraft.render();
  }
};
fillDiscoveryDraft(); button(discoveryDraft.tree, '获取模型').props.onClick(); discoveryDraft.render();
button(discoveryDraft.tree, '取消').props.onClick(); discoveryDraft.render();

const changedDraftReplies = [deferred<{ ok: boolean; models: string[] }>(), deferred<{ ok: boolean; models: string[] }>(), deferred<{ ok: boolean; models: string[] }>()];
const changedDraftRequests: any[] = [];
const changedDraft = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', draftProps, {}, {
  electronAPI: { llm: { models(request: any) { changedDraftRequests.push(request); return changedDraftReplies[changedDraftRequests.length - 1].promise; } } },
});
button(changedDraft.tree, '添加供应商').props.onClick(); changedDraft.render();
find(changedDraft.tree, node => node.props.id === 'llm-new-url').props.onChange(event('https://before-change.invalid')); changedDraft.render();
button(changedDraft.tree, '获取模型').props.onClick(); changedDraft.render();
find(changedDraft.tree, node => node.props.id === 'llm-new-url').props.onChange(event('https://after-change.invalid')); changedDraft.render();
changedDraftReplies[0].resolve({ ok: true, models: ['wrong-endpoint-model'] }); await tick(); changedDraft.render();
assert.ok(!button(changedDraft.tree, '获取模型').props.disabled, 'a stale endpoint result still releases its own busy state');
assert.equal(find(changedDraft.tree, node => node.props.id === 'llm-new-model').props.value, '');
button(changedDraft.tree, '获取模型').props.onClick(); changedDraft.render();
assert.equal(changedDraftRequests[1].provider.baseUrl, 'https://after-change.invalid');
find(changedDraft.tree, node => node.props.id === 'llm-new-key').props.onChange(event('edited-synthetic-key')); changedDraft.render();
changedDraftReplies[1].reject(new Error('stale credential error')); await tick(); changedDraft.render();
assert.ok(!button(changedDraft.tree, '获取模型').props.disabled, 'a failed request with an edited key also releases its spinner');
assert.ok(!textContent(changedDraft.tree).includes('stale credential error'), 'a stale failure does not invalidate the replacement credentials');
button(changedDraft.tree, '获取模型').props.onClick(); changedDraft.render();
assert.equal(changedDraftRequests[2].provider.apiKey, 'edited-synthetic-key');
changedDraftReplies[2].resolve({ ok: true, models: ['fresh-endpoint-model'] }); await tick(); changedDraft.render();
assert.equal(find(changedDraft.tree, node => node.props.id === 'llm-new-model').props.value, 'fresh-endpoint-model');
button(changedDraft.tree, '取消').props.onClick(); changedDraft.render();
fillDiscoveryDraft(); assert.ok(!button(discoveryDraft.tree, '获取模型').props.disabled, 'cancel releases the old discovery busy state');
button(discoveryDraft.tree, '获取模型').props.onClick(); discoveryDraft.render(); assert.equal(draftModelCalls, 2);
staleDraftModels.resolve({ ok: true, models: ['stale-draft-model'] }); await tick(); discoveryDraft.render();
assert.equal(find(discoveryDraft.tree, node => node.props.id === 'llm-new-model').props.value, '', 'late discovery cannot repopulate a cancelled draft, even with the same credentials');
currentDraftModels.resolve({ ok: true, models: ['current-draft-model'] }); await tick(); discoveryDraft.render();
assert.equal(find(discoveryDraft.tree, node => node.props.id === 'llm-new-model').props.value, 'current-draft-model');
find(discoveryDraft.tree, node => node.props.id === 'llm-new-model').props.onChange(event('')); discoveryDraft.render();
labelled(discoveryDraft.tree, '添加模型供应商').props.onSubmit(event()); discoveryDraft.render();
assert.equal(incompleteProviderWrites, 0, 'Enter-style form submission cannot restore a discovered model after its selected name was explicitly cleared');
assert.equal(find(discoveryDraft.tree, node => node.props.id === 'llm-new-model').props.value, '', 'rejecting the empty model keeps the editable draft');
button(discoveryDraft.tree, '取消').props.onClick(); discoveryDraft.render();

let providerUpdates = 0;
let providerValue = structuredClone(initialLlm);
let probeCalls = 0;
const probe = deferred<boolean>();
const providerPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', {
  llmSettings: providerValue,
  onUpdate(value: any) { providerUpdates += 1; providerValue = value; providerPanel.props.llmSettings = value; },
}, {}, { electronAPI: { llm: { probe() { probeCalls += 1; return probe.promise; } } } });
button(providerPanel.tree, '添加供应商').props.onClick(); providerPanel.render();
find(providerPanel.tree, (node) => node.props.id === 'llm-new-name').props.onChange(event('取消这条输入'));
providerPanel.render(); button(providerPanel.tree, '取消').props.onClick(); providerPanel.render();
button(providerPanel.tree, '添加供应商').props.onClick(); providerPanel.render();
assert.equal(find(providerPanel.tree, (node) => node.props.id === 'llm-new-name').props.value, '', 'cancel discards the new-provider draft');
assert.equal(button(providerPanel.tree, '添加').props.disabled, true);
for (const [id, value] of [['llm-new-name', '合成新模型'], ['llm-new-url', 'https://example.invalid'], ['llm-new-model', 'synthetic']]) {
  find(providerPanel.tree, (node) => node.props.id === id).props.onChange(event(value)); providerPanel.render();
}
find(providerPanel.tree, node => node.props.id === 'llm-context-new').props.onChange(event('409')); providerPanel.render();
labelled(providerPanel.tree, '添加模型供应商').props.onSubmit(event()); providerPanel.render();
assert.equal(providerUpdates, 0, 'submit validates raw context text before accepting a provider');
assert.equal(find(providerPanel.tree, node => node.props.id === 'llm-context-new').props.value, '409', 'failed submit keeps the entered draft');
find(providerPanel.tree, node => node.props.id === 'llm-context-new').props.onChange(event('65536')); providerPanel.render();
const addForm = labelled(providerPanel.tree, '添加模型供应商'); addForm.props.onSubmit(event()); addForm.props.onSubmit(event());
assert.equal(providerUpdates, 1, 'double add submits one provider'); providerPanel.render();
assert.equal(providerValue.providers[1].contextWindowTokens, 65536, 'Enter-style submit commits the focused numeric draft without a blur');
assert.equal(newProviderDraft.readNewLlmProviderDraft().open, false, 'an accepted provider clears the transient form draft');
assert.equal(newProviderDraft.readNewLlmProviderDraft().provider.selectedModel, undefined);
const testButton = labelled(providerPanel.tree, '测试 合成默认模型 模型');
const pendingProbe = testButton.props.onClick(); testButton.props.onClick(); assert.equal(probeCalls, 1);
providerPanel.render(); assert.equal(labelled(providerPanel.tree, '测试 合成默认模型 模型').props.disabled, true);
probe.resolve(false); await pendingProbe; providerPanel.render();
assert.ok(textContent(providerPanel.tree).includes('模型测试失败，请检查'));
const addedProvider = providerValue.providers[1];
providerPanel.props.llmSettings = { ...providerValue, workflowBinding: { 'agent-chat': addedProvider.id }, defaultProviderId: addedProvider.id };
providerPanel.render(); labelled(providerPanel.tree, '删除模型供应商 合成新模型').props.onClick(); providerPanel.render();
assert.ok(all(providerPanel.tree).some(node => node.props.role === 'alertdialog'), 'provider deletion uses the themed in-app confirmation dialog');
assert.ok(textContent(providerPanel.tree).includes('同时解除 1 项工作流绑定'), 'confirmation states the binding impact before deletion');
assert.equal(providerUpdates, 1, 'opening the confirmation preserves provider settings');
button(providerPanel.tree, '取消').props.onClick(); providerPanel.render();
assert.ok(!all(providerPanel.tree).some(node => node.props.role === 'alertdialog'), 'cancelling closes the confirmation without deleting');
assert.equal(providerUpdates, 1, 'cancelled deletion preserves provider settings');
labelled(providerPanel.tree, '删除模型供应商 合成新模型').props.onClick(); providerPanel.render();
button(providerPanel.tree, '删除供应商').props.onClick(); providerPanel.render();
assert.equal(providerValue.providers.length, 1); assert.equal(providerValue.workflowBinding['agent-chat'], undefined);
assert.equal(providerValue.defaultProviderId, model.id, 'removal cannot leave a dangling default or binding');

// Test the actual panel through controlled props and delayed probe doubles.
// Editing invalidates result identity but never unlocks an unfinished request.
const longProviderName = 'SyntheticProviderWithoutSpaces'.repeat(7);
const longModelName = 'synthetic-model-identifier-'.repeat(9);
const guardedProvider = { ...model, id: 'guarded-provider', name: longProviderName, selectedModel: longModelName, models: [longModelName] };
const disabledProvider = { ...model, id: 'disabled-provider', name: '合成停用模型', enabled: false };
let guardedValue: LlmSettings = { ...initialLlm, providers: [guardedProvider, disabledProvider], workflowBinding: {
  'document-knowledge-extract': guardedProvider.id,
  'argument-quality-review': disabledProvider.id,
  'logic-check': disabledProvider.id,
  'agent-chat': 'missing-provider',
} };
type ProbeReply = boolean | { ok: boolean; model: string; error?: string; code?: string };
let guardedProbe = deferred<ProbeReply>();
const probeConfigurations: any[] = [];
const providerDiscoveryReplies: ReturnType<typeof deferred<{ ok: boolean; models: string[] }>>[] = [];
const guardedPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', {
  llmSettings: guardedValue,
  onUpdate(value: any) { guardedValue = value; guardedPanel.props.llmSettings = value; },
}, {}, { electronAPI: { llm: {
  probe(configuration: any) { probeConfigurations.push(configuration); return guardedProbe.promise; },
  models() { const reply = deferred<{ ok: boolean; models: string[] }>(); providerDiscoveryReplies.push(reply); return reply.promise; },
} } });
const groupSelect = labelled(guardedPanel.tree, 'RAG 知识抽取的模型供应商');
assert.equal(groupSelect.props.value, '__mixed__', 'the first binding cannot impersonate all workflows in a mixed group');
assert.ok(all(groupSelect).some(node => node.type === 'option' && node.props.value === '__mixed__' && node.props.disabled && textContent(node) === '分项使用不同模型'));
const disabledSelect = labelled(guardedPanel.tree, '逻辑检查的模型供应商');
assert.equal(disabledSelect.props.value, disabledProvider.id);
assert.ok(all(disabledSelect).some(node => node.type === 'option' && node.props.value === disabledProvider.id && node.props.disabled && textContent(node).includes('已停用')), 'a disabled binding is displayed truthfully instead of visually falling back to no selection');
const missingSelect = labelled(guardedPanel.tree, 'Agent 学习助手的模型供应商');
assert.equal(missingSelect.props.value, 'missing-provider');
assert.ok(all(missingSelect).some(node => node.type === 'option' && node.props.value === 'missing-provider' && node.props.disabled && textContent(node).includes('已移除')), 'a missing binding also keeps a visible, identifiable state');
for (const value of [longProviderName, longModelName]) {
  const content = find(guardedPanel.tree, node => node.type === 'span' && textContent(node) === value);
  assert.ok(content.props.className.includes('min-w-0') && content.props.className.includes('max-w-full') && content.props.className.includes('[overflow-wrap:anywhere]'), 'rendered unbroken identifiers have intrinsic-width constraints and can wrap');
}
groupSelect.props.onChange(event(guardedProvider.id)); guardedPanel.render();
assert.equal(guardedValue.workflowBinding['document-knowledge-extract'], guardedProvider.id);
assert.equal(guardedValue.workflowBinding['argument-quality-review'], guardedProvider.id);
assert.equal(labelled(guardedPanel.tree, 'RAG 知识抽取的模型供应商').props.value, guardedProvider.id, 'explicit group selection intentionally replaces the mixed bindings');

labelled(guardedPanel.tree, `编辑 ${longProviderName} 配置`).props.onClick(); guardedPanel.render();
const modelInput = () => find(guardedPanel.tree, node => node.props.id === 'llm-model-guarded-provider');
modelInput().props.onChange(event('')); guardedPanel.render();
assert.equal(modelInput().props.value, '', 'deleting an existing model stays empty instead of repopulating the legacy model list');
assert.equal(guardedValue.providers[0].selectedModel, '');
assert.equal(labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.disabled, true, 'an explicit blank cannot test the previous model from the suggestion list');
const beforeEmptyProbe = probeConfigurations.length;
await labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick(); guardedPanel.render();
assert.equal(probeConfigurations.length, beforeEmptyProbe, 'even a stale test handler cannot send an empty model');
assert.match(textContent(guardedPanel.tree), /请先填写要测试的模型名称/);
modelInput().props.onChange(event('replacement')); guardedPanel.render();
assert.equal(modelInput().props.value, 'replacement', 'replacement input starts from empty without appending the previous name');
const originalBindings = JSON.stringify(guardedValue.workflowBinding), originalDefault = guardedValue.defaultProviderId;
find(guardedPanel.tree, node => node.props.id === 'llm-url-guarded-provider').props.onChange(event('')); guardedPanel.render();
assert.equal(find(guardedPanel.tree, node => node.props.id === 'llm-url-guarded-provider').props.value, '', 'address can be cleared while retyping');
find(guardedPanel.tree, node => node.props.id === 'llm-url-guarded-provider').props.onChange(event('http://127.0.0.1:11434')); guardedPanel.render();
find(guardedPanel.tree, node => node.props.id === 'llm-type-guarded-provider').props.onChange(event('ollama')); guardedPanel.render();
find(guardedPanel.tree, node => node.props.id === 'llm-name-guarded-provider').props.onChange(event('更正后的供应商')); guardedPanel.render();
assert.equal(guardedValue.providers[0].id, guardedProvider.id);
assert.equal(guardedValue.providers[0].baseUrl, 'http://127.0.0.1:11434');
assert.equal(guardedValue.providers[0].apiType, 'ollama');
assert.equal(guardedValue.providers[0].name, '更正后的供应商');
assert.equal(JSON.stringify(guardedValue.workflowBinding), originalBindings, 'editing a provider retains all workflow bindings');
assert.equal(guardedValue.defaultProviderId, originalDefault, 'editing a provider retains its default identity');
find(guardedPanel.tree, node => node.props.id === 'llm-name-guarded-provider').props.onChange(event(longProviderName)); guardedPanel.render();
const contextInput = () => find(guardedPanel.tree, node => node.props.id === `llm-context-${guardedProvider.id}`);
assert.equal(contextInput().props.min, 4096);
assert.ok(contextInput().props['aria-describedby'].includes(`llm-context-help-${guardedProvider.id}`));
contextInput().props.onChange(event('32768')); guardedPanel.render();
contextInput().props.onBlur(event('32768')); guardedPanel.render();
assert.equal((guardedValue.providers[0] as any).contextWindowTokens, 32768, 'valid scene window is saved without altering model routing');
contextInput().props.onChange(event('1')); guardedPanel.render();
contextInput().props.onBlur(event('1')); guardedPanel.render();
assert.equal((guardedValue.providers[0] as any).contextWindowTokens, 32768, 'invalid window cannot overwrite a valid setting');
assert.equal(contextInput().props['aria-invalid'], true);
assert.ok(all(guardedPanel.tree).some(node => node.props.id === `llm-context-error-${guardedProvider.id}` && node.props.role === 'alert'));
contextInput().props.onChange(event('')); guardedPanel.render();
contextInput().props.onBlur(event('')); guardedPanel.render();
assert.equal((guardedValue.providers[0] as any).contextWindowTokens, undefined, 'clearing restores the explicitly described local fallback budget');
const staleProbeButton = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`);
const staleProbePending = staleProbeButton.props.onClick();
find(guardedPanel.tree, node => node.props.id === 'llm-model-guarded-provider').props.onChange(event('changed-model-before-old-result'));
guardedPanel.render();
assert.equal(labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.disabled, true, 'editing clears status without falsely enabling the still-pending probe');
assert.ok(textContent(guardedPanel.tree).includes('配置已更改，等待此前测试结束'));
staleProbeButton.props.onClick(); assert.equal(probeConfigurations.length, 1, 'a stale click cannot create a concurrent probe');
guardedProbe.resolve(true); await staleProbePending; guardedPanel.render();
assert.ok(!textContent(guardedPanel.tree).includes('模型测试成功'), 'an old model result does not validate the edited model');
assert.equal(labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.disabled, false);

guardedProbe = deferred();
const currentProbe = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
assert.equal(probeConfigurations[1].provider.selectedModel, 'changed-model-before-old-result');
guardedProbe.resolve({ ok: true, model: 'changed-model-before-old-result' }); await currentProbe; guardedPanel.render();
assert.ok(textContent(guardedPanel.tree).includes('模型测试成功'), 'only the current configuration receives its successful probe result');
guardedProbe = deferred();
const rejectedModel = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
guardedProbe.resolve({ ok: false, model: 'changed-model-before-old-result', code: 'model', error: '模型不存在或当前账号无权访问（HTTP 404）。' });
await rejectedModel; guardedPanel.render();
assert.ok(!textContent(guardedPanel.tree).includes('模型测试成功'), 'a structured failure is not mistaken for truthy object success');
assert.match(textContent(guardedPanel.tree), /模型不存在或当前账号无权访问/);
guardedProbe = deferred();
const rejectedAuth = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
guardedProbe.resolve({ ok: false, model: 'changed-model-before-old-result', code: 'auth', error: '认证失败，请检查 API Key（HTTP 401）。' });
await rejectedAuth; guardedPanel.render();
assert.match(textContent(guardedPanel.tree), /认证失败，请检查 API Key/);
assert.ok(!textContent(guardedPanel.tree).includes('模型不存在或当前账号无权访问'), 'retesting replaces the prior diagnostic');
find(guardedPanel.tree, node => node.props.id === 'llm-key-guarded-provider').props.onChange(event('synthetic-key-not-a-secret'));
guardedPanel.render(); assert.ok(!textContent(guardedPanel.tree).includes('模型测试成功'), 'API key edits invalidate the previous result too');

guardedProbe = deferred();
const enabledProbe = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
labelled(guardedPanel.tree, `启用 ${longProviderName}`).props.onClick(); guardedPanel.render();
guardedProbe.reject(new Error('old synthetic provider rejection')); await enabledProbe; guardedPanel.render();
assert.ok(!textContent(guardedPanel.tree).includes('模型测试失败，请检查'), 'an old failure cannot attach itself to the newly disabled configuration');
assert.equal(labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.disabled, true, 'disabled suppliers cannot run model tests');
assert.equal(button(guardedPanel.tree, '获取模型').props.disabled, true, 'disabled suppliers cannot fetch models');
const requestsBeforeDisabledClick = probeConfigurations.length;
await labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick(); guardedPanel.render();
assert.equal(probeConfigurations.length, requestsBeforeDisabledClick, 'even a stale direct handler cannot use a disabled supplier');
assert.match(textContent(guardedPanel.tree), /供应商已停用/);
labelled(guardedPanel.tree, `启用 ${longProviderName}`).props.onClick(); guardedPanel.render();

guardedProbe = deferred();
const urlProbe = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
guardedValue = { ...guardedValue, providers: guardedValue.providers.map(provider => provider.id === guardedProvider.id ? { ...provider, baseUrl: 'https://changed.example.invalid' } : provider) };
guardedPanel.props.llmSettings = guardedValue; guardedPanel.render();
guardedProbe.resolve(true); await urlProbe; guardedPanel.render();
assert.ok(!textContent(guardedPanel.tree).includes('模型测试成功'), 'a controlled-prop URL change also invalidates the outstanding request identity');

button(guardedPanel.tree, '获取模型').props.onClick(); guardedPanel.render();
modelInput().props.onChange(event('manually-retyped-during-discovery')); guardedPanel.render();
providerDiscoveryReplies[0].resolve({ ok: true, models: ['stale-suggested-model'] }); await tick(); guardedPanel.render();
assert.equal(modelInput().props.value, 'manually-retyped-during-discovery', 'late model discovery cannot overwrite a model typed while the request was pending');
assert.equal(button(guardedPanel.tree, '获取模型').props.disabled, false, 'discarding the stale model reply still releases its request lock');
button(guardedPanel.tree, '获取模型').props.onClick(); guardedPanel.render();
guardedValue = { ...guardedValue, workflowBinding: { ...guardedValue.workflowBinding, 'review-tutor': disabledProvider.id },
  providers: guardedValue.providers.map(provider => provider.id === disabledProvider.id ? { ...provider, name: '同时修改的另一供应商' } : provider) };
guardedPanel.props.llmSettings = guardedValue; guardedPanel.render();
providerDiscoveryReplies[1].resolve({ ok: true, models: ['current-suggested-model'] }); await tick(); guardedPanel.render();
assert.equal(modelInput().props.value, 'current-suggested-model');
assert.equal(guardedValue.workflowBinding['review-tutor'], disabledProvider.id, 'a discovery result patches the latest settings instead of restoring older workflow bindings');
assert.equal(guardedValue.providers[1].name, '同时修改的另一供应商', 'a discovery result retains edits made to another provider while pending');

guardedProbe = deferred();
const deletedProbe = labelled(guardedPanel.tree, `测试 ${longProviderName} 模型`).props.onClick();
labelled(guardedPanel.tree, `删除模型供应商 ${longProviderName}`).props.onClick(); guardedPanel.render();
button(guardedPanel.tree, '删除供应商').props.onClick(); guardedPanel.render();
guardedProbe.resolve(true); await deletedProbe; guardedPanel.render();
assert.ok(!textContent(guardedPanel.tree).includes(longProviderName));
assert.ok(!textContent(guardedPanel.tree).includes('模型测试成功'), 'deleting a provider prevents its old request from recreating result UI');

// Verify the actual persistence functions propagate IPC errors and serialize
// desktop writes; all cache and file doubles below are in-memory objects.
let cached = ''; let cacheFailure = false; const diskWrites: string[] = [];
const diskOne = deferred<void>(); const diskTwo = deferred<void>();
const electronState = moduleFromSource('src/services/electronUserState.ts', { './learningAbility/timelineCompatibility': { normalizeMasteryTimeline } }, {
  window: { electronAPI: { userState: { saveLlm(value: any) { diskWrites.push(value.providers[0].selectedModel); return diskWrites.length === 1 ? diskOne.promise : diskTwo.promise; } } } },
});
const llmStorage = moduleFromSource('src/services/llmStorage.ts', { './electronUserState': electronState, './ui/settingsHydration': { createSettingsHydration }, './ui/settingsPersistence': { createSettingsPersistence } }, {
  localStorage: { getItem: () => cached || null, setItem(_key: string, value: string) { if (cacheFailure) throw new Error('合成缓存不可写'); cached = value; } },
});
const firstSave = llmStorage.saveLlmSettings(initialLlm);
const firstFailure = assert.rejects(firstSave, (error: any) => error.cause?.message === '合成桌面写入失败');
const secondSave = llmStorage.saveLlmSettings(nextLlm);
await tick(); assert.deepEqual(diskWrites, ['synthetic'], 'desktop writes are serialized');
diskOne.reject(new Error('合成桌面写入失败')); await firstFailure; await tick();
assert.deepEqual(diskWrites, ['synthetic', '保留输入'], 'the next save survives a failed predecessor');
diskTwo.resolve(); await secondSave;
cacheFailure = true; await assert.rejects(llmStorage.saveLlmSettings(initialLlm), (error: any) => error.cause?.message === '合成缓存不可写');
assert.equal(diskWrites.length, 2, 'cache failure is visible and does not schedule a misleading disk save');

const webPage = harness('src/components/SettingsModal.tsx', 'SettingsModal', settingsPage.props, {
  './LlmSettingsPanel': { LlmSettingsPanel: MockLlmPanel },
  '../services/llmStorage': { loadLlmSettings: () => initialLlm, saveLlmSettings: async () => {} },
}, {});
await tick(); webPage.render();
assert.equal(button(webPage.tree, '选择存储文件夹').props.disabled, true);
assert.equal(button(webPage.tree, '检查更新').props.disabled, true);
assert.ok(textContent(webPage.tree).includes('浏览器本机存储'));

{
  let draft: LlmSettings = structuredClone(initialLlm);
  let pending = true, waitingSave = deferred<void>(), dispatched = 0;
  const waitingPanel = harness('src/components/LlmSettingsPanel.tsx', 'LlmSettingsPanel', {
    llmSettings: draft,
    onUpdate(value: LlmSettings) { draft = value; waitingPanel.props.llmSettings = value; },
  }, { '../services/llmStorage': {
    loadLlmSettings: () => draft, saveLlmSettings: async () => {},
    hasUnsavedLlmSettings: () => pending, flushLlmSettingsWrites: () => waitingSave.promise,
  } }, { electronAPI: { llm: { probe: async (request: any) => {
    dispatched++; assert.equal(request.provider.id, model.id); return { ok: true, model: request.provider.selectedModel };
  } } } });
  const heldTest = labelled(waitingPanel.tree, `测试 ${model.name} 模型`).props.onClick();
  assert.equal(dispatched, 0, 'a new model configuration must be durable before the authoritative main-process test');
  labelled(waitingPanel.tree, `启用 ${model.name}`).props.onClick(); waitingPanel.render();
  pending = false; waitingSave.resolve(); await heldTest; waitingPanel.render();
  assert.equal(dispatched, 0, 'disabling during a settings save must block the later model test');
  labelled(waitingPanel.tree, `启用 ${model.name}`).props.onClick(); waitingPanel.render();
  pending = true; waitingSave = deferred<void>();
  const enabledTest = labelled(waitingPanel.tree, `测试 ${model.name} 模型`).props.onClick();
  assert.equal(dispatched, 0);
  pending = false; waitingSave.resolve(); await enabledTest; waitingPanel.render();
  assert.equal(dispatched, 1, 'a saved, still-enabled supplier can be tested once using its stable ID');
}
console.log('Settings UI interactions passed: genuine cancellation, explicit migration choice, pending guards, retained retries, login deletion, updater errors, model drafts, probe identity and edit/delete invalidation, truthful mixed/unavailable bindings, long identifiers, and serialized persistence.');
const capacityEdits: unknown[] = [];
const capacityPage = harness('src/components/LearningCapacitySettings.tsx', 'LearningCapacitySettings', {
  settings: { learningWeeklyBudgetMinutes: 600 }, notes: [], onUpdate: (patch: unknown) => capacityEdits.push(patch),
}, {}, {});
find(capacityPage.tree, n => n.type === 'input').props.onChange(event('480')); capacityPage.render();
find(capacityPage.tree, n => n.type === 'form').props.onSubmit(event()); capacityPage.render();
assert.equal(capacityEdits.length, 1);
assert.equal((capacityEdits[0] as any).learningWeeklyBudgetMinutes, 480);
find(capacityPage.tree, n => n.type === 'input').props.onChange(event('0')); capacityPage.render();
find(capacityPage.tree, n => n.type === 'form').props.onSubmit(event()); capacityPage.render();
assert.equal(capacityEdits.length, 1, 'invalid capacity never reaches settings writer');
assert.match(textContent(find(capacityPage.tree, n => n.props.role === 'alert')), /5–10080/);
assert.match(textContent(capacityPage.tree), /所有计划共用/);
console.log('PASS personal capacity UI: actual handlers submit a global-only patch on explicit confirmation, reject invalid input, and do not edit plans.');
await import('./check-app-settings');
await import('./check-llm-settings-startup');
await import('./check-model-settings-write');
