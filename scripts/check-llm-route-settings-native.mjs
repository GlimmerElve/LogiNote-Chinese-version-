// Actual App settings, production persistence/hydration and progressive stream
// route. Disposable providers/notes; all model/network boundaries are offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { electronFiles } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'llm-route-native.cjs'))('playwright');
await fsp.mkdir('build', { recursive: true }); const root = await fsp.mkdtemp(path.resolve('build/llm-route-settings-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state'), at = '2026-11-08T00:00:00Z', glmId = 'synthetic-glm';
for (const directory of ['app/dist-electron', 'state/vault/notes', 'state/user-state']) await fsp.mkdir(path.join(root, directory), { recursive: true });
const glm = { id: glmId, name: 'GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: at };
const ds = { ...glm, id: 'deepseek-default', name: 'DeepSeek', baseUrl: 'https://deepseek.invalid', models: ['deepseek-chat'], selectedModel: 'deepseek-chat', enabled: false };
const explicit = { 'agent-chat': glmId, 'plan-generation': glmId }, textbooks = ['textbook-blueprint', 'textbook-chapter', 'textbook-quality'];
const initial = { providers: [ds, glm], defaultProviderId: ds.id, workflowBinding: explicit };
const explicitDisabled = { providers: [ds, glm], defaultProviderId: glmId, workflowBinding: { ...explicit, ...Object.fromEntries(textbooks.map(id => [id, ds.id])) } };
const legacyAutomatic = { providers: [ds, glm], defaultProviderId: '', workflowBinding: { ...explicit } };
const titles = { default: '旧配置教材路由验收', group: '教材分组路由验收', automatic: '旧版自动路由兼容验收' };
const notes = Object.entries(titles).map(([id, title]) => ({ id: 'route-' + id, title, noteType: 'project', projectRole: 'learning', content: '# 学习目标\n\n理解输入、计算与输出的关系，说明结论的条件和边界。', planMeta: { status: 'active', dailyStudyMinutes: 30 }, tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at }));
const meta = {}; for (const note of notes) { const { content, ...metadata } = note; meta[note.id] = metadata; await fsp.writeFile(path.join(state, 'vault/notes', note.id + '.md'), content); }
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: meta })); await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false } }));
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: initial })); await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'llm-route-settings-acceptance', version: '1.0.10' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction'); await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
const nativeFiles = new Map(await Promise.all(electronFiles.map(async name => [name, await fsp.readFile(path.resolve('dist-electron', name))])));
for (const [name, buffer] of nativeFiles) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), name === 'preload.cjs' ? Buffer.concat([buffer, Buffer.from(`\nrequire('electron').contextBridge.exposeInMainWorld('llmRouteTest',{command:input=>require('electron').ipcRenderer.invoke('llm-route:command',input)});\n`)]) : buffer);
const plan = { title: '离线供应商路由讲解', objectives: ['比较输入与输出'], pages: [{ id: 'main-1', title: '观察输入与输出', objectives: ['用合成材料说明过程'] }] };
const stream = '@@PLAN\n' + JSON.stringify(plan) + '\n@@LESSON\n# 观察输入与输出\n\n这是离线合成教学内容，用于观察当前设置所选择的供应商。先明确输入条件，再说明计算规则，最后比较输出。供应商名称和模型名称来自本地设置，本例不发送网络请求，不代表模型的真实生成能力。\n\n## 解释过程\n\n保持相同条件，逐项核对输入与结果。只有条件和计算路径都相同，比较结果才有意义。\n@@CONCEPTS\n[]\n@@QUESTIONS\n[]\n@@HOOK\n' + JSON.stringify({ id: 'hook-main-1', kind: 'reflection', prompt: '请说明输入和输出如何对应。' }) + '\n@@END';
const chunks = []; for (let cursor = 0; cursor < stream.length; cursor += 45) chunks.push(stream.slice(cursor, cursor + 45));
const eventsFile = path.join(root, 'events.jsonl'), fatalFile = path.join(root, 'main-exceptions.jsonl'); await fsp.writeFile(eventsFile, ''); await fsp.writeFile(fatalFile, '');
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{app,ipcMain,utilityProcess,dialog}=require('electron'),{EventEmitter}=require('node:events');
const root=${JSON.stringify(root)},chunks=${JSON.stringify(chunks)},explicitDisabled=${JSON.stringify(explicitDisabled)},legacyAutomatic=${JSON.stringify(legacyAutomatic)},log=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({...event,at:Date.now()})+'\\n');
const fatal=(phase,error)=>{const detail={phase,message:error?.message||String(error),stack:error?.stack||String(error)};try{log(detail);fs.appendFileSync(path.join(root,'main-exceptions.jsonl'),JSON.stringify(detail)+'\\n');fs.writeSync(2,detail.stack+'\\n')}finally{process.exit(1)}};
process.prependListener('uncaughtException',error=>fatal('main-uncaught',error));process.prependListener('unhandledRejection',error=>fatal('main-unhandled',error));dialog.showErrorBox=(title,content)=>fatal('main-error-dialog',new Error(title+'\\n'+content));
globalThis.fetch=async()=>{log({phase:'unexpected-network'});throw Error('Network disabled in synthetic provider-route acceptance')};
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true};return worker};
ipcMain.handle('llm-route:command',async(_event,input)=>{if(input.op==='exit'){setTimeout(()=>app.exit(0),40);return true}if(input.op==='resize'){const window=require('electron').BrowserWindow.fromWebContents(_event.sender),previous=window.getBounds();window.setMinimumSize(640,600);window.setSize(input.width,input.height);return {previous,current:window.getBounds()}}if(input.op==='seed-first-run'){const file=path.resolve(root,'state/user-state/llm.json');assert.ok(file.startsWith(path.resolve(root,'state')+path.sep));fs.rmSync(file,{force:true});log({phase:'synthetic-first-run-reseed'});return true}if(input.op==='seed-explicit-disabled'||input.op==='seed-automatic'){fs.writeFileSync(path.join(root,'state/user-state/llm.json'),JSON.stringify({version:1,settings:input.op==='seed-automatic'?legacyAutomatic:explicitDisabled}));log({phase:'synthetic-scenario-reseed'});return true}});
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{if(channel==='llm:stream-start'){const request=args[0];assert.equal(request.provider.id,${JSON.stringify(glmId)});assert.equal(request.provider.selectedModel,'glm-5.3');log({phase:'progressive-stream',providerId:request.provider.id,model:request.provider.selectedModel,systemPrompt:request.systemPrompt,userInput:request.userInput});const id='route-stream-'+Date.now();let index=0;const timer=setInterval(()=>{if(event.sender.isDestroyed()){clearInterval(timer);return}if(index<chunks.length)event.sender.send('llm:stream-chunk',{streamId:id,chunk:{type:'content',text:chunks[index++]}});else{clearInterval(timer);event.sender.send('llm:stream-end',{streamId:id})}},45);return id}if(/^llm:(?:request|models|probe)$/u.test(channel)){log({phase:'unexpected-model',channel});throw Error('Unexpected model operation during provider-route acceptance')}return handler(event,...args)});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
assert.equal(spawnSync(process.execPath, ['--check', bootstrap], { encoding: 'utf8', windowsHide: true }).status, 0);
const renderer = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1];
const proof = { root, passed: false, checks: [], errors: [], exits: [], launches: 0, realModelRequests: 0, httpRequests: 0, renderer: { entry: renderer, sha256: createHash('sha256').update(await fsp.readFile(path.join('dist/assets', renderer))).digest('hex') }, nativeBuild: { source: 'existing-dist-electron', sha256: Object.fromEntries([...nativeFiles].map(([name, buffer]) => [name, createHash('sha256').update(buffer).digest('hex')])) } };
const executable = await prepareElectronRuntime(); let child, browser, page, fd, exited;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, label, timeout = 20000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await read(); if (accepts(last)) return last; await pause(100); } throw Error(label + ': ' + JSON.stringify(last)); }
const events = async () => (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const streamEvents = async () => (await events()).filter(event => event.phase === 'progressive-stream');
const readSettings = async () => JSON.parse(await fsp.readFile(path.join(state, 'user-state/llm.json'), 'utf8')).settings;
async function launch() { const filename = path.join(root, 'process-' + (++proof.launches) + '.log'); fd = fs.openSync(filename, 'w'); const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, SAVE_NATIVE_REAL_DIALOG: 'auto' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; child = spawn(executable, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] }); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); const endpoint = await until(async () => { const log = await fsp.readFile(filename, 'utf8'); if (child.exitCode !== null) throw Error(log.slice(-2000)); return log.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; }, Boolean, 'native startup', 40000); browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(18000); page.on('pageerror', error => proof.errors.push(error.message)); await page.getByRole('button', { name: '设置', exact: true }).waitFor({ timeout: 45000 }); }
async function close() { await page.evaluate(() => window.llmRouteTest.command({ op: 'exit' })); const result = await exited; proof.exits.push(result); await browser.close().catch(() => {}); browser = undefined; fs.closeSync(fd); fd = undefined; assert.equal(result.code, 0); }
async function settings() { await page.getByRole('button', { name: '设置', exact: true }).click(); await groupSelect().waitFor(); }
const groupSelect = () => page.getByRole('combobox', { name: '教材生成的模型供应商', exact: true });
const thinkingControl = () => page.getByRole('combobox', { name: '教材生成的思考模式', exact: true });
async function directControls(empty = false) {
  assert.equal(await page.getByRole('combobox', { name: '默认供应商', exact: true }).count(), 0);
  assert.equal(await page.locator('option').filter({ hasText: '跟随默认供应商' }).count(), 0);
  assert.equal(await groupSelect().locator('option[value=""]').count(), empty ? 1 : 0, 'only an unconfigured row shows an empty setup placeholder');
  if (empty) assert.equal(await groupSelect().locator('option[value=""]').isDisabled(), true);
  assert.equal(await page.getByRole('combobox', { name: /概念补全的模型供应商/u }).count(), 1);
  assert.equal(await thinkingControl().count(), 1);
  assert.deepEqual(await thinkingControl().locator('option').evaluateAll(options => options.map(option => option.value)), ['default', 'off', 'low', 'medium', 'high']);
}
async function checkThinkingLayout(label) {
  const result = await page.evaluate(() => {
    const issues = [], rows = [];
    const separated = (a, b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    for (const control of document.querySelectorAll('select[aria-label$="的思考模式"]')) {
      const row = control.closest('div.flex.flex-wrap.justify-between'), provider = row?.querySelector('select[aria-label$="的模型供应商"]'), title = row?.querySelector(':scope > span');
      if (!row || !provider || !title) { issues.push('missing row controls'); continue; }
      const box = row.getBoundingClientRect(), thinking = control.getBoundingClientRect(), supplier = provider.getBoundingClientRect(), caption = title.getBoundingClientRect();
      if (getComputedStyle(control).appearance !== 'none' || getComputedStyle(provider).appearance !== 'none'
        || getComputedStyle(control).borderRadius !== getComputedStyle(provider).borderRadius) issues.push(control.getAttribute('aria-label') + ': inconsistent select styling');
      if (!separated(thinking, supplier) || !separated(thinking, caption) || !separated(supplier, caption)) issues.push(control.getAttribute('aria-label') + ': overlapping controls');
      if (thinking.height < 43 || supplier.height < 43 || thinking.left < box.left - 1 || thinking.right > box.right + 1 || supplier.left < box.left - 1 || supplier.right > box.right + 1) issues.push(control.getAttribute('aria-label') + ': outside row');
      rows.push({ name: control.getAttribute('aria-label'), width: Math.round(box.width), wrapped: thinking.top > supplier.bottom - 1 });
    }
    return { viewport: { width: innerWidth, height: innerHeight }, rows, issues };
  });
  assert.deepEqual(result.issues, [], label + ': thinking/provider/name controls must stay separate and inside their row');
  assert.ok(result.rows.length >= 15); (proof.layout ||= {})[label] = result;
}
async function checkThinkingTooltip(label) {
  const control = thinkingControl(), tooltip = page.locator('#llm-thinking-textbook-blueprint');
  const row = control.locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
  await control.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await groupSelect().focus();
  await tooltip.waitFor({ state: 'hidden' });
  const initialBox = await row.boundingBox();
  await control.hover(); await tooltip.waitFor({ state: 'visible' });
  assert.equal(await tooltip.getAttribute('role'), 'tooltip');
  assert.equal(await tooltip.innerText(), '该模型不能关闭思考，实际使用最低档。');
  assert.ok((await control.getAttribute('aria-describedby')).split(' ').includes(await tooltip.getAttribute('id')));
  await page.mouse.move(0, 0); await tooltip.waitFor({ state: 'hidden' });
  await control.focus(); await tooltip.waitFor({ state: 'visible' });
  const appearance = await tooltip.evaluate(node => {
    const root = document.documentElement, previous = root.className;
    const position = getComputedStyle(node).position, light = getComputedStyle(node).backgroundColor;
    root.classList.add('dark'); const dark = getComputedStyle(node).backgroundColor; root.className = previous;
    return { position, light, dark };
  });
  assert.equal(appearance.position, 'absolute', 'the capability explanation must not occupy another line');
  assert.notEqual(appearance.light, appearance.dark, 'the floating explanation follows the dark theme');
  await page.screenshot({ path: path.join(root, 'workflow-thinking-tooltip-' + label + '.png') });
  await groupSelect().focus(); await tooltip.waitFor({ state: 'hidden' });
  const finalBox = await row.boundingBox();
  assert.equal(finalBox.height, initialBox.height, 'hover/focus explanations must not shift workflow row height');
  (proof.tooltips ||= {})[label] = { hover: true, keyboardFocus: true, hiddenAfterLeaving: true, rowHeight: finalBox.height, ...appearance };
}
async function checkThinkingHelp() {
  const trigger = page.getByRole('button', { name: '思考模式说明', exact: true }), tooltip = page.locator('#llm-thinking-help');
  await trigger.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await groupSelect().focus();
  await tooltip.waitFor({ state: 'hidden' });
  const before = await trigger.boundingBox();
  await trigger.hover(); await tooltip.waitFor({ state: 'visible' });
  await page.mouse.move(0, 0); await tooltip.waitFor({ state: 'hidden' });
  await trigger.focus(); await tooltip.waitFor({ state: 'visible' });
  assert.equal(await tooltip.evaluate(node => getComputedStyle(node).position), 'absolute');
  assert.match(await tooltip.innerText(), /默认沿用各功能原有策略/u);
  assert.equal(await trigger.getAttribute('aria-describedby'), 'llm-thinking-help');
  assert.deepEqual(await trigger.boundingBox(), before, 'shared explanations must not shift the heading');
  await groupSelect().focus(); await tooltip.waitFor({ state: 'hidden' });
  proof.checks.push('Shared thinking instructions stay in a hover and keyboard-focus tooltip beside the heading, without a permanent instruction row');
}
async function enter(id) { await page.getByRole('button', { name: '学习', exact: true }).click(); await page.getByRole('heading', { name: '学习队列', exact: true }).waitFor(); const card = page.locator('button.flow-project-card').filter({ hasText: titles[id] }); if (await card.count()) await card.click(); else { assert.equal(await page.locator('.learn-next-card h2').innerText(), titles[id]); await page.getByRole('button', { name: '进入心流', exact: true }).click(); } await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click(); await page.getByRole('button', { name: '退出并保存', exact: true }).waitFor(); const analysis = page.locator('.focus-flow-analysis-control [role="switch"]'); if (await analysis.getAttribute('aria-checked') === 'true') await analysis.click(); }
async function exitFlow() { await page.getByRole('button', { name: '退出并保存', exact: true }).click(); await page.locator('.flow-mode-container').waitFor({ state: 'detached' }); }
async function blocked(count, kind) { await page.locator('.progressive-course-error').waitFor(); const message = await page.locator('.progressive-course-error').innerText(); assert.match(message, /供应商|DeepSeek|停用|不可用/u); assert.equal((await streamEvents()).length, count); proof.checks.push(kind + ': actual progressive generation refuses invalid route before stream/model IPC'); return message; }
async function ready() { await page.waitForFunction(() => document.querySelector('[data-progressive-course]')?.getAttribute('data-status') === 'ready', null, { timeout: 30000 }); }
const preserved = settings => { assert.equal(settings.providers.find(provider => provider.id === ds.id).enabled, false); assert.equal(settings.providers.find(provider => provider.id === glmId).selectedModel, 'glm-5.3'); for (const [workflow, providerId] of Object.entries(explicit)) assert.equal(settings.workflowBinding[workflow], providerId); };
try {
  await launch(); await settings(); await directControls();
  await checkThinkingHelp();
  assert.equal(await groupSelect().inputValue(), ds.id); assert.equal(await groupSelect().locator('option[value="deepseek-default"]').isDisabled(), true);
  assert.match(await page.locator('.settings-page').innerText(), /渐进式教材/u); assert.deepEqual(await readSettings(), initial, 'opening settings must not migrate or overwrite legacy bindings');
  assert.equal(await thinkingControl().inputValue(), 'default'); assert.equal((await readSettings()).workflowThinking, undefined);
  await groupSelect().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'legacy-disabled-workflow.png') });
  await enter('default'); proof.initialBlockedMessage = await blocked(0, 'disabled legacy route'); await exitFlow(); await settings(); await groupSelect().selectOption(glmId);
  const directSaved = await until(readSettings, value => textbooks.every(workflow => value.workflowBinding[workflow] === glmId), 'explicit textbook GLM persistence'); preserved(directSaved);
  assert.equal(directSaved.defaultProviderId, ds.id); assert.deepEqual(Object.keys(directSaved.workflowBinding).sort(), [...Object.keys(explicit), ...textbooks].sort());
  await thinkingControl().selectOption('off');
  await page.getByRole('combobox', { name: 'Agent 学习助手的思考模式', exact: true }).selectOption('high');
  const thinkingSaved = await until(readSettings, value => textbooks.every(workflow => value.workflowThinking?.[workflow] === 'off') && value.workflowThinking?.['agent-chat'] === 'high', 'explicit workflow thinking persistence');
  assert.deepEqual(thinkingSaved.workflowBinding, directSaved.workflowBinding); assert.equal(thinkingSaved.defaultProviderId, ds.id);
  await checkThinkingTooltip('wide');
  assert.deepEqual(await readSettings(), thinkingSaved, 'hover/focus explanations cannot change settings');
  await checkThinkingLayout('wide');
  const resized = await page.evaluate(() => window.llmRouteTest.command({ op: 'resize', width: 860, height: 800 }));
  await page.waitForFunction(() => innerWidth <= 860); await pause(100); await thinkingControl().scrollIntoViewIfNeeded(); await checkThinkingLayout('narrow');
  await checkThinkingTooltip('narrow');
  await page.screenshot({ path: path.join(root, 'workflow-thinking-narrow.png') });
  await page.evaluate(bounds => window.llmRouteTest.command({ op: 'resize', width: bounds.width, height: bounds.height }), resized.previous);
  await pause(100);
  await groupSelect().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'direct-textbook-glm.png') }); await close();
  await launch(); await settings(); await directControls(); assert.equal(await groupSelect().inputValue(), glmId); preserved(await readSettings()); assert.equal((await readSettings()).defaultProviderId, ds.id);
  assert.equal(await thinkingControl().inputValue(), 'off');
  assert.equal(await page.getByRole('combobox', { name: 'Agent 学习助手的思考模式', exact: true }).inputValue(), 'high');
  await thinkingControl().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'workflow-thinking-restored.png') });
  await thinkingControl().selectOption('default');
  const groupDefault = await until(readSettings, value => textbooks.every(workflow => value.workflowThinking?.[workflow] === undefined), 'default restores original textbook policy');
  assert.equal(groupDefault.workflowThinking?.['agent-chat'], 'high', 'resetting a group preserves unrelated workflow preferences');
  await page.getByRole('combobox', { name: 'Agent 学习助手的思考模式', exact: true }).selectOption('default');
  await until(readSettings, value => value.workflowThinking === undefined, 'final default clears the optional field');
  assert.deepEqual((await readSettings()).workflowBinding, directSaved.workflowBinding);
  proof.checks.push('Five thinking choices persist independently of supplier routes across a complete desktop restart; default clears only the chosen group and restores the original policy without automatic model calls');
  await enter('default'); if (await page.getByRole('button', { name: '重新尝试', exact: true }).count()) await page.getByRole('button', { name: '重新尝试', exact: true }).click(); await ready(); assert.equal((await streamEvents()).length, 1); await exitFlow();
  proof.checks.push('A direct textbook supplier choice persists across complete Electron restart and repairs the same interrupted course, leaving legacy default and explicit chat/plan bindings unchanged');
  // Independent synthetic scenario: valid GLM default but explicitly disabled
  // textbook binding. An explicit invalid route must not fall back to GLM.
  await page.evaluate(() => window.llmRouteTest.command({ op: 'seed-explicit-disabled' })); await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).waitFor(); await settings(); await directControls(); assert.equal(await groupSelect().inputValue(), ds.id); assert.equal(await groupSelect().locator('option[value="deepseek-default"]').isDisabled(), true); preserved(await readSettings());
  await enter('group'); proof.explicitBlockedMessage = await blocked(1, 'disabled explicit textbook group with an enabled default'); await exitFlow(); await settings(); await groupSelect().selectOption(glmId);
  const groupSaved = await until(readSettings, value => textbooks.every(workflow => value.workflowBinding[workflow] === glmId), 'textbook group persistence'); preserved(groupSaved); assert.equal(groupSaved.defaultProviderId, glmId); assert.deepEqual(Object.keys(groupSaved.workflowBinding).sort(), [...Object.keys(explicit), ...textbooks].sort()); await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).waitFor(); await settings(); await directControls(); assert.equal(await groupSelect().inputValue(), glmId); await groupSelect().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'textbook-group-glm.png') });
  await enter('group'); if (await page.getByRole('button', { name: '重新尝试', exact: true }).count()) await page.getByRole('button', { name: '重新尝试', exact: true }).click(); await ready(); assert.equal((await streamEvents()).length, 2); await exitFlow(); proof.checks.push('textbook group changes exactly three textbook workflows; invalid explicit bindings never silently fall back, and user-selected GLM persists after reload');
  await page.evaluate(() => window.llmRouteTest.command({ op: 'seed-automatic' })); await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).waitFor(); await settings(); await directControls();
  assert.equal(await groupSelect().inputValue(), glmId); assert.deepEqual(await readSettings(), legacyAutomatic, 'legacy fallback is shown as its effective supplier without materializing any bindings');
  await enter('automatic'); await ready(); await page.screenshot({ path: path.join(root, 'glm-progressive-ready.png') }); await exitFlow(); const streams = await streamEvents(); assert.equal(streams.length, 3); assert.ok(streams.every(event => event.providerId === glmId && event.model === 'glm-5.3')); proof.streams = streams; proof.finalSettings = await readSettings(); preserved(proof.finalSettings); assert.deepEqual(proof.finalSettings, legacyAutomatic);
  proof.checks.push('Legacy configurations without a route still use the first enabled GLM and show it directly; no default/follow selector is exposed, no settings migration, no disabled supplier revival');
  // No synthetic default object is injected here: removing only this isolated
  // profile's settings lets the production renderer create its actual defaults.
  await page.evaluate(async () => { await window.llmRouteTest.command({ op: 'seed-first-run' }); localStorage.removeItem('loginote_llm_settings'); });
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).waitFor(); await settings(); await directControls(true);
  const freshDefaults = await page.evaluate(() => JSON.parse(localStorage.getItem('loginote_llm_settings')));
  assert.deepEqual(freshDefaults, { providers: [], defaultProviderId: '', workflowBinding: {} });
  assert.equal(await groupSelect().inputValue(), '');
  await assert.rejects(fsp.stat(path.join(state, 'user-state/llm.json')), { code: 'ENOENT' }, 'read-only first-run setup cannot persist defaults by merely opening settings');
  await groupSelect().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'first-model-empty.png') });
  await page.getByRole('combobox', { name: '证据驱动概念补全的思考模式', exact: true }).selectOption('low');
  await until(async () => {
    try { return await readSettings(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, value => value?.workflowThinking?.['concept-generation'] === 'low', 'first-run thinking preference persistence');
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  const form = page.getByRole('form', { name: '添加模型供应商', exact: true });
  await form.getByLabel('名称', { exact: true }).fill('GLM');
  await form.getByLabel('Base URL', { exact: true }).fill('https://open.bigmodel.cn/api/paas/v4');
  await form.getByLabel('模型名称', { exact: true }).fill('glm-5.3');
  await form.getByLabel('API Key', { exact: true }).fill('synthetic-first-provider-key');
  await form.getByRole('button', { name: '添加', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  const firstAdded = await until(readSettings, value => value.providers.length === 1 && value.providers.some(provider => provider.name === 'GLM'), 'first added supplier persistence');
  const added = firstAdded.providers.find(provider => provider.name === 'GLM');
  assert.ok(added.enabled); assert.equal(added.selectedModel, 'glm-5.3');
  assert.equal(firstAdded.defaultProviderId, added.id);
  assert.equal(Object.keys(firstAdded.workflowBinding).length, 41);
  assert.ok(Object.values(firstAdded.workflowBinding).every(id => id === added.id));
  assert.deepEqual(firstAdded.workflowThinking, { 'concept-generation': 'low' });
  const workflowChoices = await page.locator('select[aria-label$="的模型供应商"]').evaluateAll(controls => controls.map(control => ({ name: control.getAttribute('aria-label'), value: control.value })));
  assert.ok(workflowChoices.length >= 15); assert.ok(workflowChoices.every(control => control.value === added.id));
  await groupSelect().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'first-model-added.png') });
  await close(); await launch(); await settings(); await directControls();
  assert.equal(await groupSelect().inputValue(), added.id); assert.deepEqual(await readSettings(), firstAdded);
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  const secondForm = page.getByRole('form', { name: '添加模型供应商', exact: true });
  await secondForm.getByLabel('名称', { exact: true }).fill('DeepSeek');
  await secondForm.getByLabel('Base URL', { exact: true }).fill('https://api.deepseek.com');
  await secondForm.getByLabel('模型名称', { exact: true }).fill('deepseek-chat');
  await secondForm.getByRole('button', { name: '添加', exact: true }).click();
  await secondForm.waitFor({ state: 'detached' });
  const secondAdded = await until(readSettings, value => value.providers.length === 2, 'second added supplier persistence');
  assert.equal(secondAdded.defaultProviderId, added.id);
  assert.deepEqual(secondAdded.workflowBinding, firstAdded.workflowBinding);
  assert.deepEqual(secondAdded.workflowThinking, firstAdded.workflowThinking);
  assert.equal(await groupSelect().inputValue(), added.id);
  assert.equal((await streamEvents()).length, 3, 'adding a provider never generates teaching or tests a model automatically');
  proof.firstProvider = { initiallyEmpty: true, added: added.name, addedModel: added.selectedModel, boundWorkflows: 41,
    workflowChoices, persistedAfterRestart: true, secondSupplierPreservesRoutesAndThinking: true, modelCallsDuringAdd: 0 };
  proof.checks.push('Actual first-run defaults are empty and read-only; the first saved GLM fills all 41 active workflow routes, preserves thinking, survives a complete desktop restart, and adding a second supplier leaves those choices unchanged');
  assert.equal(proof.errors.length, 0); assert.equal((await events()).filter(event => ['unexpected-network', 'unexpected-model'].includes(event.phase)).length, 0); await close();
} catch (error) { proof.failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  if (child?.exitCode === null) { try { await close(); } catch (error) { proof.failure ||= String(error); child.kill(); proof.exits.push(await exited); } } await browser?.close().catch(() => {}); if (fd !== undefined) fs.closeSync(fd);
  proof.mainExceptions = (await fsp.readFile(fatalFile, 'utf8')).trim(); try { const currentEntry = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1]; proof.buildIdentity = { rendererUnchanged: currentEntry === proof.renderer.entry && createHash('sha256').update(await fsp.readFile(path.join('dist/assets', currentEntry))).digest('hex') === proof.renderer.sha256, electronUnchanged: (await Promise.all(Object.entries(proof.nativeBuild.sha256).map(async ([name, digest]) => createHash('sha256').update(await fsp.readFile(path.resolve('dist-electron', name))).digest('hex') === digest))).every(Boolean) }; assert.ok(proof.buildIdentity.rendererUnchanged && proof.buildIdentity.electronUnchanged); } catch (error) { proof.failure ||= 'Built files changed during acceptance: ' + String(error); }
  proof.passed = !proof.failure && !proof.mainExceptions && proof.errors.length === 0 && proof.exits.length === 3 && proof.exits.every(exit => exit.code === 0); await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ root, passed: proof.passed, checks: proof.checks, failure: proof.failure, buildIdentity: proof.buildIdentity, exits: proof.exits, realModelRequests: 0, httpRequests: 0 }, null, 2)); if (!proof.passed) process.exitCode = 1;
}
