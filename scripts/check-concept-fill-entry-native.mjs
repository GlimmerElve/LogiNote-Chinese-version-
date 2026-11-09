// Actual App/right-click/NoteEditor/modal/vault, isolated synthetic notes.
// Only public evidence and the model transport are mocked; no real network/model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { compileElectron, electronFiles } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'concept-entry.cjs'))('playwright');
await fsp.mkdir('build', { recursive: true });
const root = await fsp.mkdtemp(path.resolve('build/concept-fill-entry-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
for (const directory of ['app/dist-electron', 'state/vault/notes', 'state/user-state']) await fsp.mkdir(path.join(root, directory), { recursive: true });
const at = '2026-11-08T00:00:00Z', original = '这是用户已有的一句话：条件概率表示已知事件发生后的概率。';
const titles = { expand: '条件概率扩充验收', cancel: '条件概率取消验收', fail: '条件概率失败验收' };
const makeNote = (id, title, content, noteType = 'knowledge') => ({ id, title, content, noteType, tags: ['保留标签'], aliases: ['保留别名'], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const project = makeNote('concept-root', '概念补全独立验收', '# 概念补全入口\n\n' + Object.values(titles).map(title => `[[${title}]]`).join('\n\n') + '\n\n' + '隔离测试的导航资料，不使用真实笔记。\n\n'.repeat(1500), 'project');
const notes = [project, ...Object.entries(titles).map(([id, title]) => makeNote('concept-' + id, title, original))];
const metadata = {};
for (const item of notes) { const { content, ...meta } = item; metadata[item.id] = meta; await fsp.writeFile(path.join(state, 'vault/notes', item.id + '.md'), content); }
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: metadata }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false } }));
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [{ id: 'deepseek-default', name: '离线概念入口模拟', apiType: 'openai-compatible', baseUrl: 'https://concept.invalid', apiKey: '', enabled: true, models: ['concept-fixture'], selectedModel: 'concept-fixture', createdAt: at }], defaultProviderId: 'deepseek-default', workflowBinding: { 'concept-generation': 'deepseek-default' } } }));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'concept-fill-entry-check', version: '1.0.10' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
const nativeFiles = process.argv.includes('--built-electron') ? new Map(await Promise.all(electronFiles.map(async name => [name, await fsp.readFile(path.resolve('dist-electron', name))]))) : await compileElectron(process.cwd());
for (const [name, buffer] of nativeFiles) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), name === 'preload.cjs' ? Buffer.concat([buffer, Buffer.from(`\nrequire('electron').contextBridge.exposeInMainWorld('conceptEntryTest',{command:input=>require('electron').ipcRenderer.invoke('concept-entry:command',input)});\n`)]) : buffer);
const eventsFile = path.join(root, 'events.jsonl'), fatalFile = path.join(root, 'main-exceptions.jsonl');
await fsp.writeFile(eventsFile, ''); await fsp.writeFile(fatalFile, '');
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network disabled in isolated concept acceptance')};
const fs=require('node:fs'),path=require('node:path'),{app,ipcMain,utilityProcess,dialog}=require('electron'),{EventEmitter}=require('node:events');
const root=${JSON.stringify(root)},log=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({...event,at:Date.now()})+'\\n');
const fatal=(phase,error)=>{const detail={phase,message:error?.message||String(error),stack:error?.stack||String(error)};try{log(detail);fs.appendFileSync(path.join(root,'main-exceptions.jsonl'),JSON.stringify(detail)+'\\n');fs.writeSync(2,detail.stack+'\\n')}finally{process.exit(1)}};
process.prependListener('uncaughtException',error=>fatal('main-uncaught',error));process.prependListener('unhandledRejection',error=>fatal('main-unhandled',error));dialog.showErrorBox=(title,content)=>fatal('main-error-dialog',new Error(title+'\\n'+content));
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true};return worker};
let failSearch=false,failModel=false;
ipcMain.handle('concept-entry:command',async(_event,input)=>{if(input.op==='fail-search'){failSearch=!!input.value;return true}if(input.op==='fail-model'){failModel=!!input.value;return true}if(input.op==='fail-save'){globalThis.saveNativeTest.failures=1;return true}if(input.op==='exit'){setTimeout(()=>app.exit(0),40);return true}if(input.op==='stats')return {events:fs.readFileSync(path.join(root,'events.jsonl'),'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}});
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='concept-research:search'){log({phase:'research',term:args[0]});if(failSearch)throw Error('没有检索到可公开访问且内容足够的概念来源');return [{sourceId:'1',type:'web',title:'合成概率教学证据',url:'https://example.invalid/probability',snippet:'条件概率 P(A|B)=P(A∩B)/P(B)，要求 P(B)>0。学习者需要区分条件概率与联合概率。'}]}
 if(channel==='concept-research:cancel')return true;
 if(channel==='llm:request'){log({phase:'model',request:args[0]});if(failModel)throw Error('合成模型中断');return {content:'# 条件概率\\n\\n## 定义与条件\\n\\n条件概率将样本空间限制到条件事件 B；P(B)>0 时，P(A|B)=P(A∩B)/P(B)。[1]\\n\\n## 例子\\n\\n已知抽到红牌，再观察它是否为红桃；分母只计算红牌。[1]',diagnostics:{finishReason:'stop'}}}
 return handler(event,...args)});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
assert.equal(spawnSync(process.execPath, ['--check', bootstrap], { encoding: 'utf8', windowsHide: true }).status, 0);
const executable = await prepareElectronRuntime();
const proof = { root, passed: false, checks: [], errors: [], realModelRequests: 0, mockedRequests: [], original };
proof.nativeBuild = { source: process.argv.includes('--built-electron') ? 'existing-dist-electron' : 'fresh-source-compilation', sha256: Object.fromEntries([...nativeFiles].map(([name, buffer]) => [name, createHash('sha256').update(buffer).digest('hex')])) };
const renderer = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1];
proof.renderer = { entry: renderer, sha256: createHash('sha256').update(await fsp.readFile(path.join('dist/assets', renderer))).digest('hex') };
let child, browser, page, fd, exited;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, label, timeout = 20000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await read(); if (accepts(last)) return last; await pause(100); } throw Error(label + ': ' + JSON.stringify(last)); }
const logEvents = async () => (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const body = id => fsp.readFile(path.join(state, 'vault/notes', 'concept-' + id + '.md'), 'utf8');
const shell = id => page.locator(`[data-knowledge-maintenance-note="concept-${id}"]:not([aria-hidden="true"])`).filter({ visible: true });
const dialog = () => page.getByRole('dialog', { name: /补全概念/ });
async function openKnowledge(id) {
  const back = page.getByRole('button', { name: '关闭引用笔记，返回概念补全独立验收', exact: true }); if (await back.count()) await back.click();
  await page.getByTitle('打开「概念补全独立验收」', { exact: true }).click();
  await page.locator('.note-editor-shell:not([aria-hidden="true"])').getByRole('link', { name: titles[id], exact: true }).click();
  const preview = page.getByRole('dialog', { name: titles[id], exact: true }); await preview.getByRole('button', { name: '打开编辑', exact: true }).click();
  await shell(id).locator('.mdxeditor-content-editable[contenteditable="true"]').waitFor();
}
async function openConcept(id) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await shell(id).locator('.mdxeditor-content-editable[contenteditable="true"] p').first().click({ button: 'right', position: { x: 15, y: 8 } });
  await page.getByRole('menu', { name: '知识点笔记操作', exact: true }).getByRole('menuitem', { name: '概念补全', exact: true }).click();
  await dialog().waitFor(); await dialog().getByRole('button', { name: '仅公开网页', exact: false }).click();
}
async function generate() { await dialog().getByRole('button', { name: '检索并生成', exact: true }).click(); await dialog().getByRole('button', { name: '确认写入笔记', exact: true }).waitFor(); await until(() => dialog().getByRole('button', { name: '确认写入笔记', exact: true }).isEnabled(), Boolean, 'generated draft'); }
try {
  const processFile = path.join(root, 'process.log'); fd = fs.openSync(processFile, 'w'); const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, SAVE_NATIVE_REAL_DIALOG: 'auto' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  child = spawn(executable, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] }); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const endpoint = await until(async () => { const log = await fsp.readFile(processFile, 'utf8'); if (child.exitCode !== null) throw Error(log.slice(-2000)); return log.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; }, Boolean, 'native startup', 40000);
  browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.getByRole('button', { name: '笔记', exact: true }).waitFor({ timeout: 45000 }); await page.getByRole('button', { name: '笔记', exact: true }).click();
  await openKnowledge('cancel');
  const imeEditor = shell('cancel').locator('.mdxeditor-content-editable[contenteditable="true"]'); await imeEditor.click();
  await imeEditor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'half' })));
  const composingText = await imeEditor.innerText();
  await imeEditor.locator('p').first().click({ button: 'right', position: { x: 15, y: 8 } }); await pause(150);
  assert.equal(await page.getByRole('menu', { name: '知识点笔记操作', exact: true }).count(), 0, 'object menu must not steal focus during composition');
  assert.equal(await imeEditor.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true, 'right-click keeps active composing editor focus');
  assert.equal(await shell('cancel').getByRole('button', { name: '概念补全', exact: true }).count(), 0, 'concept fill stays exclusively in the object context menu');
  assert.equal(await dialog().count(), 0, 'synthetic active composition must block entry'); assert.equal(await imeEditor.innerText(), composingText, 'entry cannot modify the active composition'); assert.equal(composingText.replace(/\u200b/gu, '').trim(), original); assert.equal(await body('cancel'), original); assert.equal((await logEvents()).filter(event => event.phase === 'model').length, 0);
  await imeEditor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  proof.checks.push('synthetic composition guard blocks object-menu entry without stealing focus, reading half-input, saving, changing text or calling a model; no duplicate header button');
  await openConcept('cancel'); await generate(); assert.match(await dialog().innerText(), /这是用户已有的一句话/); await dialog().getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body('cancel'), original); proof.checks.push('actual nonempty knowledge right-click opens; canceled expansion never modifies original');
  const editor = shell('cancel').locator('.mdxeditor-content-editable[contenteditable="true"]'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('取消后最新输入保留。'); await openConcept('cancel'); await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await editor.click(); await page.keyboard.press('Control+z'); await until(() => editor.innerText(), value => !value.includes('取消后最新输入保留。'), 'cancel preserves editor undo'); await page.keyboard.press('Control+Shift+z'); await until(() => editor.innerText(), value => value.includes('取消后最新输入保留。'), 'cancel preserves editor redo');
  await openKnowledge('fail'); await until(() => body('cancel'), value => value.includes('取消后最新输入保留。'), 'latest editor draft flush on leaving'); proof.checks.push('immediately opening/canceling concept fill after typing preserves the latest actual editor input');
  await page.evaluate(() => window.conceptEntryTest.command({ op: 'fail-search', value: true })); await openConcept('fail'); await dialog().getByRole('button', { name: '检索并生成', exact: true }).click(); await dialog().getByText(/没有检索到可公开访问/).waitFor(); assert.equal(await dialog().getByRole('button', { name: '确认写入笔记', exact: true }).isEnabled(), false); await dialog().getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body('fail'), original); await page.evaluate(() => window.conceptEntryTest.command({ op: 'fail-search', value: false })); proof.checks.push('public evidence failure preserves body and does not invent a saved expansion');
  await openKnowledge('expand'); const expandEditor = shell('expand').locator('.mdxeditor-content-editable[contenteditable="true"]'); await expandEditor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('打开菜单前刚输入的补充。'); await openConcept('expand'); await generate();
  const previewText = await dialog().innerText(); assert.match(previewText, /这是用户已有的一句话/); assert.match(previewText, /打开菜单前刚输入的补充/); assert.match(previewText, /定义与条件/); await page.screenshot({ path: path.join(root, 'expansion-preview.png') });
  await page.evaluate(() => window.conceptEntryTest.command({ op: 'fail-save' })); await dialog().getByRole('button', { name: '确认写入笔记', exact: true }).click(); await dialog().getByText(/写入未完成/).waitFor(); assert.match(await dialog().innerText(), /定义与条件/); const callsBefore = (await logEvents()).filter(event => event.phase === 'model').length;
  await dialog().getByRole('button', { name: '确认写入笔记', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); assert.equal((await logEvents()).filter(event => event.phase === 'model').length, callsBefore); const saved = await body('expand'); assert.match(saved, /这是用户已有的一句话/); assert.match(saved, /打开菜单前刚输入的补充/); assert.match(saved, /定义与条件/); assert.equal(saved.split(original).length - 1, 1);
  const savedMeta = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta['concept-expand']; assert.deepEqual(savedMeta.tags, ['保留标签']); assert.deepEqual(savedMeta.aliases, ['保留别名']); proof.checks.push('preview and persisted expansion preserve original/latest input/metadata; failed-save retry neither duplicates original nor regenerates');
  await page.screenshot({ path: path.join(root, 'expanded-note.png') }); proof.savedBody = saved;
  await expandEditor.click(); await page.keyboard.press('Control+z'); await until(() => expandEditor.innerText(), value => !value.includes('定义与条件') && value.includes('打开菜单前刚输入的补充。'), 'first undo removes only confirmed augmentation');
  await page.keyboard.press('Control+z'); await until(() => expandEditor.innerText(), value => !value.includes('打开菜单前刚输入的补充。') && value.includes(original), 'second undo removes only prior typing');
  await page.getByRole('button', { name: '关闭引用笔记，返回概念补全独立验收', exact: true }).click(); await until(() => body('expand'), value => value.trim() === original, 'latest undone body persists on leaving');
  proof.checks.push('canceled modal keeps editor undo/redo; confirmed expansion is one undo step and prior typed text remains separately undoable');
  proof.mockedRequests = (await logEvents()).filter(event => event.phase === 'model').map(event => ({ workflow: event.request.workflow, userInput: event.request.userInput, systemPrompt: event.request.systemPrompt })); assert.ok(proof.mockedRequests.every(request => request.userInput.includes(original))); assert.match(proof.mockedRequests.at(-1).userInput, /打开菜单前刚输入的补充/);
  for (const request of proof.mockedRequests) { assert.match(request.systemPrompt, /符号含义/); assert.match(request.systemPrompt, /输入→计算→输出/); }
  proof.checks.push('actual production augmentation prompt includes symbol explanations and the input→calculation→output teaching path'); assert.equal(proof.errors.length, 0);
} catch (error) { proof.failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  if (child?.exitCode === null) { try { await page.evaluate(() => window.conceptEntryTest.command({ op: 'exit' })); proof.exit = await exited; } catch (error) { proof.failure ||= String(error); child.kill(); proof.exit = await exited; } }
  await browser?.close().catch(() => {}); if (fd !== undefined) fs.closeSync(fd); proof.mainExceptions = (await fsp.readFile(fatalFile, 'utf8')).trim();
  if (process.argv.includes('--built-electron')) { try { const currentEntry = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1]; proof.buildIdentity = { rendererUnchanged: currentEntry === proof.renderer.entry && createHash('sha256').update(await fsp.readFile(path.join('dist/assets', currentEntry))).digest('hex') === proof.renderer.sha256, electronUnchanged: (await Promise.all(Object.entries(proof.nativeBuild.sha256).map(async ([name, digest]) => createHash('sha256').update(await fsp.readFile(path.resolve('dist-electron', name))).digest('hex') === digest))).every(Boolean) }; if (!proof.buildIdentity.rendererUnchanged || !proof.buildIdentity.electronUnchanged) proof.failure ||= 'The built files changed during native acceptance'; } catch (error) { proof.failure ||= 'Built-file verification failed: ' + String(error); } }
  proof.passed = !proof.failure && !proof.mainExceptions && proof.errors.length === 0 && proof.exit?.code === 0;
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ root, passed: proof.passed, checks: proof.checks, failure: proof.failure, exit: proof.exit, realModelRequests: 0 }, null, 2)); if (!proof.passed) process.exitCode = 1;
}
