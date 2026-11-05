import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { writeTextbookRegion } from '../src/services/textbook/noteContent.ts';

// Production Electron/main/preload/renderer and disk, isolated data only.
// SSE is deterministic and all networking is blocked: this proves workflow,
// persistence and failure handling, not the quality of an actual model's prose.
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-phase1-check.cjs'))('playwright');
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase1-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fsp.writeFile(path.join(root, 'ipc.jsonl'), '');
await fsp.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fsp.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fsp.mkdir(path.join(state, 'user-state'), { recursive: true });
const at = '2026-11-01T00:00:00.000Z';
const makeNote = (id, title, extra = {}) => ({ id, title, noteType: 'project', projectRole: 'learning', content: '# 学习目标\n理解函数与定义域。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...extra });
const parent = makeNote('progressive-check-root', '阶段一独立验收', { planMeta: { status: 'active', dailyStudyMinutes: 30 } });
const normal = makeNote('progressive-normal', '第一页生成与恢复', { parentId: parent.id });
const interrupted = makeNote('progressive-interrupted', '断流后继续生成', { parentId: parent.id });
const failedSave = makeNote('progressive-save-failure', '保存失败后重试', { parentId: parent.id });
const nativeClose = makeNote('progressive-native-close', '生成中关闭再恢复', { parentId: parent.id });
const legacy = writeTextbookRegion(makeNote('progressive-legacy', '已有完整教材', { parentId: parent.id }),
  '# 完整旧教材\n\n已有教材正文保持原样，进入时不应该触发渐进生成。\n\n定义域说明允许输入的范围。',
  { schemaVersion: 1, textbookId: 'old-book', projectNoteId: 'progressive-legacy', rootProjectId: parent.id,
    revisionId: 'old-revision', regionId: 'old-region', createdAt: at, updatedAt: at });
const knowledge = makeNote('progressive-knowledge', '知识笔记不初始化课程', { noteType: 'knowledge', projectRole: undefined });
const notes = [parent, normal, interrupted, failedSave, nativeClose, legacy, knowledge];
const notesMeta = {};
for (const note of notes) {
  const { content, ...meta } = note;
  notesMeta[note.id] = meta;
  await fsp.writeFile(path.join(state, 'vault/notes', note.id + '.md'), content);
}
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: {
  theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false,
} }));
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: {
  providers: [{ id: 'deepseek-default', name: '阶段一确定性验收模型', apiType: 'openai-compatible', baseUrl: 'https://phase1.invalid',
    apiKey: '', enabled: true, models: ['phase1-fixture'], selectedModel: 'phase1-fixture', createdAt: at }],
  defaultProviderId: 'deepseek-default', workflowBinding: { 'textbook-chapter': 'deepseek-default' },
} }));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'progressive-learning-stage1-check', version: '1.0.10' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
for (const [name, buffer] of await compileElectron(process.cwd())) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), buffer);
const plan = { title: '函数与定义域', objectives: ['区分唯一对应与定义域限制'], pages: [
  { id: 'main-1', title: '唯一对应与定义域', objectives: ['识别函数关系'] },
  { id: 'main-2', title: '极限的两种入口', objectives: ['理解趋近过程'] },
  { id: 'main-3', title: '极限的综合判断', objectives: ['说明边界条件'] },
] };
const prefix = '# 唯一对应与定义域\n\n函数把允许的每个输入对应到唯一的输出。判断一个关系时，首先检查同一个输入是否得到两个不同输出。\n\n定义域说明允许输入的范围，不能只看公式就忽略输入限制。';
const continuation = '\n\n## 怎样判断\n\n观察对应关系时，先确认研究对象、输入范围和输出规则。只要一个允许的输入对应到两个不同输出，这个关系就不满足函数的唯一性要求。不同输入对应同一个输出则是允许的。\n\n## 用例子核对\n\n平方根要求根号中的表达式非负，分式要求分母不为零。先分别写出限制，再求这些限制的交集，可以得到实际定义域。\n\n> **交互探索**\n>\n> 改变输入并观察平方函数的变化。\n\n## 连接下一步\n\n极限研究的是输入沿着允许路径变化时，输出呈现什么趋势。先把定义域说清楚，才能判断所讨论的趋近路径是否存在。';
const hook = { id: 'hook-main-1', kind: 'reflection', prompt: '请举例说明：为什么判断函数时必须同时说明定义域与对应规则？' };
const firstResponse = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const resumeResponse = `@@LESSON\n${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('phase1Test',{command: input=>require('electron').ipcRenderer.invoke('progressive-test:command',input)});`);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network blocked by isolated progressive acceptance');};
const fs=require('node:fs'),{app,ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={mode:'normal',failPublishes:0,failPersonalSaves:0,calls:0,figureCalls:0};
const timers=new Map();
ipcMain.handle('progressive-test:command',async(_e,input)=>{if(input.op==='mode')control.mode=input.value;if(input.op==='fail-publish')control.failPublishes=input.value;if(input.op==='fail-personal')control.failPersonalSaves=input.value;if(input.op==='close-window')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);if(input.op==='figure'){const child=BrowserWindow.getAllWindows()[0]?.contentView.children.find(view=>view.webContents);return {...control,found:!!child,visible:child?.getVisible(),value:child?await child.webContents.executeJavaScript('document.querySelector("#value")?.textContent'):''};}return {...control};});
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>{log({phase:'background',operation:message.operation,noteId:message.args?.input?.noteId,pageId:message.args?.input?.regionId});setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));};worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true;};return worker;};
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='llm:request'){control.figureCalls++;log({phase:'figure-model'});const goal=JSON.parse(args[0].userInput).goal;return {content:JSON.stringify({design:{anchor:goal,goal:'理解状态',action:'调整输入',observation:'观察结果',model:'教学示意',prediction:'先预测',caveat:'示例假设',transfer:'换个情境'},html:'<label>输入<input id="slider" type="range" value="2"></label><output id="value">2</output><script>document.querySelector("#slider").oninput=e=>document.querySelector("#value").textContent=e.target.value</script><input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换个情境</p>'}),diagnostics:{finishReason:'stop'}};}
 if(channel==='vault:save-personal-state'&&control.failPersonalSaves>0){control.failPersonalSaves--;log({phase:'personal-save-failed'});throw Error('合成个人状态保存失败');}
 if(channel==='llm:stream-start'){
  const mode=control.mode,streamId='phase1-stream-'+(++control.calls);log({phase:'model-start',mode,streamId});
  const full=mode==='malformed'?${JSON.stringify(firstResponse.replace(JSON.stringify(hook), '{"id":'))}:mode==='resume'?${JSON.stringify(resumeResponse)}:${JSON.stringify(firstResponse)};
  const end=['interrupt','hold'].includes(mode)?full.indexOf('\\n\\n## 怎样判断'):full.length;
  const input=full.slice(0,end),chunks=input.match(/[\\s\\S]{1,75}/g)||[];let index=0;
  const timer=setInterval(()=>{if(event.sender.isDestroyed()){clearInterval(timer);return;}if(index<chunks.length){event.sender.send('llm:stream-chunk',{streamId,chunk:{type:'content',text:chunks[index++]}});}else{clearInterval(timer);timers.delete(streamId);if(mode==='hold'){log({phase:'stream-held',streamId});return;}if(mode==='interrupt')event.sender.send('llm:stream-error',{streamId,message:'合成断流验收'});else event.sender.send('llm:stream-end',{streamId});}},90);timers.set(streamId,timer);return streamId;
 }
 if(channel==='llm:cancel'){const timer=timers.get(args[0]);if(timer)clearInterval(timer);timers.delete(args[0]);return true;}
 if(channel==='progressive-learning:command'){
  const command=args[0];log({phase:'progressive-start',op:command?.op,projectNoteId:command?.projectNoteId||command?.lease?.projectNoteId});
  if(command?.op==='publish'&&control.failPublishes>0){control.failPublishes--;log({phase:'publish-failed'});throw Error('合成课程保存失败');}
  const result=await handler(event,...args);log({phase:'progressive-ack',op:command?.op,projectNoteId:result?.projectNoteId||result?.course?.projectNoteId,status:result?.generation?.status||result?.course?.generation?.status});return result;
 }
 return handler(event,...args);
});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);

const runtime = await prepareElectronRuntime(process.env.PROGRESSIVE_TEST_ELECTRON
  ? { executable: process.env.PROGRESSIVE_TEST_ELECTRON } : {});
const proof = { root, checks: [], pageErrors: [], rendererRestarts: 0, network: 'blocked', generationQuality: 'not assessed: deterministic stream fixture' };
let child, browser, page, fd, exitPromise;
async function launch() {
  const logFile = path.join(root, `process-${++proof.rendererRestarts}.log`);
  fd = fs.openSync(logFile, 'w');
  const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_REAL_DIALOG: 'auto' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(runtime, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] });
  exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let endpoint;
  for (let index = 0; index < 300; index++) {
    endpoint = (await fsp.readFile(logFile, 'utf8')).match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
    if (endpoint) break;
    if (child.exitCode !== null) throw Error(`Native process exited before renderer: ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(endpoint, 'native debugging endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => proof.pageErrors.push(error.message));
  await page.getByRole('button', { name: '学习', exact: true }).waitFor({ timeout: 45000 });
}
async function enterFlow(title) {
  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('heading', { name: '学习队列', exact: true }).waitFor();
  const card = page.locator('button.flow-project-card').filter({ hasText: title });
  if (await card.count()) await card.click();
  else {
    assert.equal(await page.locator('.learn-next-card h2').innerText(), title);
    await page.getByRole('button', { name: '进入心流', exact: true }).click();
  }
  await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click();
  await page.getByRole('button', { name: '退出并保存', exact: true }).waitFor();
  const analysisSwitch=page.locator('.focus-flow-analysis-control [role="switch"]');if(await analysisSwitch.getAttribute('aria-checked')==='true')await analysisSwitch.click();
}
async function exitFlow() {
  await page.getByRole('button', { name: '退出并保存', exact: true }).click();
  await page.locator('.flow-mode-container').waitFor({ state: 'detached', timeout: 15000 });
}
async function closeNative() {
  const closeButton = page.getByRole('button', { name: '关闭', exact: true });
  if (await closeButton.count()) await closeButton.click();
  else await page.evaluate(() => window.phase1Test.command({ op: 'close-window' }));
  let timer;
  const receipt = await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 20000); })]);
  clearTimeout(timer);
  assert.equal(receipt.code, 0, 'real Windows process must exit cleanly');
  await browser.close().catch(() => undefined);
  fs.closeSync(fd); fd = undefined;
}
async function events() {
  return (await fsp.readFile(path.join(root, 'ipc.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function modelCalls() { return (await events()).filter(event => event.phase === 'model-start').length; }
async function courseFiles(directory = path.join(state, 'user-state/progressive-learning')) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await courseFiles(file));
    else if (entry.name === 'course.json') result.push({ file, data: JSON.parse(await fsp.readFile(file, 'utf8')) });
  }
  return result;
}
const reader = () => page.locator('[data-progressive-course]');
const waitReady = () => page.waitForFunction(() => document.querySelector('[data-progressive-course]')?.getAttribute('data-status') === 'ready', {}, { timeout: 30000 });

try {
  await launch();
  if (process.env.PROGRESSIVE_NATIVE_TARGET === 'malformed') {
    await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'malformed' }));
    await enterFlow(normal.title);
    await page.getByRole('button', { name: '继续生成', exact: true }).waitFor({ timeout: 30000 });
    const failed = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), normal.id);
    assert.ok(failed.generation.bodyDraft.includes('函数把允许的每个输入对应到唯一的输出。'));
    assert.equal(failed.pages.length, 0, 'malformed interaction metadata must never be published');
    await page.locator('.flow-restate-textarea').fill('PRIVATE_MALFORMED_DRAFT');
    await exitFlow();
    const calls = await modelCalls(); await closeNative(); await launch(); await enterFlow(normal.title);
    await page.getByRole('button', { name: '继续生成', exact: true }).waitFor({ timeout: 30000 });
    const restored = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), normal.id);
    assert.equal(restored.id, failed.id); assert.equal(restored.pages.length, 0); assert.equal(await modelCalls(), calls);
    assert.equal(restored.progress.restatementDraft, 'PRIVATE_MALFORMED_DRAFT');
    assert.ok(restored.generation.bodyDraft.includes('函数把允许的每个输入对应到唯一的输出。'));
    assert.equal(await fsp.readFile(path.join(state, 'vault/notes', normal.id + '.md'), 'utf8'), normal.content);
    await page.screenshot({ path: path.join(root, 'malformed-restored.png') });
    await exitFlow(); await closeNative();
    proof.checks.push('格式异常不发布或标记完成，已显示正文和私人草稿可保存，原笔记未被覆盖');
    proof.checks.push('异常页原生关闭重启恢复同课程、正文和复述，不自动重复请求模型');
    assert.deepEqual(proof.pageErrors, []);
  } else if (process.env.PROGRESSIVE_NATIVE_TARGET === 'exit-failure') {
    await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'hold' }));
    await enterFlow(failedSave.title);
    await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
    const targetCourseId = await reader().getAttribute('data-course-id');
    await page.locator('.flow-question-textarea').fill('PRIVATE_EXIT_FAILURE_QUESTION');
    await page.locator('.flow-question-textarea').press('Enter');
    await page.getByText('PRIVATE_EXIT_FAILURE_QUESTION', { exact: true }).waitFor();
    await page.evaluate(() => window.phase1Test.command({ op: 'fail-personal', value: 10 }));
    await page.getByRole('button', { name: '退出并保存', exact: true }).click();
    await page.getByRole('button', { name: '继续生成', exact: true }).waitFor();
    assert.equal(await page.locator('.flow-mode-container').count(), 1);
    assert.equal(await reader().getAttribute('data-course-id'), targetCourseId);
    await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
    assert.ok((await events()).some(event => event.phase === 'personal-save-failed'));
    await page.screenshot({ path: path.join(root, 'exit-save-failure-recoverable.png') });
    proof.checks.push('退出时私人问题保存失败仍留在心流，partial与问题保留，已停止流仍有继续入口');
    await page.evaluate(() => window.phase1Test.command({ op: 'fail-personal', value: 0 }));
    await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'resume' }));
    await page.getByRole('button', { name: '继续生成', exact: true }).click();
    await waitReady();
    assert.equal(await reader().getAttribute('data-course-id'), targetCourseId);
    assert.equal((await reader().innerText()).match(/函数把允许的每个输入对应到唯一的输出。/gu)?.length, 1);
    await page.getByText('PRIVATE_EXIT_FAILURE_QUESTION', { exact: true }).waitFor();
    await exitFlow();
    const privateState = JSON.parse(await fsp.readFile(path.join(state, 'user-state/user-state.json'), 'utf8'));
    assert.ok(privateState.noteStates[failedSave.id]?.questions?.some(item => item.question === 'PRIVATE_EXIT_FAILURE_QUESTION'));
    proof.checks.push('解除故障后同一页可立即续写，问题不丢失，重试退出完成真实私人落盘');
    assert.deepEqual(proof.pageErrors, []);
    await closeNative();
    proof.checks.push('目标故障恢复场景原生退出为0，无渲染异常');
  } else {
  await enterFlow(legacy.title);
  await page.locator('.textbook-reader.focus-flow-note-preview').waitFor();
  assert.equal(await reader().count(), 0);
  assert.equal(await modelCalls(), 0);
  await exitFlow();
  assert.equal(await fsp.readFile(path.join(state, 'vault/notes', legacy.id + '.md'), 'utf8'), legacy.content);
  proof.checks.push('完整旧教材进入原阅读器、无渐进初始化或模型调用、退出原文不变');

  await enterFlow(normal.title);
  await reader().waitFor();
  await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
  assert.notEqual(await reader().getAttribute('data-status'), 'ready', 'readable prose must appear before the complete response');
  await waitReady();
  const courseId = await reader().getAttribute('data-course-id'), pageId = await reader().getAttribute('data-page-id');
  assert.ok(courseId); assert.ok(pageId);
  await page.getByRole('tab', { name: '交互探索', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '当前笔记', exact: true }).getAttribute('aria-selected'), 'true', 'preparing a figure must not interrupt reading');
  await page.getByRole('button', { name: '打开交互探索', exact: true }).click();
  await page.waitForFunction(async () => (await window.phase1Test.command({ op: 'figure' })).value === '2', {}, { timeout: 30000 });
  assert.equal((await page.evaluate(() => window.phase1Test.command({ op: 'figure' }))).figureCalls, 1);
  await page.getByRole('tab', { name: '当前笔记', exact: true }).click();
  await page.locator('.flow-restate-textarea').fill('PRIVATE_NATIVE_RESTATEMENT：函数需要一个允许输入对应唯一输出。');
  await page.locator('.flow-question-textarea').fill('PRIVATE_NATIVE_QUESTION：为什么不同输入允许得到相同输出？');
  await page.locator('.flow-question-textarea').press('Enter');
  await page.getByText('PRIVATE_NATIVE_QUESTION：为什么不同输入允许得到相同输出？', { exact: true }).waitFor();
  await page.locator('.flow-question-textarea').fill('PRIVATE_NATIVE_UNSENT_QUESTION');
  const firstModelCalls = await modelCalls();
  await page.screenshot({ path: path.join(root, 'first-page-ready.png') });
  await exitFlow();
  await enterFlow(normal.title);
  await waitReady();
  await page.getByRole('button', { name: '打开交互探索', exact: true }).click();
  await page.waitForFunction(async () => (await window.phase1Test.command({ op: 'figure' })).value === '2', {}, { timeout: 30000 });
  assert.equal((await page.evaluate(() => window.phase1Test.command({ op: 'figure' }))).figureCalls, 1, 'reopening reads saved attachment without another model call');
  await page.getByRole('tab', { name: '当前笔记', exact: true }).click();
  assert.equal(await reader().getAttribute('data-course-id'), courseId);
  assert.equal(await reader().getAttribute('data-page-id'), pageId);
  assert.match(await page.locator('.flow-restate-textarea').inputValue(), /PRIVATE_NATIVE_RESTATEMENT/u);
  await page.getByText('PRIVATE_NATIVE_QUESTION：为什么不同输入允许得到相同输出？', { exact: true }).waitFor();
  assert.equal(await page.locator('.flow-question-textarea').inputValue(), 'PRIVATE_NATIVE_UNSENT_QUESTION');
  assert.equal(await modelCalls(), firstModelCalls);
  await exitFlow();
  proof.checks.push('首轮确定主线、正文流式可读，退出重进恢复同课程同页及私人草稿，不重复模型调用');

  await closeNative();
  await launch();
  await enterFlow(normal.title);
  await waitReady();
  await page.getByRole('button', { name: '打开交互探索', exact: true }).click();
  await page.waitForFunction(async () => (await window.phase1Test.command({ op: 'figure' })).value === '2', {}, { timeout: 30000 });
  assert.equal((await page.evaluate(() => window.phase1Test.command({ op: 'figure' }))).figureCalls, 0, 'native restart reuses the saved attachment');
  await page.getByRole('tab', { name: '当前笔记', exact: true }).click();
  assert.equal(await reader().getAttribute('data-course-id'), courseId);
  assert.equal(await reader().getAttribute('data-page-id'), pageId);
  assert.match(await page.locator('.flow-restate-textarea').inputValue(), /PRIVATE_NATIVE_RESTATEMENT/u);
  await page.getByText('PRIVATE_NATIVE_QUESTION：为什么不同输入允许得到相同输出？', { exact: true }).waitFor();
  assert.equal(await page.locator('.flow-question-textarea').inputValue(), 'PRIVATE_NATIVE_UNSENT_QUESTION');
  assert.equal(await modelCalls(), firstModelCalls);
  await exitFlow();
  proof.checks.push('真实原生进程退出并重启后，主线、页面、交互图及私人草稿恢复，不重复生成教材或交互图');

  await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'interrupt' }));
  await enterFlow(interrupted.title);
  await page.getByRole('button', { name: '继续生成', exact: true }).waitFor({ timeout: 30000 });
  assert.notEqual(await reader().getAttribute('data-status'), 'ready');
  await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
  const interruptedId = await reader().getAttribute('data-course-id');
  await exitFlow();
  await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'resume' }));
  await enterFlow(interrupted.title);
  await page.getByRole('button', { name: '继续生成', exact: true }).click();
  await waitReady();
  assert.equal(await reader().getAttribute('data-course-id'), interruptedId);
  const renderedBody = await reader().innerText();
  assert.equal((renderedBody.match(/函数把允许的每个输入对应到唯一的输出。/gu) || []).length, 1);
  await exitFlow();
  proof.checks.push('断流保留主线与可读前缀，退出恢复后续写同一页，不重复已保存正文');

  await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'normal' }));
  await page.evaluate(() => window.phase1Test.command({ op: 'fail-publish', value: 10 }));
  await enterFlow(failedSave.title);
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor({ timeout: 30000 });
  assert.notEqual(await reader().getAttribute('data-status'), 'ready');
  const callsBeforeSaveRetry = await modelCalls();
  await page.evaluate(() => window.phase1Test.command({ op: 'fail-publish', value: 0 }));
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await waitReady();
  assert.equal(await modelCalls(), callsBeforeSaveRetry, 'save retry must not ask the model to regenerate');
  await exitFlow();
  proof.checks.push('发布保存失败不显示完成，重试原内容成功，无额外模型生成');

  await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'hold' }));
  await enterFlow(nativeClose.title);
  await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
  assert.equal(await reader().getAttribute('data-status'), 'generating');
  const activeCourseId = await reader().getAttribute('data-course-id');
  const activeCallsBeforeClose = await modelCalls();
  await closeNative();
  await launch();
  await enterFlow(nativeClose.title);
  await page.getByRole('button', { name: '继续生成', exact: true }).waitFor();
  assert.equal(await reader().getAttribute('data-course-id'), activeCourseId);
  assert.equal(await modelCalls(), activeCallsBeforeClose, 'restarting an active stream must restore its draft, not pay for an implicit retry');
  await page.getByText('函数把允许的每个输入对应到唯一的输出。', { exact: false }).first().waitFor();
  await page.evaluate(() => window.phase1Test.command({ op: 'mode', value: 'resume' }));
  await page.getByRole('button', { name: '继续生成', exact: true }).click();
  await waitReady();
  assert.equal(await reader().getAttribute('data-course-id'), activeCourseId);
  await exitFlow();
  proof.checks.push('模型流保持打开时原生关闭仍正常退出，重启恢复主线与partial，显式继续才续写');

  const allEvents = await events();
  const initialized = (await courseFiles()).map(entry => entry.data.projectNoteId);
  assert.equal(initialized.includes(legacy.id), false);
  assert.equal(initialized.includes(knowledge.id), false);
  assert.equal(initialized.includes(parent.id), false);
  // Stage two may index the new page. A whole-book/old managed-region job for these projects remains forbidden.
  assert.equal(allEvents.some(event => event.phase === 'background' && [normal.id, interrupted.id, failedSave.id, nativeClose.id].includes(event.noteId)
    && (event.operation !== 'chunk-textbook' || event.pageId !== 'main-1')), false);
  for (const original of notes) assert.equal(await fsp.readFile(path.join(state, 'vault/notes', original.id + '.md'), 'utf8'), original.content);
  assert.deepEqual(proof.pageErrors, []);
  proof.checks.push('渐进正文未伪装为旧教材、未调用旧整本分块；原项目和知识笔记正文均未改写');
  await closeNative();
  proof.checks.push('三次真实 Windows 原生退出均为 0，无渲染异常');
  }
  proof.status = 'passed';
  console.log(JSON.stringify({ status: 'passed', checks: proof.checks.length, root, coverage: proof.checks }, null, 2));
} catch (error) {
  proof.status = 'failed'; proof.error = error?.stack || String(error);
  if (page) {
    await fsp.writeFile(path.join(root, 'failure-text.txt'), await page.locator('body').innerText().catch(() => ''));
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => undefined);
  }
  console.error(error); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  await browser?.close().catch(() => undefined);
  if (fd !== undefined) fs.closeSync(fd);
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
}
