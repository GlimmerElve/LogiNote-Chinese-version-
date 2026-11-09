/** Real browser UI -> local RPC -> actual course authority/private files. Synthetic/offline only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { ProgressiveReviewWorker } from '../src/services/progressiveLearning/reviewWorker';
import { analyzeProgressivePart } from '../src/services/progressiveLearning/reviewAnalysis';
import { progressiveReviewModelReply } from './fixtures/progressive-phase4';
import { loadCognition, mutateCognition } from '../src/electron/cognitionStore';
import { latestCognition } from '../src/services/cognition/core';
import type { NoteItem } from '../src/types';
import type { ProgressiveReviewRecord } from '../src/services/progressiveLearning/reviewTypes';

globalThis.fetch = async () => assert.fail('No external network or real model in confirmation entry checks');
const output = await fs.mkdtemp(path.resolve('build/progressive-confirmation-entry-'));
const privateDirectory = path.join(output, 'owned-synthetic-state');
const projectId = 'synthetic-confirmation-entry', at = '2026-11-08T12:00:00Z';
const raw = '我认为实验结论只在给定条件下成立。需要先控制时间间隔与刺激相似度两个变量，重复观察之后才能讨论它们的联系。';
const revised = '经过核对，我认为结论仅在控制时间间隔和刺激相似度的条件下成立，不能推广到所有情境。';
const externalRevision = '另一保存入口已补充：结论还需要重复观察支持，当前窗口不能用旧画布覆盖这一条件。';
const relationReason = '用户核对后补充的合成关系说明，只有明确创建并保存后才可入库。';
let notes: NoteItem[] = [{ id: projectId, title: '合成项目：复盘确认入口', noteType: 'project', projectRole: 'learning',
  content: '# 合成目标', tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
  dueDates: [{ id: 'due', noteId: projectId, noteTitle: '合成项目', taskText: '合成项目', dueDate: '2026-11-08',
    completed: false, priority: 'medium', estimatedMinutes: 40 }] }];
let modelCalls = 0, cognitionAttempts = 0, cognitionCommits = 0, refuseNextCognition = false, groups = 0;
const commands: any[] = [];
const pass = (message: string) => { groups++; console.log('PASS ' + message); };
const construct = () => new ProgressiveLearningStore(privateDirectory, {
  readTarget: async () => ({ note: notes[0], root: notes[0], isLeaf: true }), isCurrent: () => true,
  writeCognition: async input => {
    cognitionAttempts++;
    if (refuseNextCognition) { refuseNextCognition = false; throw Error('Synthetic private write refusal; retry the confirmed snapshot'); }
    const value = await mutateCognition(privateDirectory, input); cognitionCommits++; return value;
  },
});
let store = construct();
const command = async (input: any): Promise<any> => { commands.push(structuredClone(input)); return store.command(input, 281); };
const load = () => command({ op: 'load', projectNoteId: projectId });
const begin = await command({ op: 'begin', projectNoteId: projectId });
await command({ op: 'publish', lease: begin.lease, teaching: { sequence: begin.course.generation.sequence + 1,
  plan: { title: '合成主线', objectives: ['核对条件'], pages: [{ id: 'main-1', title: '实验条件', objectives: ['核对条件'] }] },
  title: '实验条件', body: '# 合成教材，不得当作个人认知\n\n' + raw.repeat(8), concepts: [], questions: [],
  hook: { id: 'hook', kind: 'reflection', prompt: '说说你的理解。' } } });
let course = await load();
await command({ op: 'save-progress', projectNoteId: projectId, progress: { environmentId: course.environmentId,
  courseId: course.id, expectedProgressVersion: course.progress.version,
  patch: { restatementDraft: raw, restatementSpans: [{ pageId: 'main-1', start: 0, end: raw.length }] } } });
course = await load();
const exit = await command({ op: 'review-exit', projectNoteId: projectId, environmentId: course.environmentId,
  courseId: course.id, exitId: 'synthetic-ui-exit', expectedProgressVersion: course.progress.version, analyze: true });
await command({ op: 'review-activate', projectNoteId: projectId, environmentId: course.environmentId,
  courseId: course.id, exitId: 'synthetic-ui-exit' });
const worker = new ProgressiveReviewWorker({ command, loadCourse: load, readNotes: () => notes,
  persist: async prepare => { notes = prepare(notes); }, profile: async () => {},
  analyze: packet => analyzeProgressivePart(packet, { call: async request => {
    modelCalls++;
    const input = JSON.parse(request.userInput), reply: any = progressiveReviewModelReply(input);
    if (!input.graph) {
      reply.graph.nodes = [{ id: 'N1', role: 'claim', text: raw.slice(0, 20), rawQuote: raw.slice(0, 20) },
        { id: 'N2', role: 'premise', text: raw.slice(20), rawQuote: raw.slice(20) }];
      reply.graph.arguments = [{ id: 'A1', claim: 'N1', support: ['N2'], oppose: [], status: 'argued' }];
    }
    return { content: JSON.stringify(reply) };
  } }),
});
worker.kick(projectId); await worker.idle(); worker.stop();
const readRecord = (): Promise<ProgressiveReviewRecord> => command({ op: 'review-read', projectNoteId: projectId, reviewId: exit.record.id });
let record = await readRecord();
assert.equal(record.status, 'analyzed'); assert.equal(record.auxiliary, 'ready');
assert.equal(cognitionCommits, 0); assert.equal((await loadCognition(privateDirectory)).records.length, 0);
const analysis = await command({ op: 'review-read', projectNoteId: projectId, reviewId: record.id, partId: 'part-1' });
const analysisHash = createHash('sha256').update(JSON.stringify(analysis)).digest('hex');
const fixedModelCalls = modelCalls;
pass('actual worker completes analysis/profile/auxiliary without writing unconfirmed cognition');

const target = { projectNoteId: projectId, reviewId: record.id, courseId: course.id, environmentId: course.environmentId, noteTitle: notes[0].title };
const fixtureId = path.resolve('__progressive-confirmation-entry.tsx').replaceAll('\\', '/');
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProgressiveReviewDialog} from '/src/components/progressive/ProgressiveReviewDialog';
import {ProgressiveLatestArgument} from '/src/components/progressive/ProgressiveLatestArgument';
import '/src/index.css';import '/src/components/progressive/progressiveCourse.css';
const target=${JSON.stringify(target)};const listeners=new Set();
const emit=()=>{for(const f of [...listeners])f(target.projectNoteId,'review');};
const completed={recordReads:0};window.__confirmationEntry={emit,completed};
window.electronAPI={progressiveLearning:{onChange:f=>{listeners.add(f);return()=>listeners.delete(f);},command:async input=>{
 const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 const value=await response.json();if(!value.ok)throw Error(value.error);if(input.op==='review-read'&&!input.partId)completed.recordReads++;if(['review-graph-save','review-cognition-confirm'].includes(input.op))emit();return value.value;
}}};
function Fixture(){const[open,setOpen]=useState(false);return <main style={{padding:16}}>
 <button id="entry-open" onClick={()=>setOpen(true)}>打开当前复盘</button>
 <aside style={{width:340,maxWidth:'100%'}}><ProgressiveLatestArgument noteId={target.projectNoteId} noteTitle={target.noteTitle} enabled={true}><p id="legacy-fallback">合成旧图占位</p></ProgressiveLatestArgument></aside>
 {open&&<ProgressiveReviewDialog target={target} onClose={()=>setOpen(false)}/>}</main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'progressive-confirmation-entry.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    plugins: [react(), tailwindcss(), { name: 'isolated-confirmation-entry',
      resolveId(id) { if (id === fixtureId || id === '/__confirmation-entry.tsx') return fixtureId; },
      load(id) { if (id === fixtureId) return fixture; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/confirmation-entry') {
          res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__confirmation-entry.tsx"></script></body></html>'); return;
        }
        if (req.url !== '/rpc' || req.method !== 'POST') return next();
        void (async () => {
          let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 3000000) throw Error('Synthetic RPC input too large'); }
          const value = await command(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value }));
        })().catch(error => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: String(error.message) })); });
      }); },
    }], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [], noDiscovery: true,
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@xyflow/react',
        'zustand', 'zustand/react', 'zustand/vanilla', 'zustand/shallow', 'katex', 'react-markdown', 'remark-gfm',
        '@xenova/transformers', 'micromark-util-decode-string', 'mdast-util-from-markdown', 'micromark-extension-gfm',
        'mdast-util-gfm', 'micromark-extension-math', 'mdast-util-math', 'html-to-image', 'jspdf', 'html2canvas'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const external: string[] = [], errors: string[] = [];
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  const page = await context.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin + '/confirmation-entry', { waitUntil: 'domcontentloaded' });
  await page.locator('#entry-open').waitFor();
  await page.locator('aside .argument-doc-embed-node').first().waitFor();
  assert.equal(cognitionCommits, 0);
  await page.screenshot({ path: path.join(output, 'latest-argument-native.png') });
  pass('actual current-project sidebar reads the newest saved graph with zero cognition writes');
  await page.locator('#entry-open').click();
  const dialog = page.getByRole('dialog', { name: '复盘分析结果', exact: true });
  await dialog.getByRole('button', { name: '打开论证编辑器', exact: true }).click();
  await dialog.locator('.arg-node-content').first().waitFor();
  await dialog.locator('.arg-node-content').filter({ hasText: raw.slice(0, 20) }).dblclick();
  await dialog.locator('.arg-node-textarea').fill(revised);
  // Deliberately click directly from the textarea: the node blur commit must reach the saved graph.
  await dialog.getByRole('button', { name: '保存图草稿', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.progressive-review-dialog [aria-busy="true"]'));
  record = await readRecord();
  const draft = await command({ op: 'review-graph-read', projectNoteId: projectId, reviewId: record.id, partId: 'part-1' });
  assert.equal(draft.doc.nodes.find((node: any) => node.id === 'N1').text, revised);
  assert.equal(cognitionCommits, 0); assert.equal((await loadCognition(privateDirectory)).records.length, 0);
  pass('real editor blur/save reaches a durable revised graph without admitting cognition');
  await dialog.getByRole('button', { name: '返回笔记', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  store.releaseOwner(281); store = construct();
  await page.locator('#entry-open').click();
  await dialog.locator('.argument-doc-embed-node-text').filter({ hasText: revised }).waitFor();
  assert.equal(cognitionCommits, 0);
  pass('closing and fresh authority restart reopen the saved draft, still awaiting user confirmation');
  await dialog.getByRole('button', { name: '打开论证编辑器', exact: true }).click();
  await dialog.locator('.arg-node-content').filter({ hasText: revised }).waitFor();
  const relation = () => page.getByRole('dialog', { name: '确认新关系', exact: true });
  const openRelation = async () => {
    await dialog.getByRole('button', { name: '添加关系', exact: true }).click();
    await relation().getByRole('combobox', { name: '起点', exact: true }).selectOption('N1');
    await relation().getByRole('combobox', { name: '终点', exact: true }).selectOption('N2');
    await relation().getByRole('combobox', { name: '关系类型', exact: true }).selectOption('relates');
    await relation().getByRole('textbox', { name: '关系说明（可选）', exact: true }).fill(relationReason);
  };
  await openRelation();
  const readsBeforeExternal = await page.evaluate(() => (window as any).__confirmationEntry.completed.recordReads);
  const beforeExternal = await command({ op: 'review-graph-read', projectNoteId: projectId, reviewId: record.id, partId: 'part-1' });
  await command({ op: 'review-graph-save', projectNoteId: projectId, reviewId: record.id, partId: 'part-1',
    environmentId: course.environmentId, courseId: course.id, expectedVersion: beforeExternal.record.version,
    expectedGraphHash: beforeExternal.graphHash, doc: { ...beforeExternal.doc,
      nodes: beforeExternal.doc.nodes.map((node: any) => node.id === 'N1' ? { ...node, text: externalRevision } : node) } });
  await page.evaluate(() => (window as any).__confirmationEntry.emit());
  await page.waitForFunction((previous: number) => (window as any).__confirmationEntry.completed.recordReads > previous, readsBeforeExternal);
  // Let the actual record refresh settle: an unconfirmed portal form must not
  // disappear when the native graph revision becomes visible to this window.
  await page.waitForFunction(() => !document.querySelector('.progressive-review-dialog [aria-busy="true"]'));
  await relation().waitFor();
  assert.equal(await relation().getByRole('textbox', { name: '关系说明（可选）', exact: true }).inputValue(), relationReason);
  assert.equal(await relation().getByRole('combobox', { name: '起点', exact: true }).inputValue(), 'N1');
  assert.equal(await relation().getByRole('combobox', { name: '终点', exact: true }).inputValue(), 'N2');
  assert.equal(await relation().getByRole('combobox', { name: '关系类型', exact: true }).inputValue(), 'relates');
  assert.equal(cognitionCommits, 0);
  await page.screenshot({ path: path.join(output, 'relation-draft-preserved-native.png') });
  await relation().getByRole('button', { name: '取消', exact: true }).click();
  await dialog.locator('.arg-node-content').filter({ hasText: externalRevision }).waitFor();
  assert.equal(await dialog.locator('.arg-node-content').filter({ hasText: revised }).count(), 0);
  assert.equal(cognitionCommits, 0);
  pass('an unconfirmed relation portal survives a real native revision; cancelling it then adopts the current canvas and CAS baseline');
  await openRelation();
  await relation().getByRole('button', { name: '创建关系', exact: true }).click();
  await relation().waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: '保存图草稿', exact: true }).click();
  await dialog.getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  const relationDraft = await command({ op: 'review-graph-read', projectNoteId: projectId, reviewId: record.id, partId: 'part-1' });
  assert.ok(relationDraft.doc.edges.some((edge: any) => edge.source === 'N1' && edge.target === 'N2' && edge.relation === 'relates' && edge.reason === relationReason));
  assert.equal(cognitionCommits, 0);
  const graphSavesBeforeConfirmation = commands.filter(input => input.op === 'review-graph-save').length;
  pass('explicit relation creation and draft saving persist endpoints/type/reason through the actual queued native writer, without admitting cognition');
  refuseNextCognition = true;
  await dialog.getByRole('button', { name: '确认并写入个人认知库', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Synthetic private write refusal' }).waitFor();
  assert.equal((await loadCognition(privateDirectory)).records.length, 0);
  assert.equal(cognitionCommits, 0);
  await dialog.getByRole('button', { name: '确认并写入个人认知库', exact: true }).click();
  await dialog.getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  const cognition = await loadCognition(privateDirectory);
  assert.equal(cognition.records.length, 1);
  assert.ok(latestCognition(cognition.records[0]).branches.some(branch => branch.graph.nodes.some(node => node.text === externalRevision)));
  assert.equal(commands.filter(input => input.op === 'review-graph-save').length, graphSavesBeforeConfirmation,
    'Confirming the refreshed clean editor must not re-save or overwrite the external revision with an old store');
  assert.equal(cognitionCommits, 1); assert.equal(cognitionAttempts, 2);
  record = await readRecord(); assert.equal(record.cognitionConfirmation?.status, 'confirmed');
  pass('visible confirmation failure retries the same current snapshot once into actual private storage');
  const unchanged = await command({ op: 'review-read', projectNoteId: projectId, reviewId: record.id, partId: 'part-1' });
  assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'), analysisHash);
  assert.equal(record.rawText, raw); assert.equal(modelCalls, fixedModelCalls);
  const remainingWork = await command({ op: 'review-work', projectNoteIds: [projectId] });
  assert.equal(remainingWork.filter((job: any) => job.reviewId === record.id).length, 0,
    'Confirmation must not schedule another analysis/cognition pass; independent project completion may remain');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'confirmed-edited-argument-native.png') });
  pass('original source/report/scores remain immutable; no model reruns, pending background loops or external requests');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed-offline', groups, output, cognitionAttempts, cognitionCommits,
    fixedModelCalls, boundary: 'actual result/sidebar/editor -> local-only RPC -> native queued authority -> synthetic private files; fixed model replies only' }, null, 2));
  console.log(JSON.stringify({ status: 'passed-offline', groups, output }, null, 2));
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure-ui.txt'), await failedPage.locator('body').innerText()).catch(() => {});
  }
  console.error('Confirmation entry failure artifacts:', output);
  throw error;
} finally { if (browser) await browser.close(); if (server) await server.close(); }
