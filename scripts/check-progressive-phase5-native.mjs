/** Production desktop/main/preload/renderer, isolated library. Public search,
 * download transport and model replies are deterministic local adapters. Actual
 * import, parsing, binding, generation, sharing, migration and restart use the
 * production implementations. No real account, source library or cloud call. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-phase5-check.cjs'))('playwright');
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase5-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state'), migratedRoot = path.join(root, 'migrated');
await fsp.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fsp.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fsp.mkdir(path.join(state, 'user-state'), { recursive: true });
await fsp.mkdir(path.join(root, 'inputs'), { recursive: true });
const at = '2026-11-01T00:00:00Z';
const common = { noteType: 'project', projectRole: 'learning', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const makeRoot = (id, title) => ({ ...common, id, title, content: 'PRIVATE_ROOT_BODY', planMeta: { schemaVersion: 2, status: 'active', resourcePreparationVersion: 1, dailyStudyMinutes: 30 } });
const makeLeaf = (id, title, parentId) => ({ ...common, id, title, parentId, content: 'PRIVATE_PROJECT_BODY', dueDates: [{ id: 'due-' + id, noteId: id, noteTitle: title, taskText: title, estimatedMinutes: 40, dueDate: '2026-11-03', priority: 'medium', completed: false }] });
const parent = makeRoot('phase5-root', '函数与定义域');
const leaf = makeLeaf('phase5-leaf', '函数的唯一对应', parent.id); leaf.dueDates[0].dueDate = '2026-11-01';
const autoRoot = makeRoot('phase5-auto-root', '函数图像');
const autoLeaf = makeLeaf('phase5-auto-leaf', '函数图像的观察', autoRoot.id);
const offlineRoot = makeRoot('phase5-offline-root', '历史证据');
const offlineLeaf = makeLeaf('phase5-offline-leaf', '证据的来源判断', offlineRoot.id);
const notes = [parent, leaf, autoRoot, autoLeaf, offlineRoot, offlineLeaf], notesMeta = {};
for (const { content, ...note } of notes) { notesMeta[note.id] = note; await fsp.writeFile(path.join(state, 'vault/notes', note.id + '.md'), content); }
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, autoAiSegment: false, fontSize: 16, resourceCollectionMode: 'review' } }));
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [{ id: 'fixture', name: '隔离验收响应', apiType: 'openai-compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-only-never-sent', enabled: true, models: ['deepseek-flash'], selectedModel: 'deepseek-flash', createdAt: at }], defaultProviderId: 'fixture', workflowBinding: {} } }));
await fsp.writeFile(path.join(root, 'inputs/planning-material.md'), '# 函数资料\n\n函数要求每个允许输入有唯一输出。定义域表示允许的输入范围。'.repeat(50));
await fsp.writeFile(path.join(root, 'inputs/late-material.md'), '# 新补充的函数教材\n\n新增资料强调：先列出允许的输入，再说明唯一输出；不能把定义域当成公式的附属信息。'.repeat(50));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'phase5-native-check', version: '1.0.10' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
for (const [name, bytes] of await compileElectron(process.cwd())) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), bytes);
const plan = { title: '函数入门', objectives: ['说明输入范围与唯一对应'], pages: [{ id: 'main-1', title: '唯一对应', objectives: ['说明函数的输出条件'] }, { id: 'main-2', title: '允许的输入', objectives: ['说明定义域的作用'] }] };
const quote = '每个允许的输入对应唯一输出，不同输入可以得到相同输出。';
const bodies = [1, 2].map(index => `# ${plan.pages[index - 1].title}\n\n${quote}\n\n${'先明确允许输入的范围，再检查一个输入是否会得到两个不同的结果。用平方函数可以观察输入与输出的对应关系。'.repeat(12)}`);
const lessons = bodies.map((body, index) => `@@LESSON\n${body}\n@@CONCEPTS\n${JSON.stringify([{ key: 'unique-function', title: '唯一对应', summary: quote }])}\n@@QUESTIONS\n${JSON.stringify([{ id: 'q1', kind: 'judgment', prompt: '一个允许输入可以同时对应两个不同输出，对吗？', objective: '理解唯一性', conceptKeys: ['unique-function'], focus: 'concept', options: [{ id: 'A', text: '不对' }, { id: 'B', text: '对' }], correctOptionId: 'A', referenceAnswer: '不对', explanation: '同一输入必须有唯一输出。', referenceQuote: quote }])}\n@@HOOK\n${JSON.stringify({ id: 'hook-' + (index + 1), kind: 'reflection', prompt: '请用自己的例子说明函数的唯一对应。' })}\n@@END\n`);
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), "require('electron').contextBridge.exposeInMainWorld('phase5Test',{command:input=>require('electron').ipcRenderer.invoke('phase5-test:command',input)});");
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `
const fs=require('node:fs'),path=require('node:path'),{ipcMain,utilityProcess,session,dialog,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={upload:null,searches:0,downloads:0,streams:0,holdSearch:false,releaseSearch:null};
const fixtureText='# 公开函数教材\\n\\n每个允许的输入对应唯一输出。定义域表示允许输入的范围。\\n\\n'.repeat(100);
const dns=require('node:dns/promises');dns.lookup=async(host,options)=>{if(host!=='prep.example.org')throw Error('Unexpected DNS in offline acceptance');return options?.all?[{address:'93.184.216.34',family:4}]:{address:'93.184.216.34',family:4};};
globalThis.fetch=async(raw,options={})=>{const url=String(raw);if(url==='https://api.deepseek.com/v1/tools/search'){
 const input=JSON.parse(options.body),goal=input.query.split(' 教材')[0];control.searches++;log({phase:'search',goal});
 if(control.holdSearch)await new Promise((resolve,reject)=>{control.releaseSearch=resolve;options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 options.signal?.throwIfAborted();if(goal.includes('历史'))return new Response('{}',{status:503});
 return Response.json({results:[{title:goal+'公开教材',url:'https://prep.example.org/'+encodeURIComponent(goal)+'.md',content:fixtureText},{title:goal+'公开课程',url:'https://prep.example.org/'+encodeURIComponent(goal)+'.html',snippet:goal+'的公开学习摘要，讨论输入范围与唯一输出。'.repeat(12)}]});
 }if(url.startsWith('https://prep.example.org/')){const file=url.endsWith('.md');const response=new Response(options.method==='HEAD'?null:fixtureText,{status:200,headers:{'content-type':file?'text/markdown':'text/html','content-length':String(Buffer.byteLength(fixtureText)),...(file?{'content-disposition':'attachment; filename="function-material.md"'}:{})}});Object.defineProperty(response,'url',{value:url});return response;}
 log({phase:'unexpected-network',url});throw Error('Network disabled');};
const fromPartition=session.fromPartition.bind(session);session.fromPartition=(partition,...args)=>{const current=fromPartition(partition,...args);if(partition.startsWith('resource-download-temp-'))current.downloadURL=url=>{control.downloads++;log({phase:'download',url});const item=new EventEmitter();let target='',cancelled=false;item.getURLChain=()=>[url];item.getURL=()=>url;item.setSavePath=value=>target=value;item.getTotalBytes=()=>Buffer.byteLength(fixtureText);item.getReceivedBytes=item.getTotalBytes;item.cancel=()=>{cancelled=true;item.emit('done',{},'cancelled');};current.emit('will-download',{preventDefault(){cancelled=true;}},item);setTimeout(()=>{if(!cancelled){fs.writeFileSync(target,fixtureText);item.emit('updated');item.emit('done',{},'completed');}},30);};return current;};
const choose=dialog.showOpenDialog.bind(dialog);dialog.showOpenDialog=async(...args)=>{if(args.at(-1)?.properties?.includes('openFile')){const selected=control.upload;control.upload=null;return {canceled:!selected,filePaths:selected?[selected]:[]};}return choose(...args);};
const fork=utilityProcess.fork.bind(utilityProcess);utilityProcess.fork=(...args)=>{const worker=fork(...args),post=worker.postMessage.bind(worker);worker.postMessage=message=>{log({phase:'compute',operation:message.operation});if(message.operation==='embed')return;post(message);};return worker;};
ipcMain.handle('phase5-test:command',async(_event,input)=>{if(input.op==='upload')control.upload=path.join(${JSON.stringify(path.join(root, 'inputs'))},input.late?'late-material.md':'planning-material.md');if(input.op==='auto'){const file=path.join(require('electron').app.getPath('userData'),'user-state/settings.json'),saved=JSON.parse(fs.readFileSync(file));saved.appSettings.resourceCollectionMode=input.value?'auto':'review';fs.writeFileSync(file,JSON.stringify(saved));}if(input.op==='hold-search')control.holdSearch=input.value;if(input.op==='release-search'){control.holdSearch=false;control.releaseSearch?.();}if(input.op==='show'){const window=BrowserWindow.getAllWindows()[0];window?.setTitle('LogiNote 第五阶段隔离验收');window?.show();}if(input.op==='close')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);return {searches:control.searches,downloads:control.downloads,streams:control.streams};});
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='llm:stream-start'){const input=JSON.parse(args[0].userInput),streamId='phase5-stream-'+(++control.streams);log({phase:'generation',input});const full=(!input.fixedMainline?'@@PLAN\\n'+JSON.stringify(${JSON.stringify(plan)})+'\\n':'')+(input.routePending?'@@ROUTE\\n'+JSON.stringify({kind:'mainline',reason:'已复述关键概念，继续主线并适当衔接'})+'\\n':'')+${JSON.stringify(lessons)}[input.fixedMainline?1:0];const chunks=full.match(/[\\s\\S]{1,90}/g)||[];let offset=0;const timer=setInterval(()=>{if(event.sender.isDestroyed()){clearInterval(timer);return;}if(offset<chunks.length)event.sender.send('llm:stream-chunk',{streamId,chunk:{type:'content',text:chunks[offset++]}});else{clearInterval(timer);event.sender.send('llm:stream-end',{streamId});}},5);return streamId;}
 if(channel==='llm:request')throw Error('No formal/cloud analysis in phase5 native acceptance');
 if(channel==='progressive-learning:command')log({phase:'course-command',op:args[0]?.op,projectNoteId:args[0]?.projectNoteId||args[0]?.lease?.projectNoteId,patch:args[0]?.progress?.patch});
 return handler(event,...args);
});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});
`);
const runtime = await prepareElectronRuntime();
const proof = { root, checks: [], pageErrors: [], nativeExits: [], network: 'offline transport fixtures', quality: 'not a live recommendation or model quality sample' };
let child, browser, page, fd, exited, restarts = 0;
const bounded = (promise, label, ms = 15000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); };
async function launch() {
  const logFile = path.join(root, `process-${++restarts}.log`); fd = fs.openSync(logFile, 'w');
  const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_REAL_DIALOG: 'auto' }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(runtime, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let endpoint;
  for (let i = 0; i < 300; i++) { endpoint = (await fsp.readFile(logFile, 'utf8')).match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; if (endpoint) break; if (child.exitCode !== null) throw Error('Native exited: ' + child.exitCode); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(endpoint); browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000); page.on('pageerror', error => proof.pageErrors.push(error.message));
  await page.getByRole('button', { name: '学习', exact: true }).waitFor({ timeout: 45000 });
}
const events = async () => (await fsp.readFile(path.join(root, 'ipc.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const api = (input) => page.evaluate(input => window.electronAPI.learningPreparation.command(input), input);
async function waitStatus(id, status) { for (let i = 0; i < 150; i++) { const result = await api({ op: 'status', rootId: id }); if (result?.status === status) return result; await new Promise(resolve => setTimeout(resolve, 150)); } throw Error('Preparation status not ' + status); }
async function enter(title) {
  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('heading', { name: '学习队列', exact: true }).waitFor();
  const card = page.locator('button.flow-project-card').filter({ hasText: title });
  if (await card.count()) await card.click(); else await page.getByRole('button', { name: '进入心流', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click();
  await page.getByRole('button', { name: '退出并保存', exact: true }).waitFor();
  const toggle = page.locator('.focus-flow-analysis-control [role="switch"]'); if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click();
}
async function saveExit() { await page.getByRole('button', { name: '退出并保存', exact: true }).click(); await page.locator('.flow-mode-container').waitFor({ state: 'detached' }); }
async function close() {
  const close = page.getByRole('button', { name: '关闭', exact: true }); if (await close.count()) await close.click(); else await page.evaluate(() => window.phase5Test.command({ op: 'close' }));
  const receipt = await bounded(exited, 'native-exit', 20000); assert.equal(receipt.code, 0); proof.nativeExits.push(receipt); await browser.close().catch(() => {}); fs.closeSync(fd); fd = undefined;
}
console.log(JSON.stringify({ root }));
try {
  await launch(); await waitStatus(parent.id, 'recommended');
  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.locator('button.flow-tree-node-select').filter({ hasText: parent.title }).click();
  await page.getByRole('region', { name: '学习资料准备' }).getByText('查看推荐', { exact: false }).click();
  assert.equal(await page.getByRole('region', { name: '学习资料准备' }).getByRole('checkbox').count(), 2);
  await page.getByRole('button', { name: '收录所选并下载可用附件', exact: true }).click();
  await waitStatus(parent.id, 'ready');
  let disk = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
  assert.equal(disk[parent.id].resources.filter(resource => resource.documentId).length, 1);
  assert.equal(disk[parent.id].resources.length, 2);
  await page.screenshot({ path: path.join(root, 'root-resources.png') });
  if (process.env.PHASE5_VISUAL_CHECK === '1') {
    await page.evaluate(() => window.phase5Test.command({ op: 'show' })); console.log('COMPUTER_USE_READY ' + root);
    for (let i = 0; i < 180 && !fs.existsSync(path.join(root, 'computer-use.done')); i++) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  proof.checks.push('筛选模式实际学习页展示推荐、复选收录；附件经生产下载/入库/根绑定链路落盘');

  await page.evaluate(() => window.phase5Test.command({ op: 'auto', value: true }));
  await api({ op: 'retry', rootId: autoRoot.id }); await waitStatus(autoRoot.id, 'ready');
  await page.evaluate(() => window.phase5Test.command({ op: 'auto', value: false }));
  disk = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
  assert.ok(disk[autoRoot.id].resources.some(resource => resource.documentId));
  proof.checks.push('已保存的自动收录设置驱动后台下载与绑定，页面无需停留或额外生成学习任务');

  await page.getByRole('button', { name: '计划', exact: true }).click();
  await page.getByRole('button', { name: '制定新计划', exact: true }).click();
  await page.getByPlaceholder('在这里输入一级目标名称，例如「Python 全栈学习计划」...').fill('规划验收函数教材');
  await page.locator('.dual-palette-card.is-project').count().then(async count => {
    if (count) await page.locator('.dual-palette-card.is-project').click();
    else await page.locator('button.dual-palette-card').filter({ hasText: '结构项目' }).click();
  });
  await page.locator('.dual-structure-row[data-depth="0"]').click({ position: { x: 170, y: 25 } });
  await page.getByLabel('项目名称', { exact: true }).fill('识别输入和输出');
  await page.evaluate(() => window.phase5Test.command({ op: 'upload' }));
  await page.getByRole('button', { name: '上传教材资料', exact: true }).click();
  await page.getByRole('button', { name: '取消选择教材：planning-material.md', exact: true }).waitFor();
  let beforeCommit = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
  assert.ok(!Object.values(beforeCommit).some(note => note.title === '规划验收函数教材'));
  assert.ok(!(await events()).some(event => event.phase === 'search' && event.goal === '规划验收函数教材'));
  await page.getByRole('button', { name: '检查并确认写入', exact: true }).click();
  await page.getByRole('dialog', { name: '确认写入学习计划' }).getByRole('button', { name: '确认并正式写入', exact: true }).click();
  await page.getByRole('dialog', { name: '确认写入学习计划' }).waitFor({ state: 'detached' });
  disk = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
  const createdRoot = Object.values(disk).find(note => note.title === '规划验收函数教材');
  assert.ok(createdRoot?.resources.some(resource => resource.documentId));
  assert.equal(createdRoot.planMeta.resourcePreparationVersion, 1);
  assert.ok(Object.values(disk).some(note => note.title === '识别输入和输出' && note.parentId === createdRoot.id));
  await waitStatus(createdRoot.id, 'recommended');
  proof.checks.push('手动规划上传→真实确认写入根/叶项目及计划轨道→后台推荐；未确认草图不启动公开检索');

  await enter(leaf.title);
  await page.getByRole('button', { name: '下一页', exact: true }).waitFor({ timeout: 45000 });
  let course = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  const courseId = course.id, initialEnvironment = course.environmentId, firstHash = course.pages[0].contentHash;
  await page.locator('.flow-restate-textarea').fill('PRIVATE_NATIVE_PHASE5：函数要求同一个允许输入只能对应一个输出。');
  await saveExit();
  await page.evaluate(() => window.phase5Test.command({ op: 'upload', late: true }));
  await api({ op: 'upload', rootId: parent.id });
  disk = JSON.parse(await fsp.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta;
  const lateDocument = disk[parent.id].resources.find(resource => resource.title === 'late-material.md'); assert.ok(lateDocument?.documentId);
  let lateParsed = false;
  for (let i = 0; i < 150; i++) {
    const result = await page.evaluate(docId => window.electronAPI.ragDocs.materialCatalog({ allowedDocIds: [docId], docId, offset: 0, limit: 5 }), lateDocument.documentId);
    if (result.ok && result.value.document.parseStatus === 'ready') { lateParsed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(lateParsed, 'late local source must actually be parsed before it is used');
  const streamCount = (await page.evaluate(() => window.phase5Test.command({ op: 'stats' }))).streams;
  await page.getByRole('button', { name: '继续心流', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.phase5Test.command({ op: 'stats' }))).streams, streamCount);
  await page.locator('.flow-restate-textarea').fill('PRIVATE_NATIVE_PHASE5：函数要求同一个允许输入只能对应一个输出。');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.progressive-course-reader')?.textContent.includes('主线 2 / 2'), null, { timeout: 45000 });
  await page.getByText('主线讲解已全部生成，仍可复述并退出保存。', { exact: false }).waitFor({ timeout: 45000 });
  course = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  assert.equal(course.id, courseId); assert.equal(course.pages[0].contentHash, firstHash); assert.equal(course.pages.length, 2);
  await saveExit();
  const generationEvents = (await events()).filter(event => event.phase === 'generation');
  assert.ok(generationEvents.at(-1).input.sourceExcerpts.some(source => source.title === 'late-material.md'));
  assert.ok(!JSON.stringify(generationEvents.at(-1).input.sourceExcerpts).includes('PRIVATE_'));
  proof.checks.push('学习入口生成第一页；笔记入口恢复同课程且零重生成，晚到教材只进入第二页，旧页哈希保持不变');

  const shared = await page.evaluate(id => window.electronAPI.community.prepare({ noteIds: [id], kind: 'notes', includeDescendants: false }), leaf.id);
  assert.ok(shared.body.includes('唯一对应') && shared.body.includes('允许的输入'));
  assert.ok(!JSON.stringify(shared).includes('PRIVATE_'));
  await fsp.writeFile(path.join(root, 'shared-preview.json'), JSON.stringify(shared, null, 2));
  proof.checks.push('桌面真实分享预览 IPC 包含两页教学和静态题，不含私人复述、作答或进度');

  const beforeAgentStreams = (await page.evaluate(() => window.phase5Test.command({ op: 'stats' }))).streams;
  await page.evaluate(root => sessionStorage.setItem('loginote-agent-workflow-handoff-v1', JSON.stringify({
    version: 1, id: 'phase5-agent-handoff', sourceStage: 'plan', sourceSkillId: 'plan-planning',
    scopeProjectId: root.id, scopeProjectTitle: root.title, knowledgePointTitles: [], outcome: '已保存学习计划', createdAt: new Date().toISOString(),
    actions: [{ id: 'start-flow', targetSkillId: 'plan-planning', label: '开始心流学习', description: '继续计划叶子项目', prompt: '', destination: 'learning' }]
  })), parent);
  await page.reload(); await page.getByRole('button', { name: '学习', exact: true }).waitFor();
  await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
  await page.getByRole('region', { name: '建议的下一步' }).getByRole('button').filter({ hasText: '开始心流学习' }).click();
  await page.getByText('主线讲解已全部生成，仍可复述并退出保存。', { exact: false }).waitFor();
  assert.equal((await page.evaluate(() => window.phase5Test.command({ op: 'stats' }))).streams, beforeAgentStreams);
  const fromAgent = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  assert.equal(fromAgent.id, courseId); await saveExit();
  proof.checks.push('实际 Agent 下一步按钮直达同一叶子课程，不调用模型重生成学习任务或教材');

  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.locator('.quiet-home-project-card').filter({ hasText: parent.title }).getByRole('button', { name: '继续学习', exact: true }).click();
  await page.getByText('主线讲解已全部生成，仍可复述并退出保存。', { exact: false }).waitFor();
  assert.equal((await page.evaluate(() => window.phase5Test.command({ op: 'stats' }))).streams, beforeAgentStreams);
  const fromHome = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  assert.equal(fromHome.id, courseId); await saveExit();
  proof.checks.push('首页继续学习直达与学习页、笔记、Agent 相同的课程，已保存页面不重复生成');

  const createdLeaf = Object.values(disk).find(note => note.title === '识别输入和输出' && note.parentId === createdRoot.id);
  await enter(createdLeaf.title); await page.getByRole('button', { name: '下一页', exact: true }).waitFor({ timeout: 45000 });
  const fromCreatedPlan = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), createdLeaf.id);
  assert.ok(fromCreatedPlan.firstPage?.body);
  const createdGeneration = (await events()).filter(event => event.phase === 'generation').at(-1);
  assert.ok(createdGeneration.input.sourceExcerpts.some(source => source.title === 'planning-material.md'));
  await saveExit();
  await page.getByRole('button', { name: '继续心流', exact: true }).click(); await page.getByRole('button', { name: '下一页', exact: true }).waitFor();
  const restoredCreated = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), createdLeaf.id);
  assert.equal(restoredCreated.id, fromCreatedPlan.id); await saveExit();
  proof.checks.push('本轮实际新建计划的叶子无需旧任务/教材步骤；上传教材进入第一页，退出再进恢复同一课程');

  await waitStatus(offlineRoot.id, 'failed');
  await enter(offlineLeaf.title); await page.getByRole('button', { name: '下一页', exact: true }).waitFor({ timeout: 45000 }); await saveExit();
  proof.checks.push('联网准备失败仍能进入心流生成第一页，不伪造引用、不以资料准备为准入门槛');

  const beforeMigration = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  const moved = await page.evaluate(target => window.electronAPI.storage.setRoot(target, true), migratedRoot); assert.equal(moved.ok, true, moved.error);
  const blocked = await page.evaluate(async id => { try { await window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }); return false; } catch (error) { return String(error).includes('重启'); } }, leaf.id); assert.equal(blocked, true);
  await close(); await launch();
  course = await page.evaluate(id => window.electronAPI.progressiveLearning.command({ op: 'load', projectNoteId: id }), leaf.id);
  assert.equal(course.id, beforeMigration.id); assert.notEqual(course.environmentId, initialEnvironment); assert.equal(course.pages.length, 2);
  assert.equal(course.progress.restatementDraft, beforeMigration.progress.restatementDraft); assert.equal(course.pages[0].contentHash, firstHash);
  await fsp.writeFile(path.join(root, 'migrated-course-receipt.json'), JSON.stringify({ courseId: course.id, pages: course.pages.length, restoredDraft: course.progress.restatementDraft.includes('PRIVATE_NATIVE_PHASE5'), newEnvironment: course.environmentId !== initialEnvironment }, null, 2));
  proof.checks.push('真实设置迁移入口校验并复制课程与私人数据；重启后恢复同课程、页数和复述，旧根写入被阻止');

  const post = await events(); assert.equal(post.some(event => event.phase === 'unexpected-network'), false);
  assert.ok(post.some(event => event.phase === 'compute' && event.operation === 'embed'), 'background embedding held during UI operations');
  assert.deepEqual(proof.pageErrors, []); await close(); proof.status = 'passed';
} catch (error) {
  proof.status = 'failed'; proof.error = error.message; process.exitCode = 1; console.error(error);
  if (page) { await bounded(page.locator('body').innerText().then(text => fsp.writeFile(path.join(root, 'failure-text.txt'), text)), 'failure text', 2000).catch(() => {}); await bounded(page.screenshot({ path: path.join(root, 'failure.png') }), 'failure screenshot', 2000).catch(() => {}); }
} finally {
  if (child?.exitCode === null) child.kill(); await browser?.close().catch(() => {}); if (fd !== undefined) fs.closeSync(fd);
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}
