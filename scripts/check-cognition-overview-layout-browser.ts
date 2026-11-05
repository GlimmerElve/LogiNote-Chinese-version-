import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { cognitionNodeAction, cognitionRelationAction } from './cognition-canvas-browser-actions';
import { applyCognitionMutation, emptyCognitionFile } from '../src/services/cognition/core';

const moduleRoot = process.env.COGNITION_BROWSER_MODULES;
if (!moduleRoot) throw new Error('Set COGNITION_BROWSER_MODULES to an existing node_modules containing Playwright');
const { chromium } = createRequire(path.join(moduleRoot, 'cognition-overview-browser.cjs'))('playwright');
let fixture = emptyCognitionFile();
const examples = [
  ['心流与注意力', '目标清晰、挑战适中时，我更容易保持专注。'],
  ['心理账户', '我会根据钱的来源，给它们分配不同的用途。'],
  ['条件概率', '知道新信息后，我需要重新考虑原来的概率。'],
  ['间隔学习', '分散练习能帮助我发现哪些内容尚未记牢。'],
  ['因果与相关', '一起发生的两件事，不一定互相构成原因。'],
  ['情境与判断', '同一结论在不同的情境下可能有不同边界。'],
  ['认知负荷', '同时处理太多新信息时，我更容易遗漏步骤。'],
  ['反馈与练习', '能定位到具体步骤的反馈，更利于我调整练习。'],
  ['贝叶斯更新', '已有判断可以随新证据发生变化。'],
  ['迁移与类比', '结构相似的任务，也要核对使用条件是否一致。'],
  ['动机与习惯', '减少开始行动的阻力，有时比等到有动力更有用。'],
  ['模型与现实', '模型可以帮助解释，但不能代替实际观察。'],
];
for (const [index, [title, text]] of examples.entries()) fixture = applyCognitionMutation(fixture, {
  kind: 'confirm', expectedRevision: fixture.revision, confirmed: true, operation: 'initial', reason: '', authorship: 'own_expression', stance: 'endorsed',
  doc: { doc_id: `layout-${index}`, title, nodes: [{ id: 'claim', text, mainType: '假设' }, { id: 'premise', text: `我对${title}的练习观察。`, mainType: '事实陈述' }],
    edges: [{ id: 'support', source: 'premise', target: 'claim', relation: 'support' }] },
}, { id: `layout-v${index}`, at: '2026-10-20T00:00:00Z' });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' }); await server.listen();
const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.COGNITION_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const output = path.resolve('tmp/cognition-manager-proof'); await fs.mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(file => { if (location.protocol === 'http:') {
    localStorage.setItem('loginote-personal-cognition-v1', JSON.stringify(file)); localStorage.setItem('loginote_vault_notes', '[]');
  } }, fixture);
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${origin}/cognition.html`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '我的认知图谱', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.cm-group').length === 12);
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('loginote-personal-cognition-v1')!));
  const allInView = async () => {
    await page.waitForFunction(() => {
      const view = document.querySelector('.cm-map .react-flow')?.getBoundingClientRect();
      return view && [...document.querySelectorAll('.react-flow__node')].every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= view.left + 2 && box.right <= view.right - 2 && box.top >= view.top + 2 && box.bottom <= view.bottom - 2;
      });
    }).catch(async (cause: unknown) => {
      console.error('Visible graph bounds at failure:', await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
        view: document.querySelector('.cm-map .react-flow')?.getBoundingClientRect().toJSON(),
        nodes: [...document.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect().toJSON()) })));
      throw cause;
    });
    const boxes = await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
    }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]; assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'rendered overview nodes overlap');
    }
    const controls = await page.locator('.react-flow__controls').boundingBox(); assert.ok(controls);
    for (const box of boxes) assert.ok(box.x + box.width <= controls.x || controls.x + controls.width <= box.x
      || box.y + box.height <= controls.y || controls.y + controls.height <= box.y, 'zoom controls must not cover a group title');
    assert.equal(await page.locator('.react-flow__edge').count(), 0, 'packing cannot fabricate inter-group relationships');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  };
  await allInView();
  const xPositions = await page.locator('.cm-group').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().x)));
  assert.ok(new Set(xPositions).size > 4, 'actual overview cannot be the old two-column list');
  await page.screenshot({ path: path.join(output, 'overview-spatial-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: path.join(output, 'overview-spatial-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  for (const [width, height] of [[1600, 1000], [900, 700], [768, 1024], [375, 900], [812, 375]]) {
    await page.setViewportSize({ width, height }); await allInView();
    if (width === 375) await page.screenshot({ path: path.join(output, 'overview-spatial-mobile.png') });
  }
  await page.setViewportSize({ width: 1280, height: 850 }); await allInView();
  const search = page.getByRole('textbox', { name: '搜索认知原话或主题' });
  await search.fill('心流'); await page.waitForFunction(() => document.querySelectorAll('.cm-group').length === 1); await allInView();
  await search.fill(''); await page.waitForFunction(() => document.querySelectorAll('.cm-group').length === 12); await allInView();
  await page.getByRole('button', { name: '孤立节点', exact: true }).click();
  await page.getByRole('heading', { name: '没有匹配的认知', exact: true }).waitFor();
  await page.getByRole('button', { name: '全部认知', exact: true }).click(); await allInView();
  await page.locator('.react-flow__node').filter({ hasText: '心流与注意力' }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge').length === 1);
  await page.locator('.react-flow__node').filter({ hasText: '目标清晰' }).press('Space');
  await cognitionNodeAction(page, '更新这项理解');
  const editor = page.getByLabel('整理个人理解', { exact: true });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
  const cameraBeforeEditing = await page.locator('.react-flow__viewport').getAttribute('style');
  await editor.locator('textarea').first().fill('仅用于验证布局不打断编辑的草稿。');
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), cameraBeforeEditing, 'typing in an editor must not refit or move the camera');
  await page.setViewportSize({ width: 900, height: 700 });
  assert.equal(await editor.locator('textarea').first().inputValue(), '仅用于验证布局不打断编辑的草稿。');
  await page.keyboard.press('Escape');
  assert.equal(await editor.isVisible(), true, 'new fitting must not bypass the existing unsaved-draft guard');
  await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
  await page.getByRole('button', { name: '返回认知概览', exact: true }).click(); await allInView();
  assert.deepEqual(await read(), fixture, 'layout, resize, search and draft cancellation never write cognition');
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`PASS cognition overview browser: 12 spatial groups, no overlap/false links, responsive fit, themes, 375px/landscape/reduced motion, keyboard and draft guards; synthetic read-only data. Screenshots: ${output}`);
} finally { await browser.close(); await server.close(); }
