// Production desktop/IPC/HTTP builders; only external fetch is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { electronFiles } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'glm-native.cjs'))('playwright');
await fsp.mkdir('build', { recursive: true });
const root = await fsp.mkdtemp(path.resolve('build/glm-progressive-native-'));
const highThinking = process.argv.includes('--high-thinking');
const replayPrefix = process.argv.includes('--replay-prefix');
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
for (const dir of ['app/dist-electron', 'state/vault/notes', 'state/user-state']) await fsp.mkdir(path.join(root, dir), { recursive: true });
const at = '2026-11-09T00:00:00Z';
const titles = { normal: 'GLM 思考阶段离线验收', interrupted: 'GLM 续写恢复离线验收' };
const notes = Object.entries(titles).map(([id, title]) => ({ id: 'glm-native-' + id, title, noteType: 'project', projectRole: 'learning', content: '# 学习目标\n\n理解函数输入与输出的对应关系，能够说明同一输入必须对应唯一输出。', planMeta: { status: 'active', dailyStudyMinutes: 30 }, tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at }));
const meta = {};
for (const note of notes) { const { content, ...metadata } = note; meta[note.id] = metadata; await fsp.writeFile(path.join(state, 'vault/notes', note.id + '.md'), content); }
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: meta }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false } }));
const provider = { id: 'glm-native', name: '离线 GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: at };
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [provider], defaultProviderId: provider.id, workflowBinding: {}, ...(highThinking ? { workflowThinking: { 'textbook-chapter': 'high' } } : {}) } }));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'glm-progressive-native-check', version: '1.0.0' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
const nativeFiles = new Map(await Promise.all(electronFiles.map(async name => [name, await fsp.readFile(path.resolve('dist-electron', name))])));
for (const [name, buffer] of nativeFiles) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), name === 'preload.cjs' ? Buffer.concat([buffer, Buffer.from("\nrequire('electron').contextBridge.exposeInMainWorld('glmNativeTest',{command:input=>require('electron').ipcRenderer.invoke('glm-native:command',input)});\n")]) : buffer);
const plan = { title: '函数的输入与输出', objectives: ['判断同一输入的输出是否唯一'], pages: [{ id: 'main-1', title: '用输入检查函数', objectives: ['说明函数规则'] }] };
const prefix = '# 用输入检查函数\n\n给定一个规则，先看允许哪些输入，再看每个输入是否都有唯一输出。这里用合成材料演示教材的生成过程，内容不代表真实模型的教学能力。\n\n## 观察同一个输入\n\n设规则把每个数变为它的平方，输入二得到四，输入负二也得到四。不同输入可以得到同一个输出，这并不破坏函数的定义。\n\n';
const suffix = '## 说明判断条件\n\n判断时固定一个输入，检查输出是否唯一，而不是反过来要求不同输入一定得到不同输出。这一条件解释了平方函数的例子，也能帮助比较其他对应关系。\n';
const tail = '\n@@CONCEPTS\n[]\n@@QUESTIONS\n[]\n@@HOOK\n' + JSON.stringify({ id: 'hook-main-1', kind: 'reflection', prompt: '请说明为什么不同输入可以有同一个输出。' }) + '\n@@END';
const header = '@@PLAN\n' + JSON.stringify(plan) + '\n@@LESSON\n';
const eventsFile = path.join(root, 'events.jsonl'), fatalFile = path.join(root, 'main-exceptions.jsonl');
await fsp.writeFile(eventsFile, ''); await fsp.writeFile(fatalFile, '');
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{app,ipcMain,utilityProcess,dialog}=require('electron'),{EventEmitter}=require('node:events');
const root=${JSON.stringify(root)},header=${JSON.stringify(header)},prefix=${JSON.stringify(prefix)},suffix=${JSON.stringify(suffix)},tail=${JSON.stringify(tail)},secret='PRIVATE_REASONING_NOT_A_LESSON',runs=[];
const log=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({...event,at:Date.now()})+'\\n');
const fatal=(phase,error)=>{const detail={phase,message:error?.message||String(error),stack:error?.stack||String(error)};fs.appendFileSync(path.join(root,'main-exceptions.jsonl'),JSON.stringify(detail)+'\\n');process.exit(1)};
process.prependListener('uncaughtException',error=>fatal('main-uncaught',error));process.prependListener('unhandledRejection',error=>fatal('main-unhandled',error));dialog.showErrorBox=(title,content)=>fatal('main-dialog',Error(title+' '+content));
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true};return worker};
globalThis.fetch=async(url,init)=>{const body=JSON.parse(init?.body||'{}');assert.equal(String(url),'https://open.bigmodel.cn/api/paas/v4/chat/completions');assert.equal(body.model,'glm-5.3');assert.equal(body.stream,true);assert.equal(body.thinking?.type,'enabled');assert.equal(body.reasoning_effort,${JSON.stringify(highThinking ? 'max' : 'low')});assert.equal(body.max_tokens,${highThinking ? 26000 : 13000});const index=runs.length;let output;const stream=new ReadableStream({start(controller){output=controller;init.signal.addEventListener('abort',()=>{log({phase:'aborted',index});try{controller.error(new DOMException('Aborted','AbortError'))}catch{}},{once:true})}});runs.push({output,body,signal:init.signal});log({phase:'http-fixture',index,body});return new Response(stream,{headers:{'Content-Type':'text/event-stream'}})};
const send=(index,delta)=>{const run=runs[index];assert.ok(run&&!run.signal.aborted,'active synthetic SSE required');run.output.enqueue(new TextEncoder().encode('data: '+JSON.stringify({model:'glm-5.3',choices:[{delta}]})+'\\n\\n'))};
ipcMain.handle('glm-native:command',async(_event,input)=>{if(input.op==='exit'){setTimeout(()=>app.exit(0),40);return true}const index=input.index??runs.length-1;if(input.op==='reasoning'){send(index,{reasoning_content:secret});return true}if(input.op==='prefix'){send(index,{content:header+prefix});return true}if(input.op==='finish'){if(index===2&&${JSON.stringify(replayPrefix)}){const saved=JSON.parse(runs[index].body.messages.at(-1).content).savedBody;assert.ok(typeof saved==='string'&&saved.length>=100);const replay='@@LESSON\\n'+saved;for(let offset=0;offset<replay.length;offset+=7)send(index,{content:replay.slice(offset,offset+7)});send(index,{content:suffix+tail})}else send(index,{content:(index===2?'@@LESSON\\n':'')+suffix+tail});runs[index].output.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n'));runs[index].output.close();return true}});
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{if(channel==='llm:stream-start'){const req=args[0];assert.deepEqual(req.streamTimeout,{firstResponseMs:180000,idleMs:90000,totalMs:600000});assert.equal(req.includeActivity,true);log({phase:'stream-ipc',request:req})}if(/^llm:(?:request|probe|models)$/u.test(channel))throw Error('Unexpected nonstream model call');return handler(event,...args)});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const sha = value => createHash('sha256').update(value).digest('hex');
const renderer = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1];
const proof = { root, passed: false, replayPrefix, checks: [], errors: [], exits: [], realModelRequests: 0, networkCalls: 0, renderer: { entry: renderer, sha256: sha(await fsp.readFile(path.join('dist/assets', renderer))) }, nativeSha256: Object.fromEntries([...nativeFiles].map(([name, buffer]) => [name, sha(buffer)])) };
let executable, child, browser, page, fd, exited, launches = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, label, timeout = 25000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await read(); if (accepts(last)) return last; await pause(100); } throw Error(label + ': ' + JSON.stringify(last)); }
const events = async () => (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const http = async () => (await events()).filter(event => event.phase === 'http-fixture');
const command = input => page.evaluate(input => window.glmNativeTest.command(input), input);
async function launch() { const filename = path.join(root, 'process-' + (++launches) + '.log'); fd = fs.openSync(filename, 'w'); const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, SAVE_NATIVE_REAL_DIALOG: 'auto' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; child = spawn(executable, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] }); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); const endpoint = await until(async () => { const text = await fsp.readFile(filename, 'utf8'); if (child.exitCode !== null) throw Error(text.slice(-2000)); return text.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; }, Boolean, 'desktop startup', 40000); browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(18000); page.on('pageerror', error => proof.errors.push(error.message)); await page.getByRole('button', { name: '设置', exact: true }).waitFor({ timeout: 45000 }); }
async function close() { await command({ op: 'exit' }); const result = await exited; proof.exits.push(result); await browser.close().catch(() => {}); browser = undefined; fs.closeSync(fd); fd = undefined; assert.equal(result.code, 0); }
async function enter(id) { await page.getByRole('button', { name: '学习', exact: true }).click(); await page.getByRole('heading', { name: '学习队列', exact: true }).waitFor(); const card = page.locator('button.flow-project-card').filter({ hasText: titles[id] }); if (await card.count()) await card.click(); else { assert.equal(await page.locator('.learn-next-card h2').innerText(), titles[id]); await page.getByRole('button', { name: '进入心流', exact: true }).click(); } await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click(); await page.getByRole('button', { name: '退出并保存', exact: true }).waitFor(); const analysis = page.locator('.focus-flow-analysis-control [role="switch"]'); if (await analysis.getAttribute('aria-checked') === 'true') await analysis.click(); }
async function exitFlow() { await page.getByRole('button', { name: '退出并保存', exact: true }).click(); await page.locator('.flow-mode-container').waitFor({ state: 'detached' }); }
async function phase(value) { await page.waitForFunction(value => document.querySelector('[data-progressive-course]')?.getAttribute('data-status') === value, value); }
try {
  executable = await prepareElectronRuntime();
  await launch(); await enter('normal'); await until(http, value => value.length === 1, 'first actual HTTP fixture');
  await page.getByText('正在等待模型响应', { exact: true }).waitFor(); await page.screenshot({ path: path.join(root, 'waiting.png') });
  await command({ op: 'reasoning', index: 0 }); await page.getByText('模型正在思考，尚未开始输出正文', { exact: true }).waitFor();
  assert.ok(!(await page.locator('[data-lesson-content]').innerText()).includes('PRIVATE_REASONING')); await page.screenshot({ path: path.join(root, 'reasoning.png') });
  await command({ op: 'prefix', index: 0 }); await page.getByText('正在续写讲解，可以继续阅读和复述…', { exact: true }).waitFor(); await page.screenshot({ path: path.join(root, 'responding.png') });
  await command({ op: 'reasoning', index: 0 }); assert.equal(await page.getByText('模型正在思考，尚未开始输出正文', { exact: true }).count(), 0);
  await command({ op: 'finish', index: 0 }); await phase('ready'); await page.screenshot({ path: path.join(root, 'ready.png') });
  const normalId = await page.locator('[data-progressive-course]').getAttribute('data-course-id');
  proof.checks.push('Production Reader: waiting → reasoning without prose → readable response → ready; late reasoning cannot regress phase');
  await exitFlow(); await enter('interrupted'); await until(http, value => value.length === 2, 'second fixture'); await command({ op: 'prefix', index: 1 }); await page.getByText('正在续写讲解，可以继续阅读和复述…', { exact: true }).waitFor();
  const interruptedId = await page.locator('[data-progressive-course]').getAttribute('data-course-id');
  await exitFlow(); await until(events, value => value.some(event => event.phase === 'aborted' && event.index === 1), 'exit cancellation');
  await enter('interrupted'); await phase('interrupted'); assert.equal((await http()).length, 2, 'no automatic regeneration');
  assert.equal(await page.locator('[data-progressive-course]').getAttribute('data-course-id'), interruptedId);
  await page.getByRole('button', { name: '继续生成', exact: true }).click(); await until(http, value => value.length === 3, 'explicit retry');
  const retry = (await http())[2], input = JSON.parse(retry.body.messages.at(-1).content); assert.equal(input.savedBody.trim(), prefix.trim());
  await command({ op: 'finish', index: 2 }); await phase('ready'); assert.equal(await page.locator('[data-progressive-course]').getAttribute('data-course-id'), interruptedId);
  if (replayPrefix) {
    const text = await page.locator('[data-lesson-content]').innerText();
    assert.equal(text.split('给定一个规则').length - 1, 1, 'Exact savedBody replay must not duplicate previously visible prose');
    proof.checks.push('Seven-character SSE packets replay the actual savedBody beyond the 100-character boundary, then append only new prose without losing or duplicating the saved page');
  }
  await exitFlow();
  proof.checks.push('Exit stops real IPC/SSE; same-course prefix preserved and explicitly resumed with savedBody, no automatic retry');
  await close(); await launch(); await enter('normal'); await phase('ready'); assert.equal(await page.locator('[data-progressive-course]').getAttribute('data-course-id'), normalId); assert.equal((await http()).length, 3); await exitFlow(); await close();
  proof.checks.push('Complete desktop restart restores saved course without issuing another HTTP/model request');
} catch (error) { proof.failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  if (child?.exitCode === null) { try { await close(); } catch (error) { proof.failure ||= String(error); child.kill(); proof.exits.push(await exited); } }
  await browser?.close().catch(() => {}); if (fd !== undefined) fs.closeSync(fd);
  proof.mainExceptions = (await fsp.readFile(fatalFile, 'utf8')).trim();
  const currentEntry = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1];
  proof.buildIdentity = { rendererUnchanged: renderer === currentEntry && proof.renderer.sha256 === sha(await fsp.readFile(path.join('dist/assets', currentEntry))), electronUnchanged: (await Promise.all(Object.entries(proof.nativeSha256).map(async ([name, digest]) => digest === sha(await fsp.readFile(path.resolve('dist-electron', name)))))).every(Boolean) };
  proof.fixtureHttpRequests = (await http()).length; proof.launches = launches;
  const files = async directory => { let found = []; for (const entry of await fsp.readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, entry.name); found = found.concat(entry.isDirectory() ? await files(filename) : [filename]); } return found; };
  const persisted = await Promise.all((await files(state)).filter(filename => /\.(json|md)$/u.test(filename)).map(filename => fsp.readFile(filename, 'utf8')));
  proof.rawReasoningPersisted = persisted.some(value => value.includes('PRIVATE_REASONING_NOT_A_LESSON'));
  proof.passed = !proof.failure && !proof.mainExceptions && !proof.rawReasoningPersisted && proof.errors.length === 0 && proof.exits.length === 2 && proof.buildIdentity.rendererUnchanged && proof.buildIdentity.electronUnchanged;
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ root, passed: proof.passed, checks: proof.checks, failure: proof.failure, errors: proof.errors, fixtureHttpRequests: proof.fixtureHttpRequests, realModelRequests: 0, networkCalls: 0, buildIdentity: proof.buildIdentity }, null, 2));
  if (!proof.passed) process.exitCode = 1;
}
