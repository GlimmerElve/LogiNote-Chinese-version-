import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createSettingsPersistence } from '../src/services/ui/settingsPersistence';
import { createSettingsHydration } from '../src/services/ui/settingsHydration';

// Production controller, storage, feedback and unload handlers, synthetic boundaries only.
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settings = (name: string) => ({ providers: [{ id: 'deepseek-default', name, apiType: 'ollama',
  baseUrl: 'http://localhost:11434', apiKey: '', models: ['synthetic'], selectedModel: name,
  enabled: true, createdAt: '2026-10-08' }], defaultProviderId: 'deepseek-default', workflowBinding: {} });
{
  let cached = settings('初始'), cacheFails = true, diskCalls = 0;
  let disk = deferred<void>();
  const c = createSettingsPersistence<typeof cached>(value => { if (cacheFails) throw new Error('synthetic-secret denied'); cached = value; }, () => { diskCalls++; return disk.promise; });
  let notices = 0; const unsubscribe = c.subscribe(() => notices++);
  const submitted = settings('保留草稿'); const first = c.write(submitted);
  assert.equal(c.hasUnsavedChanges(), true, 'same-frame cache failure must protect ordinary close');
  submitted.providers[0].name = '外部修改'; await assert.rejects(first);
  assert.equal(c.getDraft()?.providers[0].name, '保留草稿'); assert.equal(diskCalls, 0);
  assert.ok(!c.getSnapshot().saveError.includes('secret'));
  const external = c.getDraft()!; external.providers[0].name = '另一调用方修改';
  assert.equal(c.getDraft()?.providers[0].name, '保留草稿'); await assert.rejects(c.flush());
  unsubscribe(); const before = notices;
  cacheFails = false; const retry = c.retry(); assert.equal(retry, c.retry()); await tick();
  assert.equal(diskCalls, 1); assert.equal(cached.providers[0].name, '保留草稿');
  disk.reject(new Error('synthetic-secret IPC rejection')); await assert.rejects(retry);
  assert.equal(c.getSnapshot().saveState, 'error', 'late failure survives panel unsubscribe');
  assert.equal(notices, before); assert.ok(!c.getSnapshot().saveError.includes('secret'));
  disk = deferred(); const next = c.retry(); await tick(); disk.resolve(); await next; await c.flush();
  assert.equal(c.hasUnsavedChanges(), false); assert.equal(c.getDraft(), null);
  assert.equal(c.getSnapshot().saveState, 'saved'); assert.equal(diskCalls, 2);
}
{
  const requests: { value: ReturnType<typeof settings>; pending: ReturnType<typeof deferred<void>> }[] = [];
  const c = createSettingsPersistence<ReturnType<typeof settings>>(() => {}, value => {
    const pending = deferred<void>(); requests.push({ value, pending }); return pending.promise;
  });
  const first = c.write(settings('第一版')); await tick();
  let finished = false; const flush = c.flush().then(() => { finished = true; });
  const second = c.write(settings('第二版')); requests[0].pending.resolve(); await first; await tick();
  assert.equal(finished, false); assert.equal(c.getSnapshot().saveState, 'saving');
  assert.equal(c.getDraft()?.providers[0].name, '第二版'); assert.equal(requests.length, 2);
  requests[1].pending.reject(new Error('synthetic late disk error')); await assert.rejects(second); await assert.rejects(flush);
  assert.equal(c.hasUnsavedChanges(), true);
  const retry = c.retry(); assert.equal(retry, c.retry()); await tick();
  assert.equal(requests[2].value.providers[0].name, '第二版');
  requests[2].pending.resolve(); await retry; await c.flush(); assert.equal(c.hasUnsavedChanges(), false);
}
function sourceModule(file: string, replacements: Record<string, any>, globals: Record<string, any> = {}) {
  const require = createRequire(import.meta.url), module = { exports: {} as any };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  runInNewContext(code, { module, exports: module.exports, structuredClone, Promise, Error, Date,
    require(id: string) { if (id in replacements) return replacements[id]; if (id.endsWith('.css')) return {};
      if (['react', 'react/jsx-runtime', 'lucide-react'].includes(id)) return require(id);
      throw new Error(`Unstubbed model recovery dependency: ${id}`); }, ...globals });
  return module.exports;
}
{
  let cache = JSON.stringify(settings('原配置')), cacheFails = false, writes = 0;
  let disk = deferred<void>();
  const api = sourceModule('src/services/llmStorage.ts', { './ui/settingsHydration': { createSettingsHydration },
    './ui/settingsPersistence': { createSettingsPersistence }, './electronUserState': { saveLlmState: () => { writes++; return disk.promise; } } }, {
    localStorage: { getItem: () => cache, setItem: (_: string, value: string) => { if (cacheFails) throw new Error('synthetic cache denied'); cache = value; } },
  });
  cacheFails = true; await assert.rejects(api.saveLlmSettings(settings('未写入缓存的新配置')));
  assert.equal(writes, 0); assert.equal(api.loadLlmSettings().providers[0].name, '未写入缓存的新配置');
  assert.equal(api.readLlmSettingsForUse().providers[0].name, '未写入缓存的新配置', 'form and actual calls agree even if browser cache rejects');
  assert.equal(api.hasUnsavedLlmSettings(), true);
  cacheFails = false; const retry = api.retryLlmSettingsSave(); await tick(); assert.equal(writes, 1);
  disk.reject(new Error('synthetic IPC denied')); await assert.rejects(retry); await assert.rejects(api.flushLlmSettingsWrites());
  assert.equal(api.loadLlmSettings().providers[0].name, '未写入缓存的新配置');
  disk = deferred(); const success = api.retryLlmSettingsSave(); await tick(); disk.resolve(); await success;
  await api.flushLlmSettingsWrites(); assert.equal(api.hasUnsavedLlmSettings(), false);
}
{
  const effects: Array<() => any> = [], listeners = new Map<string, any>();
  let dirty = false;
  const { useLlmSettingsWrite } = sourceModule('src/components/useLlmSettingsWrite.ts', {
    react: { useEffect: (effect: any) => effects.push(effect), useSyncExternalStore: (_: any, read: any) => read() },
    '../services/llmStorage': { getLlmSettingsSaveState: () => ({ saveState: 'idle', saveError: '' }),
      subscribeLlmSettingsSave: () => () => {}, hasUnsavedLlmSettings: () => dirty },
  }, { window: { addEventListener: (name: string, fn: any) => listeners.set(name, fn),
    removeEventListener: (name: string, fn: any) => { assert.equal(listeners.get(name), fn); listeners.delete(name); } } });
  useLlmSettingsWrite(true); const stops = effects.map(effect => effect());
  let prevented = 0; const event = { returnValue: 'unchanged', preventDefault: () => prevented++ };
  listeners.get('beforeunload')(event); assert.equal(prevented, 0);
  dirty = true; listeners.get('beforeunload')(event); assert.equal(prevented, 1); assert.equal(event.returnValue, '');
  dirty = false; listeners.get('beforeunload')(event); assert.equal(prevented, 1);
  stops.forEach(stop => stop?.()); assert.equal(listeners.size, 0);
}
{
  const { ModelSettingsFeedback } = sourceModule('src/components/ModelSettingsFeedback.tsx', {});
  const error = renderToStaticMarkup(React.createElement(ModelSettingsFeedback, { state: { saveState: 'error', saveError: '<synthetic>' }, onRetry() {} }));
  assert.match(error, /role="alert"/); assert.match(error, /&lt;synthetic&gt;/); assert.match(error, /重试保存模型配置/);
  for (const saveState of ['idle', 'saving', 'saved']) assert.equal(renderToStaticMarkup(React.createElement(ModelSettingsFeedback, { state: { saveState, saveError: '' }, onRetry() {} })), '');
  // Execute the actual feedback over consecutive renders with persistent refs and synthetic focus.
  const refs: any[] = []; let cursor = 0, retryCalls = 0, focusCalls = 0;
  const document = { body: {}, activeElement: null as any };
  const fx: Array<() => void> = [];
  const component = sourceModule('src/components/ModelSettingsFeedback.tsx', { react: { ...React,
    useRef: (initial: any) => refs[cursor++] ||= { current: initial }, useEffect: (effect: any) => fx.push(effect),
  } }, { document }).ModelSettingsFeedback;
  const render = (saveState: string) => { cursor = 0; fx.length = 0; const node = component({ state: { saveState, saveError: '合成保存失败', recovering: saveState === 'saving' || saveState === 'error' }, onRetry: () => retryCalls++ }); fx.forEach(effect => effect()); return node; };
  const first = render('error'), retry = first.props.children[2];
  retry.props.ref.current = { focus: () => focusCalls++ }; document.activeElement = document.body;
  retry.props.onClick(); assert.equal(retryCalls, 1);
  const waiting = render('saving'); assert.equal(waiting.props.role, 'status'); assert.equal(waiting.props.children[2], false);
  render('error'); assert.equal(focusCalls, 1);
  document.activeElement = {}; render('saving'); render('error'); assert.equal(focusCalls, 1, 'do not steal focus from another control');
  assert.equal(render('saved'), null);
  const remounted = renderToStaticMarkup(React.createElement(ModelSettingsFeedback, { state: { saveState: 'saving', saveError: '', recovering: true }, onRetry() {} }));
  assert.match(remounted, /正在重试保存模型配置/); assert.match(remounted, /role="status"/);
}
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /useLlmSettingsWrite\(true\)/); assert.match(app, /await flushLlmSettingsWrites\(\)/);
assert.match(app, /currentView !== 'settings' && React.createElement\(ModelSettingsFeedback/);
assert.match(app, /settingsRecoveryContent:[\s\S]*?React.createElement\(ModelSettingsFeedback/);
console.log('PASS model settings recovery: shared immutable drafts, latest ordered writes, cache/IPC failure, remount-independent retry, queue flush, same-frame unload, safe feedback and focus. Synthetic IO only.');
