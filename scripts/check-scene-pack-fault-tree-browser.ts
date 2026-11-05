import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { buildScenePack } from './build-scene-pack-example.mjs';
import { s2BrowserIsolationConfig } from './vite-s2-browser.config';

await buildScenePack({ sourceDir: path.resolve('examples/scene-packs/fault-tree') });
const modules = process.env.SCENE_BROWSER_MODULES || process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'fault-tree.cjs'))('playwright');
const entry = '/scripts/fixtures/s2-fault-tree-browser.html', output = path.resolve('output/fault-tree-browser');
const config = s2BrowserIsolationConfig();
const server = await createServer({ ...config, configFile: false, logLevel: 'error', optimizeDeps: { ...config.optimizeDeps, entries: [path.resolve(entry.slice(1))] },
  server: { ...config.server, port: 0, strictPort: false } });
let browser: any;
try {
  await server.listen(); const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, errors: string[] = [], remote: string[] = [];
  browser = await chromium.launch({ headless: true, executablePath: process.env.SCENE_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => { const url = route.request().url(); if (url.startsWith('data:') || new URL(url).origin === origin) return route.continue(); remote.push(url); return route.abort(); });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error: Error) => errors.push(error.message));
  const audit = () => page.evaluate(() => (window as any).__faultTree.audit());
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const gateType = async () => (await audit()).publicCanvas.nodes.find((item: any) => item.id === 'gate').values.gateType;
  const fit = async () => { await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(250); };
  await page.goto(origin + entry); await node('gate').locator('[data-fta-gate]').waitFor(); await fit();
  let state = await audit(); assert.equal(state.packLoads, 1); assert.equal(state.sessionStarts, 0);
  assert.equal(state.document.nodes.length, 0); assert.equal(state.document.execution.nodes.length, 4); assert.equal(state.document.execution.links.length, 2);
  assert.equal(await gateType(), 'AND');
  assert.equal(await node('a').getByRole('combobox', { name: '事件类型', exact: true }).count(), 1);
  assert.equal(await node('a').getByRole('textbox', { name: '内容', exact: true }).count(), 1);
  assert.equal(await node('a').locator('input').count(), 0); assert.equal(await node('gate').locator('input,select,textarea').count(), 0);
  assert.equal(await node('gate').locator('.s2-block').count(), 0);
  assert.equal(await page.getByRole('button', { name: /^(运行|开始试验|结束试验|分析)$/ }).count(), 0);
  assert(!await page.locator('.s2-header').innerText().then((text: string) => text.includes('运行')));
  const anchor = (id: string, port: string) => node(id).locator(`.react-flow__handle[data-handleid="${port}"]`);
  for (const [id, port] of [['a', 'out:event'], ['gate', 'out:condition']]) assert(await anchor(id, port).evaluate((item: Element) => item.classList.contains('react-flow__handle-top')));
  for (const [id, port] of [['c', 'in:condition'], ['gate', 'in:left'], ['gate', 'in:right']]) assert(await anchor(id, port).evaluate((item: Element) => item.classList.contains('react-flow__handle-bottom')));
  await node('a').getByRole('textbox', { name: '内容', exact: true }).fill('A：冷却失效');
  const editingViewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await node('a').getByRole('textbox', { name: '内容', exact: true }).dblclick();
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), editingViewport, 'Double-clicking event text preserves native editing and never zooms');
  await node('a').getByRole('combobox', { name: '事件类型', exact: true }).selectOption('intermediate');
  assert.equal(await node('a').locator('[data-fta-event]').getAttribute('data-fta-event'), 'intermediate');
  assert.equal((await audit()).document.execution.links.length, 2, 'Changing type keeps every existing connection');
  await node('a').getByRole('combobox', { name: '事件类型', exact: true }).selectOption('basic');
  const symbol = node('gate').getByRole('button', { name: /逻辑门：/ });
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await symbol.dblclick(); assert.equal(await gateType(), 'OR');
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), viewport, 'Package double-click does not zoom the canvas');
  await symbol.focus(); await page.keyboard.press('Control+z'); assert.equal(await gateType(), 'AND');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await gateType(), 'OR');
  await symbol.focus(); await page.keyboard.press('Enter'); assert.equal(await gateType(), 'AND');
  await page.keyboard.press('Space'); assert.equal(await gateType(), 'OR');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  const menu = page.getByRole('region', { name: '画布操作面板', exact: true });
  assert.equal(await menu.locator('button[data-s2-component]').count(), 2);
  await menu.getByRole('button', { name: '逻辑门', exact: true }).click();
  const added = (await audit()).publicCanvas.nodes.find((item: any) => item.componentId === 'gate' && item.id !== 'gate'); assert(added); assert.equal(added.values.gateType, 'AND');
  if (await menu.isVisible()) await page.getByLabel('关闭画布操作面板', { exact: true }).click(); await fit();
  await node(added.id).getByRole('button', { name: /逻辑门：/ }).click(); await page.keyboard.press('Delete');
  await page.waitForFunction(() => (window as any).__faultTree.audit().document.execution.nodes.length === 4);
  await fit();
  const source = await anchor('a', 'out:event').boundingBox(), target = await anchor('gate', 'in:left').boundingBox(); assert(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 24 }); await page.mouse.up();
  try { await page.waitForFunction(() => (window as any).__faultTree.audit().document.execution.links.length === 3); }
  catch (error) {
    await fs.mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'wire-failure.png'), fullPage: true });
    console.error(JSON.stringify({ source, target, state: await audit(), errors, body: await page.locator('.s2-error').allTextContents() })); throw error;
  }
  state = await audit(); assert.deepEqual(state.issues, []); assert.equal(state.sessionStarts, 0);
  // Manually add two more basic events and connect them to inputs that already
  // have sources. Re-measure handles after every edit: the gate count is local UI.
  const manualIds: string[] = [];
  for (const [content, port] of [['D：传感器故障', 'left'], ['E：控制器故障', 'right']]) {
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.getByRole('region', { name: '画布操作面板', exact: true }).getByRole('button', { name: '事件', exact: true }).click();
    const next = (await audit()).publicCanvas.nodes.find((item: any) => item.componentId === 'event' && !['a', 'b', 'c', ...manualIds].includes(item.id));
    assert(next); manualIds.push(next.id); await fit();
    await node(next.id).getByRole('textbox', { name: '内容', exact: true }).fill(content);
    const from = await anchor(next.id, 'out:event').boundingBox(), to = await anchor('gate', `in:${port}`).boundingBox(); assert(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 24 }); await page.mouse.up();
    await page.waitForFunction((count: number) => (window as any).__faultTree.audit().document.execution.links.length === count, 3 + manualIds.length);
    state = await audit(); assert.deepEqual(state.issues, []);
  }
  assert.equal(state.document.execution.nodes.length, 6); assert.equal(state.document.execution.links.length, 5);
  await node('gate').getByRole('button', { name: /逻辑门：/ }).dblclick(); assert.equal(await gateType(), 'AND');
  assert.equal((await audit()).document.execution.links.length, 5);
  await node('gate').getByRole('button', { name: /逻辑门：/ }).dblclick(); assert.equal(await gateType(), 'OR');
  assert(await node('gate').getByText('4 个输入 · 可继续接线', { exact: true }).isVisible());
  state = await audit();
  await fs.mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'fault-tree-canvas.png'), fullPage: true });
  const before = structuredClone(state.document);
  const toolbar = page.getByRole('navigation', { name: '画布工具', exact: true });
  await toolbar.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.getByText(/已保存场景「/).waitFor(); state = await audit(); assert.equal(state.saved.length, 1);
  assert.deepEqual(state.saved[0].canvasWorkspace.initial, before); assert.deepEqual(state.saved[0].interactionPack, { id: 'fault-tree', version: '1.0.0' });
  const savedId = state.saved[0].sceneId;
  await page.getByRole('button', { name: '重新打开已保存场景', exact: true }).click();
  await page.waitForFunction((id: string) => (window as any).__faultTree.audit().sceneId === id, savedId);
  await node('a').getByRole('textbox', { name: '内容', exact: true }).waitFor(); await fit();
  state = await audit(); assert.deepEqual(state.document, before); assert.equal(await gateType(), 'OR');
  assert.equal(await node('a').getByRole('textbox', { name: '内容', exact: true }).inputValue(), 'A：冷却失效');
  assert.equal(state.publicCanvas.connections.length, 5);
  assert.equal(await node(manualIds[0]).getByRole('textbox', { name: '内容', exact: true }).inputValue(), 'D：传感器故障');
  assert.equal(await node(manualIds[1]).getByRole('textbox', { name: '内容', exact: true }).inputValue(), 'E：控制器故障');
  await node('gate').getByRole('button', { name: /逻辑门：/ }).dblclick(); assert.equal(await gateType(), 'AND');
  assert.equal((await audit()).saved[0].canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'gate').bindings.gateType.value, 'OR', 'Reusing a scene never overwrites its saved copy');
  await page.screenshot({ path: path.join(output, 'fault-tree-restored.png'), fullPage: true });
  state = await audit(); assert.equal(state.sessionStarts, 0); assert.equal(state.modelRequests, 0); assert.equal(state.networkCalls, 0); assert.equal(state.stateWrites, 0);
  assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, packageLoads: state.packLoads, sessionStarts: state.sessionStarts, modelRequests: state.modelRequests,
    nodes: state.document.execution.nodes.length, connections: state.document.execution.links.length, savedScenes: state.saved.length, errors, remote }, null, 2));
  console.log('Fault-tree browser passed: built ESM, two-field events, AND/OR double-click+keyboard and undo/redo, actual addition of two events and pointer wiring to occupied multi-source anchors, four-input count, unchanged wires on gate toggle, toolbar save and library reopen with all six nodes/five links/layout. No execution, model or remote requests.');
} finally { await browser?.close(); await server.close(); }
