/** Isolated production UI/IPC/storage and actual local ONNX indexing. Model
 * replies for the Agent are synthetic in-process, with all external traffic blocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { saveVaultNotesDelta } from '../src/electron/vaultNoteDelta';
import type { NoteItem } from '../src/types';
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'knowledge-native.cjs'))('playwright');
const root = await fs.mkdtemp(path.resolve('build/knowledge-maintenance-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state'), at = '2026-11-02T00:00:00Z';
await fs.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
for (const dir of ['dist', 'models', 'python']) await fs.symlink(path.resolve(dir), path.join(appRoot, dir), 'junction');
for (const [name, bytes] of await compileElectron(process.cwd())) await fs.writeFile(path.join(appRoot, 'dist-electron', name), bytes);
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'knowledge-maintenance-native', version: '1.0.10' }));
const note = (id: string, title: string, content: string, knowledge = false): NoteItem => ({ id, title, content, noteType: knowledge ? 'knowledge' : 'project',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const project = note('project', '原项目保持', '# 原有目标\n\n[[数列极限的直观含义]]：原有说明。\n\n[[极限的唯一性]]：原有说明。\n\n[[待删除知识点]]：原有说明。');
project.links = ['数列极限的直观含义', '极限的唯一性', '待删除知识点'];
const a = { ...note('source-a', '数列极限的直观含义', '# 数列极限的直观含义\n\n数列的项趋近固定值称为收敛，原有公式 $a_n\\to A$。\n\n## 条件\n\n限定条件和示例必须保留。', true), parentId: project.id };
const b = { ...note('source-b', '极限的唯一性', '# 极限的唯一性\n\n收敛数列的极限唯一，需要保留此前的条件。\n\n```python\n# 原始代码\nprint("unique")\n```', true), parentId: project.id };
const c = { ...note('source-c', '待删除知识点', '# 待删除知识点\n\n合成内容，仅用于验证删除对象与保留项目正文。', true), parentId: project.id };
const keep = note('keep', '未选中人工知识', '# 未选中人工知识\n\n原始正文不应修改或重新向量化。', true);
const notes = [project, a, b, c, keep, ...Array.from({ length: 143 }, (_, i) => note('other-' + i, '其他项目' + i, ''))];
await saveVaultNotesDelta(path.join(state, 'vault'), path.join(state, 'user-state'), { upserts: notes.map(note => ({ note, before: null })), removed: [] });
await fs.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', localOnly: true, autoAiSegment: false, cloudSyncEnabled: false, fontSize: 16 } }));
await fs.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [{ id: 'fixture', name: '离线合成响应', apiType: 'openai-compatible', baseUrl: 'https://fixture.invalid', apiKey: 'not-a-real-key', enabled: true, models: ['fixture'], selectedModel: 'fixture', createdAt: at }], defaultProviderId: 'fixture', workflowBinding: {} } }));
await fs.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('knowledgeTest',{command:op=>require('electron').ipcRenderer.invoke('knowledge-test:command',op),close:()=>require('electron').ipcRenderer.invoke('save-test:command',{op:'close'})});`);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fs.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('network disabled');};
const fs=require('node:fs'),path=require('node:path'),{ipcMain,utilityProcess}=require('electron');let phase='',events=[],active=new Set(),merges=0;
const record=value=>{if(phase)events.push({...value,phase,at:Date.now()});};const root=${JSON.stringify(path.join(state, 'vault/notes'))};
const read=fs.promises.readFile.bind(fs.promises);fs.promises.readFile=async(file,...args)=>{if(String(file).startsWith(root)&&String(file).endsWith('.md'))record({type:'body-read',id:path.basename(String(file),'.md'),stack:new Error().stack?.split('\\n').slice(1,7)});return read(file,...args);};
const rename=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(from,to)=>{if(String(to).startsWith(root)&&String(to).endsWith('.md'))record({type:'body-write',id:path.basename(String(to),'.md')});return rename(from,to);};
const fork=utilityProcess.fork.bind(utilityProcess);utilityProcess.fork=(...args)=>{const worker=fork(...args),post=worker.postMessage.bind(worker);worker.postMessage=message=>{active.add(message.id);record({type:'compute',operation:message.operation,texts:message.args?.texts||[],noteId:message.args?.input?.noteId});post(message);};worker.on('message',message=>{if(message.type!=='progress')active.delete(message.id);});return worker;};
const register=ipcMain.handle.bind(ipcMain);register('knowledge-test:command',(_event,input)=>{if(input?.start){phase=input.start;events=[];}return{events,active:[...active],merges};});
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='vault:save')record({type:'full-save'});
 if(channel==='vault:save-delta')record({type:'delta',upserts:args[0].upserts.map(row=>row.note.id),removed:args[0].removed.map(row=>row.id)});
 if(channel==='noteRag:index-all')record({type:'full-index'});
 if(channel==='llm:request'){const request=args[0];if(request.tools?.some(tool=>tool.name==='merge_knowledge_notes')){if(!merges++){return{content:'',toolCalls:[{id:'synthetic-merge',name:'merge_knowledge_notes',arguments:{sourceIds:['source-a','source-b'],targetTitle:'Agent合并极限'}}]};}return{content:'已合并指定知识点，保留项目正文。'};}return{content:JSON.stringify({intent:'general',confidence:1,reason:'笔记整理'})};}
 return handler(event,...args);
});require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const env: NodeJS.ProcessEnv = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_GPU: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(await prepareElectronRuntime(), [bootstrap, '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stderr.on('data', bytes => output += bytes);
const exited = new Promise<any>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const proof: any = { root, network: 'blocked', checks: [], measurements: [], errors: [] }; let browser: any, page: any;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (read: () => Promise<any>, predicate: (value: any) => boolean, label: string, ms = 120000) => { const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await pause(100); } throw Error(label + ' timed out'); };
const metadata = async () => JSON.parse(await fs.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
try {
  let endpoint; for (let i = 0; i < 250 && !endpoint; i++) { endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; if (!endpoint) await pause(100); }
  assert.ok(endpoint, output); browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
  page.on('pageerror', (error: any) => proof.errors.push(error.message));
  await page.getByRole('button', { name: '笔记', exact: true }).click({ timeout: 45000 });
  const open = async (title: string) => {
    const knowledge = notes.find(note => note.title === title && note.noteType === 'knowledge');
    await page.getByTitle(`打开「${knowledge ? project.title : title}」`, { exact: true }).click();
    if (knowledge) { await page.getByTitle(`预览关联笔记：${title}`, { exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '打开编辑', exact: true }).click(); }
    await page.waitForFunction((title: string) => [...document.querySelectorAll('input,textarea')].some(element => (element as HTMLInputElement).value === title), title);
  };
  const flushIndexes = async () => { await page.evaluate(async () => { await window.electronAPI!.noteRag!.setEditing!(false); await window.electronAPI!.noteRag!.flushPending!(); }); };
  await flushIndexes();
  await waitFor(async () => Promise.all(['source-a', 'source-b', 'source-c', 'keep'].map(id => page.evaluate((id: string) => window.electronAPI!.noteRag!.status!(id), id))), statuses => statuses.every((row: any) => row.status === 'ready'), 'initial actual local indexing');
  await waitFor(() => page.evaluate(() => (window as any).knowledgeTest.command({})), value => !value.active.length, 'baseline compute idle');
  const keepIndex = () => fs.readFile(path.join(state, 'note-embeddings.json'), 'utf8').then(text => JSON.parse(text).entries.find((row: any) => row.noteId === 'keep'));
  const originalKeep = await keepIndex(), originalProject = await fs.readFile(path.join(state, 'vault/notes/project.md'), 'utf8');
  const begin = async (name: string) => page.evaluate((name: string) => (window as any).knowledgeTest.command({ start: name }), name);
  const inspect = async (allowed: string[], changedKnowledge?: string) => {
    await flushIndexes(); await pause(150);
    if (changedKnowledge) { await waitFor(() => page.evaluate((id: string) => window.electronAPI!.noteRag!.status!(id), changedKnowledge), status => status.status === 'ready', 'selected target indexing'); }
    const data = await page.evaluate(() => (window as any).knowledgeTest.command({}));
    proof.lastMeasurement = { allowed, events: data.events };
    assert.ok(!data.events.some((row: any) => ['full-save', 'full-index'].includes(row.type)), 'no whole-vault persistence/indexing request');
    assert.ok(data.events.filter((row: any) => row.type === 'body-write').every((row: any) => allowed.includes(row.id)), 'only selected Markdown files are written');
    // Closing the deleted context page reactivates its visible project. Its
    // saved-course availability check reads that one project, not the library.
    assert.ok(data.events.filter((row: any) => row.type === 'body-read').every((row: any) => allowed.includes(row.id)
      || row.id === 'project' && row.stack?.some((line: string) => line.includes('ProgressiveLearningStore.target'))), 'no full-library or unrelated background Markdown reads');
    assert.ok(data.events.filter((row: any) => row.type === 'delta').every((row: any) => [...row.upserts, ...row.removed].every((id: string) => allowed.includes(id))));
    assert.equal(await fs.readFile(path.join(state, 'vault/notes/project.md'), 'utf8'), originalProject);
    assert.deepEqual(await keepIndex(), originalKeep);
    proof.measurements.push({ allowed, events: data.events.map((row: any) => ({ ...row, texts: row.texts?.map((text: string) => text.slice(0, 80)) })) });
    return data;
  };

  await open(c.title); await page.locator('[data-knowledge-maintenance-note="source-c"]').click({ button: 'right', position: { x: 320, y: 80 } });
  await page.getByRole('menuitem', { name: '删除知识点笔记…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除知识点笔记', exact: true }); await dialog.waitFor();
  await begin('local-delete'); await dialog.getByRole('button', { name: '检查删除范围', exact: true }).click(); await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await waitFor(metadata, data => !data['source-c'], 'object deletion');
  await page.getByRole('status').filter({ hasText: '删除 1 篇知识点笔记' }).waitFor();
  const deletion = await inspect(['source-c']); assert.equal(deletion.events.filter((row: any) => row.type === 'compute' && row.operation === 'embed').length, 0);
  await page.screenshot({ path: path.join(root, 'deleted-object.png') });
  await begin('undo-delete'); await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitFor(metadata, data => Boolean(data['source-c']), 'delete undo');
  await inspect(['source-c'], 'source-c'); await page.getByRole('button', { name: '关闭知识点整理提示' }).click();
  proof.checks.push('知识点页面右键删除和撤销：项目原文不变，删除不调用embedding，未选中索引保持不变');

  await open(project.title); await page.locator('[data-knowledge-maintenance-note="project"] [data-wiki-target]').first().waitFor();
  await page.evaluate(() => { const root = document.querySelector('[data-knowledge-maintenance-note="project"]')!;
    const links = root.querySelectorAll('[data-wiki-target]'), range = document.createRange(); range.setStartBefore(links[0]); range.setEndAfter(links[1]); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await page.locator('[data-wiki-target]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '合并知识点笔记…', exact: true }).click();
  const mergeDialog = page.getByRole('dialog', { name: '合并知识点笔记', exact: true }); await mergeDialog.getByLabel('目标知识点名称').fill('本地合并极限');
  await begin('local-merge'); await mergeDialog.getByRole('button', { name: '预览合并', exact: true }).click();
  await mergeDialog.getByText('查看合并正文预览', { exact: true }).click(); await page.screenshot({ path: path.join(root, 'merge-preview.png') });
  await mergeDialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  const local = await waitFor(metadata, data => Object.values(data).some((note: any) => note.title === '本地合并极限'), 'local merge target');
  const localId = (Object.values(local).find((note: any) => note.title === '本地合并极限') as any).id;
  assert.ok(!local['source-a'] && !local['source-b']); await inspect(['source-a', 'source-b', localId], localId);
  await open(project.title); await page.locator('[data-wiki-target]').first().click();
  await page.getByRole('dialog').filter({ hasText: '本地合并极限' }).waitFor(); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await begin('undo-merge'); await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitFor(metadata, data => Boolean(data['source-a'] && data['source-b']) && !data[localId], 'merge undo'); await inspect(['source-a', 'source-b', localId]);
  await waitFor(async () => Promise.all(['source-a', 'source-b'].map(id => page.evaluate((id: string) => window.electronAPI!.noteRag!.status!(id), id))), statuses => statuses.every((row: any) => row.status === 'ready'), 'restored source indexing');
  await page.getByRole('button', { name: '关闭知识点整理提示' }).click();
  proof.checks.push('项目中选择两个Wiki右键合并：原文按来源分节保留；项目正文未写入；旧Wiki跳转合并目标；整体撤销恢复来源');

  await flushIndexes(); await waitFor(() => page.evaluate(() => (window as any).knowledgeTest.command({})), value => !value.active.length, 'undo compute idle');
  await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
  await begin('agent-context'); await page.getByRole('textbox', { name: '发送给学习助手的消息' }).fill('把数列极限的直观含义和极限的唯一性两篇知识点笔记合并为Agent合并极限，只处理这两篇。');
  await page.getByRole('button', { name: '发送', exact: true }).click(); await page.getByRole('button', { name: '确认执行', exact: true }).waitFor({ timeout: 45000 });
  const contextEvents = (await page.evaluate(() => (window as any).knowledgeTest.command({}))).events;
  const contextReads = contextEvents.filter((row: any) => row.type === 'body-read');
  proof.agentContextReads = contextReads;
  assert.ok(contextReads.length <= 3 && contextReads.every((row: any) => row.stack?.some((line: string) => line.includes('searchCurrent'))), 'Agent memory validates at most three ranked results, never loads the library');
  assert.ok(!contextEvents.some((row: any) => ['delta', 'full-save', 'full-index', 'body-write'].includes(row.type)), 'Agent confirmation preparation is read-only');
  await begin('agent-merge');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  const agent = await waitFor(metadata, data => Object.values(data).some((note: any) => note.title === 'Agent合并极限'), 'Agent merge');
  const agentId = (Object.values(agent).find((note: any) => note.title === 'Agent合并极限') as any).id;
  assert.ok(!agent['source-a'] && !agent['source-b']); await inspect(['source-a', 'source-b', agentId], agentId);
  await page.screenshot({ path: path.join(root, 'agent-merge.png') });
  proof.checks.push('真实Agent工具确认后执行同一条本地增量流程；仅新目标做实际ONNX向量化，其他正文和向量保持不变');
  assert.deepEqual(proof.errors, []); await page.evaluate(() => (window as any).knowledgeTest.close());
  const receipt = await Promise.race([exited, pause(20000).then(() => ({ timeout: true }))]); assert.equal(receipt.code, 0, output); proof.nativeExit = receipt.code; proof.status = 'passed';
} catch (error: any) { proof.status = 'failed'; proof.error = error.stack || String(error); process.exitCode = 1;
  if (page) { await fs.writeFile(path.join(root, 'failure-text.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
} finally { if (child.exitCode === null) child.kill(); await browser?.close().catch(() => {}); await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ root, status: proof.status, error: proof.error })); }
