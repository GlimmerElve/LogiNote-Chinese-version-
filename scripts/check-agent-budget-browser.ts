import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const modules = process.env.COGNITION_BROWSER_MODULES;
if (!modules) throw Error('Set COGNITION_BROWSER_MODULES to the bundled Playwright node_modules');
const { chromium } = createRequire(path.join(modules, 'agent-budget-browser.cjs'))('playwright');
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{ name: 'isolated-agent-budget-preview', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url !== '/agent-budget-preview') return next();
      res.setHeader('Content-Type', 'text/html');res.end('<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/scripts/fixtures/agent-budget-preview.tsx"></script></body></html>');
    });
  } }],
});
await server.listen();const address = server.httpServer!.address();assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const output = path.resolve('tmp/agent-budget-proof');await fs.mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 760 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${origin}/agent-budget-preview`);
  const slider = page.getByRole('slider', { name: /工具调用预算/ });
  await slider.waitFor();assert.equal(await slider.inputValue(), '12');
  assert.equal(await page.getByRole('button', { name: '标准 12 次' }).getAttribute('aria-pressed'), 'true');
  await slider.evaluate((element: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const value of ['20', '25', '30', '35']) { setter.call(element, value);element.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForFunction(() => document.querySelector('.agent-budget-value strong')?.textContent === '35');
  assert.equal(await page.evaluate(() => (window as any).__budgetWrites || 0), 0, 'drag previews do not write settings for every movement');
  await slider.dispatchEvent('pointerup');
  await page.waitForFunction(() => (window as any).__budgetWrites === 1);
  await page.reload();await slider.waitFor();assert.equal(await slider.inputValue(), '35');
  assert.equal(await page.getByRole('button', { name: '标准 12 次' }).getAttribute('aria-pressed'), 'false');
  await slider.focus();await slider.press('End');assert.equal(await slider.inputValue(), '48');
  await slider.press('Home');assert.equal(await slider.inputValue(), '4');
  await slider.press('ArrowRight');assert.equal(await slider.inputValue(), '5');
  assert.equal(await slider.evaluate((element: HTMLElement) => getComputedStyle(element).outlineStyle), 'solid');
  await page.getByRole('button', { name: '深度 24 次' }).click();assert.equal(await slider.inputValue(), '24');
  await page.getByRole('button', { name: '切换设置读取状态' }).click();assert(await slider.isDisabled());
  assert(await page.getByRole('button', { name: '标准 12 次' }).isDisabled());
  await page.getByRole('button', { name: '切换设置读取状态' }).click();assert(await slider.isEnabled());
  const card = page.getByRole('region', { name: 'Agent 执行策略' });
  await card.screenshot({ path: path.join(output, 'light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await card.screenshot({ path: path.join(output, 'dark.png') });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await slider.isVisible());
  }
  await page.setViewportSize({ width: 375, height: 812 });await card.screenshot({ path: path.join(output, 'mobile.png') });
  await page.setViewportSize({ width: 960, height: 760 });await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert(await slider.isVisible());
  assert.deepEqual(errors, []);await context.close();
  console.log('Agent budget browser: presets, drag coalescing, persisted reload, keyboard/focus, disabled state, light/dark, 375px/landscape/2x zoom passed; synthetic isolated storage only.');
} finally { await browser.close();await server.close(); }
