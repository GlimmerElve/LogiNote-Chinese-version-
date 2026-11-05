import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createSettingsHydration } from '../src/services/ui/settingsHydration';
import { createSettingsPersistence } from '../src/services/ui/settingsPersistence';

// Real controller/storage and extracted request handlers, memory-only IPC/network doubles.
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settings = (name: string) => ({ providers: [{ id: 'deepseek-default', name, apiType: 'ollama',
  baseUrl: 'http://localhost:11434', apiKey: '', models: ['synthetic'], selectedModel: 'synthetic',
  enabled: true, createdAt: '2026-10-08' }], defaultProviderId: 'deepseek-default', workflowBinding: {} });
const old = settings('旧缓存'), disk = settings('已读取配置'), edited = settings('用户新修改');
{
  let cache = old, reads = 0, commits = 0, notices = 0, request = deferred<typeof old>();
  const c = createSettingsHydration(() => { reads++; return request.promise; }, value => { cache = value; commits++; }, () => cache);
  const stop = c.subscribe(() => notices++);
  const first = c.load(); assert.equal(c.load(), first); assert.equal(c.getSnapshot().status, 'loading');
  await tick(); assert.equal(reads, 1); assert.equal(commits, 0);
  request.reject(new Error('synthetic-secret-key denied')); await assert.rejects(first, /无法读取模型配置/);
  assert.equal(c.getSnapshot().status, 'error'); assert.ok(!c.getSnapshot().error.includes('secret'));
  await assert.rejects(c.load()); assert.equal(reads, 1, 'ordinary calls must not silently retry a failed read');
  request = deferred(); const retry = c.load(true); assert.equal(retry, c.load(true)); await tick();
  request.resolve(disk); assert.equal(await retry, disk); assert.equal(commits, 1);
  await c.load(); assert.equal(reads, 2, 'ready reads reuse the authoritative cache');
  stop(); const before = notices; c.edited(); assert.equal(notices, before);
}
for (const fail of [false, true]) {
  let cache = old, commits = 0;
  const delayed = deferred<typeof old>();
  const c = createSettingsHydration(() => delayed.promise, value => { cache = value; commits++; }, () => cache);
  const loading = c.load(); await tick(); cache = edited; c.edited();
  if (fail) delayed.reject(new Error('old read failed')); else delayed.resolve(disk);
  assert.equal(await loading, edited); assert.equal(commits, 0);
  assert.equal(c.getSnapshot().status, 'ready', 'an older response cannot invalidate an explicit edit');
}
function storageHarness(initial: unknown = old) {
  const memory = new Map<string, string>();
  if (initial !== null) memory.set('loginote_llm_settings', typeof initial === 'string' ? initial : JSON.stringify(initial));
  let reads = 0, writes = 0;
  let request = deferred<unknown>();
  const module = { exports: {} as any };
  const code = ts.transpileModule(readFileSync('src/services/llmStorage.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, Promise, Date, Error, structuredClone,
    require(id: string) {
      if (id === './ui/settingsHydration') return { createSettingsHydration };
      if (id === './ui/settingsPersistence') return { createSettingsPersistence };
      if (id === './electronUserState') return { saveLlmState: async () => { writes++; } };
      throw new Error(`Unstubbed dependency: ${id}`);
    },
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) },
    window: { electronAPI: { userState: { loadLlm: () => { reads++; return request.promise; } } } },
  });
  return { api: module.exports, memory, get reads() { return reads; }, get writes() { return writes; },
    get request() { return request; }, restart() { request = deferred(); } };
}
{
  const h = storageHarness(); const first = h.api.ensureLlmSettingsLoaded();
  assert.throws(() => h.api.readLlmSettingsForUse(), /正在读取/);
  await tick(); h.request.resolve(disk); await first;
  assert.equal(h.api.readLlmSettingsForUse().providers[0].name, disk.providers[0].name);
  assert.equal(h.writes, 0, 'authoritative hydration cannot persist or change model credentials');
  assert.equal(h.reads, 1);
}
for (const invalid of [undefined, '{synthetic-secret-key', { providers: [{}] }, { ...disk, workflowBinding: { scene: 4 } }]) {
  const h = storageHarness(); const before = h.memory.get('loginote_llm_settings');
  const loading = h.api.ensureLlmSettingsLoaded(); await tick(); h.request.resolve(invalid);
  await assert.rejects(loading, /无法读取模型配置/);
  assert.equal(h.memory.get('loginote_llm_settings'), before); assert.equal(h.writes, 0);
  assert.throws(() => h.api.readLlmSettingsForUse(), /读取失败/);
  h.restart(); const retry = h.api.retryLlmSettingsLoad(); assert.equal(retry, h.api.retryLlmSettingsLoad());
  await tick(); h.request.resolve(disk); await retry; assert.equal(h.reads, 2);
}
{
  const h = storageHarness(); const loading = h.api.ensureLlmSettingsLoaded(); await tick();
  h.request.reject(new Error('synthetic-secret-key access denied')); await assert.rejects(loading);
  assert.ok(!h.api.getLlmSettingsLoadState().error.includes('secret'));
  assert.equal(h.writes, 0); assert.equal(h.api.loadLlmSettings().providers[0].name, old.providers[0].name);
}
for (const explicit of [false, true]) {
  const h = storageHarness(); const loading = h.api.ensureLlmSettingsLoaded(); await tick();
  if (explicit) await h.api.saveLlmSettings(edited);
  else h.memory.set('loginote_llm_settings', JSON.stringify(edited)); // Another renderer updated the shared cache.
  h.request.resolve(disk); await loading;
  assert.equal(h.api.readLlmSettingsForUse().providers[0].name, edited.providers[0].name);
  assert.equal(h.writes, explicit ? 1 : 0);
}
{
  const h = storageHarness(null); const loading = h.api.ensureLlmSettingsLoaded(); await tick();
  h.request.resolve(null); await loading; assert.equal(h.api.getLlmSettingsLoadState().status, 'ready');
  assert.equal(h.writes, 0, 'missing file may use defaults but does not create a file');
}
{
  const h = storageHarness('{invalid cached bytes'); const loading = h.api.ensureLlmSettingsLoaded(); await tick();
  h.request.resolve(null); await assert.rejects(loading); assert.equal(h.writes, 0);
  assert.equal(h.memory.get('loginote_llm_settings'), '{invalid cached bytes');
}
function extracted(file: string, name: string, env: Record<string, any>) {
  const source = readFileSync(file, 'utf8'); const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); };
  visit(ast); assert.ok(found, name);
  const code = ts.transpileModule(found.getText(ast).replace(/^export /, '') + `\nreturn ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
for (const [file, name] of [['src/services/llmService.ts', 'callLLM'], ['src/services/llmStreamService.ts', 'callLLMStream']]) {
  const gate = deferred<void>(); let resolved = 0, network = 0;
  const controller = new AbortController();
  const call = extracted(file, name, { ensureLlmSettingsLoaded: () => gate.promise,
    resolveProvider: () => { resolved++; return null; }, fetch: () => { network++; throw new Error('network forbidden'); },
    DOMException, Error });
  const result = call({ workflowId: 'synthetic', messages: [] }, { signal: controller.signal });
  await tick(); assert.equal(resolved, 0); assert.equal(network, 0);
  controller.abort(); gate.resolve(); await assert.rejects(result, (error: Error) => error.name === 'AbortError');
  assert.equal(resolved, 0); assert.equal(network, 0, 'cancelled request must not dispatch after delayed configuration load');
}
{
  const source = readFileSync('src/electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true); let handler: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'user-state:load-llm') handler = node.arguments[1];
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(handler);
  let raw: string | null = null;
  const code = ts.transpileModule(`const handler = ${handler.getText(ast)}; return handler;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const read = new Function('readUserStateFileIfExists', 'USER_STATE_FILES', 'getUserStateDir', code)(
    async (...args: any[]) => { assert.equal(args[2], true); return raw; }, { llm: 'synthetic' }, () => 'synthetic');
  assert.equal(await read(), null);
  raw = '{synthetic-secret-key'; await assert.rejects(read(), (error: Error) => !error.message.includes('secret') && /格式错误/.test(error.message));
  raw = JSON.stringify({ settings: { providers: {} } }); await assert.rejects(read(), /格式错误/);
  raw = JSON.stringify({ settings: disk }); assert.equal((await read()).providers[0].name, disk.providers[0].name);
}
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /hydrateFromUserState\(\{ skipSettings: true, skipLlm: true \}\)/);
assert.match(app, /ensureLlmSettingsLoaded\(\)\.catch/);
for (const file of ['src/services/argumentDoc/semanticQuality.ts', 'src/services/knowledgeExtractionService.ts', 'src/services/textbook/generation.ts']) {
  const source = readFileSync(file, 'utf8'); assert.match(source, /await ensureLlmSettingsLoaded\(\)/, `${file} must await authoritative read before pinning model configuration`);
}
console.log('LLM settings startup checks passed: single read owner, explicit retry, secret-safe failures, no startup writes, stale-response protection, and pre-dispatch abort.');
