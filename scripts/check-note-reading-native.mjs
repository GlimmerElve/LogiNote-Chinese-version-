// Production App/main/preload, disposable local vault, no external model or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { writeTextbookRegion } from '../src/services/textbook/noteContent.ts';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy.ts';
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'note-reading.cjs'))('playwright');
await fs.mkdir(path.resolve('.tmp-textbook-check'), { recursive: true });
const directory = await fs.mkdtemp(path.resolve('.tmp-textbook-check/note-reading-native-'));
const appRoot = path.join(directory, 'app'), state = path.join(directory, 'state');
await fs.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fs.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fs.mkdir(path.join(state, 'user-state'), { recursive: true });
const rendererEntry = process.argv.find(argument => argument.startsWith('--renderer-entry='))?.slice('--renderer-entry='.length);
if (rendererEntry) {
  assert.match(rendererEntry, /^main-[A-Za-z0-9_-]+\.js$/u);
  await fs.mkdir(path.join(appRoot, 'dist'));
  await fs.symlink(path.resolve('dist/assets'), path.join(appRoot, 'dist/assets'), 'junction');
  const html = (await fs.readFile('dist/index.html', 'utf8')).replace(/src="\.\/assets\/main-[A-Za-z0-9_-]+\.js"/u, `src="./assets/${rendererEntry}"`);
  await fs.writeFile(path.join(appRoot, 'dist/index.html'), html);
} else await fs.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'note-reading-synthetic', version: '1.0.0' }));
for (const [name, buffer] of await compileElectron(process.cwd())) await fs.writeFile(path.join(appRoot, 'dist-electron', name), name === 'preload.cjs'
  ? Buffer.concat([buffer, Buffer.from(`\nconst {contextBridge: readingBridge,ipcRenderer: readingIpc}=require('electron');readingBridge.exposeInMainWorld('readingNativeTest',{command:input=>readingIpc.invoke('save-test:command',input)});\n`)]) : buffer);
const makeNote = (id, title, content, noteType = 'project') => ({ id, title, content, noteType, tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' });
const diagram = 'flowchart TD\nA[函数] --> B[极限]\nB --> C[导数]\nB --> D[积分]\nC --> E[变化]\nD --> F[累积]';
const richBlocks = '> **对比**\n>\n> - **左侧**：$x<0$ 时从左接近。\n> - **右侧**：$x>0$ 时从右接近。\n\n'
  + '> **步骤**\n>\n> 1. 分别求两侧极限。\n> 2. 比较两侧结果。\n\n'
  + '> **例题**\n>\n> 对 $f(x)=x^2$，两侧都趋近于 $0$。\n\n'
  + '> **交互探索**\n>\n> 改变输入并观察平方函数的变化。\n\n';
const extraBlocks = '> **要点**\n>\n> 极限要比较同一观察点的两侧。\n\n> **注意**\n>\n> 两侧极限不等时极限不存在。\n\n'
  + '> **思考**\n>\n> 如果两侧都等于 1 呢？\n\n> **注释**\n>\n> 此处只讨论实函数。\n\n';
const escapedMath = String.raw`> **定理条件**
>
> 则存在 $\\xi\\in(a,b)$，使得 $f'(\\xi)=0$。` + '\n\n';
const longBody = '# 长文开始\n\n行内公式 $x^2+1$。\n\n$$\n\\frac{1}{2}+x^2\n$$\n\n' + richBlocks + '[[参考笔记#定义|关联原笔记]] [[#末尾|末尾阅读]]\n\n'
  + '```mermaid\n' + diagram + '\n```\n\n' + extraBlocks + '普通段落用于分块，原文和学习资料不变。\n\n'.repeat(1800)
  + '## 末尾\n\n远处章节正文。\n\n```mermaid\nflowchart LR\nX[远处图示] --> Y[按需加载]\n```\n';
const chart = { title: '阅读图表', type: 'bar', simulated: true, sourceIds: [], labels: ['一', '二'], series: [{ name: '次数', data: [1, 2] }] };
const plot = { title: '平方函数面积', variable: 'x', xLabel: 'x', yLabel: 'y', xDomain: [0, 2], yDomain: [0, 4], curves: [{ id: 'f', label: '平方函数', expression: 'x^2' }], area: { curveId: 'f', from: 0, to: 2 }, riemann: { curveId: 'f', from: 0, to: 2, count: 8, method: 'midpoint' } };
const molecule = { title: '乙醇', description: '乙醇的二维连接结构', smiles: 'CCO', sourceIds: [], simulated: true };
const science = { title: '推力', description: '箭头示意力的方向', width: 400, height: 240, sourceIds: [], simulated: true, elements: [{ kind: 'rect', x: 80, y: 80, width: 80, height: 50 }, { kind: 'arrow', x1: 160, y1: 105, x2: 270, y2: 105 }] };
const notes = [makeNote('long-note', '普通长文', longBody), makeNote('target-note', '参考笔记', '# 概述\n内容。\n\n## 定义\n原目标定义正文。', 'knowledge'),
  makeNote('short-note', '短文材料', '# 短文\n\n短文公式 $y=x^2$。\n\n[[参考笔记#定义|短文双链]]\n\n```chart\n' + JSON.stringify(chart) + '\n```')];
// A leaf without a completed textbook now correctly starts progressive learning.
// Seed an actual managed legacy region to exercise the short-textbook branch.
const legacyBody = '# 短文\n\n短文公式 $y=x^2$。\n\n' + escapedMath + richBlocks + '参考 [N1]。\n\n```chart\n' + JSON.stringify(chart) + '\n```\n\n' + extraBlocks
  + '```mermaid\n' + diagram + '\n```\n\n```function-plot\n' + JSON.stringify(plot) + '\n```\n\n```textbook-image\n' + JSON.stringify({ assetId: 'fixture-image', caption: '合成资料原图' }) + '\n```\n\n```molecule\n' + JSON.stringify(molecule) + '\n```\n\n```science-diagram\n' + JSON.stringify(science) + '\n```\n\n'
  + '延伸讲解：比较两侧趋势时，需要保持相同的观察条件。\n\n'.repeat(1100);
notes[2] = writeTextbookRegion(notes[2], legacyBody, {
  schemaVersion: 1, textbookId: 'short-book', projectNoteId: 'short-note', rootProjectId: 'short-note', regionId: 'short-region', revisionId: 'short-v1', generationJobId: 'figure-fixture-job',
  createdAt: notes[2].createdAt, updatedAt: notes[2].updatedAt,
  sources: [{ sourceId: 'N1', kind: 'knowledge', id: 'target-note', title: '参考笔记', version: 'fixture-v1' }, { sourceId: 'L1', kind: 'document', id: 'fixture-doc', title: '合成资料', version: 'fixture-v1', blockId: 'fixture-block' }],
  assets: [{ id: 'fixture-image', sourceId: 'L1', docId: 'fixture-doc', version: 'fixture-v1', blockId: 'fixture-block', imageIndex: 0, alt: '合成原图' }],
});
if (process.argv.includes('--navigation-regression')) {
  const navigationBody = '# 导航验收教材\n\n函数 $f(x)=x^2$。\n\n' + Array.from({ length: 160 }, (_, index) =>
    `${index % 20 === 0 ? `## 第 ${index / 20 + 1} 部分\n\n` : ''}导航段落 ${index}。${'先确定允许输入的范围，再解释不同条件下的对应关系；改变观察区间之前，应保持函数表达式不变，并比较两侧的变化趋势。'.repeat(3)}\n\n`).join('');
  const note = makeNote('navigation-book', '导航验收教材', '');
  notes.push(writeTextbookRegion(note, navigationBody, { schemaVersion: 1, textbookId: 'navigation-book', projectNoteId: note.id,
    rootProjectId: note.id, regionId: 'navigation-region', revisionId: 'navigation-v1', createdAt: note.createdAt, updatedAt: note.updatedAt }));
}
assert(longBody.length > 24000);
await fs.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: Object.fromEntries(notes.map(({ content, ...meta }) => [meta.id, meta])) }));
for (const note of notes) await fs.writeFile(path.join(state, 'vault/notes', note.id + '.md'), note.content);
await fs.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: {
  theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false,
} }));
const fixtureProvider = { id: 'deepseek-default', name: '合成模型', apiType: 'openai-compatible', baseUrl: 'https://example.invalid', apiKey: 'synthetic-only', enabled: true, models: ['synthetic'], selectedModel: 'synthetic', createdAt: '2026-10-30T00:00:00Z' };
await fs.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [fixtureProvider], defaultProviderId: 'deepseek-default', workflowBinding: {} } }));
const modelPolicy = defaultTextbookModelPolicy();
const providers = ['textbook-blueprint', 'textbook-chapter', 'textbook-quality'].map(workflow => ({ workflow, id: fixtureProvider.id, name: fixtureProvider.name,
  apiType: fixtureProvider.apiType, baseUrl: fixtureProvider.baseUrl, apiKey: fixtureProvider.apiKey, selectedModel: fixtureProvider.selectedModel, models: fixtureProvider.models }));
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const providerHash = createHash('sha256').update(stable({ providers, modelPolicy })).digest('hex');
await fs.writeFile(path.join(directory, 'figure-fixture-job.json'), JSON.stringify({ job: { stage: 'published', spec: { projectNoteId: 'short-note', allowCloud: true, providerHash, modelPolicy, promptVersion: 7 }, checkpoint: { body: legacyBody.trim() } } }));
const failPlanned = process.argv.includes('--planned-failure');
const expectedFigureCalls = failPlanned ? 2 : 1;
const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: directory, SAVE_NATIVE_REAL_DIALOG: 'auto', SAVE_NATIVE_INTERACTIVE_FIXTURE: '1', ...(failPlanned ? { SAVE_NATIVE_FAIL_FIRST_FIGURE: '1' } : {}) };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const proof = { directory, checks: [], errors: [], exits: [] }; let application, browser, page, exited;
let readingWorkerStarts = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms, label) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); };
async function until(read, accept, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await pause(50); }
  throw Error('Timed out: ' + label);
}
const pass = message => { proof.checks.push(message); console.log('PASS ' + message); };
const measureScrolling = reader => reader.evaluate(element => new Promise(resolve => {
  const gaps = []; let last, frame = 0; const start = element.scrollTop;
  const tick = now => {
    if (last !== undefined) gaps.push(now - last);
    last = now; element.scrollTop += 50;
    if (++frame < 90) requestAnimationFrame(tick);
    else { const distance = element.scrollTop - start; element.scrollTop = start;
      const sorted = gaps.slice().sort((a, b) => a - b);
      resolve({ distance, frames: gaps.length, p95FrameMs: sorted[Math.floor(sorted.length * .95)], maxFrameMs: Math.max(...gaps) }); }
  };
  requestAnimationFrame(tick);
}));
async function checkAgentOverlay(reader, label) {
  // A fixed DOM handle stays inspectable while the workspace is correctly inert.
  const host = await reader.elementHandle();
  const chunk = await host.$('.textbook-reading-chunk');
  const images = await host.$$('.textbook-reading-chunk img');
  const inspect = () => host.evaluate(element => {
    const viewport = element.getBoundingClientRect();
    const visible = [...element.querySelectorAll('.textbook-reading-chunk')].filter(chunk => {
      const bounds = chunk.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom && getComputedStyle(chunk).contentVisibility !== 'hidden';
    });
    const prose = visible.flatMap(chunk => [...chunk.querySelectorAll('h1,h2,h3,h4,p')].filter(node => !node.closest('.textbook-visual-gate')));
    const first = prose.find(node => { const bounds = node.getBoundingClientRect(); return bounds.bottom > viewport.top && bounds.top < viewport.bottom; });
    return { top: element.scrollTop, height: element.scrollHeight, width: element.clientWidth, visible: visible.length,
      first: first ? { text: first.textContent.slice(0, 80), offset: first.getBoundingClientRect().top - viewport.top } : undefined,
      text: prose.map(node => node.textContent).join('') };
  });
  const before = await inspect(); assert.ok(before.visible > 0, label);
  const dimensions = ({ text, ...geometry }) => ({ ...geometry, characters: text.length });
  const workerStarts = readingWorkerStarts;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
    await page.locator('.agent-orb[aria-expanded="true"]').waitFor();
    await pause(250);
    const opened = await inspect();
    const observation={label,before:dimensions(before),opened:dimensions(opened)};
    (proof.agentOverlays ||= []).push(observation);
    assert.ok(opened.visible > 0 && opened.text === before.text, `${label}: loaded prose must stay painted while Agent owns keyboard`);
    // Off-screen images/chunks may finish loading and adjust the total range.
    // The visible reading position and already displayed DOM must stay fixed.
    assert.ok(Math.abs(opened.top - before.top) <= 2 && opened.width === before.width
      && opened.first?.text === before.first?.text && Math.abs((opened.first?.offset || 0) - (before.first?.offset || 0)) <= 2,
      `${label}: Agent must not change the reading layout: ${JSON.stringify(observation)}`);
    await page.locator('.agent-panel textarea').waitFor();
    assert.ok(await chunk.evaluate(element => element.isConnected), 'opening Agent must retain the displayed formula/text DOM');
    for (const image of images) assert.ok(await image.evaluate(element => element.isConnected), 'opening Agent must not remount an already drawn image');
    if (attempt === 0) await page.screenshot({ path: path.join(directory, `${label}-agent-open.png`) });
    await page.locator('.agent-panel').getByRole('button', { name: '关闭学习助手', exact: true }).click();
    await page.getByRole('button', { name: '打开学习助手', exact: true }).waitFor();
    await pause(250);
    const closed = await inspect();
    assert.ok(closed.visible > 0 && closed.text === before.text && Math.abs(closed.top - before.top) <= 2, JSON.stringify({ label, before:dimensions(before),closed:dimensions(closed) }));
  }
  assert.equal(readingWorkerStarts, workerStarts, 'temporary overlay must not recreate document workers');
  await host.dispose(); await chunk.dispose(); for (const image of images) await image.dispose();
  pass(`${label}: opening/closing Agent retains visible prose/formulas, DOM identity and scroll position`);
}
async function readMiddle(reader, fraction = 0.5) {
  await reader.evaluate((element, fraction) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * fraction);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, fraction);
  await until(() => reader.evaluate(element => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll('.textbook-reading-chunk')].some(chunk => {
      const bounds = chunk.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom && getComputedStyle(chunk).contentVisibility !== 'hidden';
    });
  }), Boolean, 'middle textbook chunks prepared');
  await pause(350);
}
async function checkReadingNavigation() {
  const observations = [], activeReader = () => page.locator('.note-editor-shell:not([aria-hidden="true"]) .textbook-long-reader').last();
  const point = reader => reader.evaluate(element => {
    const viewport = element.getBoundingClientRect(), slots = [...element.querySelector('article.textbook-long-prose').children];
    const passed = slots.filter(slot => slot.getBoundingClientRect().top <= viewport.top + 10);
    const slot = passed.at(-1) || slots[0];
    const children = [...(slot.querySelector('.textbook-reading-chunk')?.children || [])];
    const passedChildren = children.filter(child => child.getBoundingClientRect().top <= viewport.top + 10);
    const child = passedChildren.at(-1) || children[0];
    const article = element.querySelector('article.textbook-long-prose'), base = article.getBoundingClientRect().top - viewport.top + element.scrollTop;
    const capturedSlot = slots.filter(slot => slot.offsetTop + base <= element.scrollTop + 10).at(-1) || slots[0];
    return { block: Number(slot.dataset.readingChunk), offset: Math.max(0, viewport.top - slot.getBoundingClientRect().top), top: element.scrollTop,
      element: child ? children.indexOf(child) : undefined, excerpt: child?.textContent?.slice(0, 32),
      captureGeometry: { block: capturedSlot.dataset.readingChunk, contentClass: capturedSlot.firstElementChild?.className, visibility: capturedSlot.firstElementChild?.style.contentVisibility,
        childCount: capturedSlot.firstElementChild?.children.length, slotOffset: capturedSlot.offsetTop, base, connected: element.isConnected, inert: !!element.closest('[inert]') } };
  });
  const ready = async reader => {
    await reader.waitFor();
    await until(() => reader.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll('.textbook-reading-chunk')].some(chunk => {
        const bounds = chunk.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom && getComputedStyle(chunk).contentVisibility !== 'hidden';
      });
    }), Boolean, 'restored viewport prepared');
    await pause(350);
  };
  const open = async title => { await page.getByTitle(`打开「${title}」`, { exact: true }).click(); const reader = activeReader(); await ready(reader); return reader; };
  const book = await open('导航验收教材'); await readMiddle(book, 0.4); const bookPoint = await point(book);
  const parseCount = readingWorkerStarts;
  const ordinary = await open('普通长文'); await readMiddle(ordinary, 0.6); const ordinaryPoint = await point(ordinary);
  for (let i = 0; i < 3; i++) {
    const a = await open('导航验收教材'); observations.push({ stage: `book-return-${i}`, expected: bookPoint, actual: await point(a), parses: readingWorkerStarts });
    const b = await open('普通长文'); observations.push({ stage: `ordinary-return-${i}`, expected: ordinaryPoint, actual: await point(b), parses: readingWorkerStarts });
  }
  await open('导航验收教材');
  let expected = bookPoint;
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '学习', exact: true }).click();
    await page.getByRole('button', { name: '打开项目：导航验收教材', exact: true }).click();
    await page.getByRole('dialog', { name: '准备进入心流？', exact: true }).getByRole('button', { name: '出发，开始学习', exact: true }).click();
    const flow = page.locator('.flow-mode-container .textbook-long-reader').last(); await ready(flow);
    observations.push({ stage: `flow-enter-${i}`, expected, actual: await point(flow), parses: readingWorkerStarts });
    await readMiddle(flow, i ? 0.35 : 0.65); expected = await point(flow);
    const analysis = page.locator('.focus-flow-analysis-control [role="switch"]');
    if (await analysis.getAttribute('aria-checked') === 'true') await analysis.click();
    await page.getByRole('button', { name: '退出并保存', exact: true }).click();
    await page.locator('.flow-mode-container').waitFor({ state: 'detached' });
    const noteReader = activeReader(); await ready(noteReader);
    observations.push({ stage: `flow-exit-${i}`, expected, actual: await point(noteReader), parses: readingWorkerStarts });
  }
  proof.navigation = { parseCount, finalParses: readingWorkerStarts, observations };
  proof.runtime = await page.evaluate(() => ({ url: location.href, scripts: [...document.scripts].map(script => script.src) }));
  for (const row of observations) assert.ok(row.actual.block === row.expected.block && row.actual.excerpt === row.expected.excerpt, JSON.stringify(row));
  assert.equal(readingWorkerStarts, parseCount, 'unchanged recently read documents should reuse their background parser across note/Flow navigation');
  for (const note of notes) assert.equal(await fs.readFile(path.join(state, 'vault/notes', note.id + '.md'), 'utf8'), note.content);
  pass('repeated note switches and Flow entry/exit reuse recent parsing, retain logical position and preserve every original body');
}
try {
  application = spawn(await prepareElectronRuntime(), ['--no-sandbox', '--remote-debugging-port=0', path.resolve('scripts/note-save-native-bootstrap.cjs')],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(resolve => application.once('exit', (code, signal) => resolve({ code, signal })));
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = ''; application.once('error', reject);
    application.once('exit', (code, signal) => reject(Error(`Electron 启动前退出（code=${code}, signal=${signal || 'none'}）${output ? `：${output.slice(-1200)}` : ''}`)));
    application.stderr.on('data', chunk => { output += chunk; void fs.appendFile(path.join(directory, 'native.log'), chunk);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u); if (match) resolve(match[1]); });
  }), 30000, 'Electron start');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => proof.errors.push(error.message));
  page.on('request', request => { if (request.url().includes('TextbookReader-')) (proof.readerModules ||= []).push(request.url()); });
  page.on('worker', worker => { if (worker.url().includes('readingDocumentWorker')) readingWorkerStarts++; });
  await page.getByRole('button', { name: '笔记', exact: true }).waitFor();
  await page.evaluate(() => {
    window.readingHeartbeat = { gaps: [], previous: performance.now() };
    window.readingHeartbeat.timer = setInterval(() => { const now = performance.now(); window.readingHeartbeat.gaps.push(now - window.readingHeartbeat.previous); window.readingHeartbeat.previous = now; }, 50);
  });
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  await page.getByTitle('打开「普通长文」', { exact: true }).click();
  if (process.argv.includes('--cold-overlay')) {
    // Switch identity and open Agent in the same browser task, before the
    // document's 180 ms settling delay can complete. Do not accidentally test
    // an already-loaded default note.
    await page.evaluate(() => {
      document.querySelector('[title="打开「短文材料」"]').click();
      document.querySelector('.agent-orb').click();
    });
    await page.locator('.agent-panel textarea').waitFor();
    await page.locator('[data-knowledge-maintenance-note="short-note"] .textbook-long-reader .katex').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(directory, 'cold-load-with-agent.png') });
    await page.locator('.agent-panel').getByRole('button', { name: '关闭学习助手', exact: true }).click();
    await page.getByTitle('打开「普通长文」', { exact: true }).click();
    pass('cold-open Agent before document settles still loads visible prose/formulas without transferring editor keyboard ownership');
  }
  const sourceShell = page.locator('.note-editor-shell:not([aria-hidden="true"])').last();
  const reader = sourceShell.locator('.textbook-long-reader');
  await reader.locator('.katex').first().waitFor();
  for (const kind of ['compare', 'steps', 'example', 'takeaway', 'warning', 'question', 'note']) await reader.locator(`.textbook-rich-${kind}`).waitFor();
  const themeColors = await reader.evaluate(element => {
    const root = document.documentElement, original = root.classList.contains('dark');
    const colors = () => ['takeaway', 'warning', 'example'].map(kind => getComputedStyle(element.querySelector(`.textbook-rich-${kind}`)).backgroundColor);
    root.classList.remove('dark'); const light = colors(); root.classList.add('dark'); const dark = colors();
    root.classList.toggle('dark', original); return { light, dark };
  });
  assert.ok(themeColors.light.every((value, index) => value !== themeColors.dark[index]), JSON.stringify(themeColors));
  assert.equal(await reader.locator('.textbook-rich-steps > ol').evaluate(element => getComputedStyle(element).listStyleType), 'none');
  await reader.locator('.textbook-diagram-svg img').first().waitFor({ timeout: 30000 });
  proof.initial = await reader.evaluate(element => ({
    formulaCount: element.querySelectorAll('.katex').length, diagrams: element.querySelectorAll('.textbook-diagram-svg img').length,
    totalChunks: element.querySelectorAll('[data-reading-chunk]').length, mountedChunks: element.querySelectorAll('.textbook-reading-chunk').length,
    farDiagramPresent: element.innerText.includes('远处图示'),
  }));
  assert(proof.initial.formulaCount >= 2);
  assert.equal(proof.initial.diagrams, 1); assert.equal(proof.initial.farDiagramPresent, false);
  assert(proof.initial.mountedChunks < proof.initial.totalChunks / 2);
  proof.maxHeartbeatGapMs = await page.evaluate(() => { clearInterval(window.readingHeartbeat.timer); return Math.max(...window.readingHeartbeat.gaps); });
  assert(proof.maxHeartbeatGapMs < 1000, 'ordinary six-node reading must not freeze the UI for a full second');
  proof.scrolling = await measureScrolling(reader);
  assert(proof.scrolling.distance > 1000, 'continuous scroll traverses the document');
  assert(proof.scrolling.maxFrameMs < 1000, 'continuous scroll must not freeze for a full second');
  await reader.locator('.textbook-rich-compare').waitFor();
  await page.screenshot({ path: path.join(directory, 'long-note-reading-restored.png') });
  pass('ordinary long-note reading renders rich comparison/steps/examples, inline/display formulas and Mermaid while far chunks remain unmounted');
  if (process.argv.includes('--navigation-regression')) {
    await checkReadingNavigation();
    await page.evaluate(() => window.readingNativeTest.command({ op: 'close' }));
    const exit = await bounded(exited, 20000, 'native navigation close'); assert.equal(exit.code, 0); proof.exits.push(exit);
    assert.deepEqual(proof.errors, []); proof.ok = true;
  } else {
  await checkAgentOverlay(reader, 'long-note');
  if (process.argv.includes('--overlay-regression')) {
    await page.getByTitle('打开「短文材料」', { exact: true }).click();
    const book = page.locator('.note-editor-shell:not([aria-hidden="true"])').last().locator('.textbook-long-reader');
    await book.locator('.katex').first().waitFor();
    await checkAgentOverlay(book, 'textbook-note');
    await readMiddle(book);
    await checkAgentOverlay(book, 'textbook-note-middle');
    await readMiddle(book, 0);
    await page.getByRole('button',{name:'学习',exact:true}).click();
    await page.getByRole('button',{name:'打开项目：短文材料',exact:true}).click();
    await page.getByRole('dialog',{name:'准备进入心流？',exact:true}).getByRole('button',{name:'出发，开始学习',exact:true}).click();
    const flowReader=page.locator('.flow-mode-container .textbook-long-reader, .flow-mode-container .textbook-reader').last();
    await flowReader.locator('.katex').first().waitFor();
    await checkAgentOverlay(flowReader, 'textbook-flow');
    await readMiddle(flowReader);
    await checkAgentOverlay(flowReader, 'textbook-flow-middle');
    await page.getByRole('button',{name:'退出并保存',exact:true}).click();
    for (const note of notes) assert.equal(await fs.readFile(path.join(state,'vault/notes',note.id+'.md'),'utf8'),note.content);
    pass('Agent overlay checks leave ordinary note/textbook content unchanged');
    assert.deepEqual(proof.errors, []); proof.status='passed'; proof.ok=true;
    await page.evaluate(() => window.readingNativeTest.command({ op: 'close' }));
    const exit=await bounded(exited, 20000, 'native overlay check close'); proof.exits.push(exit); assert.equal(exit.code,0);
    process.exitCode=0;
  } else {

  await sourceShell.getByRole('button', { name: '编辑笔记与复盘', exact: true }).click();
  assert.equal(await sourceShell.getByRole('group', { name: '长文编辑方式' }).count(), 0, 'no duplicate editing mode row');
  const sourceEditor = sourceShell.getByRole('textbox', { name: '长文 Markdown 编辑器' });
  await sourceEditor.waitFor(); await sourceEditor.click(); await page.keyboard.press('Control+End');
  const sourceCdp = await page.context().newCDPSession(page);
  await sourceEditor.evaluate(element => { window.__sourceImeEvents = []; for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) element.addEventListener(type, event => window.__sourceImeEvents.push({ type, data: event.data })); });
  await sourceCdp.send('Input.imeSetComposition', { text: 'shuru', selectionStart: 5, selectionEnd: 5 });
  const sourceImeStart = await page.evaluate(() => window.__sourceImeEvents);
  assert.ok(sourceImeStart.some(event => event.type === 'compositionstart'), JSON.stringify({ sourceImeStart, focus: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250)) }));
  await sourceShell.getByRole('button', { name: '切换到富文本编辑', exact: true }).click();
  assert.equal(await sourceEditor.isVisible(), true, 'switching cannot discard an active IME composition: ' + JSON.stringify(await page.evaluate(() => window.__sourceImeEvents)));
  await sourceCdp.send('Input.insertText', { text: '合成输入' });
  await until(() => sourceEditor.innerText(), value => value.includes('合成输入'), 'IME composition committed');
  await page.keyboard.press('Control+z');
  await until(() => sourceEditor.innerText(), value => !value.includes('合成输入'), 'undo IME fixture');
  await sourceCdp.detach();
  await page.keyboard.type('MODE_SWITCH_FIXTURE');
  await sourceShell.getByRole('button', { name: '切换到富文本编辑', exact: true }).click();
  await sourceShell.getByRole('button', { name: '切换到 Markdown 编辑', exact: true }).waitFor({ timeout: 60000 });
  await sourceShell.getByRole('button', { name: '切换到 Markdown 编辑', exact: true }).click();
  await sourceEditor.waitFor(); await sourceEditor.click(); await page.keyboard.press('Control+End');
  assert.ok((await sourceEditor.innerText()).includes('MODE_SWITCH_FIXTURE'), 'latest source survives both mode changes');
  await page.keyboard.press('Control+z');
  await until(() => sourceEditor.innerText(), value => !value.includes('MODE_SWITCH_FIXTURE'), 'source editor undo after switching');
  await sourceShell.getByRole('button', { name: '阅读笔记', exact: true }).click();
  await reader.locator('.textbook-rich-compare').waitFor();
  pass('single toolbar mode switch preserves current long-note text and source undo');

  await reader.getByRole('link', { name: '关联原笔记', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '参考笔记', exact: true });
  await preview.getByRole('heading', { name: '定义', exact: true }).waitFor();
  await preview.getByRole('button', { name: '打开编辑', exact: true }).click();
  let reference = page.locator('.context-note-page[aria-hidden="false"]');
  await until(() => reference.getAttribute('data-context-note-id'), value => value === 'target-note', 'original wiki target ID');
  await until(() => reference.getByRole('heading', { name: '定义', exact: true }).evaluate(element => {
    const rect = element.getBoundingClientRect(); return rect.top >= 100 && rect.top < innerHeight - 40;
  }), Boolean, 'chapter visible');
  await page.getByRole('button', { name: '关闭引用笔记，返回普通长文', exact: true }).click();
  pass('a long-note wiki alias opens the original note ID and preserves its heading destination');

  await reader.getByRole('link', { name: '末尾阅读', exact: true }).click();
  await until(() => reader.getByRole('heading', { name: '末尾', exact: true }).evaluate(element => {
    const rect = element.getBoundingClientRect(); return rect.top >= 100 && rect.top < innerHeight - 40;
  }).catch(() => false), Boolean, 'same-note distant heading');
  await reader.locator('.textbook-diagram-svg img').first().waitFor({ timeout: 30000 });
  await until(() => reader.locator('.textbook-diagram-svg img').evaluateAll(async images => (await Promise.all(images.map(async image => image.complete && image.naturalWidth > 0
    ? (await (await fetch(image.src)).text()).includes('远处图示') : false))).some(Boolean)), Boolean, 'distant diagram loads');
  await page.screenshot({ path: path.join(directory, 'distant-diagram-on-demand.png') });
  pass('same-note heading navigation loads the distant virtual chunk and only then renders its diagram');

  await page.getByTitle('打开「短文材料」', { exact: true }).click();
  const noteShell = page.locator('.note-editor-shell:not([aria-hidden="true"])').last();
  await noteShell.locator('.textbook-rich-takeaway').waitFor();
  await page.evaluate(() => {
    window.__noteTeachingExport = '';
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download.endsWith('-教材.zip')) return click.call(this);
      fetch(this.href).then(response => response.blob()).then(blob => {
        const reader = new FileReader(); reader.onload = () => { window.__noteTeachingExport = String(reader.result); }; reader.readAsDataURL(blob);
      });
    };
  });
  const [, exportScroll] = await Promise.all([
    noteShell.getByRole('button', { name: '导出教材', exact: true }).click(),
    measureScrolling(noteShell.locator('.textbook-long-reader')),
  ]);
  assert.ok(exportScroll.distance > 1000 && exportScroll.maxFrameMs < 1000, JSON.stringify(exportScroll));
  const noteExport = await until(() => page.evaluate(() => window.__noteTeachingExport), value => typeof value === 'string' && value.startsWith('data:'), 'note-page teaching export');
  const noteFiles = unzipSync(new Uint8Array(Buffer.from(noteExport.split(',')[1], 'base64')));
  assert.ok(noteFiles['教材.md'] && noteFiles['教材.html']);
  assert.ok(strFromU8(noteFiles['教材.html']).includes('textbook-rich-takeaway'));
  assert.ok(noteFiles['assets/material-1.png']);
  assert.ok(strFromU8(noteFiles['教材.md']).includes('assets/material-1.png'));
  const noteHtml = strFromU8(noteFiles['教材.html']);
  assert.ok(noteHtml.includes('data:image/png;base64,') && noteHtml.includes('合成资料原图'));
  const svgSources = [...noteHtml.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/gu)].map(match => Buffer.from(match[1], 'base64').toString('utf8'));
  assert.ok(svgSources.length >= 4, `expected Mermaid, plot, chart and molecule; got ${svgSources.length}`);
  assert.ok(svgSources.some(svg => svg.includes('textbook-riemann-rectangle')), 'exported function diagram includes Riemann rectangles');
  assert.ok(noteHtml.includes('science-svg') && noteHtml.includes('教学示意 · 非实测图'));
  await fs.writeFile(path.join(directory, 'offline-export.html'), noteHtml);
  const offline = await page.evaluate(() => window.readingNativeTest.command({ op: 'inspect-offline-export' }));
  assert.ok(offline.svg >= 4 && offline.png >= 1 && offline.failed === 0 && offline.scripts === 0, JSON.stringify(offline));
  pass('note-page export includes styled HTML and portable Markdown without changing the textbook');

  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('button', { name: '打开项目：短文材料', exact: true }).click();
  await page.getByRole('dialog', { name: '准备进入心流？', exact: true }).getByRole('button', { name: '出发，开始学习', exact: true }).click();
  const shortReader = page.locator('.focus-flow-note-preview');
  await shortReader.locator('.katex').first().waitFor();
  const repairedMath = await shortReader.locator('annotation').allTextContents();
  assert.ok(repairedMath.includes(String.raw`\xi\in(a,b)`));
  assert.ok(!repairedMath.includes(String.raw`\\xi\\in(a,b)`));
  for (const kind of ['compare', 'steps', 'example', 'takeaway', 'warning', 'question', 'note']) await shortReader.locator(`.textbook-rich-${kind}`).waitFor();
  assert.equal(await shortReader.locator('.textbook-rich-steps > ol').evaluate(element => getComputedStyle(element).listStyleType), 'none');
  await shortReader.locator('.textbook-chart-canvas img').waitFor({ timeout: 30000 });
  proof.flowScrolling = await measureScrolling(shortReader);
  assert(proof.flowScrolling.distance > 1000, 'Flow continuous scroll traverses the textbook');
  assert(proof.flowScrolling.maxFrameMs < 1000, 'Flow reading must not freeze for a full second');
  await shortReader.locator('.textbook-rich-compare').waitFor();
  await page.screenshot({ path: path.join(directory, 'flow-rich-layout.png') });
  if (failPlanned) {
    const failed = page.locator('.focus-flow-unfinished-figures');
    await failed.waitFor();
    assert.equal(await page.locator('.focus-flow-side-resources').getByRole('button', { name: /打开交互探索/ }).count(), 0, 'failed planned figures are not counted as resources');
    await failed.locator('summary').click();
    await failed.getByRole('button', { name: /清理失败记录/ }).click();
    await failed.waitFor({ state: 'detached' });
    const sidecars = await fs.readdir(path.join(state, 'user-state/interactive-figures'));
    const tombstone = JSON.parse(await fs.readFile(path.join(state, 'user-state/interactive-figures', sidecars[0]), 'utf8'));
    assert.equal(tombstone.status, 'dismissed');
    pass('failed planned figure is excluded from resources and clearing it keeps a non-retrying tombstone');
  }
  await shortReader.getByRole('button', { name: '打开交互探索', exact: true }).click();
  await page.getByRole('tab', { name: /^交互探索：/ }).waitFor();
  if (failPlanned) { await page.getByRole('button', { name: '单独重试交互图', exact: true }).click(); }
  const getFigure = () => page.evaluate(() => window.readingNativeTest.command({ op: 'figure-inspect' }));
  await until(getFigure, value => value.found && value.value === '4', 'generated figure tab');
  await page.evaluate(() => window.readingNativeTest.command({ op: 'figure-adjust' }));
  await page.getByRole('tab', { name: '当前笔记', exact: true }).click();
  await until(getFigure, value => value.found && !value.visible, 'figure hidden');
  await shortReader.locator('.textbook-rich-compare').waitFor();
  await page.getByRole('tab', { name: /^交互探索：/ }).click();
  await until(getFigure, value => value.found && value.visible && value.value === '49', 'figure state restored');
  proof.figureImage = await page.evaluate(() => window.readingNativeTest.command({ op: 'figure-capture' }));
  assert(proof.figureImage.width > 200 && proof.figureImage.height > 200, 'visible native guest produces a real image');
  await page.screenshot({ path: path.join(directory, 'flow-interactive-figure.png') });
  assert.equal((await getFigure()).calls, expectedFigureCalls, 'opening and switching do not regenerate the attachment');
  await page.getByRole('button', { name: '模型复核（额外请求）', exact: true }).click();
  await page.getByText('合成问题：核对图与说明是否一致。', { exact: false }).waitFor();
  assert.equal((await getFigure()).calls, expectedFigureCalls, 'a review does not regenerate the figure');
  await page.evaluate(() => {
    window.__teachingExport = '';
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download.endsWith('-教材.zip')) return click.call(this);
      fetch(this.href).then(response => response.blob()).then(blob => {
        const reader = new FileReader(); reader.onload = () => { window.__teachingExport = String(reader.result); }; reader.readAsDataURL(blob);
      });
    };
  });
  await page.getByRole('button', { name: '导出教材', exact: true }).click();
  const exported = await until(() => page.evaluate(() => window.__teachingExport), value => typeof value === 'string' && value.startsWith('data:'), 'teaching export');
  const exportFiles = unzipSync(new Uint8Array(Buffer.from(exported.split(',')[1], 'base64')));
  const exportedMarkdown = strFromU8(exportFiles['教材.md']);
  assert.ok(exportedMarkdown.includes('[打开离线交互图](figures/figure-1.html)'));
  const exportedHtml = strFromU8(exportFiles['教材.html']);
  assert.ok(exportedHtml.includes('textbook-rich-compare') && exportedHtml.includes('figures/figure-1.html'));
  assert.ok(exportedHtml.includes('<math') && exportedHtml.includes("default-src 'none'"));
  assert.ok(exportedHtml.includes('data:image/png;base64,') && exportedHtml.includes('data:image/svg+xml;base64,'));
  assert.ok(strFromU8(exportFiles['figures/figure-1.html']).includes('sandbox="allow-scripts"'));
  assert.ok(exportFiles['figures/ANATOMY-LICENSE.txt']);
  const offlineShare = path.join(directory, 'offline-share');
  await fs.mkdir(path.join(offlineShare, 'figures'), { recursive:true });
  await fs.writeFile(path.join(offlineShare, '教材.html'), exportFiles['教材.html']);
  await fs.writeFile(path.join(offlineShare, '教材.md'), exportFiles['教材.md']);
  await fs.writeFile(path.join(offlineShare, 'figures', 'figure-1.html'), exportFiles['figures/figure-1.html']);
  await fs.writeFile(path.join(offlineShare, 'figures', 'ANATOMY-LICENSE.txt'), exportFiles['figures/ANATOMY-LICENSE.txt']);
  const offlineFigure = await page.evaluate(() => window.readingNativeTest.command({ op:'inspect-offline-figure' }));
  assert.equal(offlineFigure.linked, true); assert.equal(offlineFigure.value, '49'); assert.ok(offlineFigure.svg > 0 && offlineFigure.math > 0);
  assert.equal(offlineFigure.node, 'undefined'); assert.equal(offlineFigure.bridge, 'undefined'); assert.equal(offlineFigure.blocked, 0);
  assert.equal((await getFigure()).calls, expectedFigureCalls, 'export reads the saved figure without another generation');
  pass('explicit teaching review and Markdown ZIP export work without regenerating the figure; exported link opens a working sandboxed figure offline');
  await page.getByRole('button', { name: '关闭交互探索', exact: true }).click();
  await until(getFigure, value => !value.found, 'figure closed');
  await shortReader.locator('.textbook-rich-compare').waitFor();
  const storedFigures = await fs.readdir(path.join(state, 'user-state/interactive-figures'));
  assert.equal(storedFigures.filter(name => name.endsWith('.json')).length, 1);
  const savedFigure = JSON.parse(await fs.readFile(path.join(state, 'user-state/interactive-figures', storedFigures[0]), 'utf8'));
  assert.equal(savedFigure.status, 'ready'); assert.ok(savedFigure.html.includes('平方函数探索'));
  pass('generated interactive tab preserves state when switching, closes cleanly and does not repeat the model call');
  await shortReader.getByRole('button', { name: '查看来源 N1：参考笔记', exact: true }).click();
  await page.getByRole('button', { name: '打开知识点', exact: true }).click();
  reference = page.locator('.context-note-page[aria-hidden="false"]');
  await until(() => reference.getAttribute('data-context-note-id'), value => value === 'target-note', 'Flow short wiki original target');
  await reference.getByRole('heading', { name: '定义', exact: true }).waitFor();
  pass('the long legacy textbook Flow branch displays rich blocks/formulas/background charts, scrolls continuously and opens the authorized original knowledge note');

  const figurePid = await page.evaluate(async () => {
    const figure = window.electronAPI?.interactiveFigure;
    if (!figure) throw Error('missing isolated figure bridge');
    const opened = await figure.open({ html: '<p>合成交互图</p><input type="range">', bounds: { x: 350, y: 100, width: 320, height: 240 } });
    await figure.visible(false); await figure.visible(true); await figure.close();
    return opened.processId;
  });
  assert(Number.isInteger(figurePid) && figurePid > 0);
  pass('production preload/IPC opens, hides, restores and closes a sandboxed interactive guest');

  // Focus mode intentionally hides the app titlebar; close the same native
  // BrowserWindow through the test host rather than looking for a hidden button.
  await page.evaluate(() => window.readingNativeTest.command({ op: 'close' }));
  proof.exits.push(await bounded(exited, 30000, 'native close'));
  assert.deepEqual(proof.exits, [{ code: 0, signal: null }]);
  const saved = Object.values(JSON.parse(await fs.readFile(path.join(state, 'vault/metadata.json'), 'utf8')).notesMeta);
  assert.equal(saved.length, notes.length);
  for (const note of notes) assert.equal(await fs.readFile(path.join(state, 'vault/notes', note.id + '.md'), 'utf8'), note.content);
  assert.deepEqual(proof.errors, []); proof.ok = true;
  pass('reading and navigation preserve every original note ID and exact body after native close');
  }
  }
} catch (error) {
  proof.error = String(error.stack || error);
  if (page) { proof.body = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); }
  throw error;
} finally {
  if (application?.exitCode === null) {
    await page?.evaluate(() => window.readingNativeTest.command({ op: 'close' })).catch(() => {});
    await bounded(exited, 3000, 'cleanup').catch(() => {});
  }
  if (application?.exitCode === null) application.kill();
  await browser?.close().catch(() => {});
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(proof, null, 2));
  console.log('Plain reading native proof: ' + directory);
}


