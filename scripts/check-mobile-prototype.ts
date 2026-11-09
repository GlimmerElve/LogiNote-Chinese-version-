import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { preview } from 'vite';

// Uses an existing Playwright installation. No production vault, account or AI calls.
const modules = process.env.LOGINOTE_BROWSER_MODULES || process.cwd();
const { chromium } = createRequire(path.join(modules, 'mobile-prototype-check.cjs'))('playwright');
const server = await preview({ configFile: 'scripts/vite-mobile-prototype.config.ts', logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const output = path.resolve('docs/artifacts/mobile/phase-1');
await fs.mkdir(path.join(output, 'screenshots'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [], external: string[] = [], checks: string[] = [];
const key = 'loginote.mobile-prototype.v1';
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true });
  // Browser fixture is literal JS so the TS runner cannot inject name helpers
  // into nested functions serialized across the browser boundary.
  await context.addInitScript({ content: `
    window.__prototypeVoiceRequests = 0;
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: function () { window.__prototypeVoiceRequests++; return Promise.reject(new DOMException('denied by test', 'NotAllowedError')); }
    });
    window.SpeechRecognition = function () { window.__prototypeVoiceRequests++; throw new Error('Browser speech recognition must not start'); };
    window.webkitSpeechRecognition = window.SpeechRecognition;
  ` });
  await context.route('**/*', async (route: any) => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`${origin}/design/mobile-prototype/index.html`, { waitUntil: 'networkidle' });
  const nav = page.getByRole('navigation', { name: '移动端主导航' });
  const go = (label: string) => nav.getByRole('button', { name: label, exact: true }).click();
  const close = () => page.getByRole('button', { name: '关闭弹层' }).click();
  const state = () => page.evaluate((k: string) => JSON.parse(localStorage.getItem(k) || '{}'), key);
  const card = page.getByTestId('discover-card');
  const bubble = page.getByRole('dialog', { name: '复述气泡', exact: true });
  const input = page.getByLabel('用自己的话说说', { exact: true });
  const openBubble = () => card.getByRole('button', { name: '复述', exact: true }).click();
  const closeBubble = () => page.getByRole('button', { name: '收起复述气泡', exact: true }).click();
  const saveBubble = () => page.getByRole('button', { name: '保存复述', exact: true }).click();
  const openRecord = async () => { await go('记录'); await page.getByRole('button', { name: '写一条', exact: true }).click(); };
  await page.screenshot({ path: path.join(output, 'screenshots/discover-390.png') });

  await go('记录');
  await page.getByText('还没有记录', { exact: true }).waitFor();
  assert.equal(await page.locator('.lp-record-row').count(), 0, 'a new prototype has no fabricated personal records');
  await page.screenshot({ path: path.join(output, 'screenshots/records-empty-390.png') });
  await go('发现');

  assert.equal(await card.count(), 1, 'discovery presents one current card');
  const firstSource = await card.getAttribute('data-source-id');
  await page.getByRole('button', { name: '下一张', exact: true }).click();
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') !== source, firstSource);
  await page.getByRole('button', { name: '上一张', exact: true }).click();
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') === source, firstSource);
  await card.focus();
  await card.press('ArrowRight');
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') !== source, firstSource);
  await card.focus();
  await card.press('ArrowLeft');
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') === source, firstSource);
  await card.evaluate((element: HTMLElement) => {
    const startTouch = new Touch({ identifier: 1, target: element, clientX: 280, clientY: 300 });
    const endTouch = new Touch({ identifier: 1, target: element, clientX: 70, clientY: 300 });
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [startTouch], changedTouches: [startTouch] }));
    element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [endTouch] }));
  });
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') !== source, firstSource);
  await page.getByRole('button', { name: '上一张', exact: true }).click();
  await page.waitForFunction((source: string) => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') === source, firstSource);
  checks.push('discovery is a single-card deck with button, keyboard and touch-swipe navigation');

  await page.getByLabel('搜索自己的资料').fill('完全不存在的关键词');
  await page.getByText('没有找到这项内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看全部演示资料' }).click();
  await page.getByLabel('搜索自己的资料').fill('贝叶斯');
  await page.waitForFunction(() => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') === 'bayes');
  await page.getByLabel('清除搜索').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="discover-card"]')?.getAttribute('data-source-id') === 'retrieval');
  await openBubble();
  await bubble.waitFor();
  assert.equal(await bubble.getByRole('heading').count(), 0, 'composer omits a redundant visible title');
  assert.equal(await bubble.locator('.mp-restatement-source').count(), 0, 'source is retained in data without a visible source row');
  assert.equal(await bubble.getByRole('button', { name: '键盘听写', exact: true }).count(), 0);
  assert.equal(await bubble.getByRole('button', { name: '打字', exact: true }).count(), 0);
  assert.equal(await bubble.getByText(/^\d+\s*\/\s*2000$/).count(), 0, 'composer omits the character counter');
  assert.equal(await input.evaluate((el: HTMLElement) => el === document.activeElement), false, 'opening the bubble does not focus the editor or request the keyboard');
  assert.equal(await page.getByRole('button', { name: '收起复述气泡', exact: true }).evaluate((el: HTMLElement) => el === document.activeElement), true, 'initial dialog focus stays on a non-editable control');
  await input.click();
  assert.equal(await input.evaluate((el: HTMLElement) => el === document.activeElement), true, 'tapping the editor naturally focuses the editable field');
  assert.equal(await bubble.evaluate((el: HTMLElement) => getComputedStyle(el).animationDuration), '0s', 'reduced-motion preference disables the pop animation');
  await input.fill('我把提取练习理解为先独立回忆，再用资料纠正遗漏。');
  await page.screenshot({ path: path.join(output, 'screenshots/capture-390.png') });

  const voice = page.getByRole('button', { name: '按住说话', exact: true });
  const voiceDemo = page.getByTestId('voice-demo');
  const voiceDraft = await input.inputValue();
  const voiceBefore = await state();
  await voice.click();
  assert.equal(await voiceDemo.getAttribute('data-phase'), 'idle', 'a short tap never starts a hold-to-talk session');
  assert.equal(await input.inputValue(), voiceDraft);
  const pressVoice = async () => {
    // Feedback changes the dialog height; wait for the button's final hit box
    // before holding rather than using a coordinate from a moving layout.
    await voice.hover();
    const box = await voice.boundingBox();
    assert.ok(box);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'recording');
    return box;
  };
  await pressVoice();
  assert.equal(await input.evaluate((el: HTMLElement) => el === document.activeElement), false, 'holding the voice button does not focus the editor');
  await page.screenshot({ path: path.join(output, 'screenshots/voice-hold-390.png') });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  await bubble.getByRole('status').filter({ hasText: '语音演示已结束' }).waitFor();
  assert.equal(await input.inputValue(), voiceDraft, 'finishing the demo never inserts a fabricated transcript');
  assert.equal((await state()).records.length, voiceBefore.records.length, 'voice release does not save a record');

  const cancelBox = await pressVoice();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2 - 90);
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'canceling');
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  assert.equal(await input.inputValue(), voiceDraft, 'slide-up cancellation preserves the existing draft');

  await pressVoice();
  await voice.evaluate((element: HTMLElement) => element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, isPrimary: true, bubbles: true })));
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  await pressVoice();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  await pressVoice();
  await voice.evaluate((element: HTMLElement) => element.releasePointerCapture(1));
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  await pressVoice();
  await page.evaluate(`
    window.__originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    window.__originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    if (window.__originalVisibilityDescriptor) Object.defineProperty(document, 'visibilityState', window.__originalVisibilityDescriptor);
    else delete document.visibilityState;
    if (window.__originalHiddenDescriptor) Object.defineProperty(document, 'hidden', window.__originalHiddenDescriptor);
    else delete document.hidden;
  `);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  assert.equal(await input.inputValue(), voiceDraft, 'interrupted voice gestures do not overwrite typed text');

  await voice.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'recording');
  await page.keyboard.up('Space');
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-demo"]')?.getAttribute('data-phase') === 'idle');
  assert.equal(await page.evaluate(() => (window as any).__prototypeVoiceRequests), 0, 'gesture prototype never invokes microphone or speech-recognition APIs');
  assert.equal(await input.inputValue(), voiceDraft);
  checks.push('hold-to-talk separates short tap, held voice, release and slide-up cancellation; pointer cancellation/capture loss/blur/hidden/keyboard release preserve drafts without microphone calls or fake transcripts');
  await closeBubble();
  await page.getByRole('button', { name: '下一张', exact: true }).click();
  await openBubble();
  assert.equal(await input.inputValue(), '我把提取练习理解为先独立回忆，再用资料纠正遗漏。');
  assert.equal((await state()).draftSource, 'retrieval', 'opening another card does not rebind an unfinished draft');
  await closeBubble();
  await page.getByRole('button', { name: '上一张', exact: true }).click();
  await openBubble();
  await saveBubble();
  assert.equal((await state()).records.length, 1);
  assert.equal((await state()).records[0].sourceId, 'retrieval');
  assert.equal((await state()).pending.length, 1);
  assert.equal(await bubble.count(), 0);
  assert.equal(await nav.getByRole('button', { name: '发现', exact: true }).getAttribute('aria-current'), 'page', 'saving stays on discovery');
  assert.equal(await card.getAttribute('data-source-id'), 'retrieval', 'saving preserves the current card');
  await openBubble();
  await input.fill('未提交的草稿也应该保留。');
  await closeBubble();
  await page.reload({ waitUntil: 'networkidle' });
  await openRecord();
  assert.equal(await input.inputValue(), '未提交的草稿也应该保留。');
  assert.equal((await state()).records.length, 1);
  await closeBubble();
  checks.push('search, in-place restatement bubble, editor tap-only focus, reduced motion and source-bound draft/record recovery');

  const recordSearch = page.getByRole('textbox', { name: '搜索记录', exact: true });
  await recordSearch.fill('完全没有的记录关键词');
  await page.getByText('没有匹配的记录', { exact: true }).waitFor();
  assert.equal(await page.locator('.lp-record-row').count(), 0);
  await recordSearch.fill('提取练习');
  await page.waitForFunction(() => document.querySelectorAll('.lp-record-row').length === 1);
  const firstRecordId = (await state()).records[0].id;
  await page.locator(`.lp-record-row[data-record-id="${firstRecordId}"]`).click();
  await page.getByRole('dialog').getByText('我把提取练习理解为先独立回忆，再用资料纠正遗漏。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'screenshots/record-detail-390.png') });
  await close();
  await recordSearch.fill('');
  await page.getByRole('button', { name: '继续草稿', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'screenshots/records-390.png') });
  checks.push('records show a genuine empty state, searchable saved rows, full detail and a resumable draft');

  await go('练习');
  assert.equal(await page.locator('.mp-answer').count(), 0, 'no answer explanation before submission');
  await page.screenshot({ path: path.join(output, 'screenshots/practice-question-390.png') });
  await page.locator('.mp-options button').nth(1).click();
  await page.getByRole('button', { name: '提交作答', exact: true }).click();
  await page.getByText('回答正确', { exact: true }).waitFor();
  assert.equal((await state()).answers.q1, 1);
  await page.screenshot({ path: path.join(output, 'screenshots/practice-390.png') });
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '提交作答', exact: true }).isDisabled(), true, 'a selected option is not carried to a different question');
  await page.getByRole('button', { name: '第 1 题', exact: true }).click();
  await page.getByRole('button', { name: '查看来源资料', exact: true }).click();
  await page.getByRole('dialog', { name: '阅读', exact: true }).getByText('为什么「想起来」比「再看一遍」更有效？', { exact: true }).waitFor();
  await close();
  checks.push('quiz reveals explanation only after submission and stores an isolated demo answer');

  await go('计划');
  const initialCount = (await state()).tasks.length;
  await page.getByRole('button', { name: '新计划', exact: true }).click();
  await page.getByLabel('你的目标').fill('理解概率');
  await page.getByRole('button', { name: '生成演示草案', exact: true }).click();
  assert.equal((await state()).tasks.length, initialCount, 'preview cannot mutate the plan');
  await page.screenshot({ path: path.join(output, 'screenshots/plan-draft-390.png') });
  await close();
  assert.equal((await state()).tasks.length, initialCount, 'cancelled preview is passive');
  await page.getByRole('button', { name: '新计划', exact: true }).click();
  await page.getByRole('button', { name: '生成演示草案', exact: true }).click();
  const newPlanDialog = page.getByRole('dialog', { name: '新计划', exact: true });
  await page.evaluate(() => { (window as any).__planSaveSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: '确认加入演示计划', exact: true }).click();
  await newPlanDialog.getByRole('alert').filter({ hasText: '本机保存失败' }).waitFor();
  assert.equal((await state()).tasks.length, initialCount, 'failed plan confirmation cannot add tasks');
  assert.equal(await newPlanDialog.isVisible(), true, 'plan errors are visible inside the active modal');
  assert.equal(await page.getByLabel('你的目标').inputValue(), '理解概率');
  assert.equal(await newPlanDialog.locator('.sp-plan-draft > div').count(), 3, 'the complete preview remains available for retry');
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__planSaveSetItem; });
  await page.getByRole('button', { name: '确认加入演示计划', exact: true }).click();
  assert.equal((await state()).tasks.length, initialCount + 3);
  await page.getByRole('button', { name: '完成：读懂提取练习的作用', exact: true }).click();
  assert.equal((await state()).tasks[0].done, true);
  await page.getByRole('button', { name: '查看同步状态', exact: true }).click();
  await page.getByLabel('模拟计划冲突', { exact: true }).check();
  await close();
  await page.getByRole('button', { name: '调整：读懂提取练习的作用', exact: true }).click();
  await page.getByLabel('调整到').selectOption('本周末');
  assert.equal((await state()).tasks[0].day, '今天');
  await page.screenshot({ path: path.join(output, 'screenshots/plan-adjust-390.png') });
  await page.getByRole('button', { name: '确认这次调整', exact: true }).click();
  await page.getByText('计划已更新，草案已保留', { exact: true }).waitFor();
  assert.equal((await state()).tasks[0].day, '今天', 'conflicting draft never overwrites the plan');
  assert.equal(await page.getByLabel('调整到').inputValue(), '本周末');
  await page.getByRole('button', { name: '按新版本重新预览', exact: true }).click();
  await page.evaluate(() => { (window as any).__planSaveSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: '确认这次调整', exact: true }).click();
  await page.getByRole('dialog', { name: '调整日期', exact: true }).getByRole('alert').filter({ hasText: '本机保存失败' }).waitFor();
  assert.equal((await state()).tasks[0].day, '今天', 'failed rescheduling cannot change the persisted task date');
  assert.equal(await page.getByLabel('调整到').inputValue(), '本周末', 'the requested date remains in the modal after failure');
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__planSaveSetItem; });
  await page.getByRole('button', { name: '确认这次调整', exact: true }).click();
  assert.equal((await state()).tasks[0].day, '本周末');
  assert.equal(await page.getByRole('button', { name: '打开任务：读懂提取练习的作用', exact: true }).count(), 0, 'today view excludes a task moved to the weekend');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('button', { name: '打开任务：读懂提取练习的作用', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'screenshots/plan-390.png') });
  await page.getByRole('button', { name: '打开任务：读懂提取练习的作用', exact: true }).click();
  await page.getByRole('dialog', { name: '阅读', exact: true }).waitFor();
  await close();
  checks.push('plan today/all groups, task launch, preview/confirmation, cancellation and simulated conflict preserve the plan and draft');
  checks.push('plan creation and rescheduling failures surface inside the modal, preserve the preview/date, and succeed once on retry');

  await go('消息');
  await page.screenshot({ path: path.join(output, 'screenshots/messages-390.png') });
  await page.getByRole('button', { name: '打开会话搜索', exact: true }).click();
  const messageSearch = page.getByRole('textbox', { name: '搜索会话', exact: true });
  await messageSearch.fill('林');
  await page.waitForFunction(() => document.querySelectorAll('.mx-conversation-item').length === 1);
  await messageSearch.fill('不存在的同伴');
  await page.waitForFunction(() => document.querySelectorAll('.mx-conversation-item').length === 0);
  await messageSearch.fill('');
  await page.waitForFunction(() => document.querySelectorAll('.mx-conversation-item').length === 2);
  await page.locator('.mp-conversation-item').first().click();
  assert.equal(await page.getByLabel('演示聊天消息').evaluate((element: HTMLElement) => element === document.activeElement), false, 'opening a conversation does not bring up the text keyboard');
  await page.getByLabel('演示聊天消息').fill('私信里没写完的草稿');
  await page.getByRole('button', { name: '返回消息列表', exact: true }).click();
  await page.locator('.mp-conversation-item').nth(1).click();
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '', 'a draft cannot leak into a different conversation');
  await page.getByLabel('演示聊天消息').fill('共学群里没写完的草稿');
  await page.getByRole('button', { name: '返回消息列表', exact: true }).click();
  await page.locator('.mp-conversation-item').first().click();
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '私信里没写完的草稿');
  await page.getByLabel('演示聊天消息').fill('这个例子很有帮助。');
  assert.ok(await page.getByLabel('演示聊天消息').evaluate((element: HTMLTextAreaElement) => element.scrollHeight <= element.clientHeight + 1), 'a one-line message does not get an unnecessary vertical scrollbar');
  await page.evaluate(() => { (window as any).__messageSaveSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: '发送演示消息', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '本机保存失败' }).waitFor();
  assert.equal((await state()).messages.length, 0, 'a failed local send does not append a message');
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '这个例子很有帮助。', 'failed sends keep the editable draft');
  assert.equal((await state()).messageDrafts.lin, '这个例子很有帮助。');
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__messageSaveSetItem; });
  await page.getByRole('button', { name: '发送演示消息', exact: true }).click();
  assert.equal((await state()).messages.length, 1);
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '', 'only a persisted local send clears its own composer');
  await page.reload({ waitUntil: 'networkidle' });
  await go('消息');
  await page.locator('.mp-conversation-item').nth(1).click();
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '共学群里没写完的草稿', 'each conversation draft survives reload');
  await page.getByRole('button', { name: '返回消息列表', exact: true }).click();
  await page.locator('.mp-conversation-item').first().click();
  assert.equal(await page.getByLabel('演示聊天消息').inputValue(), '');
  await page.getByRole('button', { name: '举报与屏蔽', exact: true }).click();
  await page.getByRole('button', { name: '在原型中屏蔽此会话', exact: true }).click();
  assert.equal(await page.getByLabel('演示聊天消息').count(), 0);
  await page.getByRole('button', { name: '解除屏蔽', exact: true }).click();
  await page.getByLabel('演示聊天消息').waitFor();
  await page.screenshot({ path: path.join(output, 'screenshots/chat-390.png') });
  checks.push('messages support search and per-conversation drafts; local-only send, report/block and unblock preserve the expected composer state');
  checks.push('failed message sends retain their conversation draft, append nothing, and retry without duplicate messages or single-line scrollbars');

  await page.getByRole('button', { name: '查看同步状态', exact: true }).click();
  await page.getByLabel('模拟离线', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: '模拟服务器回执', exact: true }).isDisabled(), true);
  await close();
  await openRecord();
  await input.fill('离线时也可以留下这条理解。');
  await saveBubble();
  assert.equal((await state()).records.length, 2);
  await page.getByRole('button', { name: '查看同步状态', exact: true }).click();
  await page.getByLabel('模拟离线', { exact: true }).uncheck();
  await page.getByRole('button', { name: '模拟服务器回执', exact: true }).click();
  assert.equal((await state()).pending.length, 0);
  assert.ok((await state()).receipts > 0);
  await close();
  await page.getByRole('button', { name: '账号与隐私', exact: true }).click();
  await page.getByRole('button', { name: '查看账号删除流程', exact: true }).click();
  await page.getByText('原型没有真实账号。', { exact: true }).waitFor();
  await close();
  checks.push('simulated offline recording, local-only receipt, account-deletion design entry');

  await page.getByRole('button', { name: '账号与隐私', exact: true }).click();
  await page.getByRole('button', { name: '隐私与 AI 使用', exact: true }).click();
  await page.getByRole('button', { name: '体验 AI 授权流程（不发送）', exact: true }).click();
  await page.getByRole('button', { name: '暂不发送', exact: true }).click();
  await page.getByText('未授权', { exact: true }).waitFor();
  await page.getByRole('button', { name: '体验 AI 授权流程（不发送）', exact: true }).click();
  await page.getByRole('button', { name: '模拟同意本次用途', exact: true }).click();
  await page.getByText('已允许（演示）', { exact: true }).waitFor();
  await page.getByRole('button', { name: '撤回演示授权', exact: true }).click();
  await page.getByText('未授权', { exact: true }).waitFor();
  await close();
  checks.push('AI-consent preview supports refusal, acceptance and withdrawal without data transmission');

  // Fault injection: failed persistence must preserve draft and never claim success.
  await openRecord();
  await input.fill('存储失败时必须保留我的文字。');
  const beforeFailure = await state();
  await page.evaluate(() => { (window as any).__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
  await saveBubble();
  await bubble.getByRole('alert').filter({ hasText: '本机保存失败' }).waitFor();
  assert.equal(await input.inputValue(), '存储失败时必须保留我的文字。');
  assert.equal(await bubble.isVisible(), true, 'save failure keeps the bubble open');
  assert.equal((await state()).records.length, beforeFailure.records.length);
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__originalSetItem; });
  await saveBubble();
  assert.equal((await state()).records.length, beforeFailure.records.length + 1);
  checks.push('storage failure keeps draft, does not add a record, and supports retry');

  // The pre-redesign schema has no messageDrafts map. Existing personal data
  // must remain readable rather than being mistaken for corrupt storage.
  const legacyCount = (await state()).records.length;
  await page.evaluate((k: string) => {
    const data = JSON.parse(localStorage.getItem(k)!);
    delete data.messageDrafts;
    localStorage.setItem(k, JSON.stringify(data));
  }, key);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal((await state()).records.length, legacyCount);
  assert.equal(await page.getByRole('alert').count(), 0, 'legacy data without message drafts loads without recovery warnings');
  checks.push('the previous prototype storage schema remains compatible after adding per-conversation drafts');

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const label of ['练习', '记录', '消息', '计划']) {
      await go(label);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} has no horizontal overflow at ${width}px`);
      assert.ok(await nav.evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1; }), `${label} navigation stays visible at ${width}px`);
      const selector = label === '练习' ? '.lp-practice-actions' : label === '记录' ? '.lp-add' : label === '消息' ? '.mx-list-header' : '.pl-header';
      assert.ok(await page.locator(selector).evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1; }), `${label} controls remain within the ${width}px viewport`);
      if (width === 390 && label !== '练习') {
        const name = label === '记录' ? 'records-390.png' : label === '消息' ? 'messages-390.png' : 'plan-today-390.png';
        await page.screenshot({ path: path.join(output, 'screenshots', name) });
      }
    }
    await go('消息');
    await page.locator('.mp-conversation-item').first().click();
    await page.setViewportSize({ width, height: 568 });
    assert.ok(await page.getByLabel('演示聊天消息').evaluate((element: HTMLTextAreaElement) => element.scrollHeight <= element.clientHeight + 1), `the empty single-line composer has no vertical overflow at ${width}px`);
    assert.ok(await page.locator('.mx-composer').evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); const bottom = document.querySelector('.mp-bottom-nav')!.getBoundingClientRect().top; return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= bottom + 1; }), `chat composer stays above navigation in a short ${width}px viewport`);
    await page.setViewportSize({ width, height: 844 });
  }
  checks.push('practice, records, messages and plan layouts fit 320/390/430px; chat composer survives a 568px short viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '账号与隐私', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'screenshots/account-390.png') });
  await close();

  await page.reload({ waitUntil: 'networkidle' });
  await go('发现');
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width >= 768 ? 1000 : 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
    assert.ok(await nav.isVisible());
    assert.ok(await nav.evaluate((element: HTMLElement) => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; }), `navigation visible at ${width}px`);
  }
  await page.screenshot({ path: path.join(output, 'screenshots/studio-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '协同架构', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'screenshots/architecture-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '实施路线', exact: true }).click();
  await page.getByText('正式提审与运营', { exact: true }).waitFor();
  checks.push('320/375/390/430/768/1440px layouts and persistent bottom navigation; architecture and roadmap views');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [key], 'writes only the prototype storage namespace');

  const corrupt = '{recoverable original prototype data';
  await page.evaluate(({ k, raw }: { k: string; raw: string }) => localStorage.setItem(k, raw), { k: key, raw: corrupt });
  await page.reload({ waitUntil: 'networkidle' });
  await openRecord();
  await input.fill('异常缓存先备份，再保存新记录。');
  const backups = await page.evaluate((k: string) => Object.keys(localStorage).filter(x => x.startsWith(k + '.recovery.')).map(x => localStorage.getItem(x)), key);
  assert.deepEqual(backups, [corrupt]);
  await saveBubble();
  assert.equal((await state()).records.length, 1);
  checks.push('corrupt prototype cache is backed up before any replacement write');

  const animatedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference', hasTouch: true });
  await animatedContext.route('**/*', async (route: any) => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const animatedPage = await animatedContext.newPage();
  animatedPage.on('pageerror', (e: Error) => errors.push(e.message));
  await animatedPage.goto(`${origin}/design/mobile-prototype/index.html`, { waitUntil: 'networkidle' });
  await animatedPage.getByTestId('discover-card').getByRole('button', { name: '复述', exact: true }).click();
  const animatedBubble = animatedPage.getByRole('dialog', { name: '复述气泡', exact: true });
  assert.equal(await animatedBubble.evaluate((element: HTMLElement) => getComputedStyle(element).animationName), 'mp-bubble-open');
  await animatedPage.getByLabel('用自己的话说说', { exact: true }).fill('先用自己的话说一遍，再回看资料。');
  await animatedPage.screenshot({ path: path.join(output, 'screenshots/restatement-motion-390.png') });
  assert.ok(await animatedBubble.evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }), 'bubble remains inside the phone viewport');
  await animatedContext.close();
  checks.push('standard motion plays the bubble-opening animation and keeps the editor inside the viewport');
  assert.deepEqual(external, [], 'all browser requests remain on the local preview origin');
  assert.deepEqual(errors, [], 'no runtime errors');
  await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({ result: 'passed', checkedAt: new Date().toISOString(), scope: 'isolated synthetic prototype, desktop Chrome emulated viewport; not Android/iOS device verification', checks, consoleErrors: errors, unexpectedExternalRequests: external }, null, 2));
  console.log(JSON.stringify({ result: 'passed', checks, artifacts: output }, null, 2));
  await context.close();
} finally { await browser.close(); await new Promise<void>((resolve, reject) => server.httpServer.close(e => e ? reject(e) : resolve())); }
