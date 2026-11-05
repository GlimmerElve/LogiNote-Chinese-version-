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
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase2-native-'));
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
await fsp.symlink(path.resolve('models'), path.join(appRoot, 'models'), 'junction');
for (const [name, buffer] of await compileElectron(process.cwd())) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), buffer);
const plan = { title: '函数与定义域', objectives: ['区分唯一对应与定义域限制'], pages: [
  { id: 'main-1', title: '唯一对应与定义域', objectives: ['识别函数关系'] },
  { id: 'main-2', title: '极限的两种入口', objectives: ['理解趋近过程'] },
  { id: 'main-3', title: '极限的综合判断', objectives: ['说明边界条件'] },
] };
const prefix = '# 唯一对应与定义域\n\n函数把允许的每个输入对应到唯一的输出。判断一个关系时，首先检查同一个输入是否得到两个不同输出。\n\n定义域说明允许输入的范围，不能只看公式就忽略输入限制。';
const continuation = '\n\n## 怎样判断\n\n观察对应关系时，先确认研究对象、输入范围和输出规则。只要一个允许的输入对应到两个不同输出，这个关系就不满足函数的唯一性要求。不同输入对应同一个输出则是允许的。\n\n## 用例子核对\n\n平方根要求根号中的表达式非负，分式要求分母不为零。先分别写出限制，再求这些限制的交集，可以得到实际定义域。\n\n## 连接下一步\n\n极限研究的是输入沿着允许路径变化时，输出呈现什么趋势。先把定义域说清楚，才能判断所讨论的趋近路径是否存在。';
const hook = { id: 'hook-main-1', kind: 'reflection', prompt: '请举例说明：为什么判断函数时必须同时说明定义域与对应规则？' };
const firstResponse = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const resumeResponse = `@@LESSON\n${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const responses = plan.pages.map((page,index)=> {
 const paragraphs=Array.from({length:32},(_,i)=>`## 情境 ${i+1}\n\n第${index+1}页内容：先明确研究的输入范围，再说明判断所依据的条件。${'函数中同一个允许输入有唯一输出，多种输入可以对应同一输出。分式的分母必须不为零，偶次根式的被开方数必须非负。'.repeat(3)}\n\n`).join('');
 return `${index===0?'@@PLAN\n'+JSON.stringify(plan)+'\n':''}@@LESSON\n${paragraphs}@@CONCEPTS\n${JSON.stringify([{key:'domain-'+index,title:'第'+(index+1)+'页输入限制',summary:'允许输入的范围应满足表达式有意义；分母不得为零。'}])}\n@@HOOK\n${JSON.stringify({...hook,id:'hook-'+page.id})}\n@@END\n`;
});
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('phase1Test',{command: input=>require('electron').ipcRenderer.invoke('progressive-test:command',input)});`);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network blocked by isolated progressive acceptance');};
const fs=require('node:fs'),{app,ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={mode:'normal',failPublishes:0,failPersonalSaves:0,calls:0,holdEmbedding:false,thirdChunkStarted:false,heldEmbeddings:0};
const timers=new Map();
ipcMain.handle('progressive-test:command',async(_e,input)=>{if(input.op==='mode')control.mode=input.value;if(input.op==='hold-embedding')control.holdEmbedding=input.value;if(input.op==='fail-publish')control.failPublishes=input.value;if(input.op==='fail-personal')control.failPersonalSaves=input.value;if(input.op==='close-window')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);return {...control};});
const realFork=utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork=(...args)=>{const worker=realFork(...args);log({phase:'worker-spawn',service:args[2]?.serviceName,pid:worker.pid});const post=worker.postMessage.bind(worker);worker.postMessage=message=>{if(message.operation==='chunk-textbook'&&message.args?.input?.regionId==='main-3')control.thirdChunkStarted=true;log({phase:'background',operation:message.operation,noteId:message.args?.input?.noteId,pageId:message.args?.input?.regionId,count:message.args?.texts?.length});if(message.operation==='embed'&&control.holdEmbedding&&control.thirdChunkStarted){control.heldEmbeddings++;log({phase:'embedding-held'});return;}post(message);};return worker;};
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='vault:save-personal-state'&&control.failPersonalSaves>0){control.failPersonalSaves--;log({phase:'personal-save-failed'});throw Error('合成个人状态保存失败');}
 if(channel==='llm:stream-start'){
  const mode=control.mode,streamId='phase1-stream-'+(++control.calls);log({phase:'model-start',mode,streamId});
  const inputData=JSON.parse(args[0].userInput);
  const full=(inputData.routePending?'@@ROUTE\\n{\"kind\":\"mainline\",\"reason\":\"按既定主线继续\"}\\n':'')+${JSON.stringify(responses)}[Math.min(control.calls-1,2)];
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
  const closeButton = page.locator('.window-control-close');
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
  await launch(); await enterFlow(normal.title); await waitReady();
  const courseId=await reader().getAttribute('data-course-id');
  await page.waitForFunction(()=>window.electronAPI?.progressiveLearning?.derived);
  // Actual ONNX process and durable job are live while input and rendering remain usable.
  const readStatuses=()=>page.evaluate(id=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:id}),normal.id);
  const waitJobs=async predicate=>{for(let i=0;i<450;i++){const jobs=await readStatuses();if(predicate(jobs))return jobs;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Background status timeout: '+JSON.stringify(await readStatuses()));};
  const waitIndexed=(count)=>waitJobs(jobs=>jobs.length===count&&jobs.every(job=>job.status==='ready'));
  await page.waitForFunction(()=>true);
  await page.evaluate(()=>{window.phase2Frames=[];let previous=performance.now();const next=()=>{const now=performance.now();window.phase2Frames.push(now-previous);previous=now;window.phase2Raf=requestAnimationFrame(next);};window.phase2Raf=requestAnimationFrame(next);});
  await waitJobs(jobs=>jobs.some(job=>job.status==='running'));
  proof.jobsDuringInput=await readStatuses();
  const fillStarted=Date.now();
  await page.locator('.flow-restate-textarea').fill('PRIVATE_PHASE2：先看定义域，再看对应规则。');
  proof.inputMs=Date.now()-fillStarted;
  await reader().evaluate(element=>{element.scrollTop=1200;});
  await waitIndexed(1);
  const firstJobs=await readStatuses();assert.equal(firstJobs[0].indexReady,true);
  proof.checks.push('真实Electron utility process本地分块和ONNX推理期间可输入与滚动，正文先保存');
  const backgroundStart=(await events()).length;
  await page.getByRole('button',{name:'下一页',exact:true}).click(); await waitReady();
  assert.equal(await reader().getAttribute('data-page-id'),'main-2');
  assert.equal(await reader().getAttribute('data-course-id'),courseId);
  assert.equal(await page.locator('.flow-restate-textarea').inputValue(),'PRIVATE_PHASE2：先看定义域，再看对应规则。');
  await waitIndexed(2);
  assert.equal((await events()).slice(backgroundStart).filter(e=>e.operation==='chunk-textbook'&&e.pageId==='main-1').length,0);
  proof.checks.push('下一页生成并保存第2页，复述保留，第1页不重新分块');
  await page.locator('.progressive-course-toc summary').click();
  await page.getByRole('button',{name:'唯一对应与定义域',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-1');
  await page.getByRole('button',{name:'极限的两种入口',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-2');
  assert.equal(await modelCalls(),2);
  await page.screenshot({path:path.join(root,'second-page-indexed.png')});
  proof.checks.push('目录回看第1/2页只读取目标页，不触发生成');
  await page.evaluate(()=>window.phase1Test.command({op:'hold-embedding',value:true}));
  await page.getByRole('button',{name:'下一页',exact:true}).click();await waitReady();
  assert.equal(await reader().getAttribute('data-page-id'),'main-3');
  await waitJobs(jobs=>jobs.some(job=>job.pageId==='main-3'&&job.status==='running'));
  // Interrupt inference only after a durable chunk checkpoint exists. Running
  // alone can mean chunking is still queued behind a different note's inference.
  const derivedRoot=path.join(state,'user-state/progressive-derived');
  const directories=await fsp.readdir(derivedRoot);
  const thirdIndexFile=path.join(derivedRoot,directories.find(name=>name.startsWith('project-')),'main-3.index.json');
  let durable=false;
  for(let i=0;i<450;i++){const control=await page.evaluate(()=>window.phase1Test.command({op:'status'}));try{const index=JSON.parse(await fsp.readFile(thirdIndexFile,'utf8'));if(index.chunks.length&&control.heldEmbeddings>0){durable=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(durable,'actual third-page chunks must be durable before the interrupted-inference test');
  const exitStarted=Date.now(); await exitFlow();proof.exitWhileIndexingMs=Date.now()-exitStarted;
  proof.maxFrameMs=await page.evaluate(()=>{cancelAnimationFrame(window.phase2Raf);return Math.max(0,...window.phase2Frames);});
  await closeNative();
  proof.checks.push('第3页向量任务尚未完成时退出保存与原生关闭均成功，进程退出0');
  const priorCalls=await modelCalls(), restartEvents=(await events()).length;
  await launch();await enterFlow(normal.title);await waitReady();await waitIndexed(3);
  assert.equal(await reader().getAttribute('data-course-id'),courseId);
  assert.equal(await reader().getAttribute('data-page-id'),'main-3');
  assert.equal(await modelCalls(),priorCalls);
  assert.equal((await events()).slice(restartEvents).filter(e=>e.operation==='chunk-textbook'&&['main-1','main-2','main-3'].includes(e.pageId)).length,0);
  assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).count(),0);
  await page.screenshot({path:path.join(root,'restarted-third-page.png')});
  const jobs=await readStatuses();assert.equal(jobs.length,3);assert.ok(jobs.every(job=>job.knowledgeIds?.length===1));
  const saved=JSON.parse(await fsp.readFile(path.join(state,'vault/metadata.json'),'utf8'));
  assert.equal(Object.values(saved.notesMeta).filter(note=>note.noteType==='knowledge'&&note.parentId===normal.id).length,3);
  proof.jobs=jobs;proof.workerTrace=(await events()).filter(e=>['worker-spawn','background','embedding-held'].includes(e.phase));
  proof.checks.push('重启恢复同课程第3页及知识点对象，只补缺失向量，不重分块或再次调用生成模型');
  assert.deepEqual(proof.pageErrors,[]);assert.ok(proof.inputMs<1500);assert.ok(proof.exitWhileIndexingMs<5000);
  await exitFlow();
  const projectBody = await fsp.readFile(path.join(state,'vault/notes',normal.id+'.md'),'utf8');
  assert.ok(projectBody.startsWith(normal.content));
  assert.equal((projectBody.match(/### 本项目需要掌握的知识点/gu)||[]).length,1);
  for(let index=1;index<=3;index++)assert.ok(projectBody.includes('[[第'+index+'页输入限制]]：'));
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.getByRole('button',{name:'搜索项目笔记',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索项目笔记',exact:true}).fill(normal.title);
  await page.getByTitle('打开「'+normal.title+'」',{exact:true}).click();
  await page.getByRole('button',{name:'编辑笔记与复盘',exact:true}).click();
  const noteEditor=page.locator('.mdxeditor-content-editable');
  await noteEditor.getByRole('heading',{name:'本项目需要掌握的知识点',exact:true}).waitFor();
  await noteEditor.getByText('第1页输入限制',{exact:true}).click();
  await page.getByRole('dialog').filter({hasText:'第1页输入限制'}).waitFor();
  await page.screenshot({path:path.join(root,'knowledge-links.png')});
  proof.checks.push('保存退出后项目正文显示唯一知识点清单和简述，标准双链可打开实际后台创建的知识点');
  await page.getByRole('dialog').filter({hasText:'第1页输入限制'}).getByRole('button',{name:'关闭',exact:true}).click();
  await closeNative();proof.status='passed';
  console.log(JSON.stringify({status:proof.status,checks:proof.checks.length,root,inputMs:proof.inputMs,exitWhileIndexingMs:proof.exitWhileIndexingMs,maxFrameMs:proof.maxFrameMs,coverage:proof.checks},null,2));
}catch(error){proof.status='failed';proof.error=error?.stack||String(error);if(page){await fsp.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await browser?.close().catch(()=>{});if(fd!==undefined)fs.closeSync(fd);await fsp.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));}
