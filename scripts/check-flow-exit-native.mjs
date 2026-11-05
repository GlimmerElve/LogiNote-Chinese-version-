import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileElectron } from '../scripts/build-electron.mjs';
import { prepareElectronRuntime } from '../scripts/start-electron.mjs';
import { writeTextbookRegion } from '../src/services/textbook/noteContent.ts';
const {chromium}=createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'flow-diagnostic.cjs'))('playwright');
const root=await fsp.mkdtemp(path.resolve('build/flow-exit-native-'));
const appRoot=path.join(root,'app'),state=path.join(root,'state');
await fsp.mkdir(path.join(appRoot,'dist-electron'),{recursive:true});
await fsp.mkdir(path.join(state,'vault/notes'),{recursive:true});
await fsp.mkdir(path.join(state,'user-state'),{recursive:true});
const id='synthetic-flow-exit';
const at='2026-10-31T00:00:00Z';
const note=writeTextbookRegion({id,title:'教材阅读退出验证',noteType:'project',content:'# 项目笔记',tags:[],links:[],backlinks:[],dueDates:[],createdAt:at,updatedAt:at},
  Array.from({length:25},(_,i)=>`## 第 ${i+1} 节：函数与极限\n\n每一个输入对应唯一输出。先检查定义域，再核对极限的条件。\n\n${'本段是保存与滚动验收使用的合成教材。'.repeat(12)}`).join('\n\n'),
  {schemaVersion:1,textbookId:'synthetic-book',projectNoteId:id,rootProjectId:id,regionId:'synthetic-region',revisionId:'synthetic-revision',createdAt:at,updatedAt:at});
const {content,...meta}=note;
await fsp.writeFile(path.join(state,'vault/metadata.json'),JSON.stringify({version:1,notesMeta:{[id]:meta}}));
await fsp.writeFile(path.join(state,'vault/notes',id+'.md'),content);
await fsp.writeFile(path.join(state,'user-state/user-state.json'),JSON.stringify({version:1,noteStates:{}}));
await fsp.writeFile(path.join(state,'user-state/settings.json'),JSON.stringify({version:1,appSettings:{theme:'light',accentColor:'emerald',localOnly:true,cloudSyncEnabled:false,fontSize:16,autoAiSegment:false}}));
await fsp.writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:'isolated-flow-save-check',version:'1.0.10'}));
await fsp.symlink(path.resolve('dist'),path.join(appRoot,'dist'),'junction');
await fsp.symlink(path.resolve('python'),path.join(appRoot,'python'),'junction');
for(const [name,buffer] of await compileElectron(process.cwd()))await fsp.writeFile(path.join(appRoot,'dist-electron',name),buffer);
const bootstrap=path.join(root,'bootstrap.cjs');
await fsp.writeFile(bootstrap,`globalThis.fetch=async()=>{throw Error('Network disabled in isolated flow diagnostic');};
const fs=require('node:fs'),{app,BrowserWindow,ipcMain,utilityProcess}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root,'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
// Hold derived model work indefinitely, while exercising real note save IPC/disk.
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>log({phase:'compute-pending',operation:message.operation});worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true;};return worker;};
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(...args)=>{const traced=/^(vault:|user-state:agent-task-scope)/u.test(channel);if(traced)log({phase:'start',channel});if(channel==='vault:save-reading-positions')await new Promise(r=>setTimeout(r,500));try{const result=await handler(...args);if(traced)log({phase:'ack',channel});return result;}catch(error){if(traced)log({phase:'error',channel,message:error.message});throw error;}});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const logFile=path.join(root,'process.log'),fd=fs.openSync(logFile,'w');
const env={...process.env,LOGINOTE_SAVE_NATIVE_ROOT:root,SAVE_NATIVE_REAL_DIALOG:'auto'};delete env.ELECTRON_RUN_AS_NODE;
const runtime=await prepareElectronRuntime();
const child=spawn(runtime,[bootstrap,'--remote-debugging-port=0'],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore',fd,fd]});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
console.log(JSON.stringify({root,pid:child.pid}));
const errors=[];let browser,page;const proof={root,checks:[],errors};
try{
  let endpoint;
  for(let i=0;i<150;i++){const log=await fsp.readFile(logFile,'utf8');endpoint=log.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];if(endpoint)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(endpoint,'native debugging endpoint');browser=await chromium.connectOverCDP(endpoint);
  page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'笔记',exact:true}).waitFor({timeout:45000});
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.getByRole('textbox',{name:'笔记标题',exact:true}).first().waitFor({timeout:30000});
  await page.getByRole('button',{name:'学习',exact:true}).click();
  const buttons=await page.getByRole('button').allTextContents();
  await fsp.writeFile(path.join(root,'buttons.json'),JSON.stringify(buttons));
  console.log(JSON.stringify({phase:'note-opened',buttons:buttons.filter(b=>/心流|学习|专注/u.test(b)).slice(0,20)}));
  const start=page.getByRole('button',{name:/开始学习|继续学习|进入心流|开始心流/u}).first();
  await start.click({timeout:10000});
  console.log(JSON.stringify({phase:'entrance',buttons:await page.getByRole('dialog').getByRole('button').allTextContents()}));
  await page.getByRole('dialog').getByRole('button',{name:/开始|进入/u}).last().click();
  await page.getByRole('button',{name:'退出并保存',exact:true}).waitFor({timeout:30000});
  console.log(JSON.stringify({phase:'flow-opened'}));
  const scroll=async(top)=>page.evaluate(top=>{const node=document.querySelector('.textbook-reader.focus-flow-note-preview');if(node){node.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));node.scrollTop=top;node.dispatchEvent(new Event('scroll',{bubbles:true}));return node.scrollTop;}return null;},top);
  assert.equal(await scroll(600),600);
  const startAt=Date.now();await page.getByRole('button',{name:'退出并保存',exact:true}).click();
  for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,100));await scroll(700+i*110);}
  await page.waitForFunction(()=>!document.querySelector('.flow-mode-container')||!document.querySelector('.focus-flow-save-exit')?.disabled,{},{timeout:10000});
  assert.equal(await page.locator('.flow-mode-container').count(),1,'concurrent viewport updates must exercise the cancelled-navigation branch');
  assert.match(await page.getByRole('alert').innerText(),/重试退出/);
  proof.checks.push('保存成功后跳转因新阅读位置取消时，显示可重试状态，退出按钮恢复可用');
  await page.getByRole('button',{name:'退出并保存',exact:true}).click();
  await page.locator('.flow-mode-container').waitFor({state:'detached',timeout:10000});
  proof.checks.push('重试保存最新位置后回到笔记页');
  proof.exitFlowMs=Date.now()-startAt;
  const saved=JSON.parse(await fsp.readFile(path.join(state,'user-state/user-state.json'),'utf8'));
  assert.equal(saved.noteStates[id].textbookReadingState.scrollTop,1910);
  assert.equal(saved.noteStates[id].learningReviewRecords,undefined);
  assert.equal(await fsp.readFile(path.join(state,'vault/notes',id+'.md'),'utf8'),content);
  const events=(await fsp.readFile(path.join(root,'ipc.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(e=>e.phase==='compute-pending'));
  assert.ok(events.filter(e=>e.phase==='ack'&&e.channel==='vault:save-reading-positions').length>=2);
  assert.equal(events.some(e=>e.phase==='start'&&['vault:save','vault:save-delta'].includes(e.channel)),false);
  proof.checks.push('后台模型保持等待仍可退出；仅保存阅读位置，教材原文不变、不建空复盘、不全库保存');
  console.log(JSON.stringify({phase:'exited-flow',ms:proof.exitFlowMs,errors}));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  let timer;const receipt=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),20000);})]);clearTimeout(timer);
  console.log(JSON.stringify({phase:'native-exit',...receipt}));assert.equal(receipt.code,0);proof.nativeExit=receipt;
  assert.deepEqual(errors,[]);proof.checks.push('生产 App/main/preload 无渲染异常，原生进程正常退出 0');
  console.log(`PASS ${proof.checks.length} native Flow exit checks; synthetic vault, delayed disk acknowledgement, pending background computation.`);
}catch(error){
  if(page)await fsp.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));
  console.error(error);process.exitCode=1;
}finally{
  if(child.exitCode===null)child.kill();await browser?.close().catch(()=>{});fs.closeSync(fd);
  await fsp.writeFile(path.join(root,'result.json'),JSON.stringify({...proof,exitCode:process.exitCode||0},null,2));
}
