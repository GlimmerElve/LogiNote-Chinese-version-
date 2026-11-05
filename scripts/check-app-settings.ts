import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppSettings } from '../src/components/useAppSettings';
import { AppSettingsFeedback } from '../src/components/AppSettingsFeedback';
import { connectPreferredWindowTheme, resolvePreferredWindowTheme } from '../src/services/ui/windowAppearance';
import { normalizeAgentPersona } from '../src/services/agent/persona';
import { normalizeAgentToolCallLimit } from '../src/services/agent/executionPolicy';
import type { VaultSettings } from '../src/types';

// Execute real controllers/functions against memory-only doubles, never import App or native IO.
const defaults = { theme: 'light', fontSize: 16, resourceCollectionMode: 'review' } as VaultSettings;
const disk = { ...defaults, theme: 'system', fontSize: 22 } as VaultSettings;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(file: string) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const all: ts.Node[] = []; const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); }; visit(ast);
  return { ast, all };
}
function run(code: string, env: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
function getFunction(file: string, name: string, env: Record<string, any>) {
  const { ast, all } = nodes(file);
  const fn = all.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(fn, name);
  return run(fn.getText(ast).replace(/^export /, '') + `\nreturn ${name};`, env);
}
{
  let reads = 0, writes = 0, request = deferred<VaultSettings>();
  const c = createAppSettings(defaults, () => { reads++; return request.promise; }, async () => { writes++; });
  let notifications = 0; const unsubscribe = c.subscribe(() => notifications++);
  const first = c.load(); assert.equal(first, c.load());
  c.update({ fontSize: 28 }); await tick(); assert.equal(reads, 1); assert.equal(writes, 0);
  request.reject(new Error('read denied')); await first;
  assert.equal(c.getSnapshot().loadState, 'error'); assert.equal(c.getSnapshot().settings.fontSize, 16);
  c.update({ theme: 'dark' }); await tick(); assert.equal(writes, 0, 'failed startup cannot write cached defaults');
  request = deferred(); const second = c.load(); request.resolve(disk); await second;
  assert.equal(c.getSnapshot().settings, disk, 'authoritative read updates actual UI state');
  assert.equal(writes, 0, 'hydrating settings is read-only'); await c.load(); assert.equal(reads, 2);
  c.update({ fontSize: 22 }); await c.flush(); assert.equal(writes, 0, 'unchanged fields do not persist');
  c.update({ fontSize: 23 }); assert.equal(c.hasUnsavedChanges(), true, 'same-frame edits protect unload');
  await c.flush(); assert.equal(c.getSnapshot().saveState, 'saved'); assert.equal(writes, 1); assert.equal(c.hasUnsavedChanges(), false);
  unsubscribe(); const previous = notifications; c.update({ fontSize: 24 }); await c.flush(); assert.equal(notifications, previous);
}
{
  const old = deferred<VaultSettings>(), live = deferred<VaultSettings>(); let calls = 0;
  const c = createAppSettings(defaults, () => ++calls === 1 ? old.promise : live.promise, async () => {});
  const first = c.load(); await tick(); c.cancelRead(); const second = c.load(); await tick();
  live.resolve(disk); await second; old.resolve(defaults); await first;
  assert.equal(c.getSnapshot().settings, disk, 'cancelled read cannot overwrite a restarted mount');
}
{
  const requests: Array<{ settings: VaultSettings; pending: ReturnType<typeof deferred<void>> }> = [];
  const c = createAppSettings(defaults, async () => disk, value => {
    const pending = deferred<void>(); requests.push({ settings: value, pending }); return pending.promise;
  }); await c.load();
  c.update({ fontSize: 23 }); c.update({ fontSize: 24 }); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].settings.fontSize, 23);
  const flushing = c.flush(); requests[0].pending.resolve(); await tick();
  assert.equal(c.getSnapshot().saveState, 'saving', 'older acknowledgement cannot clear latest edit');
  assert.equal(requests.length, 2); assert.equal(requests[1].settings.fontSize, 24);
  requests[1].pending.reject(new Error('disk denied')); await assert.rejects(flushing, /disk denied/);
  assert.equal(c.hasUnsavedChanges(), true); assert.equal(c.getSnapshot().settings.fontSize, 24);
  const retry = c.retrySave(); assert.equal(retry, c.retrySave(), 'duplicate retries share one write');
  await tick(); assert.equal(requests.length, 3); assert.equal(requests[2].settings.fontSize, 24);
  requests[2].pending.resolve(); await retry; await c.flush(); assert.equal(c.getSnapshot().saveState, 'saved');
}
{
  const listeners = new Map<string, any>(), effects: Array<() => any> = [];
  const use = getFunction('src/components/useAppSettings.ts', 'useAppSettings', {
    createAppSettings, useRef: (value: any) => ({ current: value }), useState: (init: any) => [init()],
    useSyncExternalStore: (_subscribe: any, read: any) => read(), useEffect: (effect: any) => effects.push(effect),
    window: { addEventListener: (name: string, listener: any) => listeners.set(name, listener),
      removeEventListener: (name: string, listener: any) => { assert.equal(listeners.get(name), listener); listeners.delete(name); } },
  });
  const blocked = deferred<void>(); const prefs = use(defaults, async () => defaults, () => blocked.promise);
  const cleanups = effects.map(effect => effect()); await tick();
  let prevented = 0; const event = { returnValue: 'unchanged', preventDefault: () => prevented++ };
  listeners.get('beforeunload')(event); assert.equal(prevented, 0);
  prefs.update({ theme: 'dark' }); listeners.get('beforeunload')(event); assert.equal(prevented, 1);
  blocked.reject(new Error('denied')); await tick(); listeners.get('beforeunload')(event); assert.equal(prevented, 2);
  cleanups.forEach(stop => stop()); assert.equal(listeners.size, 0);
}
const normalize = getFunction('src/services/storage.ts', 'normalizeAppSettings', { DEFAULT_SETTINGS: defaults, normalizeAgentPersona, normalizeAgentToolCallLimit });
for (const raw of [null, undefined, [], 'dark']) assert.throws(() => normalize(raw), /格式错误/);
assert.equal(normalize({ fontSize: 'large' }).fontSize, 18); assert.equal(normalize({ fontSize: 99 }).fontSize, 28);
assert.equal(normalize({ fontSize: NaN, theme: 'invalid' }).fontSize, 16);
async function storageRead(raw: unknown, cache: string | null = null, desktop = true) {
  let cachedWrites = 0, diskWrites = 0;
  const load = getFunction('src/services/storage.ts', 'loadAppSettingsFromStorage', {
    window: { electronAPI: desktop ? { userState: { loadSettings: async () => { if (raw instanceof Error) throw raw; return raw; } } } : undefined },
    localStorage: { getItem: () => cache, setItem: () => cachedWrites++ }, SETTINGS_KEY: 'synthetic', DEFAULT_SETTINGS: defaults,
    normalizeAppSettings: normalize, saveSettingsState: () => diskWrites++,
  });
  try { return { result: await load(), cachedWrites, diskWrites }; } catch (error) { return { error, cachedWrites, diskWrites }; }
}
for (const raw of [new Error('IPC denied'), undefined, []]) {
  const result = await storageRead(raw, JSON.stringify(defaults)); assert.ok(result.error); assert.equal(result.cachedWrites, 0); assert.equal(result.diskWrites, 0);
}
assert.equal((await storageRead(disk, JSON.stringify(defaults))).result.fontSize, 22);
assert.equal((await storageRead(null, JSON.stringify(disk))).result.fontSize, 22);
assert.equal((await storageRead(null)).result, defaults);
assert.ok((await storageRead(null, '{broken', false)).error);
{
  let writes = 0;
  const saveState = getFunction('src/services/electronUserState.ts', 'saveSettingsState', {
    getApi: () => ({ saveSettings: async () => { writes++; throw new Error('IPC save denied'); } }),
  });
  const save = getFunction('src/services/storage.ts', 'saveSettingsToStorage', {
    localStorage: { setItem: () => {} }, SETTINGS_KEY: 'synthetic', saveSettingsState: saveState,
  });
  await assert.rejects(save(defaults), /IPC save denied/); assert.equal(writes, 1);
  const noCache = getFunction('src/services/storage.ts', 'saveSettingsToStorage', {
    localStorage: { setItem: () => { throw new Error('cache denied'); } }, SETTINGS_KEY: 'synthetic', saveSettingsState: saveState,
  });
  await assert.rejects(noCache(defaults), /cache denied/); assert.equal(writes, 1);
}
{
  const nativeRead = getFunction('src/electron/main.ts', 'readUserStateFileIfExists', {
    getUserStateDir: () => '/synthetic', path, fs: { mkdir: async () => {}, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
  });
  await assert.rejects(nativeRead('settings.json', '/synthetic', true), /denied/);
  const missing = getFunction('src/electron/main.ts', 'readUserStateFileIfExists', {
    getUserStateDir: () => '/synthetic', path, fs: { mkdir: async () => {}, readFile: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } },
  }); assert.equal(await missing('settings.json', '/synthetic', true), null);
  const { ast, all } = nodes('src/electron/main.ts');
  const call = all.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'ipcMain.handle' && n.arguments[0].getText(ast) === "'user-state:load-settings'"); assert.ok(call);
  for (const text of [null, '{"appSettings":{"fontSize":22}}', '', '{}', '{"appSettings":[]}', '{broken']) {
    let load!: () => Promise<any>;
    run(call.getText(ast), { ipcMain: { handle: (_: string, fn: any) => { load = fn; } },
      readUserStateFileIfExists: async (_: any, _dir: any, strict: boolean) => { assert.equal(strict, true); return text; },
      USER_STATE_FILES: { settings: 'synthetic' }, getUserStateDir: () => '/synthetic' });
    if (text === null) assert.equal(await load(), null);
    else if (text.includes('22')) assert.equal((await load()).fontSize, 22);
    else await assert.rejects(load());
  }
}
{
  let dark = false; const changes = new Set<() => void>(), applied: string[] = [];
  const media = { get matches() { return dark; }, addEventListener: (_: any, cb: any) => changes.add(cb), removeEventListener: (_: any, cb: any) => changes.delete(cb) };
  const stop = connectPreferredWindowTheme('system', media as any, theme => applied.push(theme));
  dark = true; changes.forEach(cb => cb()); assert.deepEqual(applied, ['light', 'dark']); stop(); assert.equal(changes.size, 0);
  connectPreferredWindowTheme('light', media as any, theme => applied.push(theme)); assert.equal(changes.size, 0); assert.equal(applied.at(-1), 'light');
  assert.equal(resolvePreferredWindowTheme('system', true), 'dark');
}
for (const loadState of ['loading', 'ready', 'error'] as const) {
  const html = renderToStaticMarkup(createElement(AppSettingsFeedback, { state: { loadState, saveState: 'idle', loadError: '<unsafe>', saveError: '' }, onRetryLoad() {} }));
  if (loadState === 'error') { assert.match(html, /role="alert"/); assert.match(html, /&lt;unsafe&gt;/); assert.match(html, /重新读取应用设置/); }
  else if (loadState === 'loading') assert.match(html, /role="status"/);
  else assert.equal(html, '');
}
const failed = renderToStaticMarkup(createElement(AppSettingsFeedback, { banner: true, state: { loadState: 'ready', saveState: 'error', loadError: '', saveError: 'denied' }, onRetrySave() {} }));
assert.match(failed, /重试保存应用设置/); assert.doesNotMatch(failed, /已保存到本机/);
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /const settings = appSettings.settings/); assert.match(app, /hydrateFromUserState\(\{ skipSettings: true, skipLlm: true \}\)/);
assert.match(app, /await appSettings.flush\(\)/); assert.match(app, /currentView !== 'settings' && React.createElement\(AppSettingsFeedback/);
assert.match(app, /settingsRecoveryContent: React.createElement\(React.Fragment, null,\s*React.createElement\(AppSettingsFeedback/);
assert.doesNotMatch(app, /saveSettingsToStorage\(settings\)/, 'React mount/theme effects cannot persist cached defaults');
assert.match(readFileSync('src/ArgumentEditorApp.tsx', 'utf8'), /skipSettings: true/);
console.log('PASS app settings: read-only startup, authoritative hydration, failure gates, latest serialized write/retry, flush/unload guards, native strict reads and system appearance; synthetic IO only');
