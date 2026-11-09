/** Real review editor menu ownership and viewport regression; synthetic data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import ts from 'typescript';

globalThis.fetch = async () => assert.fail('No real library/model/external calls in context menu checks');
const output = await fs.mkdtemp(path.resolve('build/argument-context-menu-'));
// Reuse the isolated bridge fixture, not a replacement menu/dialog implementation.
const fixtureSource = await fs.readFile('scripts/check-argument-toolbar-bounds.ts', 'utf8');
const parsed = ts.createSourceFile('fixture.ts', fixtureSource, ts.ScriptTarget.Latest, true);
let fixture = '';
for (const statement of parsed.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  const declaration = statement.declarationList.declarations.find(item => item.name.getText(parsed) === 'fixture');
  if (declaration?.initializer && ts.isNoSubstitutionTemplateLiteral(declaration.initializer)) fixture = declaration.initializer.text;
}
assert.ok(fixture.includes('ProgressiveReviewDialog'));
fixture = fixture.replace("role:'premise',", '').replace("role:'claim',", '');
const fixtureId = path.resolve('__argument-context-menu.tsx').replaceAll('\\', '/');
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'argument-context-menu.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
let groups = 0;
const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    plugins: [react(), tailwindcss(), { name: 'isolated-context-menu', resolveId(id) { if (id === fixtureId || id === '/__context-menu.tsx') return fixtureId; },
      load(id) { if (id === fixtureId) return fixture; }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/context-menu') return next(); res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;min-height:100%}</style></head><body><div id="root"></div><script type="module" src="/__context-menu.tsx"></script></body></html>');
      }); } }], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [], noDiscovery: true,
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@xyflow/react', 'katex', 'zustand',
        'react-markdown', 'remark-gfm', '@xenova/transformers', 'micromark-util-decode-string', 'mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'micromark-extension-math', 'mdast-util-math'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [], external: string[] = [];
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  const page = await context.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', (error: Error) => errors.push(error.message));
  const parent = () => page.getByRole('dialog', { name: '复盘分析结果', exact: true });
  const menu = () => page.getByRole('menu', { name: '节点操作', exact: true });
  const submenu = () => page.getByRole('menu', { name: '旧标签（兼容）', exact: true });
  const open = async (x = 900, y = 650) => {
    await parent().locator('.react-flow__node').first().evaluate((element: HTMLElement, point: { x: number; y: number }) => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 2 })), { x, y });
    await menu().waitFor();
  };
  const reloadEditor = async () => {
    await page.goto(origin + '/context-menu', { waitUntil: 'domcontentloaded' });
    await parent().getByRole('button', { name: '打开论证编辑器', exact: true }).click();
    await parent().locator('.arg-node-content').first().waitFor();
  };
  const bounded = async (locator: any) => {
    await page.waitForFunction((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return rect.left >= 7 && rect.top >= 7 && rect.right <= innerWidth - 7 && rect.bottom <= innerHeight - 7; }, await locator.elementHandle());
    const value = await locator.evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); const ancestors = []; for (let item: HTMLElement | null = element; item; item = item.parentElement) { const style = getComputedStyle(item); ancestors.push({ name: item.className, style: item.style.cssText, transform: style.transform, filter: style.filter, backdrop: style.backdropFilter, contain: style.contain, position: style.position, top: item.getBoundingClientRect().top }); } return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, client: element.clientHeight, scroll: element.scrollHeight, ancestors }; });
    assert.ok(value.left >= 7 && value.top >= 7 && value.right <= value.width - 7 && value.bottom <= value.height - 7, JSON.stringify(value));
    return value;
  };
  for (const dirty of [false, true]) {
    await reloadEditor();
    if (dirty) {
      await parent().locator('.arg-node-content').first().dblclick();
      await parent().locator('.arg-node-textarea').fill('未保存的节点修改必须保留。');
      await parent().locator('.arg-node-textarea').press('Control+Enter');
    }
    await open(); await page.keyboard.press('ArrowDown');
    assert.equal(await menu().evaluate((element: HTMLElement) => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' });
    assert.equal(await parent().count(), 1);
    if (dirty) assert.ok((await parent().locator('.arg-node-content').first().innerText()).includes('未保存的节点修改'));
    await page.waitForFunction(() => document.querySelector('.argument-canvas-root')?.contains(document.activeElement));
  }
  pass('clean/dirty real review editor Escape closes only its node menu and restores canvas focus without losing edits');
  await reloadEditor();
  await page.setViewportSize({ width: 320, height: 700 });
  await open(222, 600); await bounded(menu());
  const legacy = () => menu().getByRole('menuitem', { name: '旧标签（兼容）', exact: true });
  await legacy().focus(); await page.keyboard.press('ArrowRight'); await submenu().waitFor();
  await bounded(menu()); await bounded(submenu());
  assert.equal(await submenu().evaluate((element: HTMLElement) => element.contains(document.activeElement)), true);
  await page.screenshot({ path: path.join(output, 'review-menu-320-submenu.png') });
  await page.keyboard.press('End');
  assert.equal(await submenu().getByRole('menuitem').last().evaluate((element: HTMLElement) => document.activeElement === element), true);
  await page.keyboard.press('ArrowLeft'); await submenu().waitFor({ state: 'detached' });
  assert.equal(await legacy().evaluate((element: HTMLElement) => document.activeElement === element), true);
  pass('320px actual embedded node menu and keyboard-open legacy submenu remain in viewport with independent keyboard navigation');
  await page.setViewportSize({ width: 260, height: 240 }); await bounded(menu());
  await legacy().focus(); await page.keyboard.press('ArrowRight'); await submenu().waitFor();
  await bounded(submenu());
  await submenu().getByRole('menuitem').last().focus();
  const last = await submenu().getByRole('menuitem').last().boundingBox(); assert.ok(last && last.y >= 0 && last.y + last.height <= 240);
  await page.screenshot({ path: path.join(output, 'review-menu-short-submenu.png') });
  const lastLabel = await submenu().getByRole('menuitem').last().innerText();
  await submenu().getByRole('menuitem').last().click(); await menu().waitFor({ state: 'detached' });
  await page.waitForFunction((expected: string) => document.querySelector('.react-flow__node[data-id="n1"] .arg-node-type')?.textContent === expected, lastLabel);
  await open(222, 150); await bounded(menu());
  await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' }); assert.equal(await parent().count(), 1);
  pass('resizing an open menu clamps main/submenu; short-window choices scroll into view and accept real mouse selection; Escape leaves the review open');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(origin + '/context-menu?standalone=1', { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: '论证画布', exact: true }).waitFor();
  await page.locator('.react-flow__node').first().evaluate((element: HTMLElement) => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 310, clientY: 680, button: 2 })));
  await bounded(menu()); await menu().getByRole('menuitem', { name: '前提', exact: true }).click(); await menu().waitFor({ state: 'detached' });
  await page.locator('.react-flow__node').first().evaluate((element: HTMLElement) => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 310, clientY: 680, button: 2 })));
  assert.equal(await menu().getByRole('menuitem', { name: '前提 · 当前', exact: true }).count(), 1);
  assert.equal(await legacy().count(), 0);
  await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.ok((await page.evaluate(() => (window as any).__toolbar.commands)).every((input: any) => ['load', 'review-read', 'review-graph-read'].includes(input.op)));
  pass('standalone role changes remain functional; no model, external, persistence or parent-close errors');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed-offline', groups, output, errors, external, boundary: 'actual review dialog/editor and standalone canvas; synthetic read replies only, no private library/model/network' }, null, 2));
  console.log(JSON.stringify({ status: 'passed-offline', groups, output }, null, 2));
} catch (error) { console.error('Context menu artifacts:', output); throw error; }
finally { await browser?.close(); await server?.close(); }
