import assert from 'node:assert/strict';
import { build } from 'esbuild';
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
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase4-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fsp.writeFile(path.join(root, 'ipc.jsonl'), '');
await fsp.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fsp.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fsp.mkdir(path.join(state, 'user-state'), { recursive: true });
const at = '2026-11-01T00:00:00.000Z';
const makeNote = (id, title, extra = {}) => ({ id, title, noteType: 'project', projectRole: 'learning', content: '# 学习目标\n理解函数与定义域。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...extra });
const parent = makeNote('progressive-check-root', '第四阶段独立验收', { planMeta: { status: 'active', dailyStudyMinutes: 30 } });
const normal = makeNote('progressive-normal', '复盘归档与自动完成', { parentId: parent.id, dueDates: [{id:'native-task',noteId:'progressive-normal',noteTitle:'复盘归档与自动完成',taskText:'复盘归档与自动完成',dueDate:'2026-11-06',estimatedMinutes:60,priority:'medium',completed:false}] });
const interrupted = makeNote('progressive-interrupted', '断流后继续生成', { parentId: parent.id,dueDates:[{id:'resume-review-task',noteId:'progressive-interrupted',noteTitle:'断流后继续生成',taskText:'断流后继续生成',dueDate:'2026-11-06',estimatedMinutes:40,priority:'medium',completed:false}] });
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
const plan={title:'函数与定义域',objectives:['解释唯一输出'],pages:[{id:'main-1',title:'输入与输出唯一性',objectives:['识别函数关系']}]};
const prefix = '# 唯一对应与定义域\n\n函数把允许的每个输入对应到唯一的输出。判断一个关系时，首先检查同一个输入是否得到两个不同输出。\n\n定义域说明允许输入的范围，不能只看公式就忽略输入限制。';
const continuation = '\n\n## 怎样判断\n\n观察对应关系时，先确认研究对象、输入范围和输出规则。只要一个允许的输入对应到两个不同输出，这个关系就不满足函数的唯一性要求。不同输入对应同一个输出则是允许的。\n\n## 用例子核对\n\n平方根要求根号中的表达式非负，分式要求分母不为零。先分别写出限制，再求这些限制的交集，可以得到实际定义域。\n\n## 连接下一步\n\n极限研究的是输入沿着允许路径变化时，输出呈现什么趋势。先把定义域说清楚，才能判断所讨论的趋近路径是否存在。';
const hook = { id: 'hook-main-1', kind: 'reflection', prompt: '请举例说明：为什么判断函数时必须同时说明定义域与对应规则？' };
const firstResponse = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const resumeResponse = `@@LESSON\n${continuation}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const responses = plan.pages.map((page,index)=> {
 const paragraphs=Array.from({length:32},(_,i)=>`## 情境 ${i+1}\n\n第${index+1}页内容：先明确研究的输入范围，再说明判断所依据的条件。${'函数中同一个允许输入有唯一输出，多种输入可以对应同一输出。分式的分母必须不为零，偶次根式的被开方数必须非负。'.repeat(3)}\n\n`).join('');
 return `${index===0?'@@PLAN\n'+JSON.stringify(plan)+'\n':''}@@LESSON\n${paragraphs}@@CONCEPTS\n${JSON.stringify([{key:'domain-'+index,title:'第'+(index+1)+'页输入限制',summary:'允许输入的范围应满足表达式有意义；分母不得为零。'}])}\n@@HOOK\n${JSON.stringify({...hook,id:'hook-'+page.id})}\n@@END\n`;
});
const teachingQuote='允许的每个输入必须对应唯一的输出。';
const longText='先写出输入限制，再判断对应关系是否唯一；同一输入不能得到两个不同输出，而不同输入可以得到同一个输出。'.repeat(36);
const teachingBody=`${teachingQuote}不同输入可以有相同输出。\n\n## 数量例子\n\n长度2米与1米相加得到3米。\n\n## 核对边界\n\n${longText}`;
const quizDefinitions=[
 {id:'q1',kind:'choice',prompt:'一个允许的输入能否得到两个不同输出？',objective:'判断唯一性',conceptKeys:['unique'],focus:'concept',options:[{id:'A',text:'不能'},{id:'B',text:'能'}],correctOptionId:'A',referenceAnswer:'不能',explanation:'每个允许输入必须有唯一输出。',referenceQuote:teachingQuote},
 {id:'q2',kind:'application',prompt:'长度2米与1米相加是多少？请写数值与单位。',objective:'应用数量关系',conceptKeys:['sum'],focus:'calculation',referenceAnswer:'3米',explanation:'2米+1米=3米。',referenceQuote:'长度2米与1米相加得到3米。'},
 {id:'q3',kind:'judgment',prompt:'一个允许输入可以有两个不同输出，对吗？',objective:'核对唯一性',conceptKeys:['unique'],focus:'concept',options:[{id:'A',text:'不对'},{id:'B',text:'对'}],correctOptionId:'A',referenceAnswer:'不对',explanation:'输出需要唯一。',referenceQuote:teachingQuote}
];
const nativeLessons=[3,2,1,1].map((count,index)=>`@@LESSON\n${teachingBody}\n@@CONCEPTS\n${JSON.stringify([{key:'unique',title:'输入与输出唯一性',summary:teachingQuote}])}\n@@QUESTIONS\n${JSON.stringify([])}\n@@HOOK\n${JSON.stringify(hook)}\n@@END\n`);
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('phase1Test',{command: input=>require('electron').ipcRenderer.invoke('progressive-test:command',input)});`);
await build({entryPoints:['scripts/fixtures/progressive-phase4.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(root,'model-fixtures.cjs')});
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network blocked by isolated progressive acceptance');};
const fixtures=require(${JSON.stringify(path.join(root,'model-fixtures.cjs'))});
const fs=require('node:fs'),{app,ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={mode:'normal',failPublishes:0,failPersonalSaves:0,calls:0,holdEmbedding:false,holdAssessment:false,failStudy:0,holdReview:true,failAuxAck:1};
const timers=new Map(),heldAssessments=new Map(),heldReviews=new Map();
ipcMain.handle('progressive-test:command',async(_e,input)=>{if(input.op==='release-reviews'){control.holdReview=false;for(const done of heldReviews.values())done();heldReviews.clear();}if(input.op==='mode')control.mode=input.value;if(input.op==='hold-assessment')control.holdAssessment=input.value;if(input.op==='fail-study')control.failStudy=input.value;if(input.op==='hold-embedding')control.holdEmbedding=input.value;if(input.op==='fail-publish')control.failPublishes=input.value;if(input.op==='fail-personal')control.failPersonalSaves=input.value;if(input.op==='close-window')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);return {...control};});
const realFork=utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork=(...args)=>{const worker=realFork(...args);log({phase:'worker-spawn',service:args[2]?.serviceName,pid:worker.pid});const post=worker.postMessage.bind(worker);worker.postMessage=message=>{log({phase:'background',operation:message.operation,noteId:message.args?.input?.noteId,pageId:message.args?.input?.regionId,count:message.args?.texts?.length});if(message.operation==='embed'&&control.holdEmbedding){log({phase:'embedding-held'});return;}post(message);};return worker;};
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='vault:save-personal-state'&&control.failPersonalSaves>0){control.failPersonalSaves--;log({phase:'personal-save-failed'});throw Error('合成个人状态保存失败');}
 if(channel==='llm:stream-start'){
  const mode=control.mode,streamId='phase3-stream-'+(++control.calls),payload=JSON.parse(args[0].userInput);log({phase:'model-start',mode,streamId,payload});
  const first=!payload.fixedMainline,expansion=payload.currentPage?.kind==='expansion'||payload.routePending;
  const lesson=${JSON.stringify(nativeLessons)}[first?0:expansion?3:payload.currentPage?.id==='main-2'?1:2];
  const full=(first?'@@PLAN\\n'+JSON.stringify(${JSON.stringify(plan)})+'\\n':'')+(payload.routePending?'@@ROUTE\\n'+JSON.stringify({kind:'expansion',reason:'先补充关键概念的边界'})+'\\n':'')+lesson;
  const end=['interrupt','hold'].includes(mode)?full.indexOf('\\n\\n## 怎样判断'):full.length;
  const input=full.slice(0,end),chunks=input.match(/[\\s\\S]{1,75}/g)||[];let index=0;
  const timer=setInterval(()=>{if(event.sender.isDestroyed()){clearInterval(timer);return;}if(index<chunks.length){event.sender.send('llm:stream-chunk',{streamId,chunk:{type:'content',text:chunks[index++]}});}else{clearInterval(timer);timers.delete(streamId);if(mode==='hold'){log({phase:'stream-held',streamId});return;}if(mode==='interrupt')event.sender.send('llm:stream-error',{streamId,message:'合成断流验收'});else event.sender.send('llm:stream-end',{streamId});}},8);timers.set(streamId,timer);return streamId;
 }
 if(channel==='llm:request'){
  const payload=JSON.parse(args[0].userInput);log({phase:'assessment-start',workflow:payload.protocol==='flow-argument-shadow-v2'?'flow-analysis':payload.evaluationId?'knowledge-mastery-scoring':'quiz',payload});
  if(payload.protocol==='flow-argument-shadow-v2'){
    const result={content:JSON.stringify(fixtures.progressiveReviewModelReply(payload))};
    if(control.holdReview)return new Promise(resolve=>heldReviews.set(args[0].requestId,()=>resolve(result)));
    return result;
  }
  if(payload.evaluationId&&payload.knowledgePointId)return {content:JSON.stringify(fixtures.progressiveMasteryModelReply(payload))};
  const result=payload.feedback?{content:JSON.stringify({status:'confirmed',explanation:'合成反馈核实：此题存在待核对条件，保留原作答。'})}:{content:JSON.stringify({results:(payload.tasks||[]).map(task=>({attemptId:task.attemptId,judgment:{outcome:'correct',errorKind:'none',explanation:'2米与1米相加得到3米。',referenceAnswer:'3米',referenceQuote:'长度2米与1米相加得到3米。'}}))})};
  if(control.holdAssessment)return new Promise(resolve=>heldAssessments.set(args[0].requestId,()=>resolve(result)));
  return result;
 }
 if(channel==='llm:cancel'){const complete=heldAssessments.get(args[0]);if(complete){complete();heldAssessments.delete(args[0]);} const timer=timers.get(args[0]);if(timer)clearInterval(timer);timers.delete(args[0]);return true;}
 if(channel==='progressive-learning:command'){
  if(args[0]?.op==='review-acknowledge'&&control.failAuxAck>0){control.failAuxAck--;throw Error('合成辅助回执保存失败');}
  const command=args[0];if(command?.op==='study'&&command.request?.mutation?.kind==='draft'&&control.failStudy>0){control.failStudy--;throw Error('合成作答保存失败');}log({phase:'progressive-start',op:command?.op,projectNoteId:command?.projectNoteId||command?.lease?.projectNoteId});
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
  // The native shutdown may already close a beforeunload dialog by the time
  // CDP acknowledges it. Handle that driver race without an unhandled rejection.
  page.on('dialog', dialog => {
    void (dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss()).catch(error=>{
      if(/No dialog is showing|Target.*closed/iu.test(String(error))){(proof.nativeDialogRaces??=[]).push(String(error));return;}
      proof.pageErrors.push(String(error));
    });
  });
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
}
async function exitFlow() {
  await page.getByRole('button', { name: '退出并保存', exact: true }).click();
  await page.locator('.flow-mode-container').waitFor({ state: 'detached', timeout: 15000 });
}
async function closeNative() {
  await page.evaluate(()=>{if(window.exitGuardTrace)return;window.exitGuardTrace=[];const original=Event.prototype.preventDefault;Event.prototype.preventDefault=function(...args){if(this.type==='beforeunload')window.exitGuardTrace.push(new Error().stack);return original.apply(this,args);};});
  const closeButton = page.getByRole('button', { name: '关闭', exact: true });
  if (await closeButton.count()) await closeButton.click();
  else await page.evaluate(() => window.phase1Test.command({ op: 'close-window' }));
  let timer;
  const receipt = await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 20000); })]);
  clearTimeout(timer);
  if(receipt.code!==0)proof.exitGuardTrace=await page.evaluate(()=>window.exitGuardTrace).catch(()=>[]);
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


const readCourse=(id=normal.id)=>page.evaluate(id=>window.electronAPI.progressiveLearning.command({op:'load',projectNoteId:id}),id);
async function waitCourse(predicate,id=normal.id){for(let i=0;i<600;i++){const c=await readCourse(id);if(c&&predicate(c))return c;await new Promise(r=>setTimeout(r,50));}const failed=await readCourse(id);throw Error('Course state wait timed out: '+JSON.stringify({reviews:failed?.reviews,completion:failed?.completion}));}
async function continueNote(){await page.getByRole('button',{name:'继续心流',exact:true}).click();await reader().waitFor();await waitReady();}
const flowAnalysisCalls=async()=>(await events()).filter(e=>e.phase==='assessment-start'&&e.workflow==='flow-analysis').length;
try{
 await launch();await enterFlow(normal.title);await waitReady();
 const originalText='PRIVATE_NATIVE_REVIEW：函数的每个允许输入对应唯一输出；两个不同输入可以输出相同，定义域需要明确说明。';
 await page.locator('.flow-restate-textarea').fill(originalText);
 await page.locator('.focus-flow-analysis-control [role="switch"]').click();
 await exitFlow();let saved=await readCourse();assert.equal(saved.reviews?.length||0,0);assert.equal(saved.progress.restatementDraft,originalText);assert.equal(await flowAnalysisCalls(),0);
 proof.checks.push('关闭复盘分析后只保存当前草稿，未启动正式分析，也未制造有效复盘凭据');
 await continueNote();assert.equal(await page.locator('.flow-restate-textarea').inputValue(),originalText);
 const exitAt=Date.now();await exitFlow();proof.exitWhileReviewHeldMs=Date.now()-exitAt;
 await waitCourse(c=>c.reviews?.some(r=>r.status==='running'));
 assert.ok(proof.exitWhileReviewHeldMs<2500,'remote analysis must not hold the exit button');
 await continueNote();assert.equal(await page.locator('.flow-restate-textarea').inputValue(),originalText);
 await page.locator('.flow-restate-textarea').fill(originalText+'PRIVATE_NATIVE_NEW：这是分析期间追加的复述。');
 await page.evaluate(()=>window.phase1Test.command({op:'release-reviews'}));
 saved=await waitCourse(c=>c.lastSuccessfulReview&&c.reviews?.some(r=>r.status==='analyzed'));
 await page.waitForFunction(()=>document.querySelector('.flow-restate-textarea')?.value==='PRIVATE_NATIVE_NEW：这是分析期间追加的复述。');
 assert.equal((await readCourse()).lastSuccessfulReview.reviewId,saved.lastSuccessfulReview.reviewId);
 await page.locator('.focus-flow-analysis-control [role="switch"]').click();await exitFlow();
 await waitCourse(c=>c.completion?.status==='committed');
 await page.getByRole('button',{name:'编辑笔记与复盘',exact:true}).click().catch(()=>{});
 const reopenInspector=page.getByRole('button',{name:'打开信息栏',exact:true});
 if(await reopenInspector.isVisible()) await reopenInspector.click();
 await page.getByRole('tab',{name:'学习记录',exact:true}).click();
 const record=page.locator('[data-progressive-review-id]').first();await record.locator('summary').first().click();
 await record.getByText('本次实际分析的原文',{exact:true}).click();await record.getByText(originalText,{exact:true}).waitFor();
 await record.getByText('编辑归档文本',{exact:true}).click();await record.getByRole('button',{name:'编辑文本',exact:true}).click();
 const archiveEditor=record.getByRole('textbox',{name:'编辑归档复述'});await archiveEditor.fill(originalText+' 尚未保存');
 await page.getByRole('tab',{name:'笔记信息',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'学习记录',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await archiveEditor.inputValue(),originalText+' 尚未保存');
 await page.getByRole('button',{name:'收起信息栏',exact:true}).click();
 assert.equal(await archiveEditor.inputValue(),originalText+' 尚未保存');
 await page.getByRole('button',{name:'学习',exact:true}).click();
 assert.equal(await archiveEditor.inputValue(),originalText+' 尚未保存','navigation must not discard unsaved archive edits');
 await record.getByRole('button',{name:'取消编辑',exact:true}).click();
 await page.getByRole('tab',{name:'笔记信息',exact:true}).click();await page.getByRole('tab',{name:'学习记录',exact:true}).click();
 await record.getByText(originalText,{exact:true}).waitFor();
 await page.screenshot({path:path.join(root,'archived-review-and-new-draft.png')});
 proof.checks.push('正式分析在退出后后台执行；重进期间成功归档时只清除对应原文，新增复述保留在右侧，不回填历史全文');
 await waitCourse(c=>c.reviews?.some(r=>r.auxiliary==='failed'));
 const analysisBefore=await flowAnalysisCalls();const masteryBefore=(await events()).filter(e=>e.phase==='assessment-start'&&e.workflow==='knowledge-mastery-scoring').length;
 await record.getByRole('button',{name:'重试未完成部分',exact:true}).click();await waitCourse(c=>c.reviews?.every(r=>r.auxiliary==='ready'));
 assert.equal(await flowAnalysisCalls(),analysisBefore);assert.equal((await events()).filter(e=>e.phase==='assessment-start'&&e.workflow==='knowledge-mastery-scoring').length,masteryBefore);
 proof.checks.push('辅助回执失败仍显示主分析已成功；显式重试复用掌握度回执，不重复主分析或模型评价');
 const chunk=record.locator('.progressive-attempt-record').filter({hasText:'第1段 · 已分析'});await chunk.locator('summary').first().click();
 await chunk.getByRole('button',{name:'查看分析详情',exact:true}).click();await page.locator('.flow-analysis-panel').waitFor();
 await page.getByRole('button',{name:'关闭复盘分析',exact:true}).click();assert.equal(await flowAnalysisCalls(),analysisBefore);
 await record.getByText('查看关联结构图',{exact:true}).click();await page.screenshot({path:path.join(root,'saved-analysis-graph.png')});
 proof.checks.push('展开归档原文、分析详情和关联结构图只读，不新建分析、提交答案或修改学习游标');
 const beforeRestart=await readCourse();
 await page.getByRole('button',{name:'学习',exact:true}).click();await page.getByRole('heading',{name:'学习队列',exact:true}).waitFor();const completedCard=page.locator('button.flow-project-card').filter({hasText:normal.title});await completedCard.getByText(/^(?:计划)?已完成$/,{exact:true}).waitFor();assert.equal(await completedCard.getByRole('progressbar',{name:'项目完成进度'}).getAttribute('aria-valuenow'),'100');
 await closeNative();await launch();
 await page.getByRole('button',{name:'笔记',exact:true}).click();await page.getByText(normal.title,{exact:true}).first().click();await page.locator('[data-progressive-saved]').waitFor();
 await continueNote();assert.equal(await page.locator('.flow-restate-textarea').inputValue(),'PRIVATE_NATIVE_NEW：这是分析期间追加的复述。');
 saved=await readCourse();assert.equal(saved.lastSuccessfulReview.reviewId,beforeRestart.lastSuccessfulReview.reviewId);assert.equal(saved.reviews.length,1);assert.equal(await flowAnalysisCalls(),analysisBefore);
 await page.locator('.focus-flow-analysis-control [role="switch"]').click();await exitFlow();await waitCourse(c=>c.completion?.status==='committed');
 const projectedBody=await fsp.readFile(path.join(state,'vault/notes',normal.id+'.md'),'utf8');
 const expectedBody=normal.content+'\n\n### 本项目需要掌握的知识点\n\n[[输入与输出唯一性]]：'+teachingQuote;
 assert.equal(projectedBody.replace(/\s+/gu,' ').trim(),expectedBody.replace(/\s+/gu,' ').trim());
 assert.ok(!projectedBody.includes('PRIVATE_'));
 assert.deepEqual(proof.pageErrors,[]);
 proof.checks.push('真实Windows关闭重启恢复有效凭据与新增草稿，历史分析不重跑；主线无题时由有效复盘自动完成叶子，正文仅追加公开知识点清单、不混入私人记录');

 await enterFlow(interrupted.title);await waitReady();await page.locator('.flow-restate-textarea').fill('PRIVATE_RESUME_REVIEW：函数允许的每个输入都要有唯一输出，必须核对限定条件。');await exitFlow();
 await waitCourse(c=>c.reviews?.some(r=>r.status==='running'),interrupted.id);
 const beforeHeldClose=Date.now();await closeNative();proof.closeWhileReviewHeldMs=Date.now()-beforeHeldClose;
 await launch();await page.evaluate(()=>window.phase1Test.command({op:'release-reviews'}));
 await waitCourse(c=>c.lastSuccessfulReview&&c.reviews?.length===1&&c.reviews.every(r=>r.status==='analyzed'&&r.completedParts===r.parts)&&c.progress.restatementDraft==='',interrupted.id);
 const resumed=await page.evaluate(id=>window.electronAPI.progressiveLearning.command({op:'load',projectNoteId:id}),interrupted.id);await fsp.writeFile(path.join(root,'resumed-course-receipt.json'),JSON.stringify({reviews:resumed.reviews,lastSuccessfulReview:resumed.lastSuccessfulReview},null,2));assert.equal(resumed.reviews.length,1);assert.equal(resumed.reviews[0].completedParts,1);assert.equal((await readCourse()).lastSuccessfulReview.reviewId,beforeRestart.lastSuccessfulReview.reviewId);
 assert.deepEqual(proof.pageErrors,[]);await closeNative();proof.checks.push('正式模型请求挂起时真实关闭进程仍退出0；重启只恢复未完成复盘，保留其他叶子的既有有效凭据');
 proof.status='passed';console.log(JSON.stringify({status:proof.status,root,checks:proof.checks.length,exitWhileReviewHeldMs:proof.exitWhileReviewHeldMs,coverage:proof.checks},null,2));
}catch(error){proof.status='failed';proof.error=error?.stack||String(error);if(page){await fsp.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await browser?.close().catch(()=>{});if(fd!==undefined)fs.closeSync(fd);await fsp.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));}
