import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

// This harness is served only by this check. Production builds receive the real
// apps/android platform adapter and do not expose any of the test controls below.
const harness = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {configureMobilePlatform} from '/src/mobile-prototype/mobile-platform.ts';
import '/src/styles/design-tokens.css';
import '@fontsource-variable/noto-serif-sc';
const nativeKey='loginote.test.native-recorder';
let store=JSON.parse(localStorage.getItem(nativeKey)||'{"recordings":[],"active":null}');
let restoredPhoto;
const controls={failStart:false,failStop:false,failDelete:false,deferPhoto:false,photoPending:null,calls:{start:0,pause:0,resume:0,stop:0,photo:0,delete:0},
  recordings:()=>store.recordings,
  setRecordings(records){store={recordings:records,active:null};localStorage.setItem(nativeKey,JSON.stringify(store));},
  current(){return status();},
  restorePhoto(){if(restoredPhoto)restoredPhoto(photo());},
  resolvePhoto(){if(controls.photoPending){const done=controls.photoPending;controls.photoPending=null;done();}}
};
window.__nativeHarness=controls;
function save(){localStorage.setItem(nativeKey,JSON.stringify(store));}
function status(){const record=store.recordings.find(r=>r.id===store.active);if(!record)return {state:'idle',durationMs:0};return {...record,durationMs:record.durationMs+(record.state==='recording'?Math.max(0,Date.now()-(record.startedAt||Date.now())):0)};}
function setCurrent(state){const current=status();if(!current.id)throw Error('没有活动录音');const record={...current,state,startedAt:state==='recording'?Date.now():null};store.recordings=store.recordings.map(r=>r.id===record.id?record:r);save();return {...record};}
function photo(){const data=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='),c=>c.charCodeAt(0));return new File([data],'课堂板书.png',{type:'image/png'});}
const wav=new Uint8Array(44+800);const view=new DataView(wav.buffer);function word(offset,text){for(let i=0;i<text.length;i++)wav[offset+i]=text.charCodeAt(i);}word(0,'RIFF');view.setUint32(4,wav.length-8,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);word(36,'data');view.setUint32(40,800,true);wav.fill(128,44);const audioUrl=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));
configureMobilePlatform({isNative:true,recorder:{
 async start(options){controls.calls.start++;if(controls.failStart)throw Error('麦克风权限未授予');const record={id:options.id,title:options.title,state:'recording',durationMs:0,fileUri:'file:///data/user/0/app.loginote.mobile/files/'+options.id+'.m4a',startedAt:Date.now()};store.recordings=[...store.recordings.filter(r=>r.id!==record.id),record];store.active=record.id;save();return {...record};},
 async pause(){controls.calls.pause++;return setCurrent('paused');},
 async resume(){controls.calls.resume++;return setCurrent('recording');},
 async stop(){controls.calls.stop++;if(controls.failStop)throw Error('录音文件暂时无法关闭');return setCurrent('stopped');},
 async getStatus(){return status();},
 async listRecordings(){return {recordings:store.recordings.map(record=>record.id===store.active?status():({...record}))};},
 async deleteRecording(options){controls.calls.delete++;if(controls.failDelete)throw Error('录音删除暂时失败');const record=store.recordings.find(record=>record.id===options.id);if(record&&['recording','paused'].includes(record.state))throw Error('请先结束录音');store.recordings=store.recordings.filter(record=>record.id!==options.id);if(store.active===options.id)store.active=null;save();}
},async takePhoto(){controls.calls.photo++;if(controls.deferPhoto)return new Promise(resolve=>{controls.photoPending=()=>resolve(photo());});return photo();},fileUrl(){return audioUrl;},onRestoredPhoto(handler){restoredPhoto=handler;return()=>{restoredPhoto=undefined;};}});
const {InteractiveApp}=await import('/src/mobile-prototype/InteractiveApp.tsx');
createRoot(document.getElementById('root')).render(React.createElement(InteractiveApp));
</script></body></html>`;

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.cwd(), 'android-mobile-check.cjs'))('playwright');
const server = await createServer({
  configFile: 'scripts/vite-mobile-prototype.config.ts',
  appType: 'custom', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
  plugins: [{ name: 'android-test-harness', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__android_test.html')) return next();
      try { response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await vite.transformIndexHtml('/__android_test.html', harness)); }
      catch (error) { next(error); }
    });
  } }],
});
await server.listen();
const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const key = 'loginote.interactions.v2';
const output = 'docs/artifacts/mobile/android';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks: string[] = [], errors: string[] = [], external: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route: any) => { const url = route.request().url(); if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) { external.push(url); await route.abort(); } else await route.continue(); });
  const page = await context.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message)); page.on('dialog', (dialog: any) => dialog.accept());
  const state = () => page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '{}'), key);
  const open = async () => { await page.goto(`${origin}/__android_test.html`); await page.waitForFunction(() => document.querySelector('nav[aria-label="主导航"]') || [...document.querySelectorAll('button')].some(button => button.textContent === '开始本机使用')); const entry = page.getByRole('button', { name: '开始本机使用', exact: true }); if (await entry.isVisible()) await entry.click(); await page.getByRole('navigation', { name: '主导航' }).waitFor(); };
  const back = () => page.evaluate(() => { const detail = { handled: false }; window.dispatchEvent(new CustomEvent('loginote:native-back', { detail })); return detail.handled; });
  const nav = async (name: string) => {
    const navigation = page.getByRole('navigation', { name: '主导航' });
    for (let step = 0; step < 5 && !await navigation.isVisible(); step++) {
      const previous = page.getByRole('button', { name: '返回上一页', exact: true });
      const normal = page.getByRole('button', { name: '返回', exact: true });
      if (await previous.isVisible()) await previous.click();
      else if (await normal.isVisible()) await normal.click();
      else await page.getByRole('button', { name: '返回首页', exact: true }).click();
    }
    await navigation.getByRole('button', { name, exact: true }).click();
  };
  const openAssistant = async () => { if (await page.getByLabel('问问助手').isVisible()) return; const entry = page.getByRole('button', { name: '打开学习助手', exact: true }); if (!await entry.isVisible()) await nav('首页'); await entry.click(); await page.getByLabel('问问助手').waitFor(); };
  const tasksHome = async () => { const detailBack = page.getByRole('button', { name: '返回任务列表', exact: true }); if (await detailBack.isVisible()) await detailBack.click(); await page.getByRole('button', { name: '返回首页', exact: true }).click(); };
  await open();
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button').count(), 5);
  assert.equal(await page.getByLabel('密码', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开我的', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '我的', exact: true }).count(), 1);
  assert.equal(await page.getByLabel('问问助手').isVisible(), false);
  await page.evaluate(() => { (window as any).__nativeHarness.failStart = true; });
  await page.getByRole('button', { name: '录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="alert"]') !== null);
  assert.ok(!(await state()).session, 'permission failure must not create an empty classroom');
  assert.equal(await page.locator('.ix-recording').count(), 0);
  checks.push('Android 本机入口不创建假账号，麦克风拒绝不生成空课堂');

  await page.evaluate(() => { (window as any).__nativeHarness.failStart = false; });
  await page.getByRole('button', { name: '录音', exact: true }).click();
  await page.locator('.ix-recording').waitFor();
  assert.ok((await page.locator('.ix-recording').innerText()).includes('录音中'));
  assert.ok(!(await page.locator('.ix-recording').innerText()).includes('未录音'));
  await page.getByLabel('课堂标题').fill('导数课堂');
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.waitForFunction(() => (window as any).__nativeHarness.current().state === 'paused');
  assert.equal((await state()).session.started, null);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.waitForFunction(() => (window as any).__nativeHarness.current().state === 'recording');
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await page.waitForFunction((key: string) => JSON.parse(localStorage.getItem(key) || '{}').session?.photos.length === 1, key);
  assert.equal(await page.evaluate(() => (window as any).__nativeHarness.calls.photo), 1);
  await page.screenshot({ path: `${output}/native-recording-phone.png` });
  checks.push('原生录音开始、暂停、继续及照片归入同一课堂');

  await page.evaluate(() => { (window as any).__nativeHarness.failStop = true; });
  await page.getByRole('button', { name: '结束并保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="alert"]') !== null);
  assert.ok((await state()).session, 'stop failure must preserve the classroom');
  await page.evaluate(() => { (window as any).__nativeHarness.failStop = false; });
  await page.getByRole('button', { name: '结束并保存', exact: true }).click();
  await page.waitForFunction((key: string) => !JSON.parse(localStorage.getItem(key) || '{}').session, key);
  const recorded = (await state()).notes.find((note: any) => note.title === '导数课堂');
  assert.ok(recorded?.audioUri?.startsWith('file:///'));
  assert.equal(recorded.photos.length, 1);
  assert.ok(recorded.duration >= 1);
  await page.locator('audio').waitFor({ state: 'attached' });
  assert.ok(await page.locator('audio').getAttribute('src'));
  assert.ok(await back());
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  checks.push('原生停止失败可重试，成功归档音频 URI 与照片并提供回听');

  const restored = [
    { id: 'stopped-class', title: '已结束的课堂', state: 'stopped', durationMs: 64000, fileUri: 'file:///data/user/0/app.loginote.mobile/files/stopped-class.m4a' },
    { id: 'interrupted-class', title: '中断后恢复的课堂', state: 'interrupted', durationMs: 72000, fileUri: 'file:///data/user/0/app.loginote.mobile/files/interrupted-class.m4a' },
    { id: recorded.id, title: recorded.title, state: 'stopped', durationMs: recorded.duration * 1000, fileUri: recorded.audioUri },
  ];
  await page.evaluate((records: any[]) => (window as any).__nativeHarness.setRecordings(records), restored);
  await open();
  await page.waitForFunction(({ key }: { key: string }) => JSON.parse(localStorage.getItem(key) || '{}').notes?.some((note: any) => note.id === 'interrupted-class'), { key });
  await open();
  const recovered = (await state()).notes;
  assert.equal(recovered.filter((note: any) => note.id === 'stopped-class').length, 1);
  assert.equal(recovered.filter((note: any) => note.id === 'interrupted-class').length, 1);
  assert.equal(recovered.filter((note: any) => note.id === recorded.id).length, 1);
  checks.push('停止及中断录音恢复，重新打开不重复导入已有记录');

  await nav('记录'); await page.getByRole('button', { name: /^已结束的课堂/ }).click();
  await page.getByRole('button', { name: '记录更多操作', exact: true }).click();
  await page.getByRole('button', { name: '删除记录', exact: true }).click();
  const beforeDeleteCalls = await page.evaluate(() => (window as any).__nativeHarness.calls.delete);
  await page.evaluate(() => { const original = Storage.prototype.setItem; (window as any).__storageOriginal = original; Storage.prototype.setItem = function (key, value) { if (key === 'loginote.interactions.v2') throw Error('test quota'); return original.call(this, key, value); }; });
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).__nativeHarness.calls.delete), beforeDeleteCalls, 'failed deletion-intent persistence must not delete the native recording');
  assert.ok((await state()).notes.some((note: any) => note.id === 'stopped-class'));
  assert.ok(!(await state()).pendingRecordingDeletes.includes('stopped-class'));
  assert.ok((await page.evaluate(() => (window as any).__nativeHarness.recordings())).some((record: any) => record.id === 'stopped-class'));
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__storageOriginal; });
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction((key: string) => { const data = JSON.parse(localStorage.getItem(key) || '{}'); return data.dismissedRecordingIds?.includes('stopped-class') && !data.pendingRecordingDeletes?.includes('stopped-class') && !data.notes.some((note: any) => note.id === 'stopped-class'); }, key);
  assert.ok(!(await state()).notes.some((note: any) => note.id === 'stopped-class'));
  assert.ok(!(await page.evaluate(() => (window as any).__nativeHarness.recordings())).some((record: any) => record.id === 'stopped-class'));
  await page.evaluate((records: any[]) => (window as any).__nativeHarness.setRecordings(records), restored);
  await open();
  assert.ok(!(await state()).notes.some((note: any) => note.id === 'stopped-class'), 'native stale metadata must not resurrect a deleted recording');
  checks.push('删除同时处理原生文件与本机记录，tombstone 防止恢复时复活');

  await nav('记录'); await page.getByRole('button', { name: /^中断后恢复的课堂/ }).click();
  await page.getByRole('button', { name: '记录更多操作', exact: true }).click(); await page.getByRole('button', { name: '删除记录', exact: true }).click();
  await page.evaluate(() => { (window as any).__nativeHarness.failDelete = true; });
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('button', { name: '重试删除', exact: true }).waitFor();
  assert.ok((await state()).pendingRecordingDeletes.includes('interrupted-class'));
  assert.ok((await state()).dismissedRecordingIds.includes('interrupted-class'));
  assert.ok((await page.evaluate(() => (window as any).__nativeHarness.recordings())).some((record: any) => record.id === 'interrupted-class'));
  assert.equal(await page.getByRole('button', { name: /^中断后恢复的课堂/ }).count(), 0, 'pending deletion should be hidden from the list');
  await page.evaluate(() => { (window as any).__nativeHarness.failDelete = false; });
  await page.getByRole('button', { name: '重试删除', exact: true }).click();
  await page.waitForFunction((key: string) => { const data = JSON.parse(localStorage.getItem(key) || '{}'); return data.pendingRecordingDeletes?.length === 0 && !data.notes.some((note: any) => note.id === 'interrupted-class'); }, key);
  assert.ok(!(await page.evaluate(() => (window as any).__nativeHarness.recordings())).some((record: any) => record.id === 'interrupted-class'));
  await page.evaluate((records: any[]) => (window as any).__nativeHarness.setRecordings(records), restored);
  await open();
  await page.waitForTimeout(1650);
  assert.equal((await state()).pendingRecordingDeletes.length, 0);
  assert.ok(!(await state()).notes.some((note: any) => ['stopped-class', 'interrupted-class'].includes(note.id)), 'poll and reload must preserve deletion tombstones');
  checks.push('删除意图写失败保留原音频；原生删除失败持久化待重试，重试完成清队列且刷新不复活');

  await openAssistant();
  assert.equal(await page.getByRole('button', { name: '录音', exact: true }).count(), 0);
  await page.getByLabel('问问助手').fill('尚未发送的学习问题');
  assert.ok(await back()); await page.getByRole('button', { name: '打开学习助手', exact: true }).waitFor();
  await page.getByRole('button', { name: '查看我的任务', exact: true }).click();
  await page.getByRole('region', { name: '我的任务', exact: true }).waitFor();
  assert.ok(await back()); await page.getByRole('button', { name: '打开学习助手', exact: true }).waitFor();
  await openAssistant();
  assert.equal(await page.getByLabel('问问助手').inputValue(), '尚未发送的学习问题');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('loginote:native-keyboard', { detail: { visible: true, height: 300 } })));
  await page.waitForFunction(() => document.querySelector('.ix-root')?.getAttribute('data-keyboard') === 'true');
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).isVisible(), false);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('loginote:native-keyboard', { detail: { visible: false, height: 0 } })));
  await page.waitForFunction(() => document.querySelector('.ix-root')?.getAttribute('data-keyboard') === 'false');
  assert.ok(await page.getByLabel('问问助手').isVisible());
  assert.ok(await back()); await page.getByRole('navigation', { name: '主导航' }).waitFor();
  checks.push('独立助手与任务页的硬件返回保留草稿，原生键盘事件不丢失对话');

  await openAssistant(); const cameraAssistantId = (await state()).activeAssistantId;
  await page.evaluate(() => { (window as any).__nativeHarness.deferPhoto = true; });
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('button', { name: '拍照或选图', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__nativeHarness.photoPending);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const nextAssistantId = (await state()).activeAssistantId; assert.notEqual(nextAssistantId, cameraAssistantId);
  await page.evaluate(() => { (window as any).__nativeHarness.resolvePhoto(); (window as any).__nativeHarness.deferPhoto = false; });
  await page.waitForFunction(({ key, id }: { key: string; id: string }) => JSON.parse(localStorage.getItem(key) || '{}').assistantThreads?.find((item: any) => item.id === id)?.messages.some((message: any) => message.attachment?.startsWith('photo:')), { key, id: cameraAssistantId });
  const afterPhoto = await state();
  assert.equal(afterPhoto.activeAssistantId, nextAssistantId, 'finishing an older photo must not switch the active conversation');
  assert.equal(afterPhoto.assistantThreads.find((item: any) => item.id === nextAssistantId).messages.length, 0);
  assert.equal(afterPhoto.assistantThreads.find((item: any) => item.id === cameraAssistantId).messages.filter((message: any) => message.attachment?.startsWith('photo:')).length, 1);
  assert.ok(await back()); await page.getByRole('button', { name: '打开学习助手', exact: true }).waitFor();
  checks.push('助手拍照返回前切换会话，照片仍绑定开始拍照时的对话且不串会话');

  await page.getByRole('button', { name: '查看我的任务', exact: true }).click();
  const task = (await state()).mobileTasks.find((task: any) => task.kind === '待办'); assert.ok(task);
  await page.getByRole('button', { name: `打开任务：${task.title}`, exact: true }).click();
  const future = new Date(); future.setDate(future.getDate() + 2);
  const day = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
  await page.getByLabel('新的任务日期').fill(day);
  await page.getByRole('button', { name: '预览改期', exact: true }).click();
  assert.equal((await state()).mobileTasks.find((item: any) => item.id === task.id).day, task.day);
  await page.getByRole('button', { name: '确认改期', exact: true }).click();
  assert.equal((await state()).mobileTasks.find((item: any) => item.id === task.id).day, day);
  await open();
  assert.equal((await state()).mobileTasks.find((item: any) => item.id === task.id).day, day);
  await page.getByRole('button', { name: '查看我的任务', exact: true }).click();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('button', { name: `打开任务：${task.title}`, exact: true }).click();
  await page.getByRole('button', { name: `标记完成任务：${task.title}`, exact: true }).click();
  assert.equal((await state()).mobileTasks.find((item: any) => item.id === task.id).done, true);
  checks.push('今日任务入口、改期预览不先写入、确认与完成状态持久化');

  await tasksHome();
  await nav('首页'); await page.getByRole('button', { name: '查看我的任务', exact: true }).click();
  const readingTask = (await state()).mobileTasks.find((item: any) => item.kind === '阅读');
  await page.getByRole('button', { name: `打开任务：${readingTask.title}`, exact: true }).click();
  assert.equal(await page.locator('.mt-detail-head').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '返回任务列表', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: `查看任务详情：${readingTask.title}`, exact: true }).count(), 0);
  await page.getByRole('button', { name: '问助手', exact: true }).click(); await page.getByLabel('问问助手').waitFor();
  const taskContext = await state(); assert.equal(taskContext.assistantThreads.find((item: any) => item.id === taskContext.activeAssistantId).context.id, readingTask.materialId);
  assert.ok(await back()); await page.getByRole('region', { name: '任务详情', exact: true }).waitFor();
  await page.getByRole('button', { name: '开始阅读', exact: false }).click(); await page.locator('.ix-reading').waitFor();
  assert.ok(await back()); await page.getByRole('region', { name: '任务详情', exact: true }).waitFor();
  assert.ok(await back()); await page.getByRole('button', { name: `打开任务：${readingTask.title}`, exact: true }).waitFor();
  assert.ok(await back()); await page.getByRole('button', { name: '打开学习助手', exact: true }).waitFor();
  checks.push('任务阅读/问助手直达独立内容，原生返回逐层恢复任务详情、任务列表和首页');
  await nav('发现'); await page.locator('.ix-card-open').click();
  await page.getByRole('button', { name: '问助手', exact: true }).click(); await page.getByLabel('问问助手').waitFor();
  const materialContext = await state(); assert.equal(materialContext.assistantThreads.find((item: any) => item.id === materialContext.activeAssistantId).context.id, 'derivative');
  assert.ok(await back()); await page.locator('.ix-reading').waitFor();
  await page.getByRole('button', { name: '复述', exact: true }).click();
  await page.getByLabel('复述内容').fill('导数描述瞬时变化率，这是尚未保存的草稿。');
  assert.ok(await back());
  assert.equal(await page.getByRole('dialog', { name: '复述', exact: true }).count(), 0);
  assert.ok((await state()).recap.includes('瞬时变化率'));
  assert.ok(await back());
  await page.getByTestId('discover-card').waitFor();
  checks.push('硬件返回关闭复述与阅读详情，未保存复述草稿仍保留');

  for (const width of [320, 390, 768, 1194]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['首页', '发现', '消息', '记录', '我的']) { await nav(name); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${name} horizontal overflow`); }
    await nav('首页'); await page.getByRole('button', { name: '查看我的任务', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px tasks horizontal overflow`);
    await tasksHome();
  }
  await page.setViewportSize({ width: 1194, height: 834 }); await nav('首页');
  await page.screenshot({ path: `${output}/native-home-tablet.png` });
  await openAssistant(); await page.screenshot({ path: `${output}/native-assistant-tablet.png` });
  checks.push('Android 共享界面与任务页在 320/390/768/1194px 下无横向溢出');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'shared-ui-acceptance.json'), JSON.stringify({ mode: 'fake native adapter; not device or APK validation', checks, pageErrors: errors, externalRequests: external }, null, 2));
  console.log(`PASS ${checks.length} Android shared UI groups; no page errors or external requests. Native hardware and APK remain separate checks.`);
} finally { await browser.close(); await server.close(); }
