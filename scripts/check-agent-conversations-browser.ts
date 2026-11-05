import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const modules = process.env.COGNITION_BROWSER_MODULES;
if (!modules) throw new Error('Set COGNITION_BROWSER_MODULES to an existing Playwright node_modules');
const { chromium } = createRequire(path.join(modules, 'agent-conversations-browser.cjs'))('playwright');
const fakeEngine = `
export async function runAgentTurn(input) {
  const id = input.role.id;
  window.__conversationCalls ||= [];
  window.__conversationCalls.push({id,text:input.userText,history:input.history,focus:input.ctx.getActiveNote()?.id,preferredSkillId:input.preferredSkillId});
  return new Promise((resolve,reject)=>{
    window.__conversationPending ||= {};
    window.__conversationPending[id] = () => resolve({reply:'完成：'+input.userText, updatedHistory:[...input.history,{role:'user',content:input.userText},{role:'assistant',content:'完成：'+input.userText}],toolTrace:[]});
    input.signal.addEventListener('abort',()=>{delete window.__conversationPending[id]; reject(new DOMException('Stopped','AbortError'));},{once:true});
  });
}
export const resumeAgentTurn = runAgentTurn;
export async function resolveAgentApproval(){throw new Error('No approval expected in this fixture');}
`;
const server = await createServer({ configFile: false, cacheDir: 'tmp/agent-conversation-vite-cache', logLevel: 'error',
  optimizeDeps: { entries: ['scripts/fixtures/agent-conversation-preview.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [react(), tailwindcss(), {
  name: 'isolated-agent-conversation-proof', enforce: 'pre',
  load(id) { if (id.replaceAll('\\', '/').endsWith('/src/services/agent/agentEngine.ts')) return fakeEngine; },
  configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url !== '/agent-conversations-proof') return next();
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/agent-conversation-preview.tsx"></script></body></html>');
  }); },
}] });
await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', timeout: 30000 });
console.log('Agent conversation browser: isolated Chrome ready');
const output = path.resolve('tmp/agent-conversation-proof'); await fs.mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, reducedMotion: 'reduce' });
  console.log('Agent conversation browser: isolated context ready');
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors: string[] = [];
  console.log('Agent conversation browser: page ready');
  page.on('pageerror', (error: Error) => { errors.push(error.message); console.error('Agent conversation page error:', error.message); });
  await page.goto(`${origin}/agent-conversations-proof`, { waitUntil: 'commit' });
  console.log('Agent conversation browser: fixture loaded');
  const input = page.getByRole('textbox', { name: '发送给学习助手的消息' }); await input.waitFor(); await input.isEnabled();
  const more = page.getByRole('button', { name: '对话更多操作' });
  assert.ok(await page.locator('.agent-conversations').evaluate(element => element.getBoundingClientRect().height <= 40), 'idle desktop chrome fits one compact row');
  await more.press('Enter'); await page.getByRole('button', { name: '重命名', exact: true }).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await more.evaluate(element => element === document.activeElement), true, 'Escape returns focus without closing the assistant');
  await more.click(); await input.click(); assert.equal(await more.getAttribute('aria-expanded'), 'false', 'outside click closes options');
  await more.click();
  await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('标签名称').fill('教材修订'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await input.fill('教材任务一'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('tab', { name: '教材修订 运行中' }).waitFor();
  await page.getByRole('button', { name: '新建对话标签' }).click();
  await more.click();
  await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('标签名称').fill('认知校订'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '切换页面焦点' }).click();
  assert.equal(await page.locator('.agent-plan-scope').innerText().then(text => text.includes('概率论教材')), true, 'other page focus must not silently rebind');
  await page.getByRole('button', { name: '使用当前页面', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-plan-scope')?.textContent?.includes('我的认知讨论'));
  await input.fill('认知任务二'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('tab', { name: '认知校订 运行中' }).waitFor();
  const calls = await page.evaluate(() => (window as any).__conversationCalls);
  assert.equal(calls.length, 2); assert.equal(calls[0].focus, 'preview-A'); assert.equal(calls[1].focus, 'preview-B');
  assert.deepEqual(calls[1].history, []);
  await page.screenshot({ path: path.join(output, 'parallel-light.png') });
  await page.getByRole('button', { name: '新建对话标签' }).click();
  await input.fill('第三项排队任务'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('tab', { name: '新对话 排队中' }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).__conversationCalls.length), 2, 'queued tab cannot start a third run');
  await page.getByRole('button', { name: '停止本次生成', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('排队中'));
  assert.equal(await page.evaluate(() => Object.keys((window as any).__conversationPending).length), 2, 'cancelling the queue leaves both live runs intact');
  await page.getByRole('button', { name: '收起对话：新对话' }).click();
  await page.getByRole('tab', { name: '教材修订 运行中' }).click();
  await page.getByRole('button', { name: '停止本次生成', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent?.includes('教材修订'))?.textContent?.includes('运行中'));
  assert.equal(await page.evaluate(() => Object.keys((window as any).__conversationPending).length), 1, 'stop A cannot cancel B');
  await page.getByRole('tab', { name: '认知校订 运行中' }).click();
  await page.evaluate(() => Object.values((window as any).__conversationPending).forEach((complete: any) => complete()));
  await page.getByText('完成：认知任务二', { exact: true }).waitFor();
  console.log('Agent conversation browser: parallel sessions verified');
  await input.fill('尚未发送的认知想法');
  await page.getByRole('tab', { name: '教材修订', exact: true }).click();
  assert.ok(!(await input.inputValue()).includes('认知想法'));
  await page.getByRole('tab', { name: '认知校订', exact: true }).click(); assert.equal(await input.inputValue(), '尚未发送的认知想法');
  await page.getByRole('tab', { name: '认知校订', exact: true }).press('ArrowLeft'); await page.getByRole('tab', { name: '教材修订', exact: true }).waitFor();
  await more.click(); await page.getByRole('button', { name: '收起当前标签并保留记录' }).click();
  assert.equal(await page.getByRole('tab').count(), 1);
  await more.click(); await page.getByRole('button', { name: '查看收起的对话' }).click(); await page.getByRole('button', { name: '恢复：教材修订' }).click();
  assert.equal(await page.getByRole('tab').count(), 2);
  await page.getByRole('tab', { name: '认知校订', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('loginote_agent_sessions_v1') || '{}').conversations?.activeId !== 'default');
  await page.waitForTimeout(500); await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('完成：认知任务二', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 2); assert.equal(await page.evaluate(() => (window as any).__conversationCalls?.length || 0), 0, 'restart must not replay requests');
  // Reuse this same conversation, not a clean new tab. Historical dialogue
  // must remain visible while operational history switches to the new object.
  const sendAndInspect = async (text: string) => {
    const count = await page.evaluate(() => (window as any).__conversationCalls?.length || 0);
    await input.fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(expected => (window as any).__conversationCalls?.length === expected, count + 1);
    return page.evaluate(() => (window as any).__conversationCalls.at(-1));
  };
  const finish = async (text: string) => {
    await page.evaluate(() => Object.values((window as any).__conversationPending).forEach((complete: any) => complete()));
    await page.getByText('完成：' + text, { exact: true }).waitFor();
  };
  await page.getByRole('button', { name: '使用当前页面', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-plan-scope')?.textContent?.includes('概率论教材'));
  const firstNew = await sendAndInspect('生成这个项目的教材');
  assert.equal(firstNew.focus, 'preview-A'); assert.deepEqual(firstNew.history, []); assert.equal(firstNew.preferredSkillId, undefined);
  assert(await page.getByText('完成：认知任务二', { exact: true }).isVisible());
  assert(await page.getByRole('button', { name: '使用当前页面', exact: true }).isDisabled(), 'running request keeps its object pinned');
  await finish('生成这个项目的教材');
  const followup = await sendAndInspect('这个教材接下来怎么读');
  assert(JSON.stringify(followup.history).includes('生成这个项目的教材'));
  assert(!JSON.stringify(followup.history).includes('认知任务二'));
  await finish('这个教材接下来怎么读');
  await page.waitForFunction(() => {
    const file = JSON.parse(localStorage.getItem('loginote_agent_sessions_v1') || '{}');
    const session = file.sessions?.[file.conversations?.activeId];
    return session?.contextVersion === 1 && session.previousMessages?.some((message: any) => message.content.includes('认知任务二'))
      && session.messages?.some((message: any) => message.content.includes('这个教材接下来怎么读'));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('完成：认知任务二', { exact: true }).waitFor();
  const restoredFollowup = await sendAndInspect('继续介绍当前教材');
  assert.equal(restoredFollowup.focus, 'preview-A');
  assert(JSON.stringify(restoredFollowup.history).includes('这个教材接下来怎么读'));
  assert(!JSON.stringify(restoredFollowup.history).includes('认知任务二'));
  await finish('继续介绍当前教材');
  await page.getByRole('button', { name: '切换页面焦点' }).click();
  await page.getByRole('button', { name: '使用当前页面', exact: true }).click();
  const switchedBack = await sendAndInspect('检查这个项目的教材状态');
  assert.equal(switchedBack.focus, 'preview-B'); assert.deepEqual(switchedBack.history, [], 'switching back cannot resurrect old task context');
  await finish('检查这个项目的教材状态');
  assert(await page.getByText('完成：生成这个项目的教材', { exact: true }).isVisible());
  assert(await page.getByText('完成：认知任务二', { exact: true }).isVisible());
  // Existing installations may have already persisted a mixed history under
  // the new object's key. Legacy records must be view-only after migration.
  await page.waitForFunction(() => {
    const file = JSON.parse(localStorage.getItem('loginote_agent_sessions_v1') || '{}');
    return file.sessions?.[file.conversations?.activeId]?.messages?.some((message: any) => message.content.includes('检查这个项目的教材状态'));
  });
  await page.evaluate(() => {
    const file = JSON.parse(localStorage.getItem('loginote_agent_sessions_v1')!);
    const session = file.sessions[file.conversations.activeId]; delete session.contextVersion;
    session.activeSkillId = 'personalized-textbook';
    session.messages.push({ role: 'assistant', content: '旧项目遗留状态：三章教材已完成，OLD_JOB_A 不应带入新请求。' });
    localStorage.setItem('loginote_agent_sessions_v1', JSON.stringify(file));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('旧项目遗留状态：三章教材已完成，OLD_JOB_A 不应带入新请求。', { exact: true }).waitFor();
  const migrated = await sendAndInspect('生成这个项目的新教材');
  assert.equal(migrated.focus, 'preview-B'); assert.deepEqual(migrated.history, []); assert.equal(migrated.preferredSkillId, undefined);
  await finish('生成这个项目的新教材');
  console.log('Agent conversation browser: object boundary, restore and switch-back verified');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: path.join(output, 'parallel-dark.png') });
  await page.setViewportSize({ width: 375, height: 820 });
  await page.waitForFunction(() => { const box = document.querySelector('.agent-panel')?.getBoundingClientRect(); return box && box.left >= 0 && box.right <= innerWidth + 2 && box.top >= 0 && box.bottom <= innerHeight + 2; });
  await page.screenshot({ path: path.join(output, 'parallel-mobile.png') });
  assert.ok(await page.locator('.agent-panel-messages').evaluate(element => element.getBoundingClientRect().height > 150));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  assert.ok(await page.locator('.agent-conversations').evaluate(element => element.getBoundingClientRect().height <= 46), 'touch chrome stays a single row');
  assert.ok(await more.evaluate(element => element.getBoundingClientRect().height >= 44));
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: '新建对话标签' }).click();
    await more.click(); await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('标签名称').fill(`很长的独立任务标签，用来验证横向滚动而不换行${index}`);
    await page.getByRole('button', { name: '保存', exact: true }).click();
  }
  assert.ok(await page.locator('.agent-conversation-scroll').evaluate(element => element.scrollWidth > element.clientWidth));
  assert.ok(await page.locator('.agent-conversations').evaluate(element => element.getBoundingClientRect().height <= 46), 'many long tabs never wrap');
  assert.ok(await page.getByRole('tab', { selected: true }).evaluate(element => {
    const tab = element.parentElement!.getBoundingClientRect(), viewport = element.closest('.agent-conversation-scroll')!.getBoundingClientRect();
    return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
  }), 'renaming a wide active tab keeps its title and close control in view');
  await more.click(); await page.screenshot({ path: path.join(output, 'compact-overflow-mobile.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 812, height: 375 });
  await page.waitForFunction(() => { const box = document.querySelector('.agent-panel')?.getBoundingClientRect(); return box && box.left >= 0 && box.right <= innerWidth + 2 && box.top >= 0 && box.bottom <= innerHeight + 2; });
  assert.ok(await input.isVisible());
  await page.getByRole('tab', { name: '认知校订', exact: true }).click();
  await page.getByRole('button', { name: '清空当前聊天记录', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.agent-message').length === 0);
  assert.equal(await page.getByText('完成：生成这个项目的新教材', { exact: true }).count(), 0);
  assert.equal(await page.getByText('旧项目遗留状态：三章教材已完成，OLD_JOB_A 不应带入新请求。', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close(); console.log('Agent conversation browser checks passed (actual panel + tabs, stub model boundary).');
} catch (error) { console.error('Agent conversation browser failed:', error); throw error; }
finally { await browser.close(); await server.close(); }
