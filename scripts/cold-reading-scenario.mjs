import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const coldPlot = { title: '冷启动函数图', variable: 'x', xLabel: 'x', yLabel: 'y', xDomain: [-.25, 2.3], yDomain: [-.6, 5.2],
  curves: [{ id: 'f', label: '平方函数', expression: 'x^2' }], area: { curveId: 'f', from: 0, to: 2 },
  riemann: { curveId: 'f', from: 0, to: 2, count: 8, method: 'midpoint' } };
const fence = (kind, value) => '```' + kind + '\n' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n```';
export const coldVisualBody = '# 首次加载验收\n\n' + fence('function-plot', coldPlot)
  + '\n\n' + fence('chart', { title: '冷启动数据图', type: 'bar', simulated: true, sourceIds: [], labels: ['甲', '乙'], series: [{ name: '数量', data: [1, 2] }] })
  + '\n\n' + fence('molecule', { title: '乙醇', smiles: 'CCO', simulated: true, sourceIds: [], description: '结构示意' })
  + '\n\n' + fence('mermaid', 'flowchart TD\n A[加载中]-->B[仍可滚动]\n B-->C[后台完成后显示]') + '\n\n';

/** Test-only delayed delivery of real worker results, not replacement parsing. */
export async function installColdWorkerProbe(page) {
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    const probe = window.coldProbe = { indexOpen: false, pagesOpen: false, indexes: [], pages: [], pageRequests: [],
      releaseIndex() { this.indexOpen = true; this.indexes.splice(0).forEach(run => run()); },
      releasePages() { this.pagesOpen = true; this.pages.splice(0).forEach(run => run()); } };
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); let callback, alive = true;
        Object.defineProperty(this, 'onmessage', { get: () => callback, set: value => { callback = value; } });
        this.addEventListener('message', event => {
          const deliver = () => { if (alive) callback?.call(this, event); };
          if (event.data?.index && !probe.indexOpen) probe.indexes.push(deliver);
          else if (event.data?.tree && !probe.pagesOpen) probe.pages.push(deliver);
          else deliver();
        });
        const terminate = this.terminate.bind(this); this.terminate = () => { alive = false; terminate(); };
        const post = this.postMessage.bind(this); this.postMessage = (...values) => { if (typeof values[0]?.page === 'number') probe.pageRequests.push(values[0].page); return post(...values); };
      }
    };
  });
}
export async function runColdReadingScenario({ page, cdp, root, proof, bounded }) {
  const reader = page.locator('.focus-flow-note-preview');
  await reader.locator('[data-reading-initial-placeholder]').waitFor();
  await page.waitForFunction(() => window.coldProbe.indexes.length > 0);
  await reader.hover();
  proof.coldEntryMetrics = await page.evaluate(() => ({ longTasks: window.legacyPerf.tasks, maxFrameGapMs: Math.max(0, ...window.legacyPerf.gaps) }));
  await page.evaluate(() => { window.legacyPerf.tasks = []; window.legacyPerf.gaps = []; });
  const sample = () => page.evaluate(() => {
    const host = document.querySelector('.focus-flow-note-preview');
    return { top: host.scrollTop, max: host.scrollHeight - host.clientHeight,
      initial: Boolean(host.querySelector('[data-reading-initial-placeholder]')),
      slots: host.querySelectorAll('[data-reading-chunk]').length, mounted: host.querySelectorAll('.textbook-reading-chunk').length,
      loading: [...host.querySelectorAll('[role="status"]')].filter(node => node.getClientRects().length).map(node => node.textContent),
      images: host.querySelectorAll('.textbook-background-visual img,.textbook-diagram-svg img').length };
  });
  async function wheels(label, count = 14, amplitude = 85) {
    const samples = [];
    for (let i = 0; i < count; i++) {
      await bounded(page.mouse.wheel(0, i % 6 < 3 ? amplitude : -amplitude), label + '-wheel', 3000);
      await page.waitForTimeout(45); samples.push(await bounded(sample(), label + '-sample', 3000));
    }
    assert.ok(new Set(samples.map(value => Math.round(value.top))).size >= 4, label + ': trusted wheel moves viewport while pending');
    proof[label] = samples; return samples;
  }
  const initial = await wheels('coldIndex');
  assert.ok(initial.every(value => value.initial && value.mounted === 0));
  assert.ok(initial.some(value => value.loading.some(text => text.includes('正在加载正文'))));
  await page.screenshot({ path: path.join(root, 'cold-index-loading.png') });
  await page.evaluate(() => window.coldProbe.releaseIndex());
  await page.waitForFunction(() => document.querySelectorAll('.focus-flow-note-preview [data-reading-chunk]').length > 4);
  await page.waitForFunction(() => window.coldProbe.pages.length > 0);
  assert.ok((await sample()).top >= initial.at(-1).top - 24, 'index completion preserves the position already scrolled by the reader');
  const pages = await wheels('coldPages'); assert.ok(pages.every(value => !value.initial && value.mounted === 0));
  // Prepared pages arrive DURING real continuous wheel input. Publication waits.
  await page.mouse.wheel(0, 40); await page.evaluate(() => window.coldProbe.releasePages());
  const deferred = await wheels('coldPublication'); assert.ok(deferred.every(value => value.mounted === 0), 'prepared page DOM must wait until scrolling stops');
  await page.evaluate(() => { document.querySelector('.focus-flow-note-preview').scrollTop = 0; });
  await reader.locator('.textbook-function').waitFor();
  await page.waitForFunction(() => document.querySelector('.textbook-function .textbook-background-visual[aria-busy="true"]'));
  const box = await reader.locator('.textbook-function-canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, Math.max(200, box.y + 160));
  const drawings = await wheels('coldDrawing');
  assert.ok(drawings.some(value => value.loading.some(text => text.includes('正在加载图形'))));
  await page.screenshot({ path: path.join(root, 'cold-drawing-loading.png') });
  proof.drawingProcess = await page.evaluate(() => window.legacyProbe.releaseDrawing());
  assert.equal(proof.drawingProcess.nativeWindow, false); assert.notEqual(proof.drawingProcess.mainPid, proof.drawingProcess.drawingPid);
  // Cold dynamic import, calculation and SVG measurement now happen in the other process.
  const completing = await wheels('coldDrawingCompletion', 32, 50);
  assert.ok(completing.every(value => value.images === 0), 'completed graphics keep their placeholder during continuous scrolling');
  await page.evaluate(() => { document.querySelector('.focus-flow-note-preview').scrollTop = 0; });
  await page.waitForFunction(() => {
    const image = document.querySelector('.textbook-function-canvas img'); return image?.complete && image.naturalWidth > 0;
  }, null, { timeout: 20000 });
  proof.plot = await page.evaluate(async () => {
    const image = document.querySelector('.textbook-function-canvas img'), source = await (await fetch(image.src)).text();
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
    return { rectangles: svg.querySelectorAll('.textbook-riemann-rectangle').length, area: svg.querySelectorAll('.textbook-function-area').length,
      mainSvgNodes: document.querySelectorAll('.textbook-function-canvas svg').length };
  });
  assert.equal(proof.plot.rectangles, 8); assert.equal(proof.plot.area, 1); assert.equal(proof.plot.mainSvgNodes, 0);
  await page.screenshot({ path: path.join(root, 'cold-function-ready.png') });
  // A fast reversal must reuse already displayed prose AND its decoded image,
  // rather than treating it as a cold item deferred until scrolling stops.
  proof.warmReturn = await page.evaluate(() => {
    const host = document.querySelector('.focus-flow-note-preview'), slot = host.querySelector('.textbook-function').closest('[data-reading-chunk]');
    window.warmReading = { slot, content: slot.querySelector('.textbook-reading-chunk'), image: slot.querySelector('.textbook-function-canvas img'), page: Number(slot.dataset.readingChunk) };
    const before = window.coldProbe.pageRequests.filter(page => page === window.warmReading.page).length;
    host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    host.scrollTop += slot.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 420;
    return { page: window.warmReading.page, workerRequestsBefore: before };
  });
  await page.waitForTimeout(55);
  assert.equal(await page.evaluate(() => window.warmReading.content.isConnected), true, 'recently read DOM survives leaving the warm-up area');
  await reader.hover();
  for (let step = 0; step < 8; step++) { await page.mouse.wheel(0, -600); await page.waitForTimeout(40); }
  Object.assign(proof.warmReturn, await page.evaluate(() => ({
    workerRequestsAfter: window.coldProbe.pageRequests.filter(page => page === window.warmReading.page).length,
    sameContent: window.warmReading.slot.querySelector('.textbook-reading-chunk') === window.warmReading.content,
    sameImage: window.warmReading.slot.querySelector('.textbook-function-canvas img') === window.warmReading.image,
    decoded: window.warmReading.image.complete && window.warmReading.image.naturalWidth > 0,
    busy: window.warmReading.slot.getAttribute('aria-busy'), contentVisible: getComputedStyle(window.warmReading.content).contentVisibility !== 'hidden',
  })));
  assert.equal(proof.warmReturn.workerRequestsAfter, proof.warmReturn.workerRequestsBefore);
  assert.equal(proof.warmReturn.sameContent && proof.warmReturn.sameImage && proof.warmReturn.decoded && proof.warmReturn.contentVisible, true);
  assert.equal(proof.warmReturn.busy, 'false');
  const slider = reader.locator('.textbook-riemann-controls input'); await slider.focus(); await slider.press('End');
  assert.match(await reader.locator('.textbook-riemann-controls').innerText(), /n = 80/u);
  await page.waitForFunction(async () => {
    const image = document.querySelector('.textbook-function[data-plot-status="ready"] img'); if (!image) return false;
    return new DOMParser().parseFromString(await (await fetch(image.src)).text(), 'image/svg+xml').querySelectorAll('.textbook-riemann-rectangle').length === 80;
  });
  // Move down in short steps; every graphic must eventually decode without
  // importing the plotting libraries or their SVG trees into the reader.
  const seen = new Set(['function-plot']);
  for (let step = 0; step < 16 && seen.size < 4; step++) {
    await page.evaluate(step => { document.querySelector('.focus-flow-note-preview').scrollTop = step * 260; }, step);
    await page.waitForTimeout(550);
    for (const kind of await page.evaluate(() => [
      ...[...document.querySelectorAll('.focus-flow-note-preview [data-visual-kind]')].filter(node => node.querySelector('img')?.naturalWidth > 0).map(node => node.dataset.visualKind),
      ...(document.querySelector('.focus-flow-note-preview .textbook-diagram-svg img')?.naturalWidth > 0 ? ['mermaid'] : [])])) seen.add(kind);
  }
  proof.graphics = [...seen]; assert.equal(seen.size, 4, 'all four graphic families decode');
  await reader.hover(); await wheels('decodedGraphicWheel', 16, 90);
  await page.locator('.flow-restate-textarea').focus();
  const totalSlots = await reader.locator('[data-reading-chunk]').count(); assert.ok(totalSlots > 22);
  // Walk beyond the prepared-cache limit, then return while wheel input stays
  // continuous. An evicted but previously read page must not wait for idle.
  for (let block = 1; block <= 22; block++) {
    await page.evaluate(block => {
      const host = document.querySelector('.focus-flow-note-preview'), slot = host.querySelector(`[data-reading-chunk="${block}"]`);
      host.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      host.scrollTop += slot.getBoundingClientRect().top - host.getBoundingClientRect().top;
    }, block);
    await page.waitForFunction(block => Boolean(document.querySelector(`.focus-flow-note-preview [data-reading-chunk="${block}"] .textbook-reading-chunk`)), block);
    await page.waitForTimeout(25);
  }
  const oldPage = proof.warmReturn.page;
  assert.equal(await reader.locator(`[data-reading-chunk="${oldPage}"] .textbook-reading-chunk`).count(), 0, 'far DOM was actually released');
  const beforeRestore = await page.evaluate(page => window.coldProbe.pageRequests.filter(value => value === page).length, oldPage);
  await page.evaluate(page => {
    const host = document.querySelector('.focus-flow-note-preview'), slot = host.querySelector(`[data-reading-chunk="${page}"]`);
    host.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); host.scrollTop += slot.getBoundingClientRect().top - host.getBoundingClientRect().top;
    window.warmReading = null;
  }, oldPage);
  await reader.hover(); proof.evictedReturn = [];
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel(0, step % 2 ? -10 : 10); await page.waitForTimeout(40);
    proof.evictedReturn.push(await page.evaluate(page => ({
      restored: Boolean(document.querySelector(`.focus-flow-note-preview [data-reading-chunk="${page}"] .textbook-reading-chunk`)),
      workerRequests: window.coldProbe.pageRequests.filter(value => value === page).length,
    }), oldPage));
  }
  assert.ok(proof.evictedReturn.some(value => value.restored), 'previously read content restores during continuous input, even after cache eviction');
  assert.ok(proof.evictedReturn.at(-1).workerRequests > beforeRestore, 'the test actually exercised an evicted prepared page');
  await page.getByTitle('暂停计时', { exact: true }).click(); await page.getByTitle('继续计时', { exact: true }).click();
  await page.locator('.flow-restate-textarea').fill('首次加载期间也能继续输入、阅读与退出。');
  const analysis = page.locator('.focus-flow-analysis-control [role="switch"]'); if (await analysis.getAttribute('aria-checked') === 'true') await analysis.click();
  proof.coldMetrics = await page.evaluate(() => ({ longTasks: window.legacyPerf.tasks, maxFrameGapMs: Math.max(0, ...window.legacyPerf.gaps) }));
  const workerFile = (await fs.readdir(path.resolve('dist/assets'))).find(name => /^imagePreviewWorker-.*\.js$/u.test(name));
  assert.ok(workerFile, 'the production crop worker is bundled');
  proof.previewWorker = await page.evaluate(async url => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 100, 100); context.fillStyle = '#111'; context.fillRect(30, 30, 40, 40);
    const source = canvas.toDataURL(), worker = new Worker(url, { type: 'module' });
    try {
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = event => event.data.error ? reject(Error(event.data.error)) : resolve(event.data.preview);
        worker.onerror = event => reject(Error(event.message)); worker.postMessage(source);
      });
      const image = new Image(); image.src = result; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, sourceUnchanged: source === canvas.toDataURL() };
    } finally { worker.terminate(); }
  }, pathToFileURL(path.resolve('dist/assets', workerFile)).href);
  assert.deepEqual(proof.previewWorker, { width: 64, height: 64, sourceUnchanged: true });
  await page.screenshot({ path: path.join(root, 'cold-rendered.png') });
  const result = await cdp.send('Profiler.stop'); await fs.writeFile(path.join(root, 'profile.json'), JSON.stringify(result.profile));
  await page.getByRole('button', { name: '退出并保存', exact: true }).click(); await page.locator('.flow-mode-container').waitFor({ state: 'detached' });
  proof.checks.push('首次索引、正文、图形均未就绪时，可信上下滚轮持续生效并可见加载状态；加载完成后图形和交互恢复；四类绘图均在独立进程完成');
}

