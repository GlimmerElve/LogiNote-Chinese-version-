import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareElectronRuntime } from './start-electron.mjs';
const root = await fs.mkdtemp(path.resolve('build/mermaid-unattached-view-'));
const tasks = ['flowchart TD\nA[开始]-->B[完成]', 'mindmap\n  root((共同主题))\n    第一分支\n    第二分支',
  'sequenceDiagram\n  participant A as 学生\n  participant B as 老师\n  A->>B: 问题\n  B-->>A: 回答',
  'timeline\n  title 学习阶段\n  2020 : 开始\n  2021 : 继续',
  'flowchart LR\nV1["第一行<br/>第二行"] --> V2["关系方向<br />边界条件"]\nV2 -.-> V3["核对例子"]',
  'mindmap\n  root((第一行<br>第二行))\n    主要条件\n    边界说明',
  'sequenceDiagram\n  participant A as 学生\n  participant B as 老师\n  A->>B: 第一行<br/>第二行',
  'timeline\n  起始阶段 : 第一行<BR />第二行\n  后续阶段 : 核对结果'];
const bootstrap = path.join(root, 'probe.cjs');
await fs.writeFile(bootstrap, `
const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(root, 'state'))});app.commandLine.appendSwitch('disable-renderer-backgrounding');
let view,owner;const results=[];const tasks=${JSON.stringify(tasks)};
const fail=error=>{console.error(error);app.exit(1);};process.on('uncaughtException',fail);setTimeout(()=>fail('view render timeout'),20000);
app.whenReady().then(async()=>{owner=new BrowserWindow({show:false});await owner.loadURL('about:blank');
view=new WebContentsView({webPreferences:{preload:${JSON.stringify(path.resolve('dist-electron/mermaid-preload.cjs'))},partition:'unattached-drawing-probe',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
view.setBounds({x:0,y:0,width:960,height:1000});
ipcMain.on('mermaid-worker:ready',()=>view.webContents.send('mermaid-worker:task',{requestId:'probe-0',id:'probe-0',code:tasks[0],dark:false}));
ipcMain.on('mermaid-worker:reply',(_event,value)=>{if(value.error||!value.svg?.includes('<svg')||!(value.readingWidth>0))return fail(JSON.stringify(value));
if(/<(?:br|foreignObject|script)\\b/i.test(value.svg))return fail('HTML survived the SVG-only renderer');
if(tasks[results.length].includes('第二行')&&!value.svg.includes('第二行'))return fail('line-break recovery lost label content');
results.push({width:value.readingWidth,svgLength:value.svg.length,windowCount:BrowserWindow.getAllWindows().length,mainPid:owner.webContents.getOSProcessId(),drawingPid:view.webContents.getOSProcessId()});
if(BrowserWindow.getAllWindows().length!==1||BrowserWindow.fromWebContents(view.webContents))return fail('drawing acquired a native window');
if(results.at(-1).mainPid===results.at(-1).drawingPid)return fail('shared process');
if(results.length<tasks.length)return view.webContents.send('mermaid-worker:task',{requestId:'probe-'+results.length,id:'probe-'+results.length,code:tasks[results.length],dark:false});
fs.writeFileSync(${JSON.stringify(path.join(root, 'result.json'))},JSON.stringify({status:'passed',results},null,2));view.webContents.close({waitForBeforeUnload:false});owner.destroy();app.exit(0);});
await view.webContents.loadFile(${JSON.stringify(path.resolve('dist/mermaid-renderer.html'))});}).catch(fail);
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(await prepareElectronRuntime(), [bootstrap], { env, windowsHide: true, stdio: 'pipe' });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const code = await new Promise(resolve => child.once('exit', resolve));
console.log(JSON.stringify({ root, code })); process.exitCode = code;
