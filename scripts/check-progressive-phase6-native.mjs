import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { writeTextbookRegion } from '../src/services/textbook/noteContent.ts';

// Production Electron/main/preload/renderer and disk, isolated data only.
// SSE is deterministic and all networking is blocked: this proves workflow,
// persistence and failure handling, not the quality of an actual model's prose.
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-phase1-check.cjs'))('playwright');
const pressure = !process.argv.includes('--baseline') && process.env.PHASE6_PRESSURE !== '0';
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase6-' + (pressure ? 'parallel-' : 'baseline-')));
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
knowledge.content = '# 压力索引笔记\n\n' + Array.from({length:500},(_,i)=>`## 条件${i}\n\n笔记索引${i}：函数的定义域决定允许输入的范围，单一输入必须对应唯一输出。请在讨论极限前检查可行的趋近路径。\n\n`).join('');
const notes = [parent, normal, interrupted, failedSave, nativeClose, legacy, knowledge,
 ...Array.from({length:400},(_,i)=>makeNote('library-'+i,'资料库笔记 '+i,{noteType:'knowledge',projectRole:undefined,content:('# 合成长笔记 '+i+'\n\n函数、极限、定义域与唯一对应。仅用于隔离压力验收。\n\n').repeat(100)}))];
await fsp.mkdir(path.join(root,'inputs'),{recursive:true});
await fsp.writeFile(path.join(root,'inputs/pressure-document.md'),'# 并行资料\n\n'+Array.from({length:1500},(_,i)=>`## 段落${i}\n\n资料索引${i}：函数与定义域、极限和变化趋势需要区分研究对象、成立条件和判断依据。允许输入只能对应唯一输出，多种输入可以共享输出。\n\n`).join(''));

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
 const paragraphs=Array.from({length:20},(_,i)=>`## 情境 ${i+1}\n\n第${index+1}页内容：先明确研究的输入范围，再说明判断所依据的条件。${'函数中同一个允许输入有唯一输出，多种输入可以对应同一输出。分式的分母必须不为零，偶次根式的被开方数必须非负。'.repeat(3)}\n\n`).join('');
 return `${index===0?'@@PLAN\n'+JSON.stringify(plan)+'\n':''}@@LESSON\n\`\`\`mermaid\nflowchart LR\nA[允许输入]-->B[唯一对应]\nB-->C[输出]\nA-->D[定义域约束]\n\`\`\`\n\n${paragraphs}\n@@CONCEPTS\n${JSON.stringify([{key:'domain-'+index,title:'第'+(index+1)+'页输入限制',summary:'允许输入的范围应满足表达式有意义；分母不得为零。'}])}\n@@HOOK\n${JSON.stringify({...hook,id:'hook-'+page.id})}\n@@END\n`;
});
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('phase1Test',{command: input=>require('electron').ipcRenderer.invoke('progressive-test:command',input),probe:input=>require('electron').ipcRenderer.invoke('phase6:probe',input)});`);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network blocked by isolated progressive acceptance');};
const fs=require('node:fs'),{app,ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={mode:'normal',failPublishes:0,failPersonalSaves:0,calls:0,holdEmbedding:false};
const timers=new Map();
ipcMain.handle('progressive-test:command',async(_e,input)=>{if(input.op==='mode')control.mode=input.value;if(input.op==='hold-embedding')control.holdEmbedding=input.value;if(input.op==='fail-publish')control.failPublishes=input.value;if(input.op==='fail-personal')control.failPersonalSaves=input.value;if(input.op==='close-window')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);return {...control};});
const realFork=utilityProcess.fork.bind(utilityProcess),workers=[];const active=new Map();
let priorTick=performance.now(),maxMainGap=0;const gaps=[];
setInterval(()=>{const now=performance.now(),gap=now-priorTick;priorTick=now;gaps.push(gap);maxMainGap=Math.max(maxMainGap,gap);},50).unref();
ipcMain.handle('phase6:probe',(_event,input)=>{
 if(input?.op==='kill-document'){const found=workers.find(item=>item.service==='资料解析与正文索引'&&!item.exited);if(found){log({phase:'forced-worker-exit',service:found.service});found.worker.kill();}return Boolean(found);}
 if(input?.op==='stall-drawing'){const contents=require('electron').webContents.getAllWebContents().find(item=>item.getURL().includes('mermaid-renderer.html'));if(!contents)throw Error('No drawing worker');void contents.executeJavaScript('(()=>{const end=performance.now()+1500;while(performance.now()<end){};return true;})()').catch(()=>{});return {mainPid:_event.sender.getOSProcessId(),drawingPid:contents.getOSProcessId(),nativeWindow:Boolean(BrowserWindow.fromWebContents(contents))};}
 if(input?.op==='refresh-resources')_event.sender.send('learning-preparation:changed',input.noteId,{noteId:input.noteId,before:[],resources:input.resources,updatedAt:input.updatedAt});
 if(input?.op==='reset'){gaps.length=0;maxMainGap=0;}
 return {maxMainGap,gaps:gaps.slice(-2000),active:[...active.values()],memory:process.memoryUsage(),metrics:app.getAppMetrics(),workers:workers.map(({service,pid,exited})=>({service,pid,exited}))};
});
utilityProcess.fork=(...args)=>{const worker=realFork(...args),row={worker,service:args[2]?.serviceName,pid:worker.pid,exited:false};workers.push(row);log({phase:'worker-spawn',service:row.service,pid:worker.pid});const post=worker.postMessage.bind(worker);worker.postMessage=message=>{const key=row.service+':'+message.id;active.set(key,{service:row.service,operation:message.operation,id:message.id,at:Date.now()});log({phase:'background',service:row.service,id:message.id,operation:message.operation,noteId:message.args?.input?.noteId,pageId:message.args?.input?.regionId,count:message.args?.texts?.length,firstText:message.args?.texts?.[0]?.slice(0,60)});post(message);};worker.on('message',message=>{if(message.type==='progress')return;active.delete(row.service+':'+message.id);log({phase:'background-done',service:row.service,id:message.id,ok:message.ok,dimension:message.ok&&Array.isArray(message.value?.[0])?message.value[0].length:undefined});});worker.on('exit',code=>{row.exited=true;for(const [key,value]of active)if(value.service===row.service)active.delete(key);log({phase:'worker-exit',service:row.service,code});});return worker;};
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='vault:save-personal-state'&&control.failPersonalSaves>0){control.failPersonalSaves--;log({phase:'personal-save-failed'});throw Error('合成个人状态保存失败');}
 if(channel==='mermaid:render'){log({phase:'drawing-start',streaming:timers.size>0,active:[...active.values()]});const result=await handler(event,...args);log({phase:'drawing-done'});return result;}
 if(channel==='llm:stream-start'){
  const mode=control.mode,streamId='phase1-stream-'+(++control.calls);log({phase:'model-start',mode,streamId});
  const inputData=JSON.parse(args[0].userInput);
  const full=(inputData.routePending?'@@ROUTE\\n{\"kind\":\"mainline\",\"reason\":\"按既定主线继续\"}\\n':'')+${JSON.stringify(responses)}[Math.min(control.calls-1,2)];
  const end=['interrupt','hold'].includes(mode)?full.indexOf('\\n\\n## 怎样判断'):full.length;
  const input=full.slice(0,end),chunks=input.match(/[\\s\\S]{1,75}/g)||[];let index=0;
  const timer=setInterval(()=>{if(event.sender.isDestroyed()){clearInterval(timer);return;}if(index<chunks.length){if(index===0)log({phase:'first-token',streamId});event.sender.send('llm:stream-chunk',{streamId,chunk:{type:'content',text:chunks[index++]}});}else{clearInterval(timer);timers.delete(streamId);if(mode==='hold'){log({phase:'stream-held',streamId});return;}if(mode==='interrupt')event.sender.send('llm:stream-error',{streamId,message:'合成断流验收'});else{log({phase:'model-end',streamId});event.sender.send('llm:stream-end',{streamId});}}},90);timers.set(streamId,timer);return streamId;
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
const proof = { root, pressure, hardwareAcceleration: process.env.SAVE_NATIVE_GPU === '1', libraryNotes: notes.length, sourceCharacters: notes.reduce((sum,note)=>sum+note.content.length,0), actions:[], samples:[], nativeExits:[], checks: [], pageErrors: [], rendererRestarts: 0, network: 'blocked', generationQuality: 'not assessed: deterministic stream fixture' };
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
  proof.navigation ??= [];
  const route = await page.evaluate(() => ({ flow: Boolean(document.querySelector('.flow-mode-container')), course: document.querySelector('[data-progressive-course]')?.getAttribute('data-status'), learningButtons: [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === '学习').length }));
  proof.navigation.push({ title, ...route, at: Date.now() }); console.log(JSON.stringify({ enterFlow: proof.navigation.at(-1) }));
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
  proof.nativeExits.push(receipt); assert.equal(receipt.code, 0, 'real Windows process must exit cleanly');
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

const control6 = input=>page.evaluate(input=>window.phase1Test.probe(input),input);
const measure = async(label,run)=>{const at=Date.now();await run();const ms=Date.now()-at;proof.actions.push({label,ms});assert.ok(ms<4000,label+' must not freeze the interface');};
const waitUntil = async(read,test,label,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(test(value))return value;await new Promise(r=>setTimeout(r,250));}throw Error(label+' timed out');};
try {
  const opened=Date.now();await launch();proof.startupMs=Date.now()-opened;
  await page.evaluate(()=>{window.phase6Perf={tasks:[],frames:[],inputFrames:[],started:performance.now()};new MutationObserver(()=>{const text=document.querySelector('[data-progressive-course]')?.textContent||'';if(text.includes('第1页内容')&&!window.phase6Perf.firstReadableAt)window.phase6Perf.firstReadableAt=performance.now();}).observe(document.body,{childList:true,subtree:true,characterData:true});new PerformanceObserver(list=>window.phase6Perf.tasks.push(...list.getEntries().map(item=>({at:item.startTime,duration:item.duration})))).observe({type:'longtask'});let last=performance.now();const frame=now=>{window.phase6Perf.frames.push(now-last);last=now;window.phase6Raf=requestAnimationFrame(frame);};requestAnimationFrame(frame);document.addEventListener('input',event=>{if(event.target.classList.contains('flow-restate-textarea')){const at=performance.now();requestAnimationFrame(()=>window.phase6Perf.inputFrames.push(performance.now()-at));}},{capture:true});});
  await control6({op:'reset'});
  let noteIndex;
  if(pressure){
    const upload=await page.evaluate(file=>window.electronAPI.ragDocs.upload([file]),path.join(root,'inputs/pressure-document.md'));assert.ok(upload.ok);proof.documentId=upload.documents[0].id;
    const boundRoot={...parent,resources:[{title:'并行资料',kind:'local',url:'loginote-document://'+proof.documentId,documentId:proof.documentId,indexable:true}]};
    await page.evaluate(delta=>window.electronAPI.vault.saveNotesDelta(delta),{upserts:[{before:parent,note:boundRoot}],removed:[]});
    await control6({op:'refresh-resources',noteId:parent.id,resources:boundRoot.resources,updatedAt:parent.updatedAt});await new Promise(r=>setTimeout(r,300));
    await page.evaluate(id=>{window.phase6NoteIndex=window.electronAPI.noteRag.index({id}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));},knowledge.id);
    await waitUntil(()=>control6({}),value=>value.active.some(item=>item.operation==='vectorize')&&value.active.some(item=>item.operation==='embed'),'real document and note inference overlap');
    proof.concurrentStart=await control6({});
  }
  await enterFlow(normal.title);
  await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-status')==='generating',null,{timeout:30000});
  const sampling=setInterval(()=>{void control6({}).then(value=>proof.samples.push({...value,at:Date.now()})).catch(()=>{});},500);
  try{
    for(let cycle=0;cycle<8;cycle++){
      await measure('流式输入-'+cycle,()=>page.locator('.flow-restate-textarea').fill('PRIVATE_PHASE6：先确认允许输入和唯一输出。第'+cycle+'次输入。'));
      await measure('流式滚动-'+cycle,()=>reader().evaluate(element=>{element.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));element.scrollTop+=300;}));
      await new Promise(r=>setTimeout(r,200));
    }
    await waitReady();await reader().evaluate(element=>{element.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));element.scrollTop=element.scrollHeight;});const courseId=await reader().getAttribute('data-course-id');
    await page.waitForFunction(()=>[...document.querySelectorAll('.textbook-diagram-svg img')].some(image=>image.complete&&image.naturalWidth>0),undefined,{timeout:30000});proof.drawingIsolation=await control6({op:'stall-drawing'});assert.notEqual(proof.drawingIsolation.mainPid,proof.drawingIsolation.drawingPid);assert.equal(proof.drawingIsolation.nativeWindow,false);
    await measure('绘图繁忙时输入',()=>page.locator('.flow-restate-textarea').fill('PRIVATE_PHASE6：主线、文档和索引并行时仍可输入。'));
    if(pressure){await measure('中间打开教材资料',()=>page.locator('.focus-flow-side-resource-open').filter({hasText:'并行资料'}).click());await measure('资源切回当前笔记',()=>page.getByRole('tab',{name:'当前笔记',exact:true}).click());}
    await waitUntil(()=>page.evaluate(id=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:id}),normal.id),jobs=>jobs.length===1&&jobs.every(job=>job.indexReady),'first real page index');
    const oldIndexFile=path.join(state,'user-state/progressive-derived','project-'+createHash('sha256').update(JSON.stringify(normal.id)).digest('hex'),'main-1.index.json');
    const oldIndexBytes=await fsp.readFile(oldIndexFile);
    const beforeIndex=await page.evaluate(id=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:id}),normal.id);
    const filesBefore=await courseFiles();const courseBefore=filesBefore.find(item=>item.data.projectNoteId===normal.id).data;const firstHash=courseBefore.pages[0].contentHash;
    const point=(await events()).length;await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-2');await waitReady();assert.equal(await reader().getAttribute('data-page-id'),'main-2');
    await waitUntil(()=>page.evaluate(id=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:id}),normal.id),jobs=>jobs.length===2&&jobs.every(job=>job.indexReady),'second real page index');
    assert.ok(oldIndexBytes.equals(await fsp.readFile(oldIndexFile)),'previous page index must remain byte-identical');
    assert.equal((await events()).slice(point).filter(e=>e.operation==='chunk-textbook'&&e.pageId==='main-1').length,0);
    const filesAfter=await courseFiles();assert.equal(filesAfter.find(item=>item.data.projectNoteId===normal.id).data.pages[0].contentHash,firstHash);
    await measure('目录展开',()=>page.locator('.progressive-course-toc summary').click());
    await measure('回看第一页',()=>page.getByRole('button',{name:'唯一对应与定义域',exact:true}).click());
    await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-1');
    await measure('切回第二页',()=>page.getByRole('button',{name:'极限的两种入口',exact:true}).click());
    await measure('退出保存',()=>exitFlow());
    proof.courseId=courseId;proof.oldPageHash=firstHash;proof.firstIndex=beforeIndex;
    proof.checks.push('长资料库流式生成、输入、滚动、目录切换、独立绘图与真实页级索引并行，旧页不重分块/覆盖');
    if(pressure){
      const completed=await waitUntil(()=>page.evaluate(()=>window.electronAPI.ragDocs.list()),docs=>docs.some(doc=>doc.id===proof.documentId&&doc.status==='ready'),'real document index');assert.ok(completed);
      proof.noteIndex=await page.evaluate(()=>window.phase6NoteIndex);assert.equal(proof.noteIndex.ok,true);
      proof.checks.push('文档和笔记生产索引实际同时推理并完成，非挂起替身；资料及手写正文保持不变');
      await page.evaluate(id=>{window.phase6NoteIndex=window.electronAPI.noteRag.index({id}).catch(()=>{});},knowledge.id);
      await page.evaluate(id=>window.electronAPI.ragDocs.retry(id),proof.documentId);
      await waitUntil(()=>control6({}),value=>value.active.some(item=>item.service==='资料解析与正文索引'),'document worker active before interruption');
      await control6({op:'kill-document'});
      await waitUntil(()=>page.evaluate(()=>window.electronAPI.ragDocs.list()),docs=>docs.some(doc=>doc.id===proof.documentId&&doc.status==='failed'),'worker crash recorded');
      await measure('Worker中断后导航',()=>page.getByRole('button',{name:'学习',exact:true}).click());
      await page.evaluate(id=>window.electronAPI.ragDocs.retry(id),proof.documentId);
      await waitUntil(()=>page.evaluate(()=>window.electronAPI.ragDocs.list()),docs=>docs.some(doc=>doc.id===proof.documentId&&doc.status==='ready'),'explicit document retry');
      proof.checks.push('真实文档Worker中断有失败记录，界面仍可导航；显式重试重建进程并完成索引');
    }
    proof.performance=await page.evaluate(()=>window.phase6Perf);proof.finalMain=await control6({});
    await enterFlow(normal.title);await waitReady();const beforeCalls=await modelCalls();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-status')==='generating');
    await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.textContent.includes('第3页内容'));
    await measure('生成中退出并保存',()=>exitFlow());await closeNative();
    proof.checks.push('流式生成未完成时保存退出、原生关闭退出0');
    await launch();await enterFlow(normal.title);await page.getByRole('button',{name:'继续生成',exact:true}).waitFor({timeout:30000});
    const restored=await page.evaluate(id=>window.electronAPI.progressiveLearning.command({op:'load',projectNoteId:id}),normal.id);assert.equal(restored.id,courseId);assert.equal(restored.pages[0].contentHash,firstHash);assert.equal(await modelCalls(),beforeCalls+1);
    assert.ok(restored.generation.bodyDraft.includes('第3页内容'));
    await page.screenshot({path:path.join(root,'restarted-progress.png')});await exitFlow();await closeNative();
    proof.checks.push('重启恢复同一课程、完整旧页与第三页草稿；不自动重复生成');
  }finally{clearInterval(sampling);}

  const allEvents=await events();proof.fourWayOverlap=allEvents.filter(event=>event.phase==='drawing-start'&&event.streaming&&event.active.some(item=>item.operation==='vectorize')&&event.active.some(item=>item.operation==='embed'));if(pressure)assert.ok(proof.fourWayOverlap.length,'actual streaming, diagram, document and note inference must overlap');proof.workerTrace=allEvents.filter(event=>['worker-spawn','background','background-done','worker-exit','forced-worker-exit'].includes(event.phase));
  assert.equal(await fsp.readFile(path.join(state,'vault/notes',knowledge.id+'.md'),'utf8'),knowledge.content);
  assert.deepEqual(proof.pageErrors,[]);proof.status='passed';
  console.log(JSON.stringify({status:proof.status,root,checks:proof.checks,actions:proof.actions},null,2));
}catch(error){proof.status='failed';proof.error=error?.stack||String(error);if(page){await fsp.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await browser?.close().catch(()=>{});if(fd!==undefined)fs.closeSync(fd);await fsp.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));}
