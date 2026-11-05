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
import { interactiveFigureTitle } from '../src/services/textbook/interactiveFigureTitle.ts';

// Production Electron/main/preload/renderer and disk, isolated data only.
// SSE is deterministic and all networking is blocked: this proves workflow,
// persistence and failure handling, not the quality of an actual model's prose.
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-phase1-check.cjs'))('playwright');
const liveFigurePath = process.env.LOGINOTE_LOCAL_FUNCTION_FIXTURE || process.env.LOGINOTE_FIGURE_LIVE_FIXTURE;
const liveFigure = liveFigurePath ? { html: await fsp.readFile(path.join(liveFigurePath, 'figure.html'), 'utf8'), design: JSON.parse(await fsp.readFile(path.join(liveFigurePath, 'design.json'), 'utf8')),
  ...(process.env.LOGINOTE_LOCAL_FUNCTION_FIXTURE ? { plot: JSON.parse(await fsp.readFile(path.join(liveFigurePath, 'model-response.json'), 'utf8')).plot } : {}) } : null;
const localRepair = process.env.LOGINOTE_FIGURE_REPAIR_FIXTURE ? JSON.parse(await fsp.readFile(process.env.LOGINOTE_FIGURE_REPAIR_FIXTURE, 'utf8')) : null;
const root = await fsp.mkdtemp(path.resolve('build/progressive-phase3-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fsp.writeFile(path.join(root, 'ipc.jsonl'), '');
await fsp.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fsp.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fsp.mkdir(path.join(state, 'user-state'), { recursive: true });
const at = '2026-11-01T00:00:00.000Z';
const makeNote = (id, title, extra = {}) => ({ id, title, noteType: 'project', projectRole: 'learning', content: '# 学习目标\n理解函数与定义域。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...extra });
const parent = makeNote('progressive-check-root', '阶段一独立验收', { planMeta: { status: 'active', dailyStudyMinutes: 30 } });
const normal = makeNote('progressive-normal', '第一页生成与恢复', { parentId: parent.id, dueDates: [{id:'native-task',noteId:'progressive-normal',noteTitle:'第一页生成与恢复',taskText:'第一页生成与恢复',dueDate:'2026-11-06',estimatedMinutes:60,priority:'medium',completed:false}] });
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
  { id: 'main-1', title: '唯一对应与定义域', objectives: ['识别函数关系：$x\\to x_0$ 与 $x\\to\\infty$'] },
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
const teachingQuote='允许的每个输入必须对应唯一的输出。';
const longText='先写出输入限制，再判断对应关系是否唯一；同一输入不能得到两个不同输出，而不同输入可以得到同一个输出。'.repeat(36);
const teachingBody=`${process.env.LOGINOTE_LOCAL_FUNCTION_FIXTURE ? '当 x 变化时，y 如何变化？\n\n函数 y=x^2 的定义域为 [-3,3]，观察平方函数的曲线。\n\n' : ''}${teachingQuote}不同输入可以有相同输出。\n\n## 数量例子\n\n长度2米与1米相加得到3米。\n\n## 核对边界\n\n${longText}`;
const quizDefinitions=[
 {id:'q1',kind:'choice',prompt:'一个允许的输入能否得到两个不同输出？',objective:'判断唯一性',conceptKeys:['unique'],focus:'concept',options:[{id:'A',text:'不能'},{id:'B',text:'能'}],correctOptionId:'A',referenceAnswer:'不能',explanation:'每个允许输入必须有唯一输出。',referenceQuote:teachingQuote},
 {id:'q2',kind:'application',prompt:'长度2米与1米相加是多少？请写数值与单位。',objective:'应用数量关系',conceptKeys:['sum'],focus:'calculation',referenceAnswer:'3米',explanation:'2米+1米=3米。',referenceQuote:'长度2米与1米相加得到3米。'},
 {id:'q3',kind:'judgment',prompt:'一个允许输入可以有两个不同输出，对吗？',objective:'核对唯一性',conceptKeys:['unique'],focus:'concept',options:[{id:'A',text:'不对'},{id:'B',text:'对'}],correctOptionId:'A',referenceAnswer:'不对',explanation:'输出需要唯一。',referenceQuote:teachingQuote}
];
const nativeLessons=[3,2,1,1].map((count,index)=>`@@LESSON\n${teachingBody}\n@@CONCEPTS\n${JSON.stringify([{key:'unique',title:'输入与输出唯一性',summary:teachingQuote}])}\n@@QUESTIONS\n${JSON.stringify(quizDefinitions.slice(0,count))}\n@@HOOK\n${JSON.stringify(hook)}\n@@END\n`);
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), `require('electron').contextBridge.exposeInMainWorld('phase1Test',{command: input=>require('electron').ipcRenderer.invoke('progressive-test:command',input)});`);
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Network blocked by isolated progressive acceptance');};
const fs=require('node:fs'),{app,ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
const control={mode:'normal',failPublishes:0,failPersonalSaves:0,calls:0,holdEmbedding:false,holdAssessment:false,failStudy:0,failFigure:0};
const timers=new Map(),heldAssessments=new Map();
ipcMain.handle('progressive-test:command',async(_e,input)=>{if(input.op==='mode')control.mode=input.value;if(input.op==='hold-assessment')control.holdAssessment=input.value;if(input.op==='fail-study')control.failStudy=input.value;if(input.op==='hold-embedding')control.holdEmbedding=input.value;if(input.op==='fail-publish')control.failPublishes=input.value;if(input.op==='fail-personal')control.failPersonalSaves=input.value;if(input.op==='fail-figure')control.failFigure=input.value;if(input.op==='close-window')setTimeout(()=>BrowserWindow.getAllWindows()[0]?.close(),0);return {...control};});
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
  const payload=JSON.parse(args[0].userInput);
  if(Array.isArray(payload.warnings)){log({phase:'figure-repair'});return {content:JSON.stringify(${JSON.stringify(localRepair)}||{patches:[]})};}
  if(payload.goal&&payload.lesson){
   log({phase:'figure-start',payload});
   if(control.failFigure>0){control.failFigure--;throw Error('合成交互图生成失败');}
   const fixture=${JSON.stringify(liveFigure)};
   const design=fixture?{...fixture.design,anchor:payload.goal}:{anchor:payload.goal,goal:'理解输入与输出',action:'改变输入',observation:'观察输出',model:'教材示意',prediction:'先预测结果',caveat:'合成示例',transfer:'换个输入'};
   const html=fixture?fixture.html:'<svg width="100" height="40"><circle cx="20" cy="20" r="5"></circle></svg><label>预测<input data-figure="prediction"></label><button data-figure="check">检查</button><button data-figure="reset">重置</button><label>输入<input type="range"></label><p data-figure="transfer">换个输入会怎样？</p>';
   if(fixture?.plot&&!args[0].systemPrompt?.includes('本地程序负责曲线'))throw Error('本地函数图路由未触发');
   return {content:JSON.stringify(fixture?.plot && args[0].systemPrompt?.includes('本地程序负责曲线') ? {design,plot:fixture.plot} : {design,html})};
  }
  log({phase:'assessment-start',payload});
  const result=payload.feedback?{content:JSON.stringify({status:'confirmed',explanation:'合成反馈核实：此题存在待核对条件，保留原作答。'})}:{content:JSON.stringify({results:(payload.tasks||[]).map(task=>({attemptId:task.attemptId,judgment:{outcome:'correct',errorKind:'none',explanation:'2米与1米相加得到3米。',referenceAnswer:'3米',referenceQuote:'长度2米与1米相加得到3米。'}}))})};
  if(control.holdAssessment)return new Promise(resolve=>heldAssessments.set(args[0].requestId,()=>resolve(result)));
  return result;
 }
 if(channel==='llm:cancel'){const complete=heldAssessments.get(args[0]);if(complete){complete();heldAssessments.delete(args[0]);} const timer=timers.get(args[0]);if(timer)clearInterval(timer);timers.delete(args[0]);return true;}
 if(channel==='progressive-learning:command'){
  const command=args[0];if(command?.op==='study'&&command.request?.mutation?.kind==='draft'&&control.failStudy>0){control.failStudy--;throw Error('合成作答保存失败');}log({phase:'progressive-start',op:command?.op,projectNoteId:command?.projectNoteId||command?.lease?.projectNoteId});
  if(command?.op==='publish'&&control.failPublishes>0){control.failPublishes--;log({phase:'publish-failed'});throw Error('合成课程保存失败');}
  const result=await handler(event,...args);log({phase:'progressive-ack',op:command?.op,projectNoteId:result?.projectNoteId||result?.course?.projectNoteId,status:result?.generation?.status||result?.course?.generation?.status});return result;
 }
 if(channel==='interactive-figure:open'){
  try { const result=await handler(event,...args);log({phase:'figure-opened'});return result; }
  catch(error){log({phase:'figure-open-failed',message:String(error)});throw error;}
 }
 if(channel==='interactive-figure:artifact'&&args[0]?.op==='compareReady'){const result=await handler(event,...args);log({phase:'figure-old-repair-saved',applied:result});return result;}
 if(channel==='interactive-figure:artifact'&&args[0]?.op==='write'&&args[0]?.artifact?.status==='ready'&&args[0]?.artifact?.html?.includes('fixedLim'))log({phase:'figure-repair-saved',key:args[0].key});
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

try{
 await launch();await enterFlow(normal.title);await waitReady();
 assert.equal(await reader().locator('.progressive-objectives .katex').count(),2,'both delimited formulas in the objective are rendered');
 assert.equal(await reader().locator('.progressive-objectives .textbook-formula-error').count(),0);
 assert.equal(await page.getByText('本页未安排交互图',{exact:true}).count(),0);
 const objectiveColors=await reader().locator('.progressive-objectives').evaluate(element=>{const root=document.documentElement,wasDark=root.classList.contains('dark');root.classList.remove('dark');const light=getComputedStyle(element).backgroundColor;root.classList.add('dark');const dark=getComputedStyle(element).backgroundColor;root.classList.toggle('dark',wasDark);return {light,dark};});
 assert.notEqual(objectiveColors.light,objectiveColors.dark,'learning objective color follows light and dark themes');
 const quiz=()=>page.locator('[data-progressive-quiz]');
 const question=id=>quiz().locator(`[data-question-id="${id}"]`);
 const stateOf=id=>question(id).locator('.progressive-answer-state');
 const courseId=await reader().getAttribute('data-course-id');
 assert.equal(await quiz().locator('[data-question-id]').count(),3);
 assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).count(),1);
 await question('q1').getByRole('radio',{name:'能',exact:true}).check();
 await question('q1').getByRole('button',{name:'提交答案',exact:true}).click();
 await stateOf('q1').filter({hasText:'需要再核对'}).waitFor();
 await question('q3').getByRole('radio',{name:'对',exact:true}).check();
 await question('q3').getByRole('button',{name:'提交答案',exact:true}).click();
 await stateOf('q3').filter({hasText:'需要再核对'}).waitFor();
 await question('q2').getByRole('textbox',{name:'你的回答',exact:true}).fill('3米');
 await page.locator('.flow-restate-textarea').fill('PRIVATE_NATIVE_PAGE1：一个输入仍可有两个不同输出。');
 await page.screenshot({path:path.join(root,'quiz-three-questions.png')});
 proof.checks.push('真实单页3题可选择/判断并提交，应用题可输入短数字和单位，未提交草稿不自动交卷');
 await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')!=='main-1');await waitReady();
 const expansionId=await reader().getAttribute('data-page-id');assert.ok(expansionId.startsWith('extra-'));
 assert.equal(await reader().getAttribute('data-course-id'),courseId);
 assert.equal(await quiz().locator('[data-question-id]').count(),1);
 await question('q1').getByText('反馈此题',{exact:true}).click();
 await question('q1').getByRole('textbox',{name:'题目反馈内容'}).fill('PRIVATE_FEEDBACK_ONLY：尚未答题，先核实条件。');
 await question('q1').getByRole('button',{name:'提交反馈',exact:true}).click();
 await question('q1').getByText(/反馈成立/).waitFor();
 proof.checks.push('同一生成流先编排再生成扩展页，1题/3题组件随页变化，只保留一个下一页入口');
 await reader().locator('[data-lesson-content] p').first().click({button:'right'});
 await page.getByRole('menu',{name:'讲解页操作'}).getByRole('menuitem',{name:'继续主线',exact:true}).click();await waitReady();
 assert.equal(await reader().getAttribute('data-page-id'),'main-2');assert.equal(await quiz().locator('[data-question-id]').count(),2);
 await page.locator('.flow-restate-textarea').fill('PRIVATE_NATIVE_PAGE1：一个输入仍可有两个不同输出。\nPRIVATE_NATIVE_PAGE2：现在核对输入范围。');
 await page.evaluate(()=>window.phase1Test.command({op:'hold-assessment',value:true}));
 await question('q2').getByRole('textbox',{name:'你的回答',exact:true}).fill('3米');
 await question('q2').getByRole('button',{name:'提交答案',exact:true}).click();await stateOf('q2').filter({hasText:'待判定'}).waitFor();
 const exitAt=Date.now();await exitFlow();proof.exitWhileGradingMs=Date.now()-exitAt;
 await closeNative();proof.checks.push('空白处右键继续主线回到main-2；应用题判定挂起时仍可保存退出，原生进程退出0');
 const modelBefore=await modelCalls(),assessBefore=(await events()).filter(e=>e.phase==='assessment-start').length;
 await launch();await enterFlow(normal.title);await waitReady();
 assert.equal(await reader().getAttribute('data-page-id'),'main-2');assert.equal(await modelCalls(),modelBefore);
 assert.equal((await events()).filter(e=>e.phase==='assessment-start').length,assessBefore);
 await stateOf('q2').filter({hasText:'待判定'}).waitFor();
 await question('q2').getByRole('button',{name:'重试判定',exact:true}).click();await stateOf('q2').filter({hasText:'回答正确'}).waitFor();
 await page.locator('.progressive-course-toc summary').click();
 await reader().getByRole('button',{name:plan.pages[0].title,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-1');
 assert.equal(await question('q2').getByRole('textbox',{name:'你的回答',exact:true}).inputValue(),'3米');
 assert.equal(await stateOf('q2').count(),0);
 proof.checks.push('重启恢复已提交待判作答且不自动重判；显式重试只有原尝试，回看原页仍保留未提交短答案');
 await question('q1').getByText('反馈此题',{exact:true}).click();
 await question('q1').getByRole('combobox',{name:'题目反馈类型'}).selectOption('grading');
 await question('q1').getByRole('textbox',{name:'题目反馈内容'}).fill('PRIVATE_FEEDBACK：请核实题目条件与判定。');
 await question('q1').getByRole('button',{name:'提交反馈',exact:true}).click();
 await question('q1').getByText(/反馈成立/).waitFor();
 assert.equal(await page.getByText('本页未安排交互图').count(),0);
 const shortParagraph=reader().locator('[data-lesson-content] p').first();
 const selectedFigureText=await shortParagraph.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);return selected.toString().trim();});
 await shortParagraph.click({button:'right',position:{x:35,y:5}});
 await page.getByRole('menu',{name:'讲解页操作'}).getByRole('menuitem',{name:'为选中内容生成交互图'}).click();
 await page.getByRole('tab',{name:'交互探索'}).waitFor();
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor({timeout:30000});
 const expectedTitle=interactiveFigureTitle(liveFigure?.design.goal||'理解输入与输出',selectedFigureText,normal.title);
 await page.getByRole('tab',{name:`交互探索：${expectedTitle}`,exact:true}).waitFor();
 await page.locator('.focus-flow-side-resources').getByRole('button',{name:`打开交互探索 ${expectedTitle}`,exact:true}).waitFor();
 if(liveFigure){
  await page.getByText('教学目标与使用方法',{exact:true}).click();
  if(/\$|[a-z]\s*=\s*[a-z][\w]*\s*\^/iu.test([liveFigure.design.goal,liveFigure.design.action,liveFigure.design.observation,liveFigure.design.caveat].join(''))) await page.locator('.focus-flow-figure-teaching .katex').first().waitFor();
  else await page.locator('.focus-flow-figure-teaching').getByText(liveFigure.design.goal,{exact:true}).waitFor();
 }
 for(let i=0;i<60&&!(await events()).some(e=>e.phase==='figure-opened');i++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok((await events()).some(e=>e.phase==='figure-opened'),'native figure view opens after generation');
 const figureRequests=(await events()).filter(e=>e.phase==='figure-start');
 assert.equal(figureRequests.length,1);assert.equal(figureRequests[0].payload.goal,selectedFigureText);
 assert.equal(await page.getByRole('button',{name:'本地检查',exact:true}).count(),0,'local checks are not exposed to learners');
 assert.equal(await page.getByText(/本地检查提示|这是有限的本地检查/).count(),0,'local diagnostic details are not shown');
 if(localRepair){
  assert.equal((await events()).filter(e=>e.phase==='figure-repair').length,1);assert.ok((await events()).some(e=>e.phase==='figure-repair-saved'),'verified targeted patch must be saved');
 }
 await page.getByRole('tab',{name:'当前笔记'}).click();
 assert.equal((await events()).filter(e=>e.phase==='figure-start').length,1);
 if(!await page.locator('.progressive-course-toc').evaluate(element=>element.open)) await page.locator('.progressive-course-toc summary').click();
 await reader().getByRole('button',{name:plan.pages[1].title,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-2');
 if(!await page.locator('.progressive-course-toc').evaluate(element=>element.open)) await page.locator('.progressive-course-toc summary').click();
 await reader().getByRole('button',{name:plan.pages[0].title,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-progressive-course]')?.getAttribute('data-page-id')==='main-1');
 await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).first().click();
 await page.getByRole('tab',{name:'交互探索'}).waitFor();
 await page.getByRole('tab',{name:'交互探索'}).click();
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor();
 assert.equal((await events()).filter(e=>e.phase==='figure-start').length,1,'revisiting a saved figure must not request the model');
 await page.getByRole('tab',{name:'当前笔记'}).click();
 await page.evaluate(()=>window.getSelection()?.removeAllRanges());
 await reader().locator('[data-lesson-content] p').first().click({button:'right',position:{x:35,y:5}});
 await page.getByRole('menu',{name:'讲解页操作'}).getByRole('menuitem',{name:'为本页生成交互图'}).click();
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor({timeout:30000});
 const choices=page.getByRole('combobox',{name:'选择交互图'});
 assert.equal(await choices.locator('option').count(),2,'selected and whole-page figures remain available');
 await choices.selectOption({index:0});
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor();
 assert.equal((await events()).filter(e=>e.phase==='figure-start').length,2,'switching figures must not generate another');
 if(localRepair){
  const key=(await events()).find(e=>e.phase==='figure-repair-saved')?.key;assert.ok(key);
  await page.evaluate(async ({key,html})=>{const api=window.electronAPI.interactiveFigure,old=await api.read(key);if(old?.status!=='ready')throw Error('missing fixture');await api.write(key,{status:'ready',html,design:old.design});},{key,html:liveFigure.html});
  await choices.selectOption({index:1});await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor();
  const before=(await events()).filter(e=>e.phase==='figure-repair').length;
  await choices.selectOption({index:0});await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor({timeout:30000});
  assert.equal((await events()).filter(e=>e.phase==='figure-repair').length,before+1,'old figure is checked once on open');
  assert.ok((await events()).some(e=>e.phase==='figure-old-repair-saved'&&e.applied),'old repair must be saved only if its source has not changed');
 }
 await page.getByTitle('关闭交互探索').click();
 await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).first().click();
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor();
 assert.equal((await events()).filter(e=>e.phase==='figure-start').length,2,'reopening a closed tab must not regenerate the figure');
 await page.evaluate(()=>window.phase1Test.command({op:'fail-figure',value:1}));
 await page.getByRole('button',{name:'重新生成',exact:true}).click();
 await page.getByRole('button',{name:'清理失败记录并恢复上一版',exact:true}).waitFor();
 assert.equal(await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).count(),1,'a failed retry is excluded from the resource count');
 await page.getByRole('button',{name:'清理失败记录并恢复上一版',exact:true}).click();
 await page.getByRole('button',{name:'模型复核（额外请求）'}).waitFor();
 assert.equal(await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).count(),2,'clearing a failed retry restores its previous successful figure');
 await page.getByRole('tab',{name:'当前笔记'}).click();
 await page.evaluate(()=>window.phase1Test.command({op:'fail-figure',value:1}));
 const nextParagraph=reader().locator('[data-lesson-content] p').first();
 await nextParagraph.evaluate(element=>{const node=element.firstChild;const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(5,node.textContent.length));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)});
 await nextParagraph.click({button:'right',position:{x:35,y:5}});
 await page.getByRole('menu',{name:'讲解页操作'}).getByRole('menuitem',{name:'为选中内容生成交互图'}).click();
 await page.getByRole('button',{name:'清理失败记录',exact:true}).waitFor();
 assert.equal(await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).count(),2,'failed new figures must not appear among resources');
 await page.locator('.focus-flow-unfinished-figures summary').click();
 await page.locator('.focus-flow-unfinished-figures').getByRole('button',{name:/清理失败记录/}).click();
 await page.locator('.focus-flow-unfinished-figures').waitFor({state:'detached'});
 assert.equal(await page.locator('.focus-flow-side-resources').getByRole('button',{name:/打开交互探索/}).count(),2,'clearing a failure keeps both successful figures');
 assert.equal((await events()).filter(e=>e.phase==='figure-start').length,4);
 proof.checks.push('资源按教学目标命名；失败图不计入资源，可清理，失败重试可恢复原图');
 const paragraph=reader().locator('[data-lesson-content] p').last();
 const selection=await paragraph.innerText();assert.ok(selection.length>800);
 await paragraph.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);});
 await paragraph.click({button:'right',position:{x:35,y:10}});
 const menu=page.getByRole('menu',{name:'讲解页操作'});
 await menu.getByRole('menuitem',{name:'复制',exact:true}).waitFor();
 await menu.getByRole('menuitem',{name:'针对这部分内容补充讲解页',exact:true}).click();await waitReady();
 assert.ok((await reader().getAttribute('data-page-id')).startsWith('extra-'));
 const selectedPayload=(await events()).filter(e=>e.phase==='model-start').at(-1).payload;
 assert.equal(selectedPayload.supplementScope.text,selection);
 await page.locator('.flow-restate-textarea').click({button:'right'});
 assert.equal(await page.getByRole('menu',{name:'讲解页操作'}).count(),0);
 proof.checks.push('组件反馈实际保存并核实；划词右键精确保留超过800字选区且复制入口保留，输入框不接管讲解菜单');
 await page.screenshot({path:path.join(root,'selected-supplement.png')});await exitFlow();
 await page.getByRole('button',{name:'笔记',exact:true}).click();
 // The saved note is opened through the ordinary sidebar, not through a synthetic route event.
 const titleNode=page.getByText(normal.title,{exact:true});
 await titleNode.first().click();
 await page.locator('[data-progressive-saved]').waitFor({state:'attached'});
 await page.getByRole('button',{name:'阅读教材',exact:true}).click();
 await page.locator('[data-progressive-saved] [data-progressive-course]').waitFor();
 await page.locator('[data-progressive-saved] .progressive-course-toc summary').click();
 await page.locator('[data-progressive-saved]').getByRole('button',{name:plan.pages[0].title,exact:true}).click();
 await page.getByRole('button',{name:'编辑笔记与复盘',exact:true}).click();
 const reopenInspector=page.getByRole('button',{name:'打开信息栏',exact:true});
 if(await reopenInspector.isVisible()) await reopenInspector.click();
 await page.getByRole('tab',{name:'学习记录',exact:true}).click();
 const inspector=page.getByLabel('笔记信息栏');
 await inspector.locator('.progressive-learning-records').waitFor();
 assert.equal(await page.locator('.note-editor-compose .progressive-learning-records').count(),0,'records must not consume editor height');
 assert.ok(await page.locator('.note-editor-compose [data-selection-surface="note"]').evaluate(el=>el.getBoundingClientRect().height)>150,'editor retains usable height');
 await page.getByText('待分析复述草稿 · 未分析',{exact:true}).click();
 await page.getByText(/PRIVATE_NATIVE_PAGE2/).first().waitFor();
 await page.locator('.progressive-page-record').first().locator('summary').first().click();
 await page.getByText('第2题 · 未提交草稿',{exact:true}).waitFor();
 assert.equal(await page.locator('.progressive-attempt-record summary').filter({hasText:'未提交草稿'}).count(),1,'submitted answers must not also appear as unsubmitted drafts');
 await page.locator('.progressive-attempt-record').first().locator('summary').first().click();
 const feedbackOnlyRecord=page.locator('.progressive-page-record').filter({hasText:plan.pages[0].title+' · 补充讲解'});
 await feedbackOnlyRecord.locator('summary').first().click();
 await feedbackOnlyRecord.locator('.progressive-attempt-record summary').filter({hasText:'题目反馈'}).click();
 await feedbackOnlyRecord.getByText('PRIVATE_FEEDBACK_ONLY：尚未答题，先核实条件。',{exact:true}).waitFor();
 assert.equal(await modelCalls(),modelBefore+1);
 await page.screenshot({path:path.join(root,'project-learning-records.png')});
 proof.checks.push('项目笔记沿用阅读教材/编辑笔记与复盘，目录、未提交答案草稿、仅反馈未答题记录及私人复述可回看；回看不生成、不提交、不分析');
 const files=await courseFiles();const savedCourse=files.find(file=>file.data.projectNoteId===normal.id).data;
 assert.equal(savedCourse.progress.currentPageId.startsWith('extra-'),true,'read-only note view must not move the saved flow cursor');
 assert.equal(savedCourse.studyPages.find(ref=>ref.pageId==='main-1').submitted,2);
 assert.equal(savedCourse.studyPages.find(ref=>ref.pageId==='main-2').attempts,1);
 assert.deepEqual(proof.pageErrors,[]);await closeNative();proof.status='passed';
 console.log(JSON.stringify({status:proof.status,checks:proof.checks.length,root,exitWhileGradingMs:proof.exitWhileGradingMs,coverage:proof.checks},null,2));
}catch(error){proof.status='failed';proof.error=error?.stack||String(error);if(page){await fsp.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await browser?.close().catch(()=>{});if(fd!==undefined)fs.closeSync(fd);await fsp.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));}
