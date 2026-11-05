/** Production legacy Flow regression, isolated vault and blocked cloud calls.
 * FLOW_LEGACY_VAULT optionally reads ONE published teaching region locally;
 * private drafts, review history, provider settings and source files are omitted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { prepareElectronRuntime } from './start-electron.mjs';
import { readTextbookBody, writeTextbookRegion } from '../src/services/textbook/noteContent.ts';
import { coldVisualBody, installColdWorkerProbe, runColdReadingScenario } from './cold-reading-scenario.mjs';

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'flow-diagnostic.cjs'))('playwright');
const root = await fsp.mkdtemp(path.resolve('build/flow-legacy-performance-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
await fsp.mkdir(appRoot, { recursive: true });
await fsp.mkdir(path.join(state, 'vault/notes'), { recursive: true });
await fsp.mkdir(path.join(state, 'user-state'), { recursive: true });
const at = '2026-11-01T00:00:00Z', id = 'legacy-perf';
let manifest = { schemaVersion: 1, textbookId: 'legacy-book', projectNoteId: id, rootProjectId: 'legacy-root', regionId: 'legacy-region', revisionId: 'legacy-v1', createdAt: at, updatedAt: at };
let body = '# 函数与极限\n\n' + Array.from({ length: 65 }, (_, i) => `## 概念 ${i + 1}\n\n函数 $f(x)=x^2$ 把每个输入对应到唯一输出。$x\\to x_0$ 研究变化趋势，$\\lim_{x\\to 0}f(x)=0$ 不是函数在该点的值。`).join('\n\n');
body += '\n\n```mermaid\nflowchart TD\nA[函数]-->B[极限]\nB-->C[导数]\nB-->D[积分]\n```\n';
const cold = process.env.FLOW_LEGACY_COLD === '1';
if (cold) body = coldVisualBody + body + '\n\n' + Array.from({ length: 40 }, (_, index) =>
  `## 回看缓存 ${index + 1}\n\n${'这一段用于验证已读内容在缓存淘汰后仍能在滚动中恢复，保留上下文与阅读顺序。'.repeat(12)}`).join('\n\n');
const external = process.env.FLOW_LEGACY_VAULT;
if (external) {
  const metas = JSON.parse(await fsp.readFile(path.join(external, 'metadata.json'), 'utf8')).notesMeta;
  const source = Object.values(metas).find(note => note.id === process.env.FLOW_LEGACY_NOTE_ID);
  assert.ok(source?.textbook, 'explicit published textbook note');
  body = readTextbookBody(await fsp.readFile(path.join(external, 'notes', source.id + '.md'), 'utf8'), source.textbook);
  assert.ok(body?.trim(), 'valid managed teaching region');
  manifest = { ...source.textbook, projectNoteId: id, rootProjectId: 'legacy-root' };
}
const assetRoot = process.env.FLOW_LEGACY_ASSET_ROOT;
let expectedImages = 0;
if (assetRoot) {
  // Only immutable image attachments actually embedded in this teaching body.
  // Never copy/enumerate other documents, indexes or private notes.
  const used = new Set([...body.matchAll(/^```textbook-image\s*\n([\s\S]*?)\n```/gmu)].map(hit => JSON.parse(hit[1]).assetId));
  const assets = (manifest.assets || []).filter(asset => used.has(asset.id));
  expectedImages = new Set(assets.map(asset => asset.attachmentHash)).size;
  await fsp.mkdir(path.join(state, 'textbook-assets'), { recursive: true });
  for (const asset of assets) {
    assert.match(asset.attachmentHash || '', /^[a-f0-9]{64}$/u);
    const identity = JSON.stringify([asset.docId, asset.version, asset.blockId, asset.imageIndex]);
    const name = `${createHash('sha256').update(identity).digest('hex')}-${asset.attachmentHash}.json`;
    const source = path.join(assetRoot, 'textbook-assets', name), info = await fsp.lstat(source);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1_500_000);
    await fsp.copyFile(source, path.join(state, 'textbook-assets', name));
  }
  console.log(JSON.stringify({ copiedReferencedImages: assets.length }));
}
const common = { noteType: 'project', projectRole: 'learning', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const parent = { ...common, id: 'legacy-root', title: '旧教材阅读隔离验收', content: '', planMeta: { status: 'active', dailyStudyMinutes: 30 } };
const note = writeTextbookRegion({ ...common, id, title: '旧教材阅读性能', parentId: parent.id, content: '# 学习目标\n理解函数与极限。' }, body, manifest);
const notesMeta = {};
for (const { content, ...meta } of [parent, note]) {
  notesMeta[meta.id] = meta;
  await fsp.writeFile(path.join(state, 'vault/notes', meta.id + '.md'), content);
}
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, fontSize: 16, autoAiSegment: false } }));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'legacy-flow-performance', version: '1.0.10' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('dist-electron'), path.join(appRoot, 'dist-electron'), 'junction');
await fsp.writeFile(path.join(root, 'test-control-preload.cjs'), "require('electron').contextBridge.exposeInMainWorld('legacyProbe',{show:()=>require('electron').ipcRenderer.invoke('legacy-test:show'),windows:()=>require('electron').ipcRenderer.invoke('legacy-test:windows'),stall:()=>require('electron').ipcRenderer.invoke('legacy-test:stall'),releaseDrawing:()=>require('electron').ipcRenderer.invoke('legacy-test:release-drawing')});");
const bootstrap = path.join(root, 'bootstrap.cjs');
await fsp.writeFile(bootstrap, `globalThis.fetch=async()=>{throw Error('Cloud disabled in isolated legacy regression');};
const fs=require('node:fs'),{ipcMain,utilityProcess,BrowserWindow}=require('electron'),{EventEmitter}=require('node:events');
const log=entry=>fs.appendFileSync(${JSON.stringify(path.join(root, 'ipc.jsonl'))},JSON.stringify({...entry,at:Date.now()})+'\\n');
let drawingOpen=${!cold},ready=[];const originalOn=ipcMain.on.bind(ipcMain);ipcMain.on=(channel,handler)=>originalOn(channel,channel==='mermaid-worker:ready'?function(...args){if(drawingOpen)handler(...args);else ready.push(()=>handler(...args));}:handler);
ipcMain.handle('legacy-test:release-drawing',event=>{drawingOpen=true;ready.splice(0).forEach(run=>run());const target=require('electron').webContents.getAllWebContents().find(contents=>contents.getURL().includes('mermaid-renderer.html'));if(!target)throw Error('drawing not ready');return {mainPid:event.sender.getOSProcessId(),drawingPid:target.getOSProcessId(),nativeWindow:Boolean(BrowserWindow.fromWebContents(target))};});
ipcMain.handle('legacy-test:show',event=>{const win=BrowserWindow.fromWebContents(event.sender);win.show();win.focus();return {visible:win.isVisible(),bounds:win.getBounds()};});
const setEnabled=BrowserWindow.prototype.setEnabled;BrowserWindow.prototype.setEnabled=function(value){log({windowEnabled:this.id,value,stack:new Error().stack});return setEnabled.call(this,value);};
ipcMain.handle('legacy-test:windows',()=>BrowserWindow.getAllWindows().map(win=>({id:win.id,enabled:win.isEnabled(),visible:win.isVisible(),focusable:win.isFocusable(),focused:win.isFocused(),url:win.webContents.getURL().includes('mermaid-renderer')?'diagram':'main',bounds:win.getBounds()})));
ipcMain.handle('legacy-test:stall',event=>{const target=require('electron').webContents.getAllWebContents().find(contents=>contents.getURL().includes('mermaid-renderer.html'));if(!target)throw Error('No independent diagram contents');const result={mainPid:event.sender.getOSProcessId(),diagramPid:target.getOSProcessId(),nativeWindow:Boolean(BrowserWindow.fromWebContents(target))};void target.executeJavaScript('(()=>{const until=performance.now()+20000;while(performance.now()<until){};return true;})()').catch(()=>{});return result;});
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>log({compute:message.operation});worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true;};return worker;};
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(...args)=>{if(channel.startsWith('llm:')){log({unexpectedModel:channel});throw Error('No model calls allowed');}if(channel==='progressive-learning:command')log({progressiveOp:args[1]?.op});return handler(...args);});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const logFile = path.join(root, 'process.log'), fd = fs.openSync(logFile, 'w');
const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, LOGINOTE_SAVE_NATIVE_PACKAGE: appRoot, SAVE_NATIVE_GPU: '1' };
if (process.env.FLOW_LEGACY_WHEEL === '1') env.SAVE_NATIVE_REAL_DIALOG = '1';
if (process.env.FLOW_LEGACY_GPU === '0') env.SAVE_NATIVE_GPU = '0';
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(await prepareElectronRuntime(), [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const proof = { root, mode: external ? 'local-readonly-teaching-copy' : 'synthetic', characters: body.length, errors: [], checks: [], timings: [] };
const bounded = (promise, label, ms = 10000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); };
let browser, page, cdp;
let tracing = false;
async function stopTrace() {
  if (!tracing) return;
  tracing = false;
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await bounded(complete, 'trace-complete', 10000);
  const chunks = [];
  for (;;) {
    const part = await cdp.send('IO.read', { handle: stream });
    chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
    if (part.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  await fsp.writeFile(path.join(root, 'trace.json'), Buffer.concat(chunks));
}
console.log(JSON.stringify({ root, pid: child.pid, characters: body.length }));
try {
  let endpoint;
  for (let i = 0; i < 200; i++) {
    endpoint = (await fsp.readFile(logFile, 'utf8')).match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
    if (endpoint) break;
    if (child.exitCode !== null) throw Error('Electron exited: ' + child.exitCode);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(endpoint);
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(10000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.getByRole('button', { name: '学习', exact: true }).waitFor({ timeout: 45000 });
  if (cold) await installColdWorkerProbe(page);
  if (process.env.FLOW_LEGACY_RETAIN_EDITOR === '1') {
    await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.locator('.note-tree-open').filter({ hasText: parent.title }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 800));
    const toggle = page.locator('.note-tree-row').filter({ has: page.locator('.note-tree-open').filter({ hasText: parent.title }) }).locator('.note-tree-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.locator('.note-tree-open,.note-leaf-open').filter({ hasText: note.title }).click();
    await page.getByRole('textbox', { name: '笔记标题', exact: true }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  await page.evaluate(() => {
    window.legacyPerf = { tasks: [], gaps: [], start: performance.now() };
    window.legacyImagesDecoded = new Set();
    document.addEventListener('load', event => { if (event.target instanceof HTMLImageElement && event.target.matches('.focus-flow-note-preview .textbook-image img')) window.legacyImagesDecoded.add(event.target.src); }, true);
    new PerformanceObserver(list => window.legacyPerf.tasks.push(...list.getEntries().map(e => ({ at: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: false });
    let prior = performance.now(); const frame = now => { window.legacyPerf.gaps.push(now - prior); prior = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  });
  cdp = await page.context().newCDPSession(page);
  if (process.env.FLOW_LEGACY_TRACE === '1') {
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
    tracing = true;
  }
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await page.getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('button', { name: '进入心流', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click();
  await page.getByRole('button', { name: '退出并保存', exact: true }).waitFor();
  console.log('Flow opened');
  if (process.env.FLOW_LEGACY_WHEEL === '1' || process.env.FLOW_LEGACY_PREVIEW === '1') console.log(JSON.stringify({ shownWindow: await page.evaluate(() => window.legacyProbe.show()) }));
  if (cold) {
    await runColdReadingScenario({ page, cdp, root, proof, bounded }); await stopTrace();
  } else {
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (process.env.FLOW_LEGACY_PREVIEW === '1') {
    await cdp.send('Profiler.stop');
    await page.waitForFunction(() => document.querySelectorAll('.focus-flow-note-preview .textbook-reading-slot').length > 9);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate(() => {
        const reader = document.querySelector('.focus-flow-note-preview'), target = reader.querySelector('[data-reading-chunk="9"]');
        reader.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 400;
      });
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    await page.evaluate(() => {
      window.flowInputPreview = { events: [] };
      for (const name of ['pointerdown', 'pointerup', 'click', 'wheel']) document.addEventListener(name, event => {
        const target = event.target;
        const record = { name, at: performance.now(), target: target.tagName, className: String(target.className?.baseVal ?? target.className ?? ''),
          inert: Boolean(target.closest?.('[inert]')), prevented: false };
        window.flowInputPreview.events.push(record); if (window.flowInputPreview.events.length > 80) window.flowInputPreview.events.shift();
        setTimeout(() => { record.prevented = event.defaultPrevented; }, 0);
      }, { capture: true, passive: true });
    });
    await fsp.writeFile(path.join(root, 'preview-ready.json'), JSON.stringify({ root, endpoint, pid: child.pid }));
    console.log('MANUAL_PREVIEW_READY ' + root);
    for (let tick = 0; tick < 240 && child.exitCode === null && !fs.existsSync(path.join(root, 'resume')); tick++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (tick % 3 !== 0) continue;
      const state = await bounded(page.evaluate(async () => ({ events: window.flowInputPreview.events,
        windows: await window.legacyProbe.windows(), inert: [...document.querySelectorAll('[inert]')].map(node => ({ className: String(node.className), visible: node.getClientRects().length > 0 })),
        modals: [...document.querySelectorAll('dialog[open]')].map(node => ({ visible: node.getClientRects().length > 0, className: node.className })),
        buttons: ['暂停计时', '继续计时', '退出并保存'].flatMap(label => [...document.querySelectorAll('button')].filter(button => button.title === label || button.textContent.trim() === label).map(button => {
          const box = button.getBoundingClientRect(), top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { label, hit: button.contains(top), inert: Boolean(button.closest('[inert]')), disabled: button.disabled };
        })) })), 'manual-preview-state', 3000).catch(error => ({ error: error.message }));
      await fsp.writeFile(path.join(root, 'preview-input.json'), JSON.stringify(state, null, 2));
    }
    if (child.exitCode === null) child.kill(); await browser.close().catch(() => {}); fs.closeSync(fd);
    console.log('MANUAL_PREVIEW_FINISHED ' + root); process.exit(0);
  }
  await page.evaluate(() => { window.legacyPerf.tasks = []; window.legacyPerf.gaps = []; window.legacyPerf.start = performance.now(); });
  if (process.env.FLOW_LEGACY_WHEEL === '1') {
    await page.locator('.focus-flow-note-preview').hover();
    await page.evaluate(() => {
      window.legacyMutations = { count: 0, maxBatch: 0 };
      window.legacyWheelEvents = [];
      window.addEventListener('wheel', event => {
        const path = event.composedPath().slice(0, 6).map(node => node.tagName + '.' + String(node.className?.baseVal ?? node.className ?? ''));
        setTimeout(() => window.legacyWheelEvents.push({ prevented: event.defaultPrevented, path }), 0);
      }, { capture: true, passive: true });
      new MutationObserver(entries => { window.legacyMutations.count += entries.length; window.legacyMutations.maxBatch = Math.max(window.legacyMutations.maxBatch, entries.length); })
        .observe(document.querySelector('.focus-flow-note-preview'), { childList: true, subtree: true });
    });
    proof.trustedWheel = [];
    for (let step = 0; step < 160; step++) {
      await bounded(page.mouse.wheel(0, step < 110 ? 110 : step < 135 ? -120 : 120), 'trusted-wheel-' + step, 4000);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (step % 5 !== 0) continue;
      const metrics = await bounded(page.evaluate(() => {
        const reader = document.querySelector('.focus-flow-note-preview');
        return { top: reader.scrollTop, height: reader.scrollHeight, nodes: reader.querySelectorAll('*').length,
          mounted: reader.querySelectorAll('.textbook-reading-chunk').length,
          diagrams: reader.querySelectorAll('.textbook-diagram-svg img').length,
          images: reader.querySelectorAll('.textbook-image img').length, mutations: { ...window.legacyMutations },
          tasks: window.legacyPerf.tasks.slice(-5), maxGap: Math.max(0, ...window.legacyPerf.gaps), wheel: window.legacyWheelEvents.slice(-1) };
      }), 'trusted-wheel-metrics-' + step, 4000);
      const windows = await bounded(page.evaluate(() => window.legacyProbe.windows()), 'window-enabled-' + step, 3000);
      proof.trustedWheel.push({ step, ...metrics, windows }); console.log(JSON.stringify({ trustedWheel: step, ...metrics, windows }));
      if (windows.some(win => win.url === 'main' && !win.enabled)) {
        proof.inputBlocker = { step, windows };
        throw Error('Main native window was disabled while reading');
      }
      if (process.env.FLOW_LEGACY_ASSERT_INPUT === '1') {
        assert.equal(windows.filter(win => win.url === 'diagram').length, 0, 'drawing never creates a native input window');
        const plotEvent = metrics.wheel.find(event => event.path.some(value => value.includes('zoom-and-drag')));
        if (plotEvent) assert.equal(plotEvent.prevented, false, 'fixed-range plots cannot swallow textbook wheel events');
        if ([35, 60, 90].includes(step)) {
          const pause = page.getByTitle('暂停计时', { exact: true });
          const target = await pause.boundingBox();
          const hit = await page.evaluate(box => {
            const node = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { title: node?.closest('button')?.title, inert: Boolean(node?.closest('[inert]')),
              modalCount: document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]').length };
          }, target);
          assert.deepEqual(hit, { title: '暂停计时', inert: false, modalCount: 0 });
          await pause.click({ timeout: 3000 });
          await page.getByTitle('继续计时', { exact: true }).click({ timeout: 3000 });
          proof.trustedWheel.at(-1).buttonInput = 'pause/resume passed';
          await page.locator('.focus-flow-note-preview').hover();
        }
      }
      if (step === 75) {
        await bounded(page.screenshot({ path: path.join(root, 'trusted-wheel-midpoint.png'), timeout: 4000 }), 'midpoint-screenshot', 5000);
        if (process.env.FLOW_LEGACY_HOLD === '1') {
          console.log('HOLD_FOR_NATIVE_OBSERVATION');
          for (let tick = 0; tick < 90 && !fs.existsSync(path.join(root, 'resume')); tick++) await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    if (process.env.FLOW_LEGACY_ASSERT_INPUT === '1') {
      const forward = proof.trustedWheel.filter(sample => sample.step >= 65 && sample.step <= 105);
      assert.ok(new Set(forward.map(sample => sample.top)).size > 3, 'continuous real wheel must pass through and beyond the function plot');
      assert.ok(proof.trustedWheel.every(sample => sample.mounted < 10), 'continuous scroll keeps bounded nearby DOM and may retain loading placeholders');
      proof.checks.push('连续真实滚轮经过结构图、函数图和本地附件，途中暂停/继续点击命中正确且没有隐藏绘图窗口');
    }
  }
  for (let i = 0; i < 18; i++) {
    const start = Date.now();
    const position = await bounded(page.evaluate(i => {
      const at = performance.now();
      performance.mark(`legacy-scroll-${i}-start`);
      const reader = document.querySelector('.focus-flow-note-preview');
      reader.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      reader.scrollTop = i / 17 * (reader.scrollHeight - reader.clientHeight);
      const diagram = reader.querySelector('.textbook-diagram, [aria-label*="结构图"]')?.closest('[data-reading-chunk]');
      const result = { top: reader.scrollTop, height: reader.scrollHeight, diagrams: [...reader.querySelectorAll('.textbook-diagram-svg img')].filter(image => image.complete && image.naturalWidth > 0).length,
        diagramBlock: diagram ? Number(diagram.dataset.readingChunk) : null,
        formulas: reader.querySelectorAll('.textbook-formula').length, handlerMs: performance.now() - at };
      performance.mark(`legacy-scroll-${i}-end`);
      return result;
    }, i), 'scroll-' + i);
    proof.timings.push({ step: i, ms: Date.now() - start, ...position });
    console.log(JSON.stringify(proof.timings.at(-1)));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const seenDiagram = [...proof.timings].reverse().find(value => Number.isInteger(value.diagramBlock));
  if (expectedImages) {
    proof.decodedReferencedImages = await page.evaluate(() => window.legacyImagesDecoded.size);
    assert.ok(proof.decodedReferencedImages >= expectedImages, 'all referenced immutable textbook images must decode when reading pauses near them');
  }
  if (seenDiagram) await page.evaluate(block => {
    const reader = document.querySelector('.focus-flow-note-preview');
    const slot = reader.querySelector(`[data-reading-chunk="${block}"]`);
    reader.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    reader.scrollTop += slot.getBoundingClientRect().top - reader.getBoundingClientRect().top - 80;
  }, seenDiagram.diagramBlock);
  // Virtual readers retain estimated slots. Explicitly visit the final slot so
  // drawing isolation is exercised even when nearby chunks changed its height.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(block => {
      const reader = document.querySelector('.focus-flow-note-preview');
      reader.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      if (block === undefined) reader.scrollTop = reader.scrollHeight;
    }, seenDiagram?.diagramBlock);
    if (await page.locator('.textbook-diagram-svg img').count()) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.textbook-diagram-svg img')].some(image => image.complete && image.naturalWidth > 0), undefined, { timeout: 15000 });
  assert.equal(await page.locator('.textbook-diagram-svg svg, .textbook-diagram-svg style').count(), 0, 'SVG styles and internal DOM cannot enter the interaction document');
  proof.readingDOM = await page.evaluate(() => ({
    virtual: Boolean(document.querySelector('.focus-flow-note-preview.textbook-long-reader')),
    mounted: document.querySelectorAll('.focus-flow-note-preview .textbook-reading-chunk').length,
    slots: document.querySelectorAll('.focus-flow-note-preview .textbook-reading-slot').length,
    formulas: document.querySelectorAll('.focus-flow-note-preview .textbook-formula').length,
  }));
  if (process.env.FLOW_LEGACY_STALL === '1') {
    const before = await page.evaluate(() => window.legacyProbe.stall());
    assert.notEqual(before.mainPid, before.diagramPid);
    assert.equal(before.nativeWindow, false, 'background drawing has no native input window');
    await page.evaluate(() => {
      window.cancelledDiagramProbe = window.electronAPI.mermaid.render({ requestId: 'cancelled-diagram', id: 'cancelled-diagram', code: 'flowchart TD\nA-->B', dark: false }).then(() => 'done', () => 'cancelled');
    });
    await page.evaluate(() => window.electronAPI.mermaid.cancel('cancelled-diagram'));
    assert.equal(await page.evaluate(() => window.cancelledDiagramProbe), 'cancelled');
    const recovered = await page.evaluate(async () => {
      const result = await window.electronAPI.mermaid.render({ requestId: 'recovered-diagram', id: 'recovered-diagram', code: 'flowchart TD\nA[恢复]-->B[正常绘图]', dark: false });
      return { text: result.svg.includes('正常绘图'), validWidth: result.readingWidth > 0 };
    });
    assert.deepEqual(recovered, { text: true, validWidth: true });
    proof.isolation = await page.evaluate(() => window.legacyProbe.stall());
    assert.notEqual(proof.isolation.mainPid, proof.isolation.diagramPid);
    assert.notEqual(proof.isolation.diagramPid, before.diagramPid);
    proof.checks.push('取消阻塞绘图后重建独立进程，下一张图正常生成');
    await page.evaluate(() => {
      window.pendingDiagramProbe = window.electronAPI.mermaid.render({ requestId: 'held-diagram', id: 'held-diagram', code: 'flowchart TD\nA-->B', dark: false }).then(() => 'done', () => 'cancelled');
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const reader = page.locator('.focus-flow-note-preview');
    await reader.hover();
    await page.evaluate(() => {
      window.legacyWheelFrames = [];
      document.querySelector('.focus-flow-note-preview').addEventListener('wheel', () => {
        const at = performance.now(); requestAnimationFrame(() => window.legacyWheelFrames.push(performance.now() - at));
      }, { passive: true });
    });
    const steps = [];
    for (let step = 0; step < 6; step++) {
      const at = Date.now();
      await page.mouse.wheel(0, step % 2 ? 260 : -260);
      const top = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(document.querySelector('.focus-flow-note-preview').scrollTop))));
      steps.push({ ms: Date.now() - at, top });
    }
    proof.stalledDrawingWheel = steps;
    proof.stalledDrawingWheelFrames = await page.evaluate(() => window.legacyWheelFrames);
    assert.ok(new Set(steps.map(value => value.top)).size > 1, 'real wheel events must keep scrolling while the independent drawing process is blocked');
  }
  await page.evaluate(() => {
    window.legacyLatency = {};
    document.addEventListener('input', event => {
      if (event.target?.classList?.contains('flow-restate-textarea')) {
        const at = performance.now(); requestAnimationFrame(() => { window.legacyLatency.inputFrameMs = performance.now() - at; });
      }
    }, { capture: true });
    document.addEventListener('click', event => {
      if (!event.target?.closest?.('.focus-flow-save-exit')) return;
      const at = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.flow-mode-container')) { window.legacyLatency.exitMs = performance.now() - at; observer.disconnect(); }
      }); observer.observe(document.body, { subtree: true, childList: true });
    }, { capture: true });
  });
  const start = Date.now();
  await page.locator('.flow-restate-textarea').fill('仅用于本地隔离性能检查的新复述');
  proof.inputMs = Date.now() - start;
  const analysis = page.locator('.focus-flow-analysis-control [role="switch"]');
  if (await analysis.getAttribute('aria-checked') === 'true') await analysis.click();
  proof.performance = await page.evaluate(() => ({ ...window.legacyPerf, end: performance.now() }));
  const gaps = proof.performance.gaps, tasks = proof.performance.tasks;
  const regularGaps = gaps.filter(value => value >= 5 && value <= 25).sort((a, b) => a - b);
  const nominalFrameMs = regularGaps[Math.floor(regularGaps.length / 2)] || 1000 / 60;
  proof.responsiveness = { maxScrollRoundTripMs: Math.max(...proof.timings.map(value => value.ms)),
    maxScrollHandlerMs: Math.max(...proof.timings.map(value => value.handlerMs)),
    nominalFrameMs, frameBudgetMs: Math.max(50, nominalFrameMs * 3 + 2),
    maxFrameGapMs: Math.max(...gaps), longTasks: tasks.length, maxLongTaskMs: Math.max(0, ...tasks.map(value => value.duration)) };
  if (process.env.FLOW_LEGACY_NO_LONG_TASKS === '1') assert.equal(tasks.length, 0, 'actual legacy reading and drawing recovery must not produce a foreground 50ms long task');
  await fsp.writeFile(path.join(root, 'profile.json'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
  await page.screenshot({ path: path.join(root, 'reader.png') });
  const exitStart = Date.now(); await page.getByRole('button', { name: '退出并保存', exact: true }).click();
  await page.locator('.flow-mode-container').waitFor({ state: 'detached' }); proof.exitMs = Date.now() - exitStart;
  await stopTrace();
  const events = (await fsp.readFile(path.join(root, 'ipc.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  proof.latency = await page.evaluate(() => window.legacyLatency);
  assert.equal(events.some(e => e.unexpectedModel), false);
  assert.equal(events.some(e => ['begin', 'next', 'publish'].includes(e.progressiveOp)), false);
  proof.checks.push('旧完整教材未触发渐进生成或云模型');
  if (process.env.FLOW_LEGACY_STALL === '1') {
    assert.ok(proof.inputMs < 2000, 'blocked diagram cannot block typing');
    assert.ok(proof.latency.inputFrameMs < 500, 'input paints while the drawing process is busy');
    assert.ok(proof.latency.exitMs < 3000 && proof.exitMs < 5000, 'blocked diagram cannot block save/exit');
    proof.checks.push('独立图示进程阻塞20秒时仍可输入并退出保存');
  }
  if (!external) {
    assert.equal(proof.readingDOM.virtual, true, 'short formula-dense legacy books must use background reading');
    assert.ok(proof.readingDOM.mounted < proof.readingDOM.slots, 'offscreen math DOM must be released');
    assert.ok(proof.readingDOM.formulas < 120, 'reading cannot retain the full 195-formula book');
  }
  if (!external || process.env.FLOW_LEGACY_INTERACTION_BUDGET === '1') {
    assert.ok(proof.responsiveness.maxScrollHandlerMs < 50, 'scroll handling cannot synchronously lay out the whole book');
    assert.ok(proof.responsiveness.maxFrameGapMs <= proof.responsiveness.frameBudgetMs, 'scroll/input cannot pause for more than three display frames');
    assert.equal(proof.responsiveness.longTasks, 0, 'no foreground long task during reading or drawing');
    if (process.env.FLOW_LEGACY_STALL === '1') {
      assert.ok(proof.stalledDrawingWheelFrames.length >= 5);
      assert.ok(Math.max(...proof.stalledDrawingWheelFrames) < 50, 'trusted wheel input must paint while the drawing process is stalled');
    }
    assert.ok(proof.latency.exitMs < 1000 && proof.exitMs < 1500, 'leaving legacy reading cannot synchronously remount the whole book');
    proof.checks.push('公式在后台排版、前台仅挂载附近分段；滚动/绘图期间不超过三帧预算且无50ms长任务、退出小于1.5秒');
  }
  if (!external || process.env.FLOW_LEGACY_INTERACTION_BUDGET === '1' || process.env.FLOW_LEGACY_RESTORE === '1') {
    const saved = JSON.parse(await fsp.readFile(path.join(state, 'user-state/user-state.json'), 'utf8')).noteStates[id].textbookReadingState;
    assert.match(saved.blockAnchor, /^reading-block-\d+$/u);
    const savedBlock = Number(saved.blockAnchor.slice('reading-block-'.length));
    await page.getByRole('button', { name: '学习', exact: true }).click();
    await page.getByRole('button', { name: '进入心流', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: '出发，开始学习', exact: true }).click();
    await page.waitForFunction(position => {
      const reader = document.querySelector('.focus-flow-note-preview');
      const slot = reader?.querySelector(`[data-reading-chunk="${position.block}"]`);
      if (!slot?.querySelector('.textbook-reading-chunk')) return false;
      const box = slot.getBoundingClientRect(), viewport = reader.getBoundingClientRect();
      // A saved offset may legitimately be past the anchor block's trailing
      // margin. Verify the actual logical point, not intersection of that block.
      return Math.abs(viewport.top - box.top - position.offset) < 24;
    }, { block: savedBlock, offset: saved.scrollTop });
    proof.resumedPosition = saved;
    proof.resumedOffset = await page.evaluate(block => {
      const reader = document.querySelector('.focus-flow-note-preview');
      return reader.getBoundingClientRect().top - reader.querySelector(`[data-reading-chunk="${block}"]`).getBoundingClientRect().top;
    }, savedBlock);
    const resumedAnalysis = page.locator('.focus-flow-analysis-control [role="switch"]');
    if (await resumedAnalysis.getAttribute('aria-checked') === 'true') await resumedAnalysis.click();
    await page.locator('.flow-restate-textarea').fill('恢复位置后的输入仍然可用');
    await page.getByRole('button', { name: '退出并保存', exact: true }).click();
    await page.locator('.flow-mode-container').waitFor({ state: 'detached' });
    proof.checks.push('退出后的分段/偏移保存，再次进入恢复同一阅读位置且能继续输入、退出');
  }
  }
  assert.deepEqual(proof.errors, []); proof.checks.push('可滚动、输入、退出保存，无渲染异常');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  proof.nativeExit = await bounded(exited, 'native-exit', 15000); assert.equal(proof.nativeExit.code, 0);
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed'; proof.error = error.message; process.exitCode = 1;
  if (cdp) {
    try {
      await cdp.send('Debugger.enable');
      const paused = new Promise(resolve => cdp.once('Debugger.paused', resolve));
      await cdp.send('Debugger.pause');
      const stack = await bounded(paused, 'freeze-stack', 3000);
      proof.failureStack = stack.callFrames.map(frame => ({ functionName: frame.functionName, url: frame.url, location: frame.location }));
      await cdp.send('Debugger.resume');
    } catch (captureError) { proof.failureStackError = String(captureError); }
  }
  if (page) await fsp.writeFile(path.join(root, 'failure-text.txt'), await bounded(page.locator('body').innerText(), 'failure-text', 2000).catch(() => 'renderer unavailable'));
  if (page) proof.failureGeometry = await bounded(page.evaluate(() => {
    const reader = document.querySelector('.focus-flow-note-preview');
    return reader ? { top: reader.scrollTop, height: reader.scrollHeight, viewport: reader.getBoundingClientRect().top,
      slots: [...reader.querySelectorAll('[data-reading-chunk]')].map(slot => ({ block: slot.dataset.readingChunk,
        top: slot.getBoundingClientRect().top, bottom: slot.getBoundingClientRect().bottom, mounted: Boolean(slot.querySelector('.textbook-reading-chunk')) })) } : null;
  }), 'failure-geometry', 2000).catch(() => null);
  if (cdp) await bounded(cdp.send('Profiler.stop').then(async result => fsp.writeFile(path.join(root, 'profile.json'), JSON.stringify(result.profile))), 'profile-stop', 3000).catch(() => {});
  if (tracing) await bounded(stopTrace(), 'trace-stop', 5000).catch(() => {});
  console.error(error);
} finally {
  if (child.exitCode === null) child.kill();
  await browser?.close().catch(() => {}); fs.closeSync(fd);
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, root, error: proof.error, inputMs: proof.inputMs, exitMs: proof.exitMs, checks: proof.checks }));
}
