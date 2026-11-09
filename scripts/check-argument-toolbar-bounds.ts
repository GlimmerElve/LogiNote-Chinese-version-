/** Real embedded/standalone canvases and relation modal; isolated synthetic browser only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

globalThis.fetch = async () => assert.fail('No real library/model/external calls in toolbar geometry checks');
const output = await fs.mkdtemp(path.resolve('build/argument-toolbar-bounds-'));
const fixtureId = path.resolve('__argument-toolbar-bounds.tsx').replaceAll('\\', '/');
const fixture = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ReactFlowProvider}from'@xyflow/react';
import{ArgumentCanvas}from'/src/modules/argumentCanvas/ArgumentCanvas';
import{ProgressiveReviewDialog}from'/src/components/progressive/ProgressiveReviewDialog';
import'/src/index.css';
const date='2026-11-08T12:00:00Z';
const source={doc_id:'toolbar-test',title:'合成关系工具',created_at:date,updated_at:date,status:'draft',iteration:1,
 nodes:[{id:'n1',role:'premise',mainType:'事实陈述',text:'观察条件需要明确。',position:{x:30,y:100},status:'ok',user_edited:false,collapsed:false,issue:null,severity:null,suggestion:null},
 {id:'n2',role:'claim',mainType:'推理',text:'结论只适用于这些条件。',position:{x:100,y:320},status:'ok',user_edited:false,collapsed:false,issue:null,severity:null,suggestion:null}],
 edges:[{id:'e1',source:'n1',target:'n2',relation:'support'}]};
const record={schemaVersion:1,id:'review-toolbar',version:1,courseId:'course',projectNoteId:'project',rootProjectId:'root',exitId:'exit',submittedAt:date,updatedAt:date,
 status:'analyzed',textKey:'synthetic',pageIds:[],parts:1,completedParts:1,auxiliary:'ready',rawText:'明确条件后再讨论结论。',summaryText:'',spans:[],pageRefs:[],studyRefs:[],
 chunks:[{id:'part-1',start:0,end:12,resultHash:'result'}],cognitionConfirmation:{status:'pending'}};
const commands=[];window.electronAPI={progressiveLearning:{onChange:()=>()=>{},command:async input=>{
 commands.push(input);if(input.op==='load')return{id:'course',environmentId:'env',projectNoteId:'project',title:'合成项目',reviews:[record]};
 if(input.op==='review-read')return input.partId?{argumentDoc:source,report:{summary:'原始结果',sections:[]},analysisV2:{record:{input:{rawText:record.rawText}}}}:record;
 if(input.op==='review-graph-read')return{record,doc:source,graphHash:'graph'};throw Error('No mutation or model permitted '+input.op);
}}};window.__toolbar={commands};
function Fixture(){const[doc,setDoc]=useState(source);return location.search.includes('standalone')?<main style={{padding:'68px 16px 16px',height:600,boxSizing:'border-box'}}><ReactFlowProvider><ArgumentCanvas doc={doc} onChange={setDoc}/></ReactFlowProvider></main>
 :<ProgressiveReviewDialog target={{projectNoteId:'project',reviewId:record.id,courseId:'course',environmentId:'env',noteTitle:'合成项目'}} onClose={()=>{throw Error('Parent closed unexpectedly');}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'argument-toolbar-bounds.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
let groups = 0;
const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    plugins: [react(), tailwindcss(), { name: 'isolated-argument-toolbar', resolveId(id) { if(id===fixtureId||id==='/__toolbar-bounds.tsx')return fixtureId; },
      load(id) { if(id===fixtureId)return fixture; },configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if(req.url?.split('?')[0]!=='/toolbar-bounds')return next();res.setHeader('Content-Type','text/html');
        res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;min-height:100%}</style></head><body><div id="root"></div><script type="module" src="/__toolbar-bounds.tsx"></script></body></html>');
      }); } }],resolve:{dedupe:['react','react-dom']}, optimizeDeps:{entries:[],noDiscovery:true,
      include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','@xyflow/react','katex','zustand',
        'react-markdown','remark-gfm','@xenova/transformers','micromark-util-decode-string','mdast-util-from-markdown','micromark-extension-gfm','mdast-util-gfm','micromark-extension-math','mdast-util-math']},
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null} });
  await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  browser=await chromium.launch({headless:true,executablePath:process.env.COGNITION_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1100,height:900},reducedMotion:'reduce'});
  const errors:string[]=[],external:string[]=[];
  await context.route('**/*',(route:any)=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.goto(origin+'/toolbar-bounds',{waitUntil:'domcontentloaded'});
  const parent=()=>page.getByRole('dialog',{name:'复盘分析结果',exact:true});
  await parent().getByRole('button',{name:'打开论证编辑器',exact:true}).click();
  await parent().locator('.arg-node-content').first().waitFor();
  const geometry=()=>page.locator('.argument-canvas-connection-tools').evaluate((tools:HTMLElement)=>{
    const canvas=tools.closest<HTMLElement>('.argument-canvas-root')!,a=canvas.getBoundingClientRect(),b=tools.getBoundingClientRect();
    return{canvas:{left:a.left,top:a.top,right:a.right,bottom:a.bottom},tools:{left:b.left,top:b.top,right:b.right,bottom:b.bottom},
      scroll:tools.scrollWidth,client:tools.clientWidth,position:getComputedStyle(canvas).position,
      controls:[...tools.querySelectorAll<HTMLElement>('button,label,select')].map(item=>{const b=item.getBoundingClientRect();return{left:b.left,right:b.right};})};
  });
  const within=async()=>{const value=await geometry();assert.equal(value.position,'relative');assert.ok(value.tools.left>=value.canvas.left&&value.tools.top>=value.canvas.top&&value.tools.right<=value.canvas.right+1&&value.tools.bottom<=value.canvas.bottom+1,JSON.stringify(value));assert.ok(value.scroll<=value.client+1,JSON.stringify(value));assert.ok(value.controls.every(item=>item.left>=value.tools.left&&item.right<=value.tools.right+1),JSON.stringify(value));};
  const old=await page.addStyleTag({content:'.argument-canvas-root{position:static!important}'});
  const broken=await geometry();assert.ok(broken.tools.left<broken.canvas.left||broken.tools.top<broken.canvas.top,JSON.stringify(broken));
  await old.evaluate((element:HTMLElement)=>element.remove());await within();
  pass('reproduces original missing-anchor escape and fixes the actual embedded toolbar without positioning shared scopes');
  const toolbar=()=>page.locator('.argument-canvas-connection-tools');
  for(const width of[1100,375,320]){
    await page.setViewportSize({width,height:900});
    for(const dark of[false,true]){
      await page.evaluate((dark:boolean)=>document.documentElement.classList.toggle('dark',dark),dark);
      await toolbar().getByRole('checkbox',{name:'记住关系类型',exact:true}).check();await within();
      await toolbar().getByRole('combobox',{name:'选择新建连线类型',exact:true}).selectOption('oppose');
      await within();
      const viewport=()=>parent().locator('.react-flow__viewport').first();const before=await viewport().getAttribute('style');
      await toolbar().getByRole('checkbox',{name:'记住关系类型',exact:true}).uncheck();await within();
      assert.equal(await viewport().getAttribute('style'),before,'toolbar controls must not drag/zoom the canvas');
      await toolbar().getByRole('checkbox',{name:'记住关系类型',exact:true}).check();
      const beforeScroll=await geometry();await parent().locator('.learning-analysis-body').evaluate((element:HTMLElement)=>element.scrollTop+=80);
      await within();const afterScroll=await geometry();assert.ok(Math.abs((beforeScroll.tools.top-beforeScroll.canvas.top)-(afterScroll.tools.top-afterScroll.canvas.top))<1);
      await page.screenshot({path:path.join(output,`embedded-${width}-${dark?'dark':'light'}.png`)});
    }
  }
  pass('desktop, 375px and 320px light/dark wrapping and body scrolling retain bounded controls with the remembered-type selector open');
  await toolbar().getByRole('button',{name:'添加关系',exact:true}).click();
  const relation=()=>page.getByRole('dialog',{name:'确认新关系',exact:true});await relation().waitFor();
  assert.equal(await relation().evaluate((element:HTMLElement)=>Boolean(element.closest('[inert]'))),false);
  const portal=await relation().evaluate((element:HTMLElement)=>({inCanvas:!!element.closest('.argument-canvas-root'),overlayParent:element.parentElement?.parentElement===document.body,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,width:innerWidth}));
  assert.equal(portal.inCanvas,false);assert.equal(portal.overlayParent,true);assert.ok(portal.left>=0&&portal.right<=portal.width+1,JSON.stringify(portal));
  await relation().getByRole('combobox',{name:'起点',exact:true}).selectOption('n1');
  await relation().getByRole('combobox',{name:'终点',exact:true}).selectOption('n2');
  await relation().getByRole('combobox',{name:'关系类型',exact:true}).selectOption('relates');
  await relation().getByRole('button',{name:'创建关系',exact:true}).click();await relation().waitFor({state:'detached'});
  await toolbar().getByRole('status').filter({hasText:'关系已保存'}).waitFor();
  await toolbar().getByRole('button',{name:'添加关系',exact:true}).click();await relation().waitFor();
  await page.keyboard.press('Escape');await relation().waitFor({state:'detached'});assert.equal(await parent().count(),1);
  assert.equal(await toolbar().getByRole('combobox',{name:'选择新建连线类型',exact:true}).inputValue(),'relates');
  pass('relation creation/remember state and Escape work in the body portal; the child modal is not clipped or inert and does not close its parent');
  await page.goto(origin+'/toolbar-bounds?standalone=1',{waitUntil:'domcontentloaded'});
  await page.getByRole('region',{name:'论证画布',exact:true}).waitFor();await within();
  const standaloneViewport=()=>page.locator('.react-flow__viewport');const initial=await standaloneViewport().getAttribute('style');
  await page.locator('.react-flow__controls-zoomin').click();await page.waitForFunction((initial:string|null)=>document.querySelector('.react-flow__viewport')?.getAttribute('style')!==initial,initial);
  await within();await toolbar().getByRole('button',{name:'添加关系',exact:true}).click();await relation().waitFor();await page.keyboard.press('Escape');await relation().waitFor({state:'detached'});
  await page.screenshot({path:path.join(output,'standalone-320.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.ok((await page.evaluate(()=>(window as any).__toolbar.commands)).every((input:any)=>['load','review-read','review-graph-read'].includes(input.op)));
  pass('standalone canvas remains positioned, zoomable and modal-safe with zero persistence/model calls');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({status:'passed-offline',groups,output,boundary:'actual embedded/standalone ArgumentCanvas and relation portal; only synthetic read replies, no private library/model/network'},null,2));
  console.log(JSON.stringify({status:'passed-offline',groups,output},null,2));
}catch(error){console.error('Toolbar layout artifacts:',output);throw error;}finally{await browser?.close();await server?.close();}
