/** Actual graph editor, dialog keyboard ownership and latest-current-note projection; synthetic/offline only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { progressiveGraphEditKey } from '../src/services/progressiveLearning/reviewGraphEdit';
globalThis.fetch = async () => assert.fail('No private library, real model or external network in confirmation UI checks');
const output = await fs.mkdtemp(path.resolve('build/progressive-confirmation-ui-'));
const keyDoc: any = { title: '只比较可编辑内容', nodes: [{ id: 'n1', mainType: '推理', role: 'claim', text: '保留真实修改', position: { x: 1, y: 2 }, collapsed: false, status: 'ok', user_edited: false }], edges: [] };
const canonical = structuredClone(keyDoc); canonical.status = 'draft'; canonical.nodes[0].status = 'edited'; canonical.nodes[0].user_edited = true;
assert.equal(progressiveGraphEditKey(keyDoc), progressiveGraphEditKey(canonical), 'native status stamping alone cannot trap an already-saved editor as dirty');
for (const change of [
  (doc: any) => { doc.nodes[0].text = '不同的内容'; }, (doc: any) => { doc.nodes[0].role = 'premise'; },
  (doc: any) => { doc.nodes[0].position.x++; }, (doc: any) => { doc.nodes = []; },
  (doc: any) => { doc.edges = [{ id: 'e1', source: 'n1', target: 'n2', relation: 'oppose', reason: '需保留的关系变动' }]; },
]) { const changed = structuredClone(keyDoc); change(changed); assert.notEqual(progressiveGraphEditKey(keyDoc), progressiveGraphEditKey(changed)); }
const fixtureId = path.resolve('__progressive-confirmation-ui.tsx').replaceAll('\\', '/');
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProgressiveLatestArgument} from '/src/components/progressive/ProgressiveLatestArgument';
import '/src/index.css';
const date='2026-11-08T12:00:00Z';
const doc=(id,part)=>({doc_id:'doc-'+id+'-'+part,title:'结构'+id,version:1,created_at:date,updated_at:date,
 nodes:[{id:'n1',mainType:'事实陈述',role:'premise',text:id+'项目原始前提'+part,position:{x:30,y:80},status:'ok',issue:null,severity:null,suggestion:null,user_edited:false,collapsed:false},
 {id:'n2',mainType:'推理',role:'claim',text:id+'项目主张'+part,position:{x:100,y:300},status:'ok',issue:null,severity:null,suggestion:null,user_edited:false,collapsed:false}],
 edges:[{id:'e1',source:'n1',target:'n2',relation:'support'}]});
const rows=new Map(['A','B'].map(id=>[id,{record:{schemaVersion:1,id:'review-'+id,version:1,courseId:'course-'+id,projectNoteId:id,rootProjectId:'root',exitId:'exit',submittedAt:date,updatedAt:date,
 status:'analyzed',textKey:'source',pageIds:[],parts:2,completedParts:2,auxiliary:'ready',rawText:'本次用户原始复述，评分不能由图编辑自动改变。',summaryText:'',spans:[],pageRefs:[],studyRefs:[],
 chunks:[{id:'part-1',start:0,end:12,resultHash:'original1'},{id:'part-2',start:12,end:25,resultHash:'original2'}],cognitionConfirmation:{status:'pending'}},
 docs:{'part-1':doc(id,1),'part-2':doc(id,2)},hashes:{'part-1':'hash1','part-2':'hash2'}}]));
const state={commands:[],saves:0,confirms:0,writes:0,failSave:false,failConfirm:false,holdA:false};const listeners=new Set();let releaseA;
const course=id=>({id:'course-'+id,environmentId:'env',projectNoteId:id,title:id+'项目',reviews:[structuredClone(rows.get(id).record)]});
const emit=id=>{for(const callback of [...listeners])callback(id,'review');};
window.electronAPI={progressiveLearning:{onChange:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},command:async input=>{
 state.commands.push(structuredClone(input));const id=input.projectNoteId;const row=rows.get(id);
 if(input.op==='load'){const value=course(id);if(id==='A'&&state.holdA)await new Promise(resolve=>releaseA=resolve);return value;}
 if(input.op==='review-read')return input.partId?{argumentDoc:doc(id,1),report:{summary:'不可变原始报告',clarityScore:88,sections:[]},analysisV2:{record:{input:{rawText:row.record.rawText}}}}:structuredClone(row.record);
 if(input.op==='review-graph-read')return {record:structuredClone(row.record),doc:structuredClone(row.docs[input.partId]),graphHash:row.hashes[input.partId]};
 if(input.op==='review-graph-save'){if(state.failSave){state.failSave=false;throw Error('合成图草稿保存失败，修改未丢失');}if(input.expectedVersion!==row.record.version||input.expectedGraphHash!==row.hashes[input.partId])throw Error('合成版本冲突');
 row.docs[input.partId]=structuredClone(input.doc);row.hashes[input.partId]='draft-'+(++state.saves);row.record.version++;row.record.graphDrafts={...row.record.graphDrafts,[input.partId]:row.hashes[input.partId]};row.record.cognitionConfirmation={status:'pending'};emit(id);
 return {record:structuredClone(row.record),doc:structuredClone(row.docs[input.partId]),graphHash:row.hashes[input.partId]};}
 if(input.op==='review-cognition-confirm'){state.confirms++;if(state.failConfirm){state.failConfirm=false;throw Error('合成认知写入暂未完成，请重试');}if(input.expectedVersion!==row.record.version||input.confirmed!==true)throw Error('合成确认无效');state.writes++;row.record.version++;row.record.cognitionConfirmation={status:'confirmed',confirmedAt:date};emit(id);return {record:structuredClone(row.record),course:course(id)};}
 throw Error('Unexpected mutation/model command '+input.op);
}}};
let choose;function Fixture(){const[id,setId]=useState('A');choose=setId;return <><nav><button id="choose-A" onClick={()=>setId('A')}>切换A</button><button id="choose-B" onClick={()=>setId('B')}>切换B</button></nav>
 <aside style={{width:'min(360px,100%)'}}><ProgressiveLatestArgument key={id} noteId={id} noteTitle={id+'项目'} enabled><p>旧图占位</p></ProgressiveLatestArgument></aside></>;}
window.__confirmation={state,rows,emit,hold(){state.holdA=true;emit('A');},release(){state.holdA=false;releaseA?.();}};
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'progressive-confirmation-ui.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
let groups = 0; const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error', plugins: [react(), tailwindcss(), {
    name: 'isolated-progressive-confirmation-ui', resolveId(id) { if (id === fixtureId || id === '/__confirmation-ui.tsx') return fixtureId; }, load(id) { if (id === fixtureId) return fixture; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/confirmation-ui') return next(); res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__confirmation-ui.tsx"></script></body></html>'); }); }
  }], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
    'lucide-react', '@xyflow/react', 'katex', 'zustand', 'react-markdown', 'remark-gfm', '@xenova/transformers', 'micromark-util-decode-string', 'mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'micromark-extension-math', 'mdast-util-math'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [], external: string[] = [];
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  const page = await context.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', (error: Error) => errors.push(error.message));
  const state = () => page.evaluate(() => structuredClone((window as any).__confirmation.state));
  const dialog = () => page.getByRole('dialog', { name: '复盘分析结果', exact: true });
  await page.goto(origin + '/confirmation-ui', { waitUntil: 'domcontentloaded' });
  await page.getByText('A项目原始前提1', { exact: true }).waitFor(); assert.equal((await state()).writes, 0); assert.equal((await state()).saves, 0);
  await page.screenshot({ path: path.join(output, 'latest-argument-sidebar.png') });
  pass('sidebar directly displays the latest current-project graph without a model, cognition write or graph save');

  await page.getByRole('button', { name: '查看与编辑', exact: true }).click(); await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).click();
  await dialog().locator('.arg-node-content').first().waitFor();
  const first = () => dialog().locator('.arg-node-content').filter({ hasText: 'A项目原始前提1' }).first();
  await first().dblclick(); const input = dialog().locator('.arg-node-textarea'); await input.fill('直接点击保存也必须保留的新条件');
  await dialog().getByRole('button', { name: '第 2 段', exact: true }).click();
  await dialog().getByText('结构图修改尚未保存，请先保存草稿或放弃修改。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '第 1 段', exact: true }).getAttribute('aria-pressed'), 'true');
  await dialog().getByRole('button', { name: '关闭复盘窗口', exact: true }).click(); assert.equal(await dialog().count(), 1);
  assert.equal((await state()).saves, 0); assert.equal((await state()).writes, 0);
  pass('uncommitted node text blocks segment switches and closing; no silent save or confirmation');

  await page.evaluate(() => (window as any).__confirmation.state.failSave = true);
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click(); await dialog().getByText('合成图草稿保存失败，修改未丢失', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click(); await dialog().getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  assert.equal((await state()).saves, 1); assert.equal((await state()).writes, 0);
  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  await page.getByText('直接点击保存也必须保留的新条件', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看与编辑', exact: true }).click(); await dialog().getByText('直接点击保存也必须保留的新条件', { exact: true }).waitFor();
  pass('failed graph save retains edits; an explicit retry saves only a draft, and reopening/sidebar show that same revision');

  await page.evaluate(() => (window as any).__confirmation.state.failConfirm = true);
  await dialog().getByRole('button', { name: '确认并写入个人认知库', exact: true }).click(); await dialog().getByText('合成认知写入暂未完成，请重试', { exact: true }).waitFor(); assert.equal((await state()).writes, 0);
  await dialog().getByRole('button', { name: '确认并写入个人认知库', exact: true }).click(); await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor(); assert.equal((await state()).writes, 1);
  await dialog().getByRole('tab', { name: '分析报告', exact: true }).click(); await dialog().getByText('不可变原始报告', { exact: true }).waitFor();
  assert.equal(await dialog().locator('.flow-analysis-score-value').textContent(), '88');
  pass('confirmation is explicit and retryable; saved report and original 88 score are unchanged');

  await dialog().getByRole('tab', { name: '逻辑结构图', exact: true }).click(); await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).click();
  const canvas = () => dialog().getByRole('region', { name: '论证画布', exact: true }); await canvas().waitFor();
  await canvas().locator('.arg-node-content').first().click(); await page.keyboard.press('Delete'); await page.waitForFunction(() => document.querySelectorAll('[role=dialog] .arg-node').length === 1);
  await canvas().focus(); await page.keyboard.press('Control+z'); await page.waitForFunction(() => document.querySelectorAll('[role=dialog] .arg-node').length === 2);
  await canvas().getByRole('button', { name: '添加关系', exact: true }).click();
  const relation = page.getByRole('dialog', { name: '确认新关系', exact: true }); await relation.waitFor();
  const before = await canvas().locator('.arg-node').count(); await page.keyboard.press('Delete'); assert.equal(await canvas().locator('.arg-node').count(), before);
  await page.keyboard.press('Escape'); await dialog().waitFor(); assert.equal((await state()).writes, 1);
  await dialog().getByRole('button', { name: '放弃未保存修改', exact: true }).click();
  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click();
  pass('the embedded editor owns Delete/undo, while a higher relation dialog blocks canvas shortcuts');

  await page.evaluate(() => (window as any).__confirmation.hold());
  await page.locator('#choose-B').click(); await page.getByText('B项目原始前提1', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__confirmation.release()); await page.waitForTimeout(100);
  assert.equal(await page.getByText('直接点击保存也必须保留的新条件', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 375, height: 850 }); await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.getByRole('button', { name: '查看与编辑', exact: true }).click(); await dialog().getByText('B项目原始前提1', { exact: true }).waitFor();
  const geometry = await dialog().evaluate((element: HTMLElement) => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: window.innerWidth, scroll: element.scrollWidth, client: element.clientWidth }));
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.scroll <= geometry.client + 1, JSON.stringify(geometry));
  await page.screenshot({ path: path.join(output, 'confirmation-375-dark.png') });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  pass('a delayed old-project read cannot replace the new sidebar; 375px dark dialog stays in the viewport');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed-offline', groups, output, boundary: 'actual editor/dialog/sidebar with synthetic client responses; native confirmation checked separately; no real data/network/models' }, null, 2));
  console.log(JSON.stringify({ status: 'passed-offline', groups, output }));
} finally { await browser?.close(); await server?.close(); }
