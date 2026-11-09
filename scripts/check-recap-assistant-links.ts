import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { preview } from 'vite';

// Independent synthetic browser contexts: never read the user's current tab or vault.
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.cwd(), 'recap-assistant-check.cjs'))('playwright');
const server = await preview({ configFile: 'scripts/vite-mobile-prototype.config.ts', logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const storageKey = 'loginote.interactions.v2';
const output = 'docs/artifacts/mobile/interactions';
const checks: string[] = [], pageErrors: string[] = [], externalRequests: string[] = [];
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const materialA = { id: 'derivative', title: '导数与变化率' };
const materialB = { id: 'retrieval', title: '为什么「想起来」比「再看一遍」更有效？' };
const legacyState = (patch: Record<string, unknown> = {}) => ({ notes: [], bookmarks: [], drafts: {}, chats: {}, assistant: [], blocked: [], session: null, recap: '', ...patch });

async function makePage(seed?: Record<string, unknown>, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route: any) => {
    const url = route.request().url();
    if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) { externalRequests.push(url); await route.abort(); }
    else await route.continue();
  });
  await context.addInitScript(({ key, seed }: { key: string; seed?: Record<string, unknown> }) => {
    sessionStorage.setItem('loginote.demo-session', 'yes');
    if (seed && !sessionStorage.getItem('recap-fixture-seeded')) {
      localStorage.setItem(key, JSON.stringify(seed));
      sessionStorage.setItem('recap-fixture-seeded', 'yes');
    }
  }, { key: storageKey, seed });
  const page = await context.newPage();
  page.on('pageerror', (error: Error) => pageErrors.push(error.message));
  page.on('dialog', (dialog: any) => dialog.accept());
  await page.goto(`${origin}/design/mobile-prototype/index.html`);
  return { page, context };
}
async function state(page: any) { return page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey); }
async function nav(page: any, name: string) {
  const navigation = page.getByRole('navigation', { name: '主导航' });
  for (let step = 0; step < 5 && !await navigation.isVisible(); step++) {
    const previous = page.getByRole('button', { name: '返回上一页', exact: true });
    const normal = page.getByRole('button', { name: '返回', exact: true });
    if (await previous.isVisible()) await previous.click();
    else if (await normal.isVisible()) await normal.click();
    else await page.getByRole('button', { name: '返回首页', exact: true }).click();
  }
  await navigation.getByRole('button', { name, exact: true }).click();
}
async function openAssistant(page: any) {
  if (await page.getByLabel('问问助手').isVisible()) return;
  const entry = page.getByRole('button', { name: '打开学习助手', exact: true });
  if (!await entry.isVisible()) await nav(page, '首页');
  await entry.click(); await page.getByLabel('问问助手').waitFor();
}
async function newAssistant(page: any) {
  const headerButton = page.locator('.ix-assistant > .ix-page-head').getByRole('button', { name: '新对话', exact: true });
  if (await headerButton.isVisible()) await headerButton.click();
  else await page.locator('.ix-assistant-history').getByRole('button', { name: '新建助手对话', exact: true }).click();
}
async function openMaterial(page: any, title: string) {
  await nav(page, '发现');
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await page.getByLabel('搜索资料').fill(title);
  await page.locator('.ix-material-list .ix-list-row').filter({ hasText: title }).click();
}
async function failMetadataWrites(page: any) {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__recapStorageOriginal = original;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'loginote.interactions.v2') throw Error('test quota');
      return original.call(this, key, value);
    };
  });
}
async function restoreMetadataWrites(page: any) { await page.evaluate(() => { Storage.prototype.setItem = (window as any).__recapStorageOriginal; }); }

try {
  const { page, context } = await makePage();
  await openMaterial(page, materialA.title);
  await page.getByRole('button', { name: '复述', exact: true }).click();
  await page.getByLabel('复述内容').fill('针对导数资料的未完成草稿');
  await page.getByRole('button', { name: '关闭弹层', exact: true }).click();
  await openMaterial(page, materialB.title);
  await page.getByRole('button', { name: '复述', exact: true }).click();
  assert.equal((await state(page)).recapSource, materialA.id);
  assert.equal((await state(page)).recapSourceTitle, materialA.title);
  assert.ok((await page.getByRole('dialog').innerText()).includes(materialA.title), 'resumed draft displays its original source');
  await page.getByLabel('复述内容').fill('导数描述的是瞬时变化率。');
  await page.getByRole('button', { name: '保存复述', exact: true }).click();
  const recap = (await state(page)).notes.find((note: any) => note.title.includes('导数描述的是瞬时变化率。'));
  assert.equal(recap.source, materialA.id); assert.equal(recap.sourceTitle, materialA.title);
  checks.push('A来源草稿在B资料续写仍显示并保存原来源A');

  await nav(page, '记录');
  await page.getByLabel('搜索记录').fill(materialA.title);
  const row = page.locator('.ix-list-row').filter({ hasText: '导数描述的是瞬时变化率。' });
  assert.ok((await row.innerText()).includes(materialA.title), 'record list shows linked material title');
  await row.click();
  const sourceButton = page.getByRole('button', { name: `查看关联资料：${materialA.title}`, exact: true });
  assert.ok(await sourceButton.isVisible());
  await page.screenshot({ path: `${output}/recap-source-phone.png` });
  await sourceButton.click();
  assert.ok(await page.getByRole('heading', { name: materialA.title, exact: true }).isVisible());
  assert.ok((await page.getByRole('region', { name: '我的复述', exact: true }).innerText()).includes('导数描述的是瞬时变化率。'));
  await page.getByRole('button', { name: '返回', exact: true }).click();
  assert.ok(await page.getByRole('region', { name: '记录详情' }).isVisible());
  assert.ok(await page.getByRole('heading', { name: recap.title, exact: true }).isVisible());
  await sourceButton.click();
  await page.getByRole('region', { name: '我的复述', exact: true }).getByRole('button').filter({ hasText: '导数描述的是瞬时变化率。' }).click();
  assert.ok(await sourceButton.isVisible());
  await page.reload(); await nav(page, '记录');
  await page.locator('.ix-list-row').filter({ hasText: recap.title }).click();
  assert.ok(await sourceButton.isVisible());
  checks.push('列表和详情显示来源、跳回原文再返回同一复述、原文反查复述及刷新恢复');
  await context.close();

  const failed = await makePage(legacyState({ recapSource: materialA.id, recapSourceTitle: materialA.title }));
  await openMaterial(failed.page, materialB.title);
  await failMetadataWrites(failed.page);
  await failed.page.getByRole('button', { name: '复述', exact: true }).click();
  assert.equal(await failed.page.getByRole('dialog').count(), 0, 'source switch cannot open with stale binding after failed save');
  assert.equal((await state(failed.page)).recapSource, materialA.id);
  await restoreMetadataWrites(failed.page);
  await failed.page.getByRole('button', { name: '复述', exact: true }).click();
  await failed.page.getByLabel('复述内容').fill('B来源恢复后保存');
  await failed.page.getByRole('button', { name: '保存复述', exact: true }).click();
  const recovered = (await state(failed.page)).notes.find((note: any) => note.title.includes('B来源恢复后保存'));
  assert.equal(recovered.source, materialB.id); assert.equal(recovered.sourceTitle, materialB.title);
  await failed.context.close();
  checks.push('来源切换持久化失败不打开错绑草稿，恢复后安全重试');

  const missingTitle = '已归档的学习资料';
  const missing = await makePage(legacyState({ notes: [{ id: 'orphan-recap', title: '失效来源的复述', kind: '复述', at: new Date().toISOString(), duration: 0, segments: [{ id: 'orphan-text', time: 0, text: '来源移除后仍保留这份理解。' }], photos: [], source: 'missing-source', sourceTitle: missingTitle }] }));
  await nav(missing.page, '记录');
  const missingRow = missing.page.locator('.ix-list-row').filter({ hasText: '失效来源的复述' });
  assert.ok((await missingRow.innerText()).includes(missingTitle)); await missingRow.click();
  const missingDetail = missing.page.getByRole('region', { name: '记录详情' });
  assert.ok((await missingDetail.innerText()).includes(missingTitle));
  const orphanLink = missingDetail.getByRole('button', { name: `查看关联资料：${missingTitle}`, exact: true });
  if (await orphanLink.count()) assert.equal(await orphanLink.isDisabled(), true, 'missing source must not navigate to another material');
  else assert.match(await missingDetail.innerText(), /不可用|不存在|移除|已删除/);
  await missing.context.close();
  checks.push('来源不存在时保留标题快照且不误跳转');

  const assistant = await makePage(undefined, 1194);
  const a = assistant.page;
  await openAssistant(a);
  await a.getByLabel('问问助手').fill('导数复习'); await a.getByRole('button', { name: '向助手发送', exact: true }).click();
  let saved = await state(a); const firstId = saved.activeAssistantId; const first = saved.assistantThreads.find((thread: any) => thread.id === firstId);
  assert.equal(first.messages.length, 2);
  await a.getByLabel('问问助手').fill('为什么切线斜率表示变化率？');
  await newAssistant(a);
  saved = await state(a); const secondId = saved.activeAssistantId;
  assert.notEqual(secondId, firstId);
  assert.equal(saved.assistantThreads.find((thread: any) => thread.id === firstId).messages.length, 2);
  assert.equal(saved.assistantThreads.find((thread: any) => thread.id === firstId).draft, '为什么切线斜率表示变化率？');
  assert.equal(await a.getByLabel('问问助手').inputValue(), '');
  await a.getByLabel('问问助手').fill('间隔复习'); await a.getByRole('button', { name: '向助手发送', exact: true }).click();
  await a.getByLabel('问问助手').fill('明天怎样安排一次复习？');
  saved = await state(a); const second = saved.assistantThreads.find((thread: any) => thread.id === secondId);
  await a.locator('.ix-assistant-history').getByRole('button', { name: `打开助手对话：${first.title}`, exact: true }).click();
  assert.equal(await a.getByLabel('问问助手').inputValue(), '为什么切线斜率表示变化率？');
  assert.ok((await a.getByRole('log', { name: '学习助手对话' }).innerText()).includes('导数复习'));
  assert.ok(!(await a.getByRole('log', { name: '学习助手对话' }).innerText()).includes('间隔复习'));
  await a.reload(); await openAssistant(a); assert.equal(await a.getByLabel('问问助手').inputValue(), '为什么切线斜率表示变化率？');
  await a.locator('.ix-assistant-history').getByRole('button', { name: `打开助手对话：${second.title}`, exact: true }).click();
  assert.equal(await a.getByLabel('问问助手').inputValue(), '明天怎样安排一次复习？');
  const messagesBeforeFailure = (await state(a)).assistantThreads.find((thread: any) => thread.id === secondId).messages.length;
  await failMetadataWrites(a);
  await a.getByRole('button', { name: '向助手发送', exact: true }).click();
  assert.equal(await a.getByLabel('问问助手').inputValue(), '明天怎样安排一次复习？');
  assert.equal((await state(a)).assistantThreads.find((thread: any) => thread.id === secondId).messages.length, messagesBeforeFailure);
  await newAssistant(a);
  assert.equal((await state(a)).activeAssistantId, secondId); assert.equal(await a.getByLabel('问问助手').inputValue(), '明天怎样安排一次复习？');
  await restoreMetadataWrites(a);
  await a.getByRole('button', { name: '向助手发送', exact: true }).click();
  assert.equal((await state(a)).assistantThreads.find((thread: any) => thread.id === secondId).messages.length, messagesBeforeFailure + 2);
  assert.equal(await a.getByLabel('问问助手').inputValue(), '');
  await a.getByLabel('问问助手').fill('明天怎样安排一次复习？');
  checks.push('助手发送或新建写入失败保留当前会话与草稿，恢复后仅提交一次');

  await a.getByRole('button', { name: '对话设置', exact: true }).click();
  await a.getByLabel('对话名称').fill('间隔复习 · 已整理');
  await a.getByLabel('对话标签', { exact: true }).fill('记忆,复习,记忆');
  await a.getByRole('button', { name: '保存对话设置', exact: true }).click();
  assert.deepEqual((await state(a)).assistantThreads.find((thread: any) => thread.id === secondId).tags, ['记忆', '复习']);
  const history = a.locator('.ix-assistant-history');
  await history.getByRole('group', { name: '按对话标签筛选' }).getByRole('button', { name: '记忆', exact: true }).click();
  assert.equal(await history.locator('.ix-ah-conversation').count(), 1);
  assert.ok(await history.getByRole('button', { name: '打开助手对话：间隔复习 · 已整理', exact: true }).isVisible());
  await history.getByLabel('搜索助手对话').fill(first.title);
  assert.equal(await history.locator('.ix-ah-conversation').count(), 0, 'tag and title search combine rather than ignore each other');
  await history.getByLabel('搜索助手对话').fill('');
  await history.getByRole('group', { name: '按对话标签筛选' }).getByRole('button', { name: '全部', exact: true }).click();
  await history.getByLabel('搜索助手对话').fill('记忆'); assert.equal(await history.locator('.ix-ah-conversation').count(), 1);
  await history.getByLabel('搜索助手对话').fill(first.title); assert.equal(await history.locator('.ix-ah-conversation').count(), 1);
  assert.ok(await history.getByRole('button', { name: `打开助手对话：${first.title}`, exact: true }).isVisible());
  await history.getByLabel('搜索助手对话').fill('');
  checks.push('助手对话改名、去重标签、标签筛选、名称/标签搜索及组合空结果');

  await history.getByRole('group', { name: '按对话标签筛选' }).getByRole('button', { name: '记忆', exact: true }).click();
  await newAssistant(a);
  const newlyCreated = await state(a);
  const manualId = newlyCreated.activeAssistantId;
  const manualInitial = newlyCreated.assistantThreads.find((thread: any) => thread.id === manualId);
  await history.getByRole('button', { name: `打开助手对话：${manualInitial.title}`, exact: true }).waitFor({ state: 'visible' });
  assert.ok(await history.getByRole('button', { name: `打开助手对话：${manualInitial.title}`, exact: true }).isVisible(), 'new active conversation remains visible when previous conversation was tag filtered');
  assert.equal(await history.getByRole('group', { name: '按对话标签筛选' }).getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed'), 'true');
  await a.getByRole('button', { name: '对话设置', exact: true }).click();
  await a.getByLabel('对话名称', { exact: true }).fill('课堂概念梳理');
  await a.getByLabel('对话标签', { exact: true }).fill('概念');
  await a.getByRole('button', { name: '保存对话设置', exact: true }).click();
  await a.getByLabel('问问助手').fill('如何理解导数？');
  await a.getByRole('button', { name: '向助手发送', exact: true }).click();
  const manualSaved = (await state(a)).assistantThreads.find((thread: any) => thread.id === manualId);
  assert.equal(manualSaved.title, '课堂概念梳理', 'first send preserves a manually assigned empty conversation title');
  assert.equal(manualSaved.messages.length, 2);
  checks.push('带标签筛选时新建会话自动可见，空白会话手动命名后首发保留名称');

  await newAssistant(a);
  const emptyId = (await state(a)).activeAssistantId;
  await a.getByRole('button', { name: '添加内容', exact: true }).click();
  await a.getByRole('button', { name: '引用课堂记录', exact: true }).click();
  const availableRecord = (await state(a)).notes.find((note: any) => note.id === 'sample-class');
  await a.getByRole('dialog', { name: '引用课堂记录', exact: true }).getByRole('button', { name: availableRecord.title, exact: true }).click();
  const referenced = (await state(a)).assistantThreads.find((thread: any) => thread.id === emptyId);
  assert.equal(referenced.context.id, availableRecord.id);
  assert.equal(referenced.title, availableRecord.title, 'empty default conversation takes the referenced material title');
  assert.ok(await history.getByRole('button', { name: `打开助手对话：${availableRecord.title}`, exact: true }).isVisible());
  checks.push('空白默认会话引用课堂记录后采用资料名称并保留引用上下文');

  await history.getByRole('button', { name: '打开助手对话：间隔复习 · 已整理', exact: true }).click();
  await a.screenshot({ path: `${output}/assistant-history-tablet.png` });
  await a.setViewportSize({ width: 390, height: 844 });
  await a.getByRole('button', { name: '对话记录', exact: true }).click();
  assert.ok(await a.getByRole('button', { name: `打开助手对话：${first.title}`, exact: true }).isVisible());
  await a.getByRole('button', { name: `打开助手对话：${first.title}`, exact: true }).click();
  assert.equal(await a.getByLabel('问问助手').inputValue(), '为什么切线斜率表示变化率？');
  await assistant.context.close();
  checks.push('助手新建保留旧消息、多会话草稿隔离和刷新恢复、手机历史选择');

  const oldMessages = [{ id: 'legacy-user', text: '旧版提问内容', self: true }, { id: 'legacy-reply', text: '旧版回复内容', self: false }];
  const legacy = await makePage(legacyState({ assistant: oldMessages, drafts: { assistant: '旧版助手草稿' } }), 1194);
  await openAssistant(legacy.page);
  const log = legacy.page.getByRole('log', { name: '学习助手对话' });
  assert.ok((await log.innerText()).includes('旧版提问内容')); assert.ok((await log.innerText()).includes('旧版回复内容'));
  assert.equal(await legacy.page.getByLabel('问问助手').inputValue(), '旧版助手草稿');
  await legacy.page.getByLabel('问问助手').fill('迁移后的助手草稿');
  const migrated = await state(legacy.page);
  for (const message of oldMessages) assert.equal(migrated.assistantThreads.flatMap((thread: any) => thread.messages).filter((candidate: any) => candidate.id === message.id).length, 1);
  await legacy.page.reload(); await openAssistant(legacy.page);
  assert.equal(await legacy.page.getByLabel('问问助手').inputValue(), '迁移后的助手草稿');
  await legacy.page.getByLabel('问问助手').fill('迁移后再刷新');
  const again = await state(legacy.page);
  for (const message of oldMessages) assert.equal(again.assistantThreads.flatMap((thread: any) => thread.messages).filter((candidate: any) => candidate.id === message.id).length, 1);
  await legacy.context.close();
  checks.push('旧版助手消息与草稿迁移保留，刷新后不重复迁移');

  assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
  await fs.writeFile(path.join(output, 'recap-assistant-acceptance.json'), JSON.stringify({ checks, pageErrors, externalRequests }, null, 2));
  console.log(`PASS ${checks.length} recap/assistant groups; no page errors or external requests.`);
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
