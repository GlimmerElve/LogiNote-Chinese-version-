/** Opt-in real configured model + production S2 UI. Only synthetic task text leaves this process.
 * Scene persistence is on disk under output/, never in the user's scene library. */
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
import { readFaultTreeModel } from '../examples/scene-packs/fault-tree/model';
import type { LlmCallRequest, LlmProvider } from '../src/types';

const args = process.argv.slice(2);
assert(args[0] === '--execute' && (args.length === 1 || args.length === 2 && args[1] === '--edits-only' || args.length === 3 && args[1] === '--understanding-from'),
  'Use --execute, optionally --understanding-from <passed-run-directory>.');
const understandingSource = args[2] ? path.resolve(args[2]) : undefined;
const editsOnly = args[1] === '--edits-only';
const root = path.resolve('.'), output = path.join(root, 'output/fault-tree-agent-live', new Date().toISOString().replace(/[:.]/g, '-'));
const library = path.join(output, 'scene-skills'), scenes = path.join(library, 'scenes');
const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note/storage-config.json'), 'utf8'));
const settings = JSON.parse(await fs.readFile(path.join(anchor.dataRoot, 'user-state/llm.json'), 'utf8')).settings;
const providerId = settings.workflowBinding?.['agent-scene-setup'] || settings.defaultProviderId;
const provider: LlmProvider = settings.providers.find((item: LlmProvider) => item.id === providerId && item.enabled);
assert(provider?.apiType === 'openai-compatible' && provider.apiKey?.trim() && provider.selectedModel, 'Configured scene model unavailable');
const metadata = { name: provider.name, model: provider.selectedModel, origin: new URL(provider.baseUrl).origin };
const installed = path.join(anchor.dataRoot, 'scene-interaction-packs/fault-tree/1.0.0');
const artifacts: Record<string, string> = {}, hashes: Record<string, string> = {};
for (const file of ['manifest.json', 'main.js', 'styles.css']) {
  artifacts[file] = await fs.readFile(path.join(installed, file), 'utf8');
  hashes[file] = createHash('sha256').update(artifacts[file]).digest('hex');
  assert.equal(hashes[file], createHash('sha256').update(await fs.readFile(path.join(root, 'output/scene-pack-examples/fault-tree/1.0.0', file))).digest('hex'), `Installed ${file} differs from current build`);
}
await fs.mkdir(scenes, { recursive: true });
const save = async (name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2); assert(!text.includes(provider.apiKey!), 'Secret in artifact');
  await fs.writeFile(path.join(output, name), text);
};
let restoredSceneId: string | undefined;
if (understandingSource) {
  const relative = path.relative(path.join(root, 'output/fault-tree-agent-live'), understandingSource);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Only a local prior fault-tree test may be used');
  const report = JSON.parse(await fs.readFile(path.join(understandingSource, 'report.json'), 'utf8'));
  assert(report.passed && report.execution === 'real-provider'); assert.deepEqual(report.installedPackage.hashes, hashes);
  const manifest = JSON.parse(await fs.readFile(path.join(understandingSource, 'scene-skills/manifest.json'), 'utf8'));
  assert.equal(manifest.scenes.length, 1); restoredSceneId = manifest.scenes[0].sceneId;
  assert(restoredSceneId && /^[A-Za-z0-9-]+$/.test(restoredSceneId));
  const source = await fs.readFile(path.join(understandingSource, 'scene-skills/scenes', restoredSceneId + '.json'), 'utf8');
  await fs.writeFile(path.join(scenes, restoredSceneId + '.json'), source);
  await fs.writeFile(path.join(library, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await save('source.json', { directory: understandingSource, sceneId: restoredSceneId, sha256: createHash('sha256').update(source).digest('hex'), freshConversation: true });
}
const publicSettings = { providers: [{ ...provider, apiKey: '' }], defaultProviderId: provider.id, workflowBinding: { 'agent-scene-setup': provider.id } };
let calls = 0, outputReserved = 0, inputTokens = 0, outputTokens = 0, activeSignal: AbortSignal | undefined;
const actualFetch = globalThis.fetch, endpoint = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), endpoint); assert.equal(init?.method, 'POST');
  return actualFetch(url, { ...init, redirect: 'error' });
};
Object.assign(globalThis, { window: { electronAPI: { llm: { request: (request: Parameters<typeof proxyLlmRequest>[0]) => proxyLlmRequest(request, activeSignal), cancel() {} } } } });
const modules = process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'fta-live.cjs'))('playwright');
const transport = normalizePath(path.join(root, 'scripts/fixtures/s2-fault-tree-agent-live-model.ts'));
const entry = '/scripts/fixtures/s2-fault-tree-agent-live.html';
const server = await createServer({ configFile: false, root, publicDir: false, envDir: false, envPrefix: 'FTA_LIVE_UNUSED_', logLevel: 'error',
  plugins: [react()], resolve: { alias: [
    { find: /^(?:.*\/)?llmService(?:\.ts)?$/, replacement: transport },
    { find: /^(?:.*\/)?llmStorage(?:\.ts)?$/, replacement: transport },
  ] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, open: false,
    fs: { strict: true, allow: [path.join(root, 'src'), path.join(root, 'scripts/fixtures'), path.join(root, 'node_modules')], deny: ['.env', '.env.*', '**/.git/**'] } },
  optimizeDeps: { entries: [path.join(root, entry.slice(1))], include: ['react', 'react-dom/client', '@xyflow/react'] } });
let browser: any, currentPage: any;
const errors: string[] = [], remote: string[] = [], checks: string[] = [], stages: unknown[] = [];
const observations: Array<{ name: string; task: string; reply: string; fromCall: number; toCall: number }> = [];
let passed = false;
try {
  await server.listen(); const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  async function open(url = entry) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
    await context.route('**/*', (route: any) => {
      const url = route.request().url(); if (url.startsWith('data:') || new URL(url).origin === origin) return route.continue();
      remote.push(new URL(url).origin); return route.abort();
    });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.exposeBinding('__ftaSettings', () => publicSettings);
    await page.exposeBinding('__ftaPack', (_: unknown, op: string) => op === 'list'
      ? { managed: true, packs: [JSON.parse(artifacts['manifest.json'])], errors: [] }
      : { manifest: JSON.parse(artifacts['manifest.json']), codeBase64: Buffer.from(artifacts['main.js']).toString('base64'), styles: artifacts['styles.css'] });
    await page.exposeBinding('__ftaStorage', async (_: unknown, request: { op: string; id?: string; value?: unknown }) => {
      if (request.id) assert(/^[A-Za-z0-9-]+$/.test(request.id));
      const manifestFile = path.join(library, 'manifest.json');
      const sceneFile = request.id ? path.join(scenes, request.id + '.json') : '';
      if (request.op === 'getDir') return library;
      if (request.op === 'loadManifest') return fs.readFile(manifestFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { version: '1.0', scenes: [] }; throw error; });
      if (request.op === 'loadScene') return JSON.parse(await fs.readFile(sceneFile, 'utf8'));
      if (request.op === 'saveManifest' || request.op === 'saveScene') {
        assert(request.op !== 'saveScene' || sceneFile); const text = JSON.stringify(request.value, null, 2); assert(!text.includes(provider.apiKey!));
        await fs.writeFile(request.op === 'saveManifest' ? manifestFile : sceneFile, text); return;
      }
      throw new Error('Unsupported test storage operation');
    });
    await page.exposeBinding('__ftaLiveModel', async (_: unknown, request: LlmCallRequest) => {
      assert.equal(request.workflow, 'agent-scene-setup'); assert(request.skipMemoryInjection && request.skipProfileInjection);
      assert(!request.tools?.length && !request.images?.length && !request.context);
      assert(calls < 28 && outputReserved + (request.maxTokensOverride || 4096) <= 150000, 'Live test request ceiling');
      const id = ++calls; outputReserved += request.maxTokensOverride || 4096;
      console.log(JSON.stringify({ call: id, stage: JSON.parse(request.userInput).stage || 'interaction', status: 'sending' }));
      await save(`request-${id}.json`, request);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000); activeSignal = controller.signal;
      try {
        const response = await callLLM(request, { signal: controller.signal, providerSnapshot: provider });
        inputTokens += response.usage?.promptTokens || 0; outputTokens += response.usage?.completionTokens || 0;
        await save(`response-${id}.json`, response);
        console.log(JSON.stringify({ call: id, status: 'received', chars: response.content.length })); return response;
      } catch (error) {
        const code = controller.signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_CALL_FAILED';
        const cause = (error as any)?.cause?.code;
        const transportCode = typeof cause === 'string' && /^[A-Z0-9_]{1,60}$/.test(cause) ? cause : undefined;
        await save(`failure-${id}.json`, { code, name: (error as Error).name, transportCode });
        console.log(JSON.stringify({ call: id, status: 'failed', code, transportCode })); throw new Error(code);
      } finally { clearTimeout(timer); activeSignal = undefined; }
    });
    await page.goto(origin + url); return { page, context };
  }
  const { page, context } = await open(entry + (restoredSceneId ? '?reopen=' + restoredSceneId : editsOnly ? '?edits=1' : ''));
  async function readLive(target: any) {
    await target.getByRole('button', { name: '更多', exact: true }).click();
    const summary = target.getByText('工作区导入／导出', { exact: true });
    if (!(await summary.locator('..').getAttribute('open') !== null)) await summary.click();
    await target.getByRole('button', { name: '导出工作区 JSON 到下方', exact: true }).click();
    const workspace = JSON.parse(await target.locator('label').filter({ hasText: /^工作区 JSON/ }).locator('textarea').inputValue());
    await target.getByLabel('关闭画布操作面板', { exact: true }).click();
    return target.evaluate((definition: unknown) => (window as any).__ftaAudit(definition), workspace.definition);
  }
  const audit = () => readLive(page);
  await page.waitForFunction(() => !!(window as any).__ftaAudit?.() || document.querySelector('#root[role="alert"]') || [...document.querySelectorAll('.s2-error')].some(node => node.textContent?.includes('MODEL_')), undefined, { timeout: 180000 });
  assert(await page.evaluate(() => !!(window as any).__ftaAudit?.()), 'Initial scene design failed; inspect sanitized model failure record');
  if (understandingSource) {
    async function explain(name: string, task: string) {
      const before = await audit(), firstCall = calls + 1;
      await page.getByLabel('向 Agent 提出要求', { exact: true }).fill(task);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.s2-assistant-status'), undefined, { timeout: 150000 });
      assert.deepEqual(await page.locator('.s2-assistant-panel .s2-error').allTextContents(), []);
      assert(calls >= firstCall);
      const response = JSON.parse(await fs.readFile(path.join(output, `response-${calls}.json`), 'utf8'));
      const terminal = response.parsedJson ?? JSON.parse(response.content);
      assert(!terminal.read); assert.deepEqual(terminal.actions ?? [], [], 'Checking understanding must not modify or execute');
      const after = await audit(); assert.deepEqual(after.canvas, before.canvas);
      const reply = await page.locator('.s2-messages > div').last().locator('p').innerText();
      assert.equal(reply, terminal.reply); observations.push({ name, task, reply, fromCall: firstCall, toCall: calls });
      await save(name + '.json', { state: after, reply, fromCall: firstCall, toCall: calls });
      console.log(JSON.stringify({ observation: name, reply })); return { before, after, reply };
    }
    const initial = await audit(), gateNode = initial.canvas.nodes.find((node: any) => node.componentId === 'gate');
    const a = initial.canvas.nodes.find((node: any) => node.values?.content === 'A：冷却系统故障');
    const b = initial.canvas.nodes.find((node: any) => node.values?.content === 'B：供电失效');
    assert(a && b && gateNode); assert.equal(gateNode.values.gateType, 'OR');
    const first = await explain('understand-fresh-scene', '这个场景现在在做什么？请说明用途、当前事件和逻辑关系，以及这些配置能证明什么、还不能证明什么。只解释，不修改、不运行。');
    assert(/事故树/.test(first.reply) && /或门|OR|A\s*或\s*B|任一/.test(first.reply));
    assert(first.reply.includes('冷却系统故障') && first.reply.includes('供电失效') && first.reply.includes('设备停机'));
    checks.push('Fresh conversation recognizes restored scene purpose, current content and OR relation without build history');
    await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(300);
    await page.locator(`.react-flow__node[data-id="${gateNode.id}"]`).getByRole('button', { name: /逻辑门：/ }).dblclick();
    await page.locator(`.react-flow__node[data-id="${a.id}"]`).getByRole('textbox', { name: '内容', exact: true }).fill('A：冷却泵故障');
    const manual = await audit(); assert.equal(manual.canvas.nodes.find((node: any) => node.id === gateNode.id).values.gateType, 'AND');
    const second = await explain('understand-manual-change', '我刚手动调整了画布。请重新说明当前事件内容和逻辑关系，以现在的画布为准。只解释，不修改、不运行。');
    assert(/与门|AND|且|同时/.test(second.reply)); assert(second.reply.includes('冷却泵故障'));
    checks.push('Manual double-click and content editing are visible to the next Agent turn and override previous conversation');
    const edges = await page.locator('.react-flow__edge').all();
    let removed = false;
    for (const edge of edges) {
      if (!(await edge.getAttribute('data-id'))?.includes(b.id)) continue;
      const point = await edge.locator('path').first().evaluate((path: SVGPathElement) => {
        const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM()!;
        const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: transformed.x, y: transformed.y };
      });
      await page.mouse.click(point.x, point.y); await page.keyboard.press('Delete'); removed = true; break;
    }
    assert(removed); const disconnected = await audit(); assert.equal(disconnected.canvas.connections.length, 2);
    const third = await explain('understand-missing-wire', '检查当前画布的结构是否完整，指出实际问题和影响。只检查，不修复、不运行。');
    assert(/未连|缺|断开|不完整|未接/.test(third.reply)); assert(/B|供电/.test(third.reply));
    checks.push('Agent identifies the real missing B→gate connection without silently repairing it');
    const fourth = await explain('understand-evidence-limit', '现在能认定设备已经停机、事故已经发生了吗？设备停机概率具体是多少？请按已有证据回答，不补设数据、不修改、不运行。');
    assert(/不能|无法|不足|没有|未提供/.test(fourth.reply)); assert(/概率/.test(fourth.reply));
    checks.push('Agent distinguishes modeled conditions from actual events and does not infer a probability from structure alone');
    const fifth = await explain('understand-ui-limit', '你能确定我刚才是否点过保存场景，以及最后点击的具体按钮是什么吗？请只按你确实收到的信息回答，不猜测、不修改、不运行。');
    assert(/无法|不能|不确定|没有|未提供/.test(fifth.reply));
    checks.push('Agent does not invent save state or unobserved UI actions');
    await page.screenshot({ path: path.join(output, 'understanding.png'), fullPage: true });
    await save('observations.json', observations);
  } else {
  const built = await audit(); await save('built.json', built);
  assert.equal(built.runtimeStarts, 0); assert.equal(built.executionCalls, 0);
  function inspect(state: any, operator: string, content = 'A：冷却失效', addedContents: string[] = []) {
    assert.equal(state.canvas.nodes.length, 4 + addedContents.length); assert.equal(state.canvas.connections.length, 3 + addedContents.length); assert.deepEqual(state.issues, []);
    const events = state.canvas.nodes.filter((n: any) => n.componentId === 'event'), gates = state.canvas.nodes.filter((n: any) => n.componentId === 'gate');
    assert.equal(events.length, 3 + addedContents.length); assert.equal(gates.length, 1);
    const a = events.find((n: any) => n.values.content === content), b = events.find((n: any) => n.values.content === 'B：供电失效'), c = events.find((n: any) => n.values.content === 'C：设备停机');
    assert(a && b && c); assert.equal(a.values.eventType, 'basic'); assert.equal(b.values.eventType, 'basic'); assert.equal(c.values.eventType, 'top');
    assert.equal(gates[0].values.gateType, operator);
    for (const event of events) assert.deepEqual(Object.keys(event.values).sort(), ['content', 'eventType']);
    const model = readFaultTreeModel(state.scene.canvasWorkspace.initial); assert.deepEqual(model.issues, []);
    assert.equal(model.rules.length, 1); assert.equal(model.rules[0].eventId, c.id); assert.equal(model.rules[0].operator, operator);
    const extra = addedContents.map(content => events.find((n: any) => n.values.content === content)); assert(extra.every(Boolean));
    for (const event of extra) assert.equal(event.values.eventType, 'basic');
    assert.deepEqual([...model.rules[0].inputEventIds].sort(), [a.id, b.id, ...extra.map((n: any) => n.id)].sort());
    return { a, b, c, gate: gates[0] };
  }
  const ids = inspect(built, 'AND'); assert(ids.c.position.y < ids.gate.position.y && ids.gate.position.y < ids.a.position.y && ids.gate.position.y < ids.b.position.y);
  checks.push(editsOnly ? 'Seeded known four-node AND scene for real editing tests; no model build or reply replay' : 'Real model built exactly three typed events and one AND gate, correct event→gate→event wiring and vertical layout');
  stages.push({ stage: 'build', modelCalls: calls });
  await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, 'built.png'), fullPage: true });
  async function chat(text: string, name: string) {
    await page.getByLabel('向 Agent 提出要求', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.s2-assistant-status'), undefined, { timeout: 150000 });
    const problem = await page.locator('.s2-assistant-panel .s2-error').allTextContents(); assert.deepEqual(problem, []);
    await page.waitForTimeout(150); const state = await audit();
    assert.equal(state.runtimeStarts, 0); assert.equal(state.executionCalls, 0);
    const response = JSON.parse(await fs.readFile(path.join(output, `response-${calls}.json`), 'utf8'));
    const terminal = response.parsedJson ?? JSON.parse(response.content);
    assert(!(terminal.actions ?? []).some((action: any) => ['run', 'cancel'].includes(action.type)), 'An ordinary edit must not append execution');
    assert(!/(?<!不|无)需要(?:先|再)?运行|请(?:先|再)?运行|运行后才生效/.test(terminal.reply ?? ''), 'Editing cannot ask the user to run before it takes effect');
    await save(name + '.json', state); return state;
  }
  const changed = await chat('把当前与门改成或门，保留所有事件、内容和连线。', 'changed-gate');
  inspect(changed, 'OR'); assert.deepEqual(changed.canvas.connections, built.canvas.connections);
  assert.deepEqual(changed.canvas.nodes.map((n: any) => n.id).sort(), built.canvas.nodes.map((n: any) => n.id).sort());
  checks.push('Conversation changed existing AND to OR with stable node IDs and wiring'); stages.push({ stage: 'change-gate', modelCalls: calls });
  const edited = await chat('把基本事件 A 的内容改为“A：冷却系统故障”，其他事件、或门和连线保持原样。', 'changed-content');
  inspect(edited, 'OR', 'A：冷却系统故障'); assert.deepEqual(edited.canvas.connections, built.canvas.connections);
  checks.push('Conversation changed A content only and preserved OR/topology'); stages.push({ stage: 'change-content', modelCalls: calls });
  const readonly = await chat('只解释当前事故树的逻辑关系。', 'explanation');
  assert.deepEqual(readonly.canvas, edited.canvas); checks.push('Explanation-only conversation preserved the complete canvas');
  const thirdInput = await chat('新增一个基本事件，内容为“D：传感器故障”，把它接入当前已有的或门，与 A、B 一起作为或门输入。保留已有节点和连线。', 'third-input');
  inspect(thirdInput, 'OR', 'A：冷却系统故障', ['D：传感器故障']);
  for (const link of built.canvas.connections) assert(thirdInput.canvas.connections.some((item: unknown) => JSON.stringify(item) === JSON.stringify(link)));
  const expanded = editsOnly ? thirdInput : await chat('把当前或门切换为与门，再新增一个基本事件，内容为“E：控制器故障”，接入这个与门。四个下级事件共同作为同一门的输入，保留其他内容和所有已有连线。', 'fourth-input');
  const finalOperator = editsOnly ? 'OR' : 'AND', remainingExtras = editsOnly ? [] : ['D：传感器故障'];
  inspect(expanded, finalOperator, 'A：冷却系统故障', editsOnly ? ['D：传感器故障'] : ['D：传感器故障', 'E：控制器故障']);
  assert.equal(expanded.canvas.nodes.find((n: any) => n.componentId === 'gate').id, ids.gate.id);
  for (const link of thirdInput.canvas.connections) assert(expanded.canvas.connections.some((item: unknown) => JSON.stringify(item) === JSON.stringify(link)));
  checks.push(editsOnly ? 'Real Agent adds the third event and connects it to the existing OR gate without replacing old wires' : 'Real Agent adds and wires a third event to the existing OR gate, then switches it to AND and adds a fourth event without replacing old wires');
  stages.push({ stage: 'multi-input', modelCalls: calls });
  const disconnected = await chat('只断开“D：传感器故障”事件到当前逻辑门的连线，保留两个节点和其他连线。', 'disconnect-event');
  assert.equal(disconnected.canvas.nodes.length, expanded.canvas.nodes.length); assert.equal(disconnected.canvas.connections.length, expanded.canvas.connections.length - 1);
  const d = expanded.canvas.nodes.find((node: any) => node.values?.content === 'D：传感器故障');
  assert(!disconnected.canvas.connections.some((link: any) => link.source.nodeId === d.id));
  const reconnected = await chat('把“D：传感器故障”事件重新连接到已有逻辑门。', 'reconnect-event');
  inspect(reconnected, finalOperator, 'A：冷却系统故障', editsOnly ? ['D：传感器故障'] : ['D：传感器故障', 'E：控制器故障']);
  const final = await chat(`删除内容为“${editsOnly ? 'D：传感器故障' : 'E：控制器故障'}”的事件块及其连线，保留其他节点和连线。`, 'remove-event');
  inspect(final, finalOperator, 'A：冷却系统故障', remainingExtras);
  checks.push('Plain add/connect/disconnect/reconnect/remove requests need no execution veto; zero package runtimes or local executions are started');
  await page.getByRole('navigation', { name: '画布工具', exact: true }).getByRole('button', { name: '保存场景', exact: true }).click();
  await page.getByText(/已保存场景「/).waitFor();
  const manifest = JSON.parse(await fs.readFile(path.join(library, 'manifest.json'), 'utf8')); assert.equal(manifest.scenes.length, 1);
  const savedId = manifest.scenes[0].sceneId, saved = JSON.parse(await fs.readFile(path.join(scenes, savedId + '.json'), 'utf8'));
  assert.deepEqual(saved.canvasWorkspace.initial, final.scene.canvasWorkspace.initial); assert.deepEqual(saved.interactionPack, { id: 'fault-tree', version: '1.0.0' });
  await page.screenshot({ path: path.join(output, 'edited-and-saved.png'), fullPage: true });
  await page.getByRole('button', { name: '重新打开已保存场景', exact: true }).click();
  await page.waitForFunction((id: string) => (window as any).__ftaAudit?.()?.sceneId === id, savedId);
  inspect(await audit(), finalOperator, 'A：冷却系统故障', remainingExtras);
  checks.push('Toolbar save wrote a real scene JSON and manifest; library reopen restored it');
  await context.close();
  const priorCalls = calls, reopened = await open(entry + '?reopen=' + savedId);
  await reopened.page.waitForFunction(() => !!(window as any).__ftaAudit?.(), undefined, { timeout: 30000 });
  const restored = await readLive(reopened.page);
  inspect(restored, finalOperator, 'A：冷却系统故障', remainingExtras); assert.deepEqual(restored.canvas, final.canvas); assert.equal(calls, priorCalls);
  assert.equal(restored.runtimeStarts, 0); assert.equal(restored.executionCalls, 0);
  await save('restored.json', restored);
  await reopened.page.locator('.react-flow__controls-fitview').click(); await reopened.page.waitForTimeout(300);
  await reopened.page.screenshot({ path: path.join(output, 'reopened.png'), fullPage: true });
  const gate = reopened.page.locator(`.react-flow__node[data-id="${ids.gate.id}"]`).getByRole('button', { name: /逻辑门：/ });
  await gate.dblclick(); await reopened.page.waitForTimeout(150);
  const reusable = await readLive(reopened.page); inspect(reusable, finalOperator === 'AND' ? 'OR' : 'AND', 'A：冷却系统故障', remainingExtras);
  assert.equal(JSON.parse(await fs.readFile(path.join(scenes, savedId + '.json'), 'utf8')).canvasWorkspace.initial.execution.nodes.find((n: any) => n.id === ids.gate.id).bindings.gateType.value, finalOperator);
  checks.push('Fresh browser context restored disk data without model calls; reused canvas editable without overwriting saved template');
  }
  assert.deepEqual(remote, []); assert.deepEqual(errors, []); passed = true;
} catch (error) {
  await currentPage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await save('failure.json', { name: (error as Error).name, message: (error as Error).message });
  throw error;
} finally {
  await save('report.json', { passed, execution: 'real-provider', provider: metadata, installedPackage: { ref: 'fault-tree@1.0.0', hashes },
    scope: 'Production S2 component, public Agent design/interaction, installed ESM package and production sceneSkillStore; Playwright bridges model IPC and isolated disk scene IPC. Not the full installed desktop shell.',
    userLibraryWrites: 0, profile: understandingSource ? 'interaction-understanding' : editsOnly ? 'plain-edits-without-execution' : 'build-edit-reuse',
    observations, calls, outputReserved, usage: { inputTokens, outputTokens }, stages, checks, errors, remote });
  await browser?.close(); await server.close(); globalThis.fetch = actualFetch;
  console.log(JSON.stringify({ passed, output, calls, checks }));
}
