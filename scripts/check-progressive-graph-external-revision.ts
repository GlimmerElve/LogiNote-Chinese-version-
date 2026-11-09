/** Real result/editor/Canvas, synthetic revision notifications, no private data or models. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

globalThis.fetch = async () => assert.fail('External/model/private-library requests are forbidden');
const output = await fs.mkdtemp(path.resolve('build/progressive-graph-external-revision-'));
const fixtureId = path.resolve('__progressive-graph-external-revision.tsx').replaceAll('\\', '/');
const fixture = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ProgressiveReviewDialog}from'/src/components/progressive/ProgressiveReviewDialog';
import'/src/index.css';
const at='2026-11-08T12:00:00Z';
const record={schemaVersion:1,id:'review-A',version:1,courseId:'course-A',projectNoteId:'A',rootProjectId:'root',exitId:'exit',submittedAt:at,updatedAt:at,status:'analyzed',auxiliary:'ready',
 textKey:'source-A',rawText:'合成的原始复述，原分析与评分不因编辑而改变。',summaryText:'',pageIds:[],parts:1,completedParts:1,spans:[],pageRefs:[],studyRefs:[],chunks:[{id:'part-1',start:0,end:26,resultHash:'original-analysis'}],cognitionConfirmation:{status:'pending'}};
let doc={doc_id:'doc-A',title:'合成论证图',created_at:at,updated_at:at,iteration:1,status:'draft',nodes:[
 {id:'n1',mainType:'事实陈述',role:'premise',text:'原始已保存观点',position:{x:30,y:50},status:'ok',issue:null,severity:null,suggestion:null,user_edited:false,collapsed:false},
 {id:'n2',mainType:'推理',role:'claim',text:'只在给定条件下成立',position:{x:80,y:250},status:'ok',issue:null,severity:null,suggestion:null,user_edited:false,collapsed:false}],edges:[{id:'e1',source:'n1',target:'n2',relation:'support'}]};
let graphHash='initial';const listeners=new Set();
const state={commands:[],saves:0,confirms:0,writes:0,failSave:false,holdNextRead:false,heldReads:[],accepted:[]};
const emit=()=>{for(const listener of [...listeners])listener('A','review');};
const course=()=>({id:'course-A',environmentId:'env',projectNoteId:'A',title:'合成项目',reviews:[structuredClone(record)]});
window.electronAPI={progressiveLearning:{onChange:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},command:async input=>{
 state.commands.push(structuredClone(input));if(input.projectNoteId!=='A')throw Error('Foreign project rejected');
 if(input.op==='load')return course();
 if(input.op==='review-read')return input.partId?{argumentDoc:structuredClone(doc),report:{clarityScore:88,summary:'不可变原分析',sections:[]},analysisV2:{record:{input:{rawText:record.rawText}}}}:structuredClone(record);
 if(input.op==='review-graph-read'){const value={record:structuredClone(record),doc:structuredClone(doc),graphHash};if(state.holdNextRead){state.holdNextRead=false;await new Promise(resolve=>state.heldReads.push(resolve));}return value;}
 if(input.op==='review-graph-save'){
  if(input.expectedVersion!==record.version||input.expectedGraphHash!==graphHash)throw Error('合成保存版本冲突');
  if(state.failSave){state.failSave=false;throw Error('合成保存失败，修改仍保留');}
  state.saves++;doc=structuredClone(input.doc);doc.updated_at='2026-11-08T12:01:00Z';doc.status='draft';doc.nodes=doc.nodes.map(node=>({...node,status:'edited',user_edited:true}));
  graphHash='saved-'+state.saves;record.version++;record.graphDrafts={'part-1':graphHash};emit();return{record:structuredClone(record),doc:structuredClone(doc),graphHash};
 }
 if(input.op==='review-cognition-confirm'){if(input.expectedVersion!==record.version||input.confirmed!==true)throw Error('合成确认版本冲突');state.confirms++;state.writes++;state.accepted.push(structuredClone(doc));record.version++;record.cognitionConfirmation={status:'confirmed',confirmedAt:at};emit();return{record:structuredClone(record),course:course()};}
 throw Error('Unexpected mutation/model command '+input.op);
}}};
let open;
function Fixture(){const[visible,setVisible]=useState(false);open=()=>setVisible(true);return <><button id="open" onClick={open}>打开合成复盘</button>{visible&&<ProgressiveReviewDialog target={{projectNoteId:'A',reviewId:'review-A',courseId:'course-A',environmentId:'env',noteTitle:'合成项目'}} onClose={()=>setVisible(false)}/>}</>;}
window.__external={state,record,getDoc:()=>structuredClone(doc),external(text){doc.nodes[0].text=text;graphHash='external-'+(++record.version);record.graphDrafts={'part-1':graphHash};record.cognitionConfirmation={status:'pending'};emit();},hold(){state.holdNextRead=true;},release(){const held=state.heldReads.splice(0);for(const resolve of held)resolve();}};
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'graph-external-revision.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any, groups = 0;
const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    plugins: [react(), tailwindcss(), { name: 'external-revision-fixture', resolveId(id) { if (id === fixtureId || id === '/__external-revision.tsx') return fixtureId; },
      load(id) { if (id === fixtureId) return fixture; }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/external-revision') return next(); res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__external-revision.tsx"></script></body></html>');
      }); } }], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [], noDiscovery: true, include: [
        'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@xyflow/react', 'katex', 'zustand',
        'react-markdown', 'remark-gfm', '@xenova/transformers', 'micromark-util-decode-string', 'mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'micromark-extension-math', 'mdast-util-math'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [], outside: string[] = [];
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (outside.push(route.request().url()), route.abort()));
  const page = await context.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', (error: Error) => errors.push(error.message));
  const dialog = () => page.getByRole('dialog', { name: '复盘分析结果', exact: true });
  const state = () => page.evaluate(() => {
    const { heldReads, ...plain } = (window as any).__external.state; return structuredClone({ ...plain, heldReads: heldReads.length });
  });
  const content = () => dialog().locator('.arg-node-content').first();
  const reset = async () => {
    await page.goto(origin + '/external-revision', { waitUntil: 'domcontentloaded' }); await page.locator('#open').click();
    await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).waitFor();
    await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).click(); await content().waitFor();
  };
  const external = async (text: string) => page.evaluate((value: string) => (window as any).__external.external(value), text);
  const expectStored = async (text: string) => assert.equal(await page.evaluate(() => (window as any).__external.getDoc().nodes[0].text), text);
  const confirm = () => dialog().getByRole('button', { name: '确认并写入个人认知库', exact: true }).click();
  const conflict = () => dialog().getByText('论证图或复述已有更新，请重新读取并核对后再保存或确认；当前未保存修改仍保留。', { exact: true });

  await reset();
  await external('外部已保存的新观点'); await dialog().locator('.arg-node-content').filter({ hasText: '外部已保存的新观点' }).waitFor();
  await confirm(); await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  let current = await state(); assert.equal(current.saves, 0); assert.equal(current.writes, 1); assert.equal(current.accepted[0].nodes[0].text, '外部已保存的新观点');
  await expectStored('外部已保存的新观点');
  pass('a clean mounted editor adopts the external saved graph and confirms it without re-saving an old canvas');

  await reset(); await content().dblclick(); const input = dialog().locator('.arg-node-textarea'); await input.fill('尚未失焦的本地输入');
  await external('外部不能覆盖本地未提交输入');
  await page.waitForFunction(() => (window as any).__external.state.commands.filter((request: any) => request.op === 'review-read' && !request.partId).length >= 2);
  assert.equal(await input.inputValue(), '尚未失焦的本地输入'); assert.equal(await input.evaluate((node: HTMLTextAreaElement) => node === document.activeElement), true);
  await confirm(); await conflict().waitFor(); current = await state(); assert.equal(current.saves, 0); assert.equal(current.confirms, 0);
  await expectStored('外部不能覆盖本地未提交输入'); assert.equal(await dialog().locator('.arg-node-content').filter({ hasText: '尚未失焦的本地输入' }).count(), 1);
  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click(); assert.equal(await dialog().count(), 1);
  await dialog().getByRole('button', { name: '放弃未保存修改', exact: true }).click(); await dialog().getByText('外部不能覆盖本地未提交输入', { exact: true }).waitFor();
  pass('pending textarea input is neither blurred nor rebased by a refresh; confirmation/close cannot bypass its original CAS baseline');

  await reset(); await content().dblclick(); await dialog().locator('.arg-node-textarea').fill('已提交到内存但未保存的本地修改');
  await dialog().getByRole('region', { name: '论证画布', exact: true }).focus(); await dialog().locator('.arg-node-content').filter({ hasText: '已提交到内存但未保存的本地修改' }).waitFor();
  await external('另一个已保存的外部版本'); await page.waitForFunction(() => (window as any).__external.record.version === 2);
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click(); await conflict().waitFor();
  current = await state(); assert.equal(current.saves, 0); assert.equal(current.writes, 0); await expectStored('另一个已保存的外部版本');
  assert.equal(await dialog().locator('.arg-node-content').filter({ hasText: '已提交到内存但未保存的本地修改' }).count(), 1);
  pass('dirty committed edits remain local and cannot be written using a newer foreign graph version');

  await reset(); await page.evaluate(() => (window as any).__external.hold()); await external('先到记录、后到图的外部新稿');
  await page.waitForFunction(() => (window as any).__external.state.heldReads.length === 1);
  await confirm(); await conflict().waitFor(); current = await state(); assert.equal(current.saves, 0); assert.equal(current.confirms, 0);
  await page.evaluate(() => (window as any).__external.release()); await dialog().locator('.arg-node-content').filter({ hasText: '先到记录、后到图的外部新稿' }).waitFor();
  await confirm(); await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  assert.equal((await state()).accepted[0].nodes[0].text, '先到记录、后到图的外部新稿');
  pass('new record metadata cannot confirm an old displayed graph while the matching saved graph is still loading');

  await page.goto(origin + '/external-revision', { waitUntil: 'domcontentloaded' }); await page.locator('#open').click();
  await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).waitFor(); await page.evaluate(() => (window as any).__external.hold());
  await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).click(); await content().waitFor();
  await page.waitForFunction(() => (window as any).__external.state.heldReads.length === 1);
  await content().dblclick(); await dialog().locator('.arg-node-textarea').fill('本人刚保存的新草稿');
  await page.evaluate(() => (window as any).__external.state.failSave = true);
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click(); await dialog().getByText('合成保存失败，修改仍保留', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click(); await dialog().getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__external.release()); await page.waitForTimeout(100);
  assert.equal(await dialog().locator('.arg-node-content').filter({ hasText: '本人刚保存的新草稿' }).count(), 1); await expectStored('本人刚保存的新草稿');
  current = await state(); assert.equal(current.saves, 1); assert.equal(current.writes, 0);
  const canvas = dialog().getByRole('region', { name: '论证画布', exact: true }); await canvas.focus(); await page.keyboard.press('Control+z');
  await dialog().locator('.arg-node-content').filter({ hasText: '原始已保存观点' }).waitFor();
  await canvas.focus(); await page.keyboard.press('Control+y'); await dialog().locator('.arg-node-content').filter({ hasText: '本人刚保存的新草稿' }).waitFor();
  await confirm(); await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  assert.equal((await state()).saves, 1); assert.equal((await state()).accepted[0].nodes[0].text, '本人刚保存的新草稿');
  pass('late pre-write graph reads cannot replace an acknowledged save; retry, native stamping and undo/redo preserve the saved local revision');

  await reset(); await dialog().getByRole('button', { name: '添加关系', exact: true }).click();
  const relation = () => page.getByRole('dialog', { name: '确认新关系', exact: true });
  await relation().getByRole('combobox').nth(0).selectOption('n1');
  await relation().getByRole('combobox').nth(1).selectOption('n2');
  await relation().getByRole('combobox').nth(2).selectOption('relates');
  await relation().getByRole('textbox').fill('尚未保存的用户关系理由');
  await external('外部更新不能丢弃门户中的关系草稿');
  await page.waitForFunction(() => (window as any).__external.state.commands.filter((request: any) => request.op === 'review-read' && !request.partId).length >= 2);
  assert.equal(await relation().getByRole('combobox').nth(0).inputValue(), 'n1');
  assert.equal(await relation().getByRole('combobox').nth(1).inputValue(), 'n2');
  assert.equal(await relation().getByRole('combobox').nth(2).inputValue(), 'relates');
  assert.equal(await relation().getByRole('textbox').inputValue(), '尚未保存的用户关系理由');
  // A portal traps normal interaction. Exercise parent callbacks as well to
  // verify a save/confirm cannot silently omit the unfinished relation form.
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await dialog().getByText('关系编辑尚未完成，请先创建、保存或取消这条关系。', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '确认并写入个人认知库', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  current = await state(); assert.equal(current.saves, 0); assert.equal(current.confirms, 0); assert.equal(await relation().count(), 1);
  await page.screenshot({ path: path.join(output, 'pending-relation-protected.png') });
  await relation().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().locator('.arg-node-content').filter({ hasText: '外部更新不能丢弃门户中的关系草稿' }).waitFor();
  assert.equal(await relation().count(), 0); current = await state(); assert.equal(current.saves, 0); assert.equal(current.confirms, 0);
  pass('portal relation endpoints/type/reason survive external refresh; parent writes are blocked until explicit cancel, then latest clean graph is loaded');

  await dialog().getByRole('button', { name: '添加关系', exact: true }).click();
  await relation().getByRole('textbox').fill('Esc明确取消的草稿');
  await page.keyboard.press('Escape'); assert.equal(await relation().count(), 0); assert.equal(await dialog().count(), 1);
  await dialog().getByRole('button', { name: '添加关系', exact: true }).click();
  assert.equal(await relation().getByRole('textbox').inputValue(), '');
  await relation().getByRole('combobox').nth(0).selectOption('n1');
  await relation().getByRole('combobox').nth(1).selectOption('n2');
  await relation().getByRole('combobox').nth(2).selectOption('relates');
  await relation().getByRole('textbox').fill('经确认后才能进入图草稿的说明');
  await relation().getByRole('button', { name: '创建关系', exact: true }).click();
  assert.equal(await relation().count(), 0); current = await state(); assert.equal(current.saves, 0); assert.equal(current.confirms, 0);
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click();
  await dialog().getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => (window as any).__external.getDoc())).edges.find((edge: any) => edge.relation === 'relates')?.reason, '经确认后才能进入图草稿的说明');
  await confirm(); await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  current = await state(); assert.equal(current.saves, 1); assert.equal(current.confirms, 1); assert.equal(current.accepted[0].edges.length, 2);
  pass('Escape cancels only the relation form; explicit edge creation, graph save and cognition confirmation retain their separate boundaries');

  await dialog().getByRole('tab', { name: '分析报告', exact: true }).click(); await dialog().getByText('不可变原分析', { exact: true }).waitFor();
  assert.equal(await dialog().locator('.flow-analysis-score-value').textContent(), '88'); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  await page.screenshot({ path: path.join(output, 'external-revision-safe.png') });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed-offline', groups, output, boundary: 'actual Dialog, GraphEditor and Canvas with synthetic revision/IO replies; no real data/model/network' }, null, 2));
  console.log(JSON.stringify({ status: 'passed-offline', groups, output }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText()).catch(() => {}); }
  console.error('External revision diagnostic:', output); throw error;
} finally { await browser?.close(); await server?.close(); }
