/** Real latest/sidebar/editor lifecycle; deterministic local fixture only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

globalThis.fetch = async () => assert.fail('No network, private data or model in title lifecycle regression');
const output = await fs.mkdtemp(path.resolve('build/progressive-title-lifecycle-'));
const source = await fs.readFile('scripts/check-progressive-confirmation-ui.ts', 'utf8');
const ast = ts.createSourceFile('confirmation-ui.ts', source, ts.ScriptTarget.Latest, true);
let expression: ts.Expression | undefined;
function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'fixture') expression = node.initializer; ts.forEachChild(node, visit); }
visit(ast); assert.ok(expression);
let fixture: string = new Function('return (' + expression.getText(ast) + ');')();
const oldState = "let choose;function Fixture(){const[id,setId]=useState('A');choose=setId;return";
assert.ok(fixture.includes(oldState));
fixture = fixture.replace(oldState, `let choose;function Fixture(){const[id,setId]=useState('A');const[title,setTitle]=useState('A项目');const[enabled,setEnabled]=useState(true);const[legacyAt,setLegacyAt]=useState('');
choose=next=>{setId(next);setTitle(next+'项目');};window.__titleLifecycle={rename:setTitle,choose,setEnabled,setLegacyAt};return`);
const oldProps = "key={id} noteId={id} noteTitle={id+'项目'} enabled";
assert.ok(fixture.includes(oldProps));
fixture = fixture.replace(oldProps, 'noteId={id} noteTitle={title} enabled={enabled} legacyUpdatedAt={legacyAt}');
fixture = fixture.replace("const date='2026-11-08T12:00:00Z';", "let releaseSave;const date='2026-11-08T12:00:00Z';");
fixture = fixture.replace("if(input.op==='review-graph-save'){", "if(input.op==='review-graph-save'){if(state.holdSave){state.saveWaiting=true;await new Promise(resolve=>releaseSave=resolve);state.saveWaiting=false;}");
fixture = fixture.replace('window.__confirmation={state,rows,emit,', 'window.__confirmation={state,rows,emit,releaseSave(){state.holdSave=false;releaseSave?.();},');
const fixtureId = path.resolve('__progressive-title-lifecycle.tsx').replaceAll('\\', '/');
const modules = process.env.COGNITION_BROWSER_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 'progressive-title-lifecycle.cjs'))('playwright');
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
let groups = 0; const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  server = await createServer({ root: process.cwd(), configFile: false, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    plugins: [react(), tailwindcss(), { name: 'title-lifecycle-fixture',
      resolveId(id) { if (id === fixtureId || id === '/__title-lifecycle.tsx') return fixtureId; },
      load(id) { if (id === fixtureId) return fixture; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/title-lifecycle') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__title-lifecycle.tsx"></script></body></html>');
      }); },
    }], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [], noDiscovery: true, include: [
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@xyflow/react', 'katex', 'zustand',
      'react-markdown', 'remark-gfm', '@xenova/transformers', 'micromark-util-decode-string', 'mdast-util-from-markdown',
      'micromark-extension-gfm', 'mdast-util-gfm', 'micromark-extension-math', 'mdast-util-math',
    ] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [], external: string[] = [];
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  const page = await context.newPage(); page.setDefaultTimeout(45000); page.on('pageerror', (error: Error) => errors.push(error.message));
  const dialog = () => page.getByRole('dialog', { name: '复盘分析结果', exact: true });
  const canvas = () => dialog().getByRole('region', { name: '论证画布', exact: true });
  const state = () => page.evaluate(() => structuredClone((window as any).__confirmation.state));
  const rename = (title: string) => page.evaluate(value => (window as any).__titleLifecycle.rename(value), title);
  const savedText = () => page.evaluate(() => (window as any).__confirmation.rows.get('A').docs['part-1'].nodes[0].text);
  await page.goto(origin + '/title-lifecycle', { waitUntil: 'domcontentloaded' });
  await page.getByText('A项目原始前提1', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看与编辑', exact: true }).click();
  await dialog().getByRole('button', { name: '打开论证编辑器', exact: true }).click();
  await canvas().locator('.arg-node-content').filter({ hasText: 'A项目原始前提1' }).dblclick();
  await canvas().locator('.arg-node-textarea').fill('先验证离开保护仍有效');
  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click();
  await dialog().getByText('结构图修改尚未保存，请先保存草稿或放弃修改。', { exact: true }).waitFor();
  assert.equal(await dialog().count(), 1);
  await canvas().locator('.arg-node-content').filter({ hasText: '先验证离开保护仍有效' }).dblclick();
  await canvas().locator('.arg-node-textarea').fill('尚未失焦的理解也应在重命名后保留');
  const canvasHandle = await canvas().elementHandle(); assert.ok(canvasHandle);
  const loadsBeforeRename = (await state()).commands.filter((input: any) => input.op === 'load').length;
  await rename('同一项目的新标题');
  await dialog().getByText('同一项目的新标题', { exact: true }).waitFor();
  assert.equal(await canvasHandle.evaluate((element: HTMLElement) => element.isConnected), true);
  assert.equal(await canvas().locator('.arg-node-textarea').inputValue(), '尚未失焦的理解也应在重命名后保留');
  assert.equal((await state()).saves, 0); assert.equal((await state()).writes, 0);
  assert.equal((await state()).commands.filter((input: any) => input.op === 'load').length, loadsBeforeRename,
    'Title-only rerenders must not reset/reload the source lifecycle');
  pass('same-project rename retains the mounted dirty editor, pending node text and focus while updating its visible title');

  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click();
  await dialog().getByText('结构图修改尚未保存，请先保存草稿或放弃修改。', { exact: true }).waitFor();
  await canvas().focus(); await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('[aria-label="论证画布"]')?.textContent?.includes('尚未失焦的理解也应在重命名后保留'));
  await page.keyboard.press('Control+y');
  await canvas().getByText('尚未失焦的理解也应在重命名后保留', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click();
  await dialog().getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  assert.equal(await savedText(), '尚未失焦的理解也应在重命名后保留'); assert.equal((await state()).writes, 0);
  await dialog().getByRole('button', { name: '确认并写入个人认知库', exact: true }).click();
  await dialog().getByText('已确认并写入个人认知库；原始分析与历史评分保持不变。', { exact: true }).waitFor();
  assert.equal((await state()).writes, 1);
  pass('renaming preserves undo/redo and the normal explicit save/confirm path without automatic adoption');

  await canvas().locator('.arg-node-content').filter({ hasText: '尚未失焦的理解也应在重命名后保留' }).dblclick();
  await canvas().locator('.arg-node-textarea').fill('保存进行中改名不能中断这次草稿');
  await page.evaluate(() => { (window as any).__confirmation.state.holdSave = true; });
  await dialog().getByRole('button', { name: '保存图草稿', exact: true }).click();
  await page.waitForFunction(() => (window as any).__confirmation.state.saveWaiting);
  await rename('保存时更新的同项目标题');
  await dialog().getByText('保存时更新的同项目标题', { exact: true }).waitFor();
  assert.equal(await dialog().count(), 1); assert.equal(await canvasHandle.evaluate((element: HTMLElement) => element.isConnected), true);
  await page.evaluate(() => (window as any).__confirmation.releaseSave());
  await dialog().getByText('结构图草稿已保存，尚未写入个人认知库。', { exact: true }).waitFor();
  assert.equal(await savedText(), '保存进行中改名不能中断这次草稿'); assert.equal((await state()).writes, 1);
  pass('a same-project title update cannot unmount or interrupt an in-flight draft save');

  await canvas().locator('.arg-node-content').filter({ hasText: '保存进行中改名不能中断这次草稿' }).dblclick();
  await canvas().locator('.arg-node-textarea').fill('旧图预览变新也不能丢掉当前编辑');
  await page.evaluate(() => (window as any).__titleLifecycle.setLegacyAt('2099-01-01T00:00:00Z'));
  await page.locator('aside').getByText('旧图占位', { exact: true }).waitFor();
  assert.equal(await canvasHandle.evaluate((element: HTMLElement) => element.isConnected), true);
  assert.equal(await canvas().locator('.arg-node-textarea').inputValue(), '旧图预览变新也不能丢掉当前编辑');
  await page.evaluate(() => (window as any).__titleLifecycle.setLegacyAt(''));
  await dialog().getByRole('button', { name: '返回笔记', exact: true }).click();
  await dialog().getByText('结构图修改尚未保存，请先保存草稿或放弃修改。', { exact: true }).waitFor();
  assert.equal((await state()).saves, 2); assert.equal((await state()).writes, 1);
  await page.screenshot({ path: path.join(output, 'renamed-dirty-editor-preserved.png') });
  pass('a latest-preview fallback change also retains the active editor instead of bypassing its dirty guard');

  await page.evaluate(() => (window as any).__confirmation.hold());
  await page.evaluate(() => (window as any).__titleLifecycle.choose('B'));
  await dialog().waitFor({ state: 'detached' });
  await page.getByText('B项目原始前提1', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__confirmation.release());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('A项目原始前提1', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '查看与编辑', exact: true }).click();
  await dialog().getByText('B项目', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__titleLifecycle.setEnabled(false));
  await dialog().waitFor({ state: 'detached' });
  await page.locator('aside').getByText('旧图占位', { exact: true }).waitFor();
  await page.evaluate(() => (window as any).__titleLifecycle.setEnabled(true));
  await page.getByText('B项目原始前提1', { exact: true }).waitFor();
  assert.equal(await dialog().count(), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  pass('true project/enable changes still dispose the old scope and reject late old-project reads');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed-offline', groups, output,
    boundary: 'actual latest/sidebar/result/editor components; synthetic local bridge only, no private data, model or external requests' }, null, 2));
  console.log(JSON.stringify({ status: 'passed-offline', groups, output }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
  console.error('Title lifecycle evidence:', output); throw error;
} finally { await browser?.close(); await server?.close(); }
