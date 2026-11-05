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
const { chromium } = createRequire(path.join(modules, 'fta-theme.cjs'))('playwright');
const output = path.resolve('output/fault-tree-theme'), entry = '/scripts/fixtures/s2-fault-tree-browser.html';
const config = s2BrowserIsolationConfig();
const server = await createServer({ ...config, configFile: false, logLevel: 'error',
  optimizeDeps: { ...config.optimizeDeps, entries: [path.resolve(entry.slice(1))] },
  server: { ...config.server, port: 0, strictPort: false } });
const errors: string[] = [], remote: string[] = [], themes: unknown[] = [];
let browser: any;
function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
try {
  await fs.mkdir(output, { recursive: true }); await server.listen();
  const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.SCENE_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => {
    const url = route.request().url(); if (url.startsWith('data:') || new URL(url).origin === origin) return route.continue();
    remote.push(url); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin + entry);
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const audit = () => page.evaluate(() => (window as any).__faultTree.audit());
  const fit = async () => { await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(300); };
  await node('a').getByRole('textbox', { name: '内容', exact: true }).fill('冷却系统故障');
  await node('b').getByRole('textbox', { name: '内容', exact: true }).fill('供电中断');
  await node('c').getByRole('textbox', { name: '内容', exact: true }).fill('设备停机');
  await fit();
  const source = await node('a').locator('[data-handleid="out:event"]').boundingBox();
  const target = await node('gate').locator('[data-handleid="in:left"]').boundingBox(); assert(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 24 }); await page.mouse.up();
  await page.waitForFunction(() => (window as any).__faultTree.audit().document.execution.links.length === 3);
  const before = await audit(); assert.deepEqual(before.issues, []);
  for (const theme of ['light', 'dark', 'light']) {
    // Explicit app choice must win even when the operating-system preference differs.
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await page.evaluate((dark: boolean) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await fit();
    const styles = await node('a').evaluate((element: Element) => {
      const shape = getComputedStyle(element.querySelector('.fta-event-shape')!);
      const input = getComputedStyle(element.querySelector('textarea')!);
      const select = getComputedStyle(element.querySelector('select')!);
      const option = getComputedStyle(element.querySelector('option')!);
      return { scheme: select.colorScheme, shape: { width: shape.width, height: shape.height, background: shape.backgroundColor },
        text: { color: input.color, background: input.backgroundColor, border: input.borderTopWidth, fontSize: input.fontSize, alignment: input.textAlign },
        select: { color: select.color, background: select.backgroundColor, radius: select.borderRadius },
        option: { color: option.color, background: option.backgroundColor } };
    });
    assert.equal(styles.scheme, theme); assert.equal(styles.shape.width, '200px'); assert.equal(styles.shape.height, '200px');
    assert.equal(styles.text.fontSize, '16px'); assert.equal(styles.text.border, '0px'); assert.equal(styles.text.background, 'rgba(0, 0, 0, 0)');
    assert.equal(styles.text.alignment, 'center'); assert.equal(styles.select.radius, '999px');
    assert(contrast(styles.text.color, styles.shape.background) >= 4.5);
    assert(contrast(styles.select.color, styles.select.background) >= 4.5);
    assert(contrast(styles.option.color, styles.option.background) >= 4.5);
    const controls = await page.locator('.react-flow__controls-button').first().evaluate((element: Element) => {
      const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor };
    });
    assert(contrast(controls.color, controls.background) >= 4.5, 'Canvas controls also follow the host theme');
    const sidebarBorder = await page.getByLabel('向 Agent 提出要求', { exact: true }).evaluate((element: Element) => getComputedStyle(element).borderTopWidth);
    assert.equal(sidebarBorder, '1px', 'Generic host fields retain their default styling');
    assert.deepEqual((await audit()).document, before.document, 'Theme changes do not change graph data');
    await page.mouse.click(1180, 630);
    await page.locator('.s2-flow').screenshot({ path: path.join(output, `fault-tree-${theme}.png`) });
    const select = node('c').getByRole('combobox', { name: '事件类型', exact: true });
    await select.focus(); await page.keyboard.press('Space');
    await page.screenshot({ path: path.join(output, `fault-tree-${theme}-menu.png`), fullPage: true });
    await page.keyboard.press('Escape'); themes.push({ theme, styles });
  }
  const state = await audit(); assert.equal(state.packLoads, 1); assert.equal(state.sessionStarts, 0); assert.equal(state.modelRequests, 0);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, themes, packageLoads: state.packLoads, errors, remote }, null, 2));
  console.log('Fault-tree theme passed: light/dark/light live switching, native select scheme and option contrast, package control priority, compact shapes, actual wire drag and unchanged graph. No model or remote calls.');
} finally { await browser?.close(); await server.close(); }
