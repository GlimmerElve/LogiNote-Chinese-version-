import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { writeTextbookRegion } from '../src/services/textbook/noteContent.ts';
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'switch-native.cjs'))('playwright');
const pressure = process.argv.includes('--pressure');
const diagnostic = process.argv.includes('--trace') || process.env.SWITCH_TRACE === '1';
const root = await fs.mkdtemp(path.resolve(pressure ? 'build/note-switch-pressure-' : 'build/note-switch-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fs.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fs.mkdir(path.join(state, 'vault/notes'), { recursive: true }); await fs.mkdir(path.join(state, 'user-state'), { recursive: true });
await fs.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
if (pressure) for (const directory of ['models', 'python']) await fs.symlink(path.resolve(directory), path.join(appRoot, directory), 'junction');
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'rapid-note-switch-regression', version: '1.0.10' }));
for (const [name, bytes] of await compileElectron(process.cwd())) await fs.writeFile(path.join(appRoot, 'dist-electron', name), bytes);
const at = '2026-11-01T00:00:00Z';
const note = (id, title, content) => ({ id, title, content, noteType: 'project', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const body = '# 教材标记 HEAVY_BOOK_SENTINEL\n\n' + Array.from({ length: 36 }, (_, i) =>
  `## 函数概念 ${i}\n\n函数 $f(x)=x^2$，研究 $x\\to 0$ 的变化趋势，$\\lim_{x\\to 0}f(x)=0$ 不代表函数在该点有定义。${'先找到允许输入的范围，再判断每个输入是否对应唯一输出。'.repeat(5)}\n\n`).join('');
assert.ok(body.length < 24000);
const textbook = id => ({ schemaVersion: 1, textbookId: 'book-' + id, projectNoteId: id, rootProjectId: id, regionId: 'switch-region', revisionId: 'v1', createdAt: at, updatedAt: at });
const notes = [writeTextbookRegion(note('switch-A', '切换验收甲', ''), body, textbook('switch-A')),
  writeTextbookRegion(note('switch-B', '切换验收乙', ''), body.replace('HEAVY_BOOK_SENTINEL', 'SECOND_HEAVY_BOOK'), textbook('switch-B')),
  note('switch-empty', '切换验收空项目', ''), note('switch-short', '切换验收短文', 'SHORT_NOTE_SENTINEL\n\n短文原文保持。'),
  ...Array.from({length:143},(_,i)=>note('switch-other-'+i,'其他项目 '+String(i).padStart(3,'0'),'既有项目内容。'))];
const indexNote = notes.at(-1);
if (pressure) {
  indexNote.noteType = 'knowledge';
  indexNote.content = '# 真实笔记索引压力\n\n' + Array.from({length:1200},(_,i)=>`## 情境 ${i}\n\n函数需要先规定允许输入的范围，再核对对应关系；第${i}个情境中一个输入只能对应唯一的输出，不同输入可以对应相同输出。\n\n`).join('');
  await fs.mkdir(path.join(root,'inputs'));
  await fs.writeFile(path.join(root,'inputs/pressure-document.md'),'# 真实资料分块与向量化压力\n\n'+Array.from({length:3000},(_,i)=>`## 资料 ${i}\n\n第${i}段：讨论函数的极限前应确认定义域和可行的趋近路径，左侧与右侧的趋近结果相同，才能判断双侧极限存在。\n\n`).join(''));
}
await fs.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: Object.fromEntries(notes.map(({ content, ...meta }) => [meta.id, meta])) }));
for (const value of notes) await fs.writeFile(path.join(state, 'vault/notes', value.id + '.md'), value.content);
await fs.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', localOnly: true, autoAiSegment: false, cloudSyncEnabled: false, fontSize: 16 } }));
const bootstrap = path.join(root, 'bootstrap.cjs');
await fs.writeFile(path.join(root,'test-control-preload.cjs'),`require('electron').contextBridge.exposeInMainWorld('switchTest',{probe:(full=false)=>require('electron').ipcRenderer.invoke('switch-test:probe',full)});`);
const realWorkers = `const fs=require('node:fs'),active=new Map(),workers=[],trace=[];const log=entry=>{trace.push({...entry,at:Date.now()});fs.appendFileSync(${JSON.stringify(path.join(root,'ipc.jsonl'))},JSON.stringify(trace.at(-1))+'\\n');};
require('electron').app.on('browser-window-created',(_event,win)=>{const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel,...args)=>{if(channel==='progressive-learning:knowledge')log({phase:'knowledge-commit',projectNoteId:args[1]?.note?.id,rows:args[1]?.rows?.length});return send(channel,...args);};});
require('electron').ipcMain.handle('switch-test:probe',(_event,full)=>({active:[...active.values()],workers:workers.map(row=>({service:row.service,pid:row.worker.pid,exited:row.exited})),...(full?{trace}:{})}));
const realFork=utilityProcess.fork.bind(utilityProcess);utilityProcess.fork=(...args)=>{const worker=realFork(...args),row={worker,service:args[2]?.serviceName,exited:false};workers.push(row);const post=worker.postMessage.bind(worker);worker.postMessage=message=>{const key=workers.indexOf(row)+':'+message.id;active.set(key,{key,service:row.service,operation:message.operation,at:Date.now()});log({phase:'start',key,service:row.service,operation:message.operation,pageId:message.args?.input?.regionId,noteId:message.args?.input?.noteId});post(message);};worker.on('message',message=>{if(message.type==='progress')return;const key=workers.indexOf(row)+':'+message.id;active.delete(key);log({phase:'done',key,ok:message.ok,dimension:message.ok&&Array.isArray(message.value?.[0])?message.value[0].length:undefined});});worker.on('exit',code=>{row.exited=true;for(const [key,value]of active)if(value.service===row.service)active.delete(key);log({phase:'exit',service:row.service,code});});return worker;};`;
const mockWorkers = `utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=()=>{};worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true;};return worker;};`;
await fs.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('cloud disabled in switch regression');};const {utilityProcess}=require('electron'),{EventEmitter}=require('node:events');${pressure ? realWorkers : mockWorkers}require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const runtime = await prepareElectronRuntime();
const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_GPU: '1', SAVE_NATIVE_REAL_DIALOG: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(runtime, [bootstrap, '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stderr.on('data', bytes => { output += bytes; });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const proof = { root, pressure, diagnostic, noteCount: notes.length, errors: [], checks: [], clicks: [], overlap: [] }; let browser, page, cdp;
let profiling=false;
const traceEvents=[]; let tracing=false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (promise, label, ms = 10000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]); } finally { clearTimeout(timer); } };
const waitFor = async (read, predicate, label, ms = 120000) => { const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(predicate(value))return value;await pause(100);}throw Error(label+' timed out'); };
const both = value => value.active.some(item=>item.operation==='vectorize') && value.active.some(item=>item.operation==='embed');
const authoredDraft = 'AUTHOR_DRAFT_SENTINEL：自己写下的学习目标与边界条件。';
const plan={title:'输入限制',objectives:['核对允许的输入'],pages:[{id:'main-1',title:'输入的范围',objectives:['解释定义域']},{id:'main-2',title:'输入的边界',objectives:['判断边界条件']}]};
const teachingFor=index=>({sequence:index+1,plan,title:plan.pages[index].title,body:'## 定义域的概念\n\n函数允许输入的值组成定义域；应先核对所有输入条件，再讨论对应规则。',concepts:[{key:index?'boundary':'domain',title:index?'压力验收边界条件':'压力验收定义域',summary:index?'讨论边界值时必须核对表达式是否仍有意义。':'函数允许输入的值组成定义域；先确认表达式有意义。'}],questions:[],hook:{id:'domain-hook-'+index,kind:'reflection',prompt:'为什么需要先明确输入范围？'}});
let publishReply;
try {
  let endpoint; for (let i = 0; i < 200 && !endpoint; i++) { endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]; if (!endpoint) await pause(100); }
  assert.ok(endpoint); browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(12000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.getByRole('button', { name: '笔记', exact: true }).waitFor(); await page.getByRole('button', { name: '笔记', exact: true }).click();
  const open = title => page.getByTitle(`打开「${title}」`, { exact: true }).click();
  await open('切换验收短文'); await page.locator('.mdxeditor-content-editable').waitFor({ timeout: 40000 });
  await open('切换验收甲'); await page.getByRole('button', { name: '编辑笔记与复盘', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mdxeditor-content-editable,.cm-editor'));
  await pause(300);
  proof.directoryStyle=await page.evaluate(()=>{const row=document.querySelector('.note-tree-row'),style=getComputedStyle(row);return{visibility:style.contentVisibility,intrinsicBlockSize:style.containIntrinsicBlockSize,domElements:document.querySelectorAll('*').length};});
  if (pressure) {
    const upload=await page.evaluate(file=>window.electronAPI.ragDocs.upload([file]),path.join(root,'inputs/pressure-document.md'));
    assert.ok(upload.ok);proof.documentId=upload.documents[0].id;
    await page.evaluate(id=>{window.pressureNoteIndex=window.electronAPI.noteRag.index({id}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));},indexNote.id);
    proof.concurrentStart=await waitFor(()=>page.evaluate(()=>window.switchTest.probe()),both,'actual document and note vectorization overlap');
    const begin=await page.evaluate(()=>window.electronAPI.progressiveLearning.command({op:'begin',projectNoteId:'switch-empty'}));
    publishReply=begin;
  }
  await page.evaluate(() => {
    window.switchPerf = { tasks: [], stale: [], workers: 0, terminated: 0, gaps: [] };
    let last=performance.now();window.switchPerfTimer=setInterval(()=>{const now=performance.now();window.switchPerf.gaps.push(now-last);last=now;},25);
    new PerformanceObserver(list => window.switchPerf.tasks.push(...list.getEntries().map(value => ({ at: value.startTime, duration: value.duration })))).observe({ type: 'longtask' });
    const Native = window.Worker;
    window.Worker = class extends Native { constructor(...args) { super(...args); window.switchPerf.workers++; const end = this.terminate.bind(this); this.terminate = () => { window.switchPerf.terminated++; end(); }; } };
    new MutationObserver(() => {
      const shell = document.querySelector('.note-editor-shell:not([aria-hidden="true"])'), title = shell?.querySelector('input[aria-label="笔记标题"]')?.value;
      if (title === '切换验收空项目' && shell?.querySelector('.mdxeditor-content-editable')?.textContent.includes('HEAVY_BOOK_SENTINEL')) window.switchPerf.stale.push(title);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  if(pressure){
    await page.evaluate(docId=>{window.pressureMaterials=Promise.all(Array.from({length:3},()=>window.electronAPI.ragDocs.materialSearch({allowedDocIds:[docId],docId,query:'函数的极限与趋近路径',topic:'函数极限',subject:'函数与极限',limit:8})));},proof.documentId);
    await open('切换验收空项目');
    const editor=page.locator('.mdxeditor-content-editable[contenteditable="true"]');await editor.waitFor();await editor.fill(authoredDraft);
    proof.knowledgeOverlap=await page.evaluate(()=>window.switchTest.probe());
    await page.evaluate(({lease,teaching})=>window.electronAPI.progressiveLearning.command({op:'publish',lease,teaching}),{lease:publishReply.lease,teaching:teachingFor(0)});
    await waitFor(()=>page.evaluate(()=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:'switch-empty'})),jobs=>jobs.some(job=>job.knowledgeReady),'background knowledge commit');
    await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('继续输入后仍须保留知识点清单。');
    await open('切换验收甲');await pause(240);
    proof.authoringMetrics=await page.evaluate(()=>{const value={tasks:window.switchPerf.tasks,gaps:window.switchPerf.gaps};window.switchPerf.tasks=[];window.switchPerf.gaps=[];return value;});
    proof.checks.push('separate authoring measurement: background knowledge append races with a live draft, typing is retained before rapid switching');
  }
  cdp = await page.context().newCDPSession(page);
  if(!pressure||diagnostic){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');profiling=true;}
  if(diagnostic){cdp.on('Tracing.dataCollected',value=>traceEvents.push(...value.value));await cdp.send('Tracing.start',{categories:'devtools.timeline,toplevel,blink.user_timing',transferMode:'ReportEvents'});tracing=true;}
  const order = ['切换验收空项目', '切换验收乙', '切换验收甲', '切换验收短文'];
  for (let step = 0; step < (pressure ? 40 : 20); step++) {
    if (pressure) {
      const sample=await page.evaluate(()=>window.switchTest.probe());proof.overlap.push({step,at:Date.now(),active:sample.active});
      if (step===8) {
        const course=await page.evaluate(()=>window.electronAPI.progressiveLearning.command({op:'load',projectNoteId:'switch-empty'}));
        proof.firstPageHash=course.pages.find(item=>item.id==='main-1').contentHash;
        const next=await page.evaluate(course=>window.electronAPI.progressiveLearning.command({op:'next',projectNoteId:'switch-empty',request:{environmentId:course.environmentId,courseId:course.id,expectedRevision:course.revision,requestId:'pressure-second-page',intent:'mainline',fromPageId:'main-1'}}),course);
        await page.evaluate(({lease,teaching})=>window.electronAPI.progressiveLearning.command({op:'publish',lease,teaching}),{lease:next.lease,teaching:teachingFor(1)});
      }
    }
    const title = order[step % order.length], began = Date.now(); await bounded(open(title), 'switch-' + step, 6000);
    proof.clicks.push({ step, title, startedAt: began, finishedAt: Date.now(), ms: Date.now() - began }); await pause(35);
  }
  await page.waitForFunction(() => document.querySelector('.mdxeditor-content-editable')?.textContent.includes('SHORT_NOTE_SENTINEL'));
  await pause(500);
  proof.metrics = await page.evaluate(() => {clearInterval(window.switchPerfTimer);return window.switchPerf;});
  if(profiling){const profile = await cdp.send('Profiler.stop');profiling=false;await fs.writeFile(path.join(root, 'profile.json'), JSON.stringify(profile.profile));}
  if(tracing){const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await done;tracing=false;await fs.writeFile(path.join(root,'trace.json'),JSON.stringify({traceEvents}));}
  await page.screenshot({ path: path.join(root, 'final-note.png') });
  assert.deepEqual(proof.errors, []); assert.equal(proof.metrics.stale.length, 0, 'empty project never imports previous teaching');
  assert.ok(Math.max(...proof.clicks.map(value => value.ms)) < 500, 'sidebar clicks remain responsive');
  if (pressure) {
    const searches=await bounded(page.evaluate(()=>window.pressureMaterials),'parsed original searches',30000);
    assert.ok(searches.every(r=>r.ok&&r.value.hits.length>0),'full-text original retrieval works during actual vectorization');
    proof.materialSearches=searches.map(r=>({hits:r.value.hits.length,indexStatus:r.value.document.indexStatus}));
    proof.checks.push('three full-text original searches run alongside actual vectorization and rapid switching without starting reparse/reindex');
    assert.ok(proof.overlap.filter(both).length>=12,'at least 12 switches must actually overlap document and note vectorization');
    assert.ok(both(proof.knowledgeOverlap),'knowledge append must occur during both production index workloads');
    await open('其他项目 141');
    await page.waitForFunction(()=>document.querySelector('input[aria-label="笔记标题"]')?.value==='其他项目 141');
    await page.getByTitle('打开「其他项目 141」',{exact:true}).focus();
    proof.actionIcons=await page.getByTitle('打开「其他项目 141」',{exact:true}).evaluate(button=>[...button.closest('.note-tree-row').querySelectorAll('.note-tree-actions .note-action-icon')].map(icon=>{const box=icon.getBoundingClientRect();return{width:box.width,height:box.height,mask:getComputedStyle(icon).maskImage};}));
    assert.equal(proof.actionIcons.length,2);assert.ok(proof.actionIcons.every(icon=>icon.width>0&&icon.height>0&&icon.mask!=='none'));
    await page.locator('.note-navigator').screenshot({path:path.join(root,'directory-actions.png')});
    await page.getByRole('button',{name:'搜索项目笔记',exact:true}).click();
    const search=page.getByRole('textbox',{name:'搜索项目笔记',exact:true});await search.fill('其他项目 140');
    const found=page.getByTitle('打开「其他项目 140」',{exact:true});await found.focus();await found.press('Enter');
    await page.waitForFunction(()=>document.querySelector('input[aria-label="笔记标题"]')?.value==='其他项目 140');
    await search.fill('');
    proof.checks.push('off-screen directory entry scrolls into view; search and Enter activation still work with row rendering containment');
    await waitFor(()=>page.evaluate(()=>window.electronAPI.ragDocs.list()),docs=>docs.some(doc=>doc.id===proof.documentId&&doc.status==='ready'),'document indexing completion');
    proof.noteIndex=await bounded(page.evaluate(()=>window.pressureNoteIndex),'note indexing completion',120000);assert.equal(proof.noteIndex.ok,true);
    await waitFor(()=>page.evaluate(()=>window.electronAPI.progressiveLearning.derived({op:'status',projectNoteId:'switch-empty'})),jobs=>jobs.length===2&&jobs.every(job=>job.status==='ready'),'page indexing completion');
    proof.background=await page.evaluate(()=>window.switchTest.probe(true));
    const ends=new Map(proof.background.trace.filter(item=>item.phase==='done').map(item=>[item.key,item.at]));
    const spans=proof.background.trace.filter(item=>item.phase==='start').map(item=>({...item,end:ends.get(item.key)||Date.now()}));
    proof.actualOverlap=proof.clicks.map(click=>({step:click.step,...Object.fromEntries(['vectorize','embed'].map(operation=>[operation+'Ms',spans.filter(span=>span.operation===operation).reduce((sum,span)=>sum+Math.max(0,Math.min(click.finishedAt,span.end)-Math.max(click.startedAt,span.at)),0)]))}));
    assert.ok(proof.actualOverlap.filter(item=>item.vectorizeMs>0&&item.embedMs>0).length>=12,'completed worker traces must prove real inference overlap with clicks');
    assert.ok(spans.some(span=>span.operation==='chunk-textbook'&&span.at>=proof.clicks[0].startedAt&&span.at<=proof.clicks.at(-1).finishedAt),'real page chunking must occur during the switching session');
    assert.ok(proof.background.trace.some(item=>item.phase==='knowledge-commit'&&item.at>=proof.clicks[0].startedAt&&item.at<=proof.clicks.at(-1).finishedAt),'knowledge body projection must commit during rapid switching');
    assert.ok(proof.background.trace.some(item=>item.phase==='done'&&item.ok&&item.dimension===384),'real ONNX embedding vectors must complete');
    assert.equal(proof.background.trace.filter(item=>item.phase==='start'&&item.operation==='chunk-textbook'&&item.pageId==='main-1').length,1,'switching must not re-chunk the published page');
    assert.equal(proof.background.trace.filter(item=>item.phase==='start'&&item.operation==='chunk-textbook'&&item.pageId==='main-2').length,1);
    const chunkCounts=new Map();
    for(const item of proof.background.trace.filter(item=>item.phase==='start'&&item.operation==='chunk-textbook')){
      const key=item.noteId+':'+item.pageId;chunkCounts.set(key,(chunkCounts.get(key)||0)+1);
    }
    assert.ok([...chunkCounts.values()].every(count=>count===1),'existing textbook first-index builds must not repeat on selection');
    const finalCourse=await page.evaluate(()=>window.electronAPI.progressiveLearning.command({op:'load',projectNoteId:'switch-empty'}));
    assert.equal(finalCourse.pages.find(item=>item.id==='main-1').contentHash,proof.firstPageHash);
    await open('切换验收空项目');await page.getByRole('button',{name:'编辑笔记与复盘',exact:true}).click();
    const editor=page.locator('.mdxeditor-content-editable[contenteditable="true"]');await editor.getByRole('heading',{name:'本项目需要掌握的知识点',exact:true}).waitFor();
    assert.ok((await editor.innerText()).includes(authoredDraft));assert.ok((await editor.innerText()).includes('继续输入后仍须保留知识点清单。'));
    await editor.getByText('压力验收定义域',{exact:true}).click();
    const dialog=page.getByRole('dialog').filter({hasText:'压力验收定义域'});await dialog.waitFor();await page.screenshot({path:path.join(root,'pressure-knowledge.png')});await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    const saved=await fs.readFile(path.join(state,'vault/notes/switch-empty.md'),'utf8');
    assert.ok(saved.replaceAll('\\_','_').includes(authoredDraft));assert.ok(saved.includes('继续输入后仍须保留知识点清单。'));assert.equal((saved.match(/### 本项目需要掌握的知识点/gu)||[]).length,1);
    const metadata=JSON.parse(await fs.readFile(path.join(state,'vault/metadata.json'),'utf8'));
    assert.ok(metadata.notesMeta['switch-empty'].links.includes('压力验收定义域'));
    assert.ok(metadata.notesMeta['switch-empty'].links.includes('压力验收边界条件'));
    proof.checks.push('document, note and two page production indexes complete; each page chunks once; prior content hash, authored draft and clickable knowledge links survive');
  }
  for (const value of notes) if(!pressure||value.id!=='switch-empty')assert.equal(await fs.readFile(path.join(state, 'vault/notes', value.id + '.md'), 'utf8'), value.content, 'switches never rewrite original bodies');
  await page.getByRole('button', { name: '关闭', exact: true }).click(); proof.nativeExit = await bounded(exited, 'exit', 15000); assert.equal(proof.nativeExit.code, 0);
  assert.equal(proof.metrics.tasks.length, 0, 'rapid note switching cannot synchronously import/parse abandoned textbooks');
  proof.status = 'passed'; proof.checks.push((pressure?'40':'20')+' rapid switches among dense textbooks, an empty project and a short note; no stale import or foreground long task; originals unchanged');
} catch (error) { proof.status = 'failed'; proof.error = String(error.stack || error); process.exitCode = 1; if (profiling) await cdp.send('Profiler.stop').then(result => fs.writeFile(path.join(root, 'profile.json'), JSON.stringify(result.profile))).catch(() => {}); if(page&&!page.isClosed()){await fs.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});} console.error(error); }
finally { if (child.exitCode === null) child.kill(); await browser?.close().catch(() => {}); await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ root, status: proof.status, error: proof.error })); }
