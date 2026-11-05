import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { selectLlmProvider } from '../src/services/llmProviderSelection.ts';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share.ts';

// Deliberately separate from the offline deterministic native regression.
// One real STEM lesson only; at most one explicit continuation if a useful
// partial page exists. Existing provider configuration is read, never edited.
const replayRoot = process.env.PROGRESSIVE_MODEL_REPLAY_ROOT;
if (replayRoot) {
  const resolved = await fs.realpath(replayRoot), build = await fs.realpath('build');
  if (path.dirname(resolved) !== build || !path.basename(resolved).startsWith('progressive-phase1-model-'))
    throw Error('Offline replay requires an existing owned live-sample directory in build.');
}
const sourceFile = process.env.PROGRESSIVE_MODEL_CONFIG;
if (!sourceFile && !replayRoot) throw Error('Set PROGRESSIVE_MODEL_CONFIG to the read-only existing model configuration before running this optional live sample.');
const originalSettings = replayRoot ? {
  providers: [{ id: 'offline-replay', apiType: 'openai-compatible', baseUrl: 'https://offline-replay.invalid',
    selectedModel: 'offline-replay', models: ['offline-replay'], enabled: true, apiKey: '' }],
  defaultProviderId: 'offline-replay', workflowBinding: {},
} : JSON.parse(await fs.readFile(sourceFile, 'utf8')).settings;
const provider = selectLlmProvider(originalSettings, 'textbook-chapter');
if (!provider) throw Error('No enabled textbook provider is configured; real-model sample not run.');
if (!replayRoot && process.env.PROGRESSIVE_APPROVED_ORIGIN && new URL(provider.baseUrl).origin !== process.env.PROGRESSIVE_APPROVED_ORIGIN)
  throw Error('Configured provider origin differs from the explicitly approved destination.');
if (!replayRoot && process.env.PROGRESSIVE_APPROVED_MODEL && provider.selectedModel !== process.env.PROGRESSIVE_APPROVED_MODEL)
  throw Error('Configured model differs from the explicitly approved model.');
const privateValues = [provider.apiKey].filter(value => typeof value === 'string' && value.length > 3);
const redact = value => {
  let text = String(value);
  for (const secret of privateValues) text = text.split(secret).join('[REDACTED]');
  return text;
};
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-model-sample.cjs'))('playwright');
const root = await fs.mkdtemp(path.resolve('build/progressive-phase1-model-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fs.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fs.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fs.mkdir(path.join(state, 'user-state'), { recursive: true });
if (replayRoot) await fs.cp(path.join(replayRoot, 'state/user-state/progressive-learning'),
  path.join(state, 'user-state/progressive-learning'), { recursive: true, errorOnExist: true });
const configFile = path.join(state, 'user-state/llm.json');
const isolatedSettings = { providers: [provider], defaultProviderId: provider.id, workflowBinding: { 'textbook-chapter': provider.id } };
const at = new Date().toISOString();
const id = 'real-model-function-domain';
const note = { id, title: '函数与定义域入门', content: '# 学习目标\n理解函数的唯一对应、定义域限制，并能判断简单函数关系。',
  noteType: 'project', projectRole: 'learning', tags: [], links: [], backlinks: [],
  dueDates: [{ id: 'real-model-deadline', noteId: id, noteTitle: '函数与定义域入门', taskText: '函数与定义域入门',
    dueDate: '2026-11-02', startDate: '2026-11-01', estimatedMinutes: 40, priority: 'medium', completed: false }], createdAt: at, updatedAt: at };
const { content, ...meta } = note;
await fs.writeFile(path.join(state, 'vault/notes', id + '.md'), content);
await fs.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: { [id]: meta } }));
await fs.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fs.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: {
  theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false,
} }));
await fs.writeFile(path.join(root, 'ipc.jsonl'), '');
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'progressive-real-model-sample', version: '1.0.10' }));
await fs.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fs.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
for (const [name, buffer] of await compileElectron(process.cwd())) await fs.writeFile(path.join(appRoot, 'dist-electron', name), buffer);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fs.writeFile(bootstrap, `const fs=require('node:fs'),Module=require('node:module'),electron=require('electron'),{EventEmitter}=require('node:events');
const {app,ipcMain,utilityProcess,session}=electron;
const llm=JSON.parse(fs.readFileSync(${JSON.stringify(configFile)},'utf8')).settings;
const target=new URL(llm.providers[0].baseUrl).origin;
const secrets=llm.providers.map(p=>p.apiKey).filter(v=>typeof v==='string'&&v.length>3);
const sanitize=value=>{let text=String(value);for(const secret of secrets)text=text.split(secret).join('[REDACTED]');return text;};
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},sanitize(JSON.stringify({...entry,at:Date.now()}))+'\\n');
let providerRequests=0;
const originalFetch=globalThis.fetch;globalThis.fetch=(input,options)=>{if(${Boolean(replayRoot)})throw Error('Offline replay blocks all network');const url=new URL(typeof input==='string'?input:input.url);if(url.origin!==target)throw Error('Network outside selected provider blocked');if(++providerRequests>2)throw Error('Approved provider request limit reached');log({phase:'provider-request',requestNumber:providerRequests});return originalFetch(input,options);};
// Use an in-memory Chromium partition: settings hydration must not leave API
// credentials in the test profile's persistent Local Storage after cleanup.
class MemoryWindow extends electron.BrowserWindow{constructor(options){super({...options,webPreferences:{...options?.webPreferences,partition:'progressive-live-'+process.pid}});}}
const originalLoad=Module._load;Module._load=function(request,...args){const loaded=originalLoad.call(this,request,...args);return request==='electron'?{...loaded,BrowserWindow:MemoryWindow}:loaded;};
app.on('browser-window-created',(_event,window)=>{
 const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,payload,...rest)=>{
  if(channel==='llm:stream-chunk'&&payload?.chunk?.type==='content'&&payload.chunk.text)log({phase:'model-chunk',streamId:payload.streamId,characters:payload.chunk.text.length});
  if(channel==='llm:stream-end'||channel==='llm:stream-error')log({phase:channel,streamId:payload?.streamId});
  return send(channel,payload,...rest);
 };
 window.webContents.session.webRequest.onBeforeRequest((request,done)=>{const local=/^(file|data|blob|devtools):/u.test(request.url);done({cancel:!local});});
});
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true;};return worker;};
const register=ipcMain.handle.bind(ipcMain);let calls=0;
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='llm:stream-start'){if(++calls>2)throw Error('Real-model sample request cap reached');log({phase:'model-start',requestNumber:calls});}
 if(channel==='progressive-learning:command'){const result=await handler(event,...args);if(args[0]?.op==='publish')log({phase:'page-published'});return result;}
 return handler(event,...args);
});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);

const proof = { root, topic: note.title, providerType: provider.apiType, model: provider.selectedModel, mode: replayRoot ? 'offline-replay' : 'live-model',
  requestLimit: 2, sourceMode: 'model knowledge; no user documents copied', rendererErrors: [], status: 'not-run', credentialFileRemoved: false };
let child, browser, page, exited;
const processLog = path.join(root, 'process.log');
let pendingStdout = Promise.resolve();
const appendOutput = chunk => { pendingStdout = pendingStdout.then(() => fs.appendFile(processLog, redact(chunk.toString()))); };
async function readEvents() {
  return (await fs.readFile(path.join(root, 'ipc.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
try {
  console.log(JSON.stringify({ phase: 'live-model-start', root, topic: note.title, requestLimit: 2 }));
  await fs.writeFile(configFile, JSON.stringify({ version: 1, settings: isolatedSettings }));
  const runtime = await prepareElectronRuntime(process.env.PROGRESSIVE_TEST_ELECTRON ? { executable: process.env.PROGRESSIVE_TEST_ELECTRON } : {});
  await fs.writeFile(processLog, '');
  const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_REAL_DIALOG: 'auto' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(runtime, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(resolve => child.once('exit', code => resolve({ code })));
  child.stdout.on('data', appendOutput); child.stderr.on('data', appendOutput);
  let endpoint;
  for (let i = 0; i < 250; i++) {
    await pendingStdout;
    endpoint = (await fs.readFile(processLog, 'utf8')).match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
    if (endpoint) break;
    if (child.exitCode !== null) throw Error(`Native process exited before renderer: ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(endpoint, 'native model sample debugging endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap(context => context.pages())[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => proof.rendererErrors.push(redact(error.message)));
  await page.getByRole('button', { name: '学习', exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('button', { name: '进入心流', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click();
  const reader = page.locator('[data-progressive-course]');
  await reader.waitFor();
  if (replayRoot) {
    await reader.locator('[data-teaching-provenance="model-knowledge"]').waitFor();
    proof.provenanceVisible = true;
  }
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.waitForFunction(() => ['ready', 'error', 'interrupted'].includes(document.querySelector('[data-progressive-course]')?.getAttribute('data-status') || ''), {}, { timeout: 200000 });
    if (await reader.getAttribute('data-status') === 'ready') break;
    const saved = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), id);
    if (attempt || !saved?.plan || !saved.generation.bodyDraft?.trim()) break;
    const retry = page.getByRole('button', { name: '继续生成', exact: true });
    if (!await retry.count()) break;
    await retry.click();
  }
  proof.wallMs = Date.now() - startedAt;
  proof.finalPhase = await reader.getAttribute('data-status');
  proof.rendererTimings = await reader.evaluate(node => ({
    firstTokenMs: node.dataset.firstTokenMs || null, firstReadableMs: node.dataset.firstReadableMs || null,
    pageCompleteMs: node.dataset.pageCompleteMs || null, pageSavedMs: node.dataset.pageSavedMs || null,
  }));
  const course = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), id);
  const rows = await readEvents(), starts = rows.filter(row => row.phase === 'model-start');
  const firstChunk = rows.find(row => row.phase === 'model-chunk');
  proof.requests = starts.length;
  proof.providerRequests = rows.filter(row => row.phase === 'provider-request').length;
  proof.firstTokenMs = starts.length && firstChunk ? firstChunk.at - starts[0].at : null;
  if (course?.firstPage) {
    const shared = shareProgressiveTeaching(course);
    await fs.writeFile(path.join(root, 'teaching.json'), JSON.stringify(shared, null, 2));
    await fs.writeFile(path.join(root, 'lesson.md'), course.firstPage.body + '\n\n复述钩子：' + course.firstPage.hook.prompt);
    proof.bodyCharacters = course.firstPage.body.length;
    proof.mainlinePages = course.plan.pages.length;
    proof.formulaMarkers = (course.firstPage.body.match(/\$|\\\[|\\\(/gu) || []).length;
    proof.diagramMarkers = (course.firstPage.body.match(/```(?:mermaid|function-plot|science-diagram)\b|<FunctionPlot|<ScienceDiagram/gu) || []).length;
    proof.hook = course.firstPage.hook.prompt;
  }
  if (replayRoot) {
    proof.restoredScrollTop = await reader.evaluate(node => node.scrollTop);
    await reader.evaluate(node => { node.scrollTop = 0; });
  }
  await page.screenshot({ path: path.join(root, 'lesson-first-viewport.png') });
  const gates = reader.locator('.textbook-visual-gate');
  proof.visualGates = await gates.count();
  if (proof.visualGates) {
    await gates.first().scrollIntoViewIfNeeded();
    try {
      await page.waitForFunction(() => Boolean(document.querySelector(
        '[data-progressive-course] .textbook-function[data-plot-status="ready"] .textbook-function-canvas img,' +
        '[data-progressive-course] .textbook-science svg,' +
        '[data-progressive-course] .textbook-diagram-svg img,' +
        '[data-progressive-course] .textbook-visual-gate .textbook-format-error,' +
        '[data-progressive-course] .textbook-visual-gate .textbook-function-skipped,' +
        '[data-progressive-course] .textbook-visual-gate .textbook-diagram-failure'
      )), {}, { timeout: 30000 });
    } catch { proof.visualWaitTimedOut = true; }
    proof.renderedVisuals = await reader.locator('.textbook-function[data-plot-status="ready"] .textbook-function-canvas img, .textbook-science svg, .textbook-diagram-svg img').count();
    proof.visualErrors = await reader.locator('.textbook-visual-gate .textbook-format-error, .textbook-visual-gate .textbook-diagram-failure, .textbook-visual-gate .textbook-function-skipped').allTextContents();
    if (replayRoot) {
      const diagram = reader.locator('.textbook-diagram-svg > img').first();
      await page.waitForFunction(() => [...document.querySelectorAll('.textbook-diagram-svg > img')].some(image => image.complete && image.naturalWidth > 0), undefined, { timeout: 20000 });
      proof.fittedDiagramHeight = await diagram.evaluate(node => node.getBoundingClientRect().height);
      assert.ok(proof.fittedDiagramHeight <= 577, 'progressive diagram fits the bounded reading height');
    }
    await page.screenshot({ path: path.join(root, 'diagram-viewport.png') });
    if (replayRoot) {
      await reader.getByRole('button', { name: '原尺寸阅读', exact: true }).click();
      proof.nativeDiagramHeight = await reader.locator('.textbook-diagram-svg > img').first().evaluate(node => node.getBoundingClientRect().height);
      assert.ok(proof.nativeDiagramHeight > proof.fittedDiagramHeight, 'original-size reading remains available');
      await reader.getByRole('button', { name: '适应页面', exact: true }).click();
    }
  } else {
    proof.renderedVisuals = 0;
  }
  await fs.writeFile(path.join(root, 'rendered-text.txt'), await reader.innerText());
  await fs.writeFile(path.join(root, 'lesson.html'), await reader.innerHTML());
  assert.equal(proof.finalPhase, 'ready', 'real model must yield a valid persisted first lesson');
  assert.ok(replayRoot ? proof.requests === 0 : proof.requests >= 1 && proof.requests <= 2);
  assert.ok(replayRoot ? proof.providerRequests === 0 : proof.providerRequests >= 1 && proof.providerRequests <= 2);
  assert.deepEqual(proof.rendererErrors, []);
  await page.getByRole('button', { name: '退出并保存', exact: true }).click();
  await page.locator('.flow-mode-container').waitFor({ state: 'detached', timeout: 15000 });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  let closeTimer;
  const receipt = await Promise.race([exited, new Promise(resolve => { closeTimer = setTimeout(() => resolve({ timeout: true }), 15000); })]);
  clearTimeout(closeTimer);
  assert.equal(receipt.code, 0);
  proof.nativeExitCode = receipt.code; proof.status = replayRoot ? 'passed-offline-render-review' : 'passed-workflow-pending-content-review';
} catch (error) {
  proof.status = 'failed'; proof.error = redact(error?.stack || error);
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  await browser?.close().catch(() => undefined);
  await pendingStdout;
  // This is the one explicitly created sensitive file, never the source config.
  await fs.unlink(configFile).then(() => { proof.credentialFileRemoved = true; }, error => {
    if (error.code === 'ENOENT') proof.credentialFileRemoved = true;
    else proof.cleanupError = 'Temporary credential file could not be removed';
  });
  await fs.writeFile(path.join(root, 'result.json'), redact(JSON.stringify(proof, null, 2)));
  console.log(redact(JSON.stringify({ status: proof.status, root, requests: proof.requests, firstTokenMs: proof.firstTokenMs,
    wallMs: proof.wallMs, bodyCharacters: proof.bodyCharacters, credentialFileRemoved: proof.credentialFileRemoved,
    error: proof.error ? proof.error.split('\n')[0] : undefined }, null, 2)));
}

