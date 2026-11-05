import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { createServer, type Plugin } from 'vite';
import { s2BrowserIsolationConfig } from './vite-s2-browser.config';
import { buildScenePack } from './build-scene-pack-example.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = '/scripts/fixtures/s2-material-browser.html';
const resourcePrefix = '/scripts/fixtures/scene-interaction-packs/';
const workspaceRoute = '/scripts/fixtures/material-study.workspace.json';
const source = path.join(repository, 'examples/scene-packs/material-study');
const output = path.join(repository, 'output/scene-pack-materials');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, 'browser-build-'));
const modules = process.env.SCENE_BROWSER_MODULES || process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 's2-material-browser.cjs'))('playwright');
const errors: string[] = [], remote: string[] = [], served: string[] = [], modulePaths = new Set<string>();
let browser: any, page: any, server: Awaited<ReturnType<typeof createServer>> | undefined, installed = true;
try {
  const built = await buildScenePack({ sourceDir: source, outputRoot: path.join(temporary, 'distribution') });
  assert.equal(built.manifest.protocolVersion, 2);
  const routes = new Map<string, { bytes: Buffer; mediaType: string }>();
  const packagePrefix = resourcePrefix + `${built.manifest.id}/${built.manifest.version}/`;
  for (const name of ['manifest.json', 'main.js', 'styles.css', 'agent.json']) routes.set(packagePrefix + name,
    { bytes: await fs.readFile(path.join(built.destination, name)), mediaType: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8' });
  for (const descriptor of built.manifest.materials) routes.set(packagePrefix + descriptor.path,
    { bytes: await fs.readFile(path.join(built.destination, descriptor.path)), mediaType: descriptor.mediaType });
  routes.set(workspaceRoute, { bytes: await fs.readFile(path.join(source, 'sample.s2-workspace.json')), mediaType: 'application/json; charset=utf-8' });
  const html = await fs.readFile(path.join(repository, entry.slice(1)), 'utf8');
  const transport: Plugin = { name: 'material-browser-fixed-transport', enforce: 'pre', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const route = request.url?.split('?')[0];
      if (route !== entry && route !== workspaceRoute && !route?.startsWith(resourcePrefix)) return next();
      if (!['GET', 'HEAD'].includes(request.method || '')) { response.statusCode = 405; response.end(); return; }
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
      if (route === entry) {
        // The legacy fixture forbids all fetch/data modules. This one exact page
        // exercises real same-origin package transport while the original module
        // and route allowlists still guard every source/dependency request.
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' data: 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'");
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : await vite.transformIndexHtml(entry, html)); return;
      }
      served.push(route!);
      const value = route === resourcePrefix + 'index.json'
        ? { bytes: Buffer.from(JSON.stringify(installed ? [built.manifest] : [])), mediaType: 'application/json; charset=utf-8' } : routes.get(route!);
      if (!value) { response.statusCode = 404; response.end(); return; }
      response.setHeader('Content-Type', value.mediaType);
      response.end(request.method === 'HEAD' ? undefined : value.bytes);
    });
  } };
  const config = s2BrowserIsolationConfig(id => modulePaths.add(id));
  server = await createServer({ ...config, configFile: false, logLevel: 'error', plugins: [transport, ...(config.plugins ?? [])],
    optimizeDeps: { ...config.optimizeDeps, entries: [path.join(repository, entry.slice(1))] },
    server: { ...config.server, port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.SCENE_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    remote.push(url.href); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin + entry);
  await page.getByRole('heading', { name: 'S2 实验画布', exact: true }).waitFor();
  const study = page.locator('.react-flow__node[data-id="study"]');
  await study.getByRole('img', { name: '三次测验成绩柱状图', exact: true }).waitFor();
  await study.getByText('这组分数仅用于演示随包学习物料；平均分描述这三次测验，不代表能力已经达标。', { exact: false }).waitFor();
  const image = study.getByAltText('蓝色成绩柱与绿色参考线图例', { exact: true });
  await image.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.material-study-panel img')].some(image => image.complete && image.naturalWidth > 0));
  const imageDimensions = await image.evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.src }));
  assert(imageDimensions.width > 0 && imageDimensions.height > 0 && imageDimensions.src.startsWith('blob:'));
  assert.equal(await study.locator('svg[aria-label="三次测验成绩柱状图"] rect').count(), 3);
  const audit = () => page.evaluate(() => (window as any).__s2MaterialBrowser.audit());
  const initial = await audit(); assert(initial.liveUrls.length > 0);

  await page.getByRole('button', { name: '开始试验', exact: true }).click();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const shown = page.locator('.react-flow__node[data-id="show"]');
  await shown.getByText(/三次学习测验：3 次，平均 75 分/).first().waitFor();
  const resultText = await shown.innerText(); assert.match(resultText, /平均 75 分/);
  await page.getByLabel('关闭画布操作面板', { exact: true }).click();
  await image.waitFor();
  await page.screenshot({ path: path.join(output, 'materials-browser.png'), fullPage: true });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '结束试验', exact: true }).click();
  await page.waitForFunction(() => (window as any).__s2MaterialBrowser.audit().liveUrls.length === 0);
  assert.equal(await page.locator('.material-study-panel img').count(), 0, 'Ending a real canvas session removes all material image views');
  const finished = await audit(); assert.equal(finished.session, 'finished');
  await page.evaluate(() => (window as any).__s2MaterialBrowser.close());
  await page.getByText('验收画布已关闭。', { exact: true }).waitFor();

  // A real pending legend fetch is released only after the canvas has unmounted.
  await page.evaluate(() => { (window as any).__s2MaterialBrowser.pause(true); (window as any).__s2MaterialBrowser.open(); });
  await page.waitForFunction(() => (window as any).__s2MaterialBrowser.audit().pendingReads > 0);
  const beforeLate = await audit();
  await page.evaluate(() => (window as any).__s2MaterialBrowser.close());
  await page.getByText('验收画布已关闭。', { exact: true }).waitFor();
  const completedResponse = page.waitForResponse((response: any) => response.url().endsWith('/materials/legend.png'));
  await page.evaluate(() => (window as any).__s2MaterialBrowser.release());
  const lateResponse = await completedResponse; await lateResponse.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const afterLate = await audit();
  assert.equal(afterLate.created.length, beforeLate.created.length, 'Late reads cannot create an image URL for an unmounted scene');
  assert.deepEqual(afterLate.liveUrls, []); assert.equal(await page.locator('.material-study-panel img').count(), 0);
  await page.evaluate(() => (window as any).__s2MaterialBrowser.open());
  await image.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.material-study-panel img')].some(image => image.complete && image.naturalWidth > 0));
  assert(!(await image.getAttribute('src')).includes(imageDimensions.src), 'Reopening receives a fresh display lease');

  // Isolate the new material wrapper's StrictMode lifecycle from the legacy
  // canvas. The real loaded package view exercises list/read/openUrl through
  // ScenePackView's injected scope, including the effect setup/cleanup replay.
  await page.evaluate(() => (window as any).__s2MaterialBrowser.close());
  await page.getByText('验收画布已关闭。', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__s2MaterialBrowser.probe());
  const strictProbe = page.getByRole('region', { name: 'StrictMode 物料视图', exact: true });
  const strictImage = strictProbe.getByAltText('蓝色成绩柱与绿色参考线图例', { exact: true });
  await strictImage.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[aria-label="StrictMode 物料视图"] img')].some(image => image.complete && image.naturalWidth > 0));
  const strictFirstUrl = await strictImage.getAttribute('src'), strictInitial = await audit();
  assert.equal(strictInitial.strictEffectSetups, 2, 'The root-level StrictMode probe actually replays initial effects');
  assert.equal(strictInitial.strictEffectCleanups, 1, 'Initial replay includes cleanup before the second setup');
  assert(strictInitial.strictListReads.length >= 2, 'StrictMode render/effect replay must still expose a live listable scope');
  assert(strictInitial.strictListReads.every((ids: string[]) => JSON.stringify(ids) === JSON.stringify(['scores', 'guide', 'legend'])));
  assert.deepEqual(strictInitial.strictErrors, []); assert.equal(await strictProbe.getByRole('alert').count(), 0);
  await page.evaluate(() => (window as any).__s2MaterialBrowser.setProbeActive(false));
  await page.waitForFunction(() => (window as any).__s2MaterialBrowser.audit().liveUrls.length === 0);
  assert.equal(await strictProbe.locator('img').count(), 0);
  await page.evaluate(() => (window as any).__s2MaterialBrowser.setProbeActive(true));
  await strictImage.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[aria-label="StrictMode 物料视图"] img')].some(image => image.complete && image.naturalWidth > 0));
  const strictResumed = await audit();
  assert.notEqual(await strictImage.getAttribute('src'), strictFirstUrl, 'Same-owner activation gets a fresh live scope and image lease');
  assert.equal(strictResumed.strictOwner, strictInitial.strictOwner);
  assert(strictResumed.strictListReads.length > strictInitial.strictListReads.length);
  assert.deepEqual(strictResumed.strictErrors, []); assert.equal(await strictProbe.getByRole('alert').count(), 0);

  // Simulate removal from the same real Web discovery endpoint, then close the
  // page wrapper. Availability revocation itself must already retire every URL.
  installed = false;
  const remainingAfterDiscovery = await page.evaluate(() => (window as any).__s2MaterialBrowser.refreshAndClose());
  assert.equal(remainingAfterDiscovery, 0, 'Directory withdrawal revokes URLs before the fixture unmounts its canvas');
  await page.getByText('验收画布已关闭。', { exact: true }).waitFor();
  const final = await audit(); assert.deepEqual(final.liveUrls, []);
  assert.equal(final.strictEffectSetups, final.strictEffectCleanups, 'The StrictMode probe finally unmounts and cleans up');
  assert(final.created.length > 0 && final.created.every((url: string) => final.revoked.includes(url)));
  assert.equal(final.storageAttempts, 0); assert.equal(final.deniedNetwork, 0); assert.equal(final.realModelCalls, 0);
  assert.equal(final.syntheticModelRequests, 0); assert.equal(final.agentCalls, 0); assert.equal(final.networkCalls, 0);
  assert.equal(final.persistentWrites, 0); assert.equal(final.storeWrites, 0);
  assert.equal(remote.length, 0); assert.deepEqual(errors, []);
  assert(![...modulePaths].some(file => file.includes('/src/interaction-packs/prompt-lab/')), 'Independent material example does not import prompt package implementation');
  assert(served.some(route => route.endsWith('/main.js')) && served.some(route => route.endsWith('/materials/scores.json'))
    && served.some(route => route.endsWith('/materials/guide.txt')) && served.some(route => route.endsWith('/materials/legend.png')));
  const report = { passed: true, package: { id: built.manifest.id, version: built.manifest.version, modules: built.modules, bytes: built.bytes },
    checks: ['real Web transport and package ESM activation', 'production S2 nodes render guide/three-bar chart/decoded PNG', 'real local mean 75 result',
      'session end and unmount revoke every URL', 'late material completion after unmount cannot render/create URL', 'fresh scope on reopen',
      'StrictMode real view effect replay preserves list/read/decoded image', 'same-owner inactive/reactive view gets a fresh live scope', 'directory withdrawal revokes before unmount'],
    imageDimensions, resultText, audit: final, remoteRequests: remote, browserErrors: errors, sourceModules: modulePaths.size };
  await fs.writeFile(path.join(output, 'materials-browser.json'), JSON.stringify(report, null, 2));
  console.log('Scene package materials browser passed: real independent Web-loaded package in production S2 canvas, guide/chart/decoded PNG and actual local mean 75; session end/unmount/directory withdrawal revoke every URL and late reads do not publish stale images. Headless Chrome with strict source isolation; zero model, remote or persistent IO.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'materials-browser-failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'materials-browser-failure.json'), JSON.stringify({ error: (error as Error).message, browserErrors: errors, remoteRequests: remote, served }, null, 2));
  throw error;
} finally {
  await browser?.close(); await server?.close();
  const target = path.resolve(temporary); assert.equal(path.dirname(target), output); assert(path.basename(target).startsWith('browser-build-'));
  await fs.rm(target, { recursive: true, force: true });
}
