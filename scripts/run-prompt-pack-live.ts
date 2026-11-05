/** Opt-in installed prompt pack, production canvas + Agent + model-test session,
 * real configured providers, and production sceneSkillStore with isolated disk IPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { callLLM } from '../src/services/llmService';
import { proxyLlmRequest } from '../src/electron/apiHandlers';
import { supportsS2ThinkingControl } from '../src/services/scene/sceneS2ModelTransport';
import type { LlmCallRequest, LlmProvider, LlmCallResponse } from '../src/types';

assert.deepEqual(process.argv.slice(2), ['--execute'], 'Opt in with --execute; sends real configured-model requests.');
const root = path.resolve('.'), output = path.join(root, 'output/prompt-pack-live', new Date().toISOString().replace(/[:.]/g, '-'));
const library = path.join(output, 'scene-skills'), scenes = path.join(library, 'scenes');
const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note/storage-config.json'), 'utf8'));
const settings = JSON.parse(await fs.readFile(path.join(anchor.dataRoot, 'user-state/llm.json'), 'utf8')).settings;
const workflows = ['agent-scene-setup', 'scene-model-experiment'] as const;
const providers = new Map<string, LlmProvider>();
for (const workflow of workflows) {
  const id = settings.workflowBinding?.[workflow] || settings.defaultProviderId;
  const selected = settings.providers.find((provider: LlmProvider) => provider.enabled && provider.id === id);
  assert(selected?.apiType === 'openai-compatible' && selected.apiKey?.trim() && selected.selectedModel, `${workflow}: configured provider unavailable`);
  providers.set(workflow, structuredClone(selected));
}
const metadata = Object.fromEntries([...providers].map(([workflow, provider]) => [workflow, { name: provider.name, model: provider.selectedModel, origin: new URL(provider.baseUrl).origin }]));
const publicSettings = { providers: [...new Map([...providers.values()].map(provider => [provider.id, {
  id: provider.id, name: provider.name, apiType: provider.apiType, baseUrl: new URL(provider.baseUrl).origin, apiKey: '',
  models: provider.models, selectedModel: provider.selectedModel, enabled: true, contextWindowTokens: provider.contextWindowTokens,
}])).values()], defaultProviderId: providers.get('agent-scene-setup')!.id,
workflowBinding: Object.fromEntries([...providers].map(([workflow, provider]) => [workflow, provider.id])),
supportsTestThinking: supportsS2ThinkingControl(providers.get('scene-model-experiment')!) };
const installed = path.join(anchor.dataRoot, 'scene-interaction-packs/prompt-lab/0.1.0');
const packFiles: Record<string, string> = {}, hashes: Record<string, string> = {};
for (const name of ['manifest.json', 'main.js', 'styles.css', 'agent.json']) {
  packFiles[name] = await fs.readFile(path.join(installed, name), 'utf8'); hashes[name] = createHash('sha256').update(packFiles[name]).digest('hex');
}
await fs.mkdir(scenes, { recursive: true });
const save = async (name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  for (const provider of providers.values()) assert(!text.includes(provider.apiKey!), 'Secret in test artifact');
  await fs.writeFile(path.join(output, name), text);
};
const wire: Array<{ kind: 'assistant' | 'test'; request: LlmCallRequest; response?: LlmCallResponse; status: string }> = [];
const count = (kind: 'assistant' | 'test') => wire.filter(record => record.kind === kind).length;
let activeSignal: AbortSignal | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert([...providers.values()].some(provider => String(url) === provider.baseUrl.replace(/\/+$/, '') + '/chat/completions'));
  assert.equal(init?.method, 'POST'); return originalFetch(url, { ...init, redirect: 'error' });
};
Object.assign(globalThis, { window: { electronAPI: { llm: { request: (request: Parameters<typeof proxyLlmRequest>[0]) => proxyLlmRequest(request, activeSignal), cancel() {} } } } });
const modules = process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'prompt-live.cjs'))('playwright');
const entry = '/scripts/fixtures/s2-prompt-agent-live.html', transport = normalizePath(path.join(root, 'scripts/fixtures/s2-prompt-agent-live-model.ts'));
const server = await createServer({ configFile: false, root, publicDir: false, envDir: false, envPrefix: 'PROMPT_LIVE_UNUSED_', logLevel: 'error',
  plugins: [react()], resolve: { alias: [
    { find: /^(?:.*\/)?llmService(?:\.ts)?$/, replacement: transport }, { find: /^(?:.*\/)?llmStorage(?:\.ts)?$/, replacement: transport },
  ] }, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, open: false,
    fs: { strict: true, allow: [path.join(root, 'src'), path.join(root, 'scripts/fixtures'), path.join(root, 'node_modules')], deny: ['.env', '.env.*', '**/.git/**'] } },
  optimizeDeps: { entries: [path.join(root, entry.slice(1))], include: ['react', 'react-dom/client', '@xyflow/react'] } });
let browser: any, currentPage: any, passed = false, savedId: string | undefined;
const checks: string[] = [], errors: string[] = [], remote: string[] = [];
try {
  await server.listen(); const address = server.httpServer!.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  async function open(reopen?: string) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1150 }, reducedMotion: 'reduce' });
    await context.route('**/*', (route: any) => {
      const url = route.request().url(); if (url.startsWith('data:') || new URL(url).origin === origin) return route.continue(); remote.push(new URL(url).origin); return route.abort();
    });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.exposeBinding('__promptConfiguration', () => publicSettings);
    await page.exposeBinding('__promptPack', (_: unknown, op: string) => op === 'list'
      ? { managed: true, packs: [JSON.parse(packFiles['manifest.json'])], errors: [] }
      : { manifest: JSON.parse(packFiles['manifest.json']), codeBase64: Buffer.from(packFiles['main.js']).toString('base64'), styles: packFiles['styles.css'] });
    await page.exposeBinding('__promptStorage', async (_: unknown, request: { op: string; id?: string; value?: unknown }) => {
      if (request.id) assert(/^[A-Za-z0-9-]+$/.test(request.id));
      const index = path.join(library, 'manifest.json'), file = request.id ? path.join(scenes, request.id + '.json') : '';
      if (request.op === 'getDir') return library;
      if (request.op === 'loadManifest') return fs.readFile(index, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { version: '1.0', scenes: [] }; throw error; });
      if (request.op === 'loadScene') return JSON.parse(await fs.readFile(file, 'utf8'));
      if (request.op === 'saveManifest' || request.op === 'saveScene') {
        assert(request.op !== 'saveScene' || file); await fs.writeFile(request.op === 'saveManifest' ? index : file, JSON.stringify(request.value, null, 2)); return;
      }
      throw new Error('Unsupported isolated storage operation');
    });
    await page.exposeBinding('__promptLiveModel', async (_: unknown, request: LlmCallRequest) => {
      const provider = providers.get(request.workflow); assert(provider, 'Unapproved test workflow');
      assert(request.skipMemoryInjection && request.skipProfileInjection && !request.tools?.length && !request.images?.length && !request.context);
      const kind = request.workflow === 'scene-model-experiment' ? 'test' : 'assistant';
      assert(count(kind) < (kind === 'test' ? 3 : 12), 'Real test call ceiling');
      if (kind === 'test') { assert.equal(request.providerId, provider.id); assert.equal(request.model, provider.selectedModel); assert.equal(request.maxTokensOverride, 512); }
      const record = { kind, request: structuredClone(request), status: 'sending' } as typeof wire[number]; wire.push(record);
      const id = wire.length; await save(`request-${id}.json`, { kind, request }); console.log(JSON.stringify({ call: id, kind, status: 'sending' }));
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000); activeSignal = controller.signal;
      try {
        const response = await callLLM(request, { signal: controller.signal, providerSnapshot: provider });
        record.response = response; record.status = 'returned'; await save(`response-${id}.json`, { kind, response });
        console.log(JSON.stringify({ call: id, kind, status: 'returned', chars: response.content.length })); return response;
      } catch (error) {
        record.status = 'failed'; await save(`error-${id}.json`, { kind, name: (error as Error).name, aborted: controller.signal.aborted });
        throw new Error(controller.signal.aborted ? 'LIVE_MODEL_TIMEOUT' : 'LIVE_MODEL_FAILED');
      } finally { clearTimeout(timer); activeSignal = undefined; }
    });
    await page.goto(origin + entry + (reopen ? '?reopen=' + reopen : ''));
    await page.waitForFunction(() => !!(window as any).__promptAudit?.() || document.querySelector('#root[role="alert"]'));
    assert(await page.evaluate(() => !!(window as any).__promptAudit?.()), await page.locator('#root').innerText());
    await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(250);
    return { page, context };
  }
  async function readLive(page: any) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    const summary = page.getByText('工作区导入／导出', { exact: true }); if ((await summary.locator('..').getAttribute('open')) === null) await summary.click();
    await page.getByRole('button', { name: '导出工作区 JSON 到下方', exact: true }).click();
    const workspace = JSON.parse(await page.locator('label').filter({ hasText: /^工作区 JSON/ }).locator('textarea').inputValue());
    await page.getByLabel('关闭画布操作面板', { exact: true }).click();
    return page.evaluate((definition: unknown) => (window as any).__promptAudit(definition), workspace.definition);
  }
  const node = (page: any, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  async function editContent(page: any, id: string, text: string) {
    await node(page, id).locator('.s2-content-preview').dblclick();
    const input = node(page, id).getByRole('textbox', { name: '内容', exact: true }); await input.fill(text); await input.press('Control+Enter');
    await input.waitFor({ state: 'hidden' });
  }
  async function chat(page: any, task: string) {
    await page.getByLabel('向 Agent 提出要求', { exact: true }).fill(task); await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.s2-assistant-status'), undefined, { timeout: 180000 });
    assert.deepEqual(await page.locator('.s2-assistant-panel .s2-error').allTextContents(), []);
  }
  async function result(page: any, expectedCity: string, testCount: number) {
    const resultNode = node(page, 'result');
    await page.waitForFunction(() => ![...document.querySelectorAll('.s2-prompt-test button')].some(button => button.textContent === '停止'), undefined, { timeout: 120000 });
    await resultNode.locator('pre[aria-label="原始文本产物"]').waitFor({ timeout: 30000 });
    const shown = await resultNode.locator('pre[aria-label="原始文本产物"]').allTextContents();
    const response = wire.filter(record => record.kind === 'test').at(-1)?.response;
    assert(response && response.content.trim()); assert(shown.includes(response.content));
    assert.equal(JSON.parse(response.content).城市, expectedCity); assert.equal(count('test'), testCount);
    assert.deepEqual(await node(page, 'test').locator('[role="alert"]').allTextContents(), []);
    return response.content;
  }
  const { page, context } = await open(); assert.equal(wire.length, 0);
  await editContent(page, 'task', '提取待处理文本中的城市，使用原文城市名称。');
  await editContent(page, 'material', '小林今天抵达南京。');
  const structure = node(page, 'assemble').locator('details.s2-prompt-node-editor');
  await structure.locator(':scope > summary').click(); await structure.getByRole('textbox', { name: '入口2标题', exact: true }).fill('提取任务：');
  await page.getByRole('heading', { name: 'S2 实验画布', exact: true }).click(); await structure.locator(':scope > summary').click();
  await page.waitForTimeout(750); assert.equal(wire.length, 0); assert.equal((await readLive(page)).runtimeStarts, 0);
  checks.push('Direct content/material/assembly edits make zero assistant calls, zero model-test calls and create no runtime');
  await save('edited.json', await readLive(page));
  await node(page, 'test').getByRole('button', { name: '测试', exact: true }).click();
  const first = await result(page, '南京', 1); assert.equal(count('assistant'), 0);
  const firstRequest = wire.find(record => record.kind === 'test')!.request;
  assert(firstRequest.systemPromptOverride?.includes('提取任务：')); assert.equal(firstRequest.userInput, '小林今天抵达南京。');
  await page.screenshot({ path: path.join(output, 'button-test.png'), fullPage: true });
  checks.push('One click on the installed package Test button sends exactly one real model request with current full prompt/material; exact response is visible in result block');
  await editContent(page, 'material', '小林今天抵达苏州。'); await page.waitForTimeout(750); assert.equal(count('test'), 1); assert.equal(count('assistant'), 0);
  await chat(page, '把任务内容改为“提取资料中的城市，保留原文写法”。');
  const edited = await readLive(page); assert.equal(edited.canvas.nodes.find((item: any) => item.id === 'task').values.content, '提取资料中的城市，保留原文写法');
  assert.equal(count('test'), 1); const assistantEdits = count('assistant'); assert(assistantEdits > 0);
  checks.push('An Agent edit request uses assistant calls only and does not start a prompt test');
  await chat(page, '用当前提示词测试当前待测资料，把模型返回显示到结果块。');
  const second = await result(page, '苏州', 2); assert.notEqual(first, second); assert(count('assistant') > assistantEdits);
  const secondRequest = wire.filter(record => record.kind === 'test')[1].request;
  assert.equal(secondRequest.userInput, '小林今天抵达苏州。'); assert(secondRequest.systemPromptOverride?.includes('提取资料中的城市，保留原文写法'));
  checks.push('Explicit Agent test request runs the current graph once and publishes the second real model response to the result block');
  const beforeSave = await readLive(page);
  await page.getByRole('navigation', { name: '画布工具', exact: true }).getByRole('button', { name: '保存场景', exact: true }).click();
  await page.getByText(/已保存场景「/).waitFor();
  const manifest = JSON.parse(await fs.readFile(path.join(library, 'manifest.json'), 'utf8')); assert.equal(manifest.scenes.length, 1); savedId = manifest.scenes[0].sceneId;
  const saved = JSON.parse(await fs.readFile(path.join(scenes, savedId + '.json'), 'utf8'));
  assert.deepEqual(saved.canvasWorkspace.initial, beforeSave.scene.canvasWorkspace.initial); assert.deepEqual(saved.interactionPack, { id: 'prompt-lab', version: '0.1.0' });
  await save('saved-state.json', beforeSave); await page.screenshot({ path: path.join(output, 'agent-test.png'), fullPage: true });
  const priorCalls = wire.length, priorAssistantCalls = count('assistant'); await context.close();
  const reopened = await open(savedId); const restored = await readLive(reopened.page);
  assert.deepEqual(restored.canvas, beforeSave.canvas); assert.equal(restored.runtimeStarts, 0); assert.equal(wire.length, priorCalls);
  assert.equal(await node(reopened.page, 'result').locator('pre[aria-label="原始文本产物"]').count(), 0);
  checks.push('Toolbar save writes design/values/wires to disk; fresh browser reopening restores the exact canvas with no calls, sessions or previous results');
  await node(reopened.page, 'test').getByRole('button', { name: '测试', exact: true }).click(); await result(reopened.page, '苏州', 3);
  assert.equal(count('assistant'), priorAssistantCalls);
  await save('restored-state.json', restored); await reopened.page.screenshot({ path: path.join(output, 'reused.png'), fullPage: true });
  checks.push('Reused saved scene starts a fresh model session on Test and displays a new real response');
  assert.deepEqual(errors, []); assert.deepEqual(remote, []); passed = true;
} catch (error) {
  await currentPage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await save('failure.json', { name: (error as Error).name, message: (error as Error).message }); throw error;
} finally {
  await save('report.json', { passed, execution: 'real-provider', providers: metadata, installedPackage: { id: 'prompt-lab', version: '0.1.0', hashes },
    scope: 'Installed ESM through production loader, production S2 canvas/Agent/model preparation/session/callLLM/proxy and sceneSkillStore. Test bridges replace Electron IPC and isolate disk scenes; not the full desktop shell.',
    userLibraryWrites: 0, savedId, assistantCalls: count('assistant'), modelTestCalls: count('test'), checks, errors, remote,
    calls: wire.map((record, index) => ({ id: index + 1, kind: record.kind, status: record.status, usage: record.response?.usage })) });
  await browser?.close(); await server.close(); globalThis.fetch = originalFetch;
  console.log(JSON.stringify({ passed, output, assistantCalls: count('assistant'), modelTestCalls: count('test'), checks }));
}
