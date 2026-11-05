import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createH5pStore } from '../src/electron/h5pStore';
import { registerH5pHost, h5pRequestAllowed, h5pWindowPreferences } from '../src/electron/h5pHost';
import type { IpcMainInvokeEvent } from 'electron';

async function main() {
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-native-'));
app.setPath('userData', root);
app.on('window-all-closed', () => {}); // Reopen/restore is part of this isolated test.
const timeout = setTimeout(() => { console.error('Native H5P check timed out'); app.exit(1); }, 45000);
let code = 0, host: ReturnType<typeof registerH5pHost> | undefined;
let appearance: { theme: 'light' | 'dark'; tokens: Record<string,string> } = { theme: 'dark', tokens: { '--ln-accent': '#9bd4a5' } };
try {
  await app.whenReady();
  const handlers = new Map<string, Function>();
  host = registerH5pHost({ handle: (name: string, run: Function) => { handlers.set(name, run); } } as any, {
    root: () => root, assets: path.resolve('node_modules/h5p-standalone/dist'), parent: () => null,
    current: () => root, allowed: event => event.sender.id === 987, visible: false,
    styles: path.resolve('src/styles/design-tokens.css'), appearance: async () => appearance,
  });
  const script = `(function(){
    H5P.Synthetic=function(params,id,extras){H5P.EventDispatcher.call(this);this.state=extras.previousState||{count:0};};
    H5P.Synthetic.prototype=Object.create(H5P.EventDispatcher.prototype);
    H5P.Synthetic.prototype.constructor=H5P.Synthetic;
    H5P.Synthetic.prototype.attach=function(container){
      const button=document.createElement('button');button.id='synthetic-action';button.textContent='synthetic action '+this.state.count;
      button.onclick=()=>{this.state.count++;button.textContent='synthetic action '+this.state.count;this.triggerXAPICompleted(1,1);};
      container.append(button);
    };
    H5P.Synthetic.prototype.getCurrentState=function(){return this.state;};
  })();`;
  const bytes = Buffer.from(zipSync({
    'h5p.json': strToU8(JSON.stringify({ title: 'Native synthetic H5P', language: 'en', mainLibrary: 'H5P.Synthetic', embedTypes: ['iframe'],
      preloadedDependencies: [{ machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0 }] })),
    'content/content.json': strToU8('{}'),
    'H5P.Synthetic-1.0/library.json': strToU8(JSON.stringify({ title: 'Synthetic', machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0,
      patchVersion: 0, runnable: 1, embedTypes: ['iframe'], preloadedJs: [{ path: 'synthetic.js' }] })),
    'H5P.Synthetic-1.0/synthetic.js': strToU8(script),
  }));
  const store = createH5pStore(root), descriptor = await store.importBytes(bytes);
  const event = { sender: { id: 987 } } as unknown as IpcMainInvokeEvent;
  await assert.rejects(handlers.get('h5p:list')!({ sender: { id: 111 } }), /当前窗口/);
  await handlers.get('h5p:open')!(event, descriptor.id);
  let win = BrowserWindow.getAllWindows()[0]; assert.ok(win); assert.equal(win.isVisible(), false);
  const consoleErrors: string[] = [];
  win.webContents.on('console-message', event => consoleErrors.push(event.message));
  const wait = async (test: () => Promise<boolean>) => {
    for (let i = 0; i < 240; i++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('H5P player did not finish: ' + (await win.webContents.executeJavaScript('document.body.innerText')) + '\n' + consoleErrors.join('\n'));
  };
  await wait(() => win.webContents.executeJavaScript("Boolean(document.querySelector('#player iframe')?.contentDocument?.querySelector('#synthetic-action')) && !document.getElementById('save').disabled"));
  assert.equal(await win.webContents.executeJavaScript("document.documentElement.classList.contains('dark') && getComputedStyle(document.documentElement).getPropertyValue('--ln-accent').trim()==='#9bd4a5'"), true);
  appearance = { theme: 'light', tokens: { '--ln-accent': '#2f5743' } }; await host.updateAppearance();
  assert.equal(await win.webContents.executeJavaScript("document.documentElement.classList.contains('dark')"), false);
  const exposed = await win.webContents.executeJavaScript("({electron:typeof window.electronAPI,require:typeof require,process:typeof process})");
  assert.deepEqual(exposed, { electron: 'undefined', require: 'undefined', process: 'undefined' });
  const preferences = (win.webContents as any).getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
  assert.equal((h5pWindowPreferences('synthetic') as any).preload, undefined);
  assert.equal(h5pRequestAllowed('https://outside.example', win.webContents.getURL()), false);
  const remote = await win.webContents.executeJavaScript("fetch('https://example.com').then(()=>true,()=>false)");
  assert.equal(remote, false);
  await win.webContents.executeJavaScript("document.querySelector('#player iframe').contentDocument.querySelector('#synthetic-action').click(); window.logiH5pCheckpoint()");
  assert.deepEqual((await store.progress(descriptor.id))?.state, { count: 1 });
  assert.equal((await store.progress(descriptor.id))?.reportedCompleted, true);
  const reloaded = new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
  await win.webContents.executeJavaScript('location.reload();true'); await reloaded;
  await wait(() => win.webContents.executeJavaScript("document.querySelector('#player iframe')?.contentDocument?.querySelector('#synthetic-action')?.textContent==='synthetic action 1' && !document.getElementById('save').disabled"));
  await win.webContents.executeJavaScript('window.logiH5pCheckpoint()');
  assert.deepEqual((await store.progress(descriptor.id))?.state, { count: 1 }, 'actual page reload/checkpoint cannot roll back committed progress');
  assert.equal(await win.webContents.executeJavaScript("document.documentElement.classList.contains('dark')"), false, 'reload retains the live host theme as well as progress');
  await win.webContents.executeJavaScript("document.querySelector('#player iframe').contentDocument.querySelector('#synthetic-action').click()");
  await new Promise(resolve => setTimeout(resolve, 11000));
  assert.deepEqual((await store.progress(descriptor.id))?.state, { count: 2 }, 'actual 10-second autosave persists without a manual checkpoint');
  await win.webContents.executeJavaScript(`
    const originalFetch=window.fetch.bind(window);let delayCheckpoint=true;
    window.fetch=async(...args)=>{const response=await originalFetch(...args);if(delayCheckpoint&&String(args[0]).endsWith('/checkpoint')){delayCheckpoint=false;await new Promise(resolve=>setTimeout(resolve,300));}return response;};
    document.querySelector('#player iframe').contentDocument.querySelector('#synthetic-action').click();
    window.pendingSyntheticSave=window.logiH5pCheckpoint();window.pendingSyntheticSave.catch(()=>{});true;
  `);
  await win.webContents.executeJavaScript("document.querySelector('#player iframe').contentDocument.querySelector('#synthetic-action').click()");
  const closed = new Promise<void>(resolve => win.once('closed', () => resolve())); win.close(); await closed;
  assert.equal(host.hasWindows(), false);
  assert.deepEqual((await store.progress(descriptor.id))?.state, { count: 4 }, 'close waits for the delayed save then captures the newest unsaved action');
  await handlers.get('h5p:open')!(event, descriptor.id); win = BrowserWindow.getAllWindows()[0];
  await wait(() => win.webContents.executeJavaScript("document.querySelector('#player iframe')?.contentDocument?.querySelector('#synthetic-action')?.textContent==='synthetic action 4' && !document.getElementById('save').disabled"));
  const closedRestored = new Promise<void>(resolve => win.once('closed', () => resolve())); win.close(); await closedRestored;
  const failing = Buffer.from(zipSync({
    'h5p.json': strToU8(JSON.stringify({ title: 'Failed constructor fixture', mainLibrary: 'H5P.Synthetic', language: 'en', embedTypes: ['iframe'], preloadedDependencies: [{ machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0 }] })),
    'content/content.json': strToU8('{}'),
    'H5P.Synthetic-1.0/library.json': strToU8(JSON.stringify({ machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0, patchVersion: 0, runnable: 1, preloadedJs: [{ path: 'synthetic.js' }] })),
    'H5P.Synthetic-1.0/synthetic.js': strToU8(script.replace('H5P.EventDispatcher.call(this);', "throw new Error('synthetic constructor failure');")),
  }));
  const failedPackage = await store.importBytes(failing);
  await handlers.get('h5p:open')!(event, failedPackage.id); win = BrowserWindow.getAllWindows()[0];
  await wait(() => win.webContents.executeJavaScript("document.getElementById('status').textContent==='场景加载失败'"));
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('save').disabled"), true);
  assert.equal(await store.progress(failedPackage.id), null, 'constructor failure never starts autosave or creates a false checkpoint');
  await host.shutdown(); assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log('PASS real Electron hidden H5P: rendering, isolation, actual reload restores latest committed progress, manual/10-second save, concurrent close/reopen, constructor failure stays failed without progress writes, and shutdown. Temp profile only.');
  win = new BrowserWindow({ show: false, width: 1040, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'h5p-ui-fixture' } });
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith('file:') && !request.url.startsWith('data:') }));
  await win.loadFile(process.env.LOGINOTE_H5P_UI_FILE!);
  await wait(() => win.webContents.executeJavaScript("document.querySelectorAll('article').length===2"));
  assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].filter(b=>b.textContent==='打开场景' && b.disabled).length"), 1);
  await win.webContents.executeJavaScript("const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='打开场景' && !b.disabled);b.click();b.click();");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=status]')?.textContent.includes('独立窗口')"));
  assert.equal(await win.webContents.executeJavaScript('window.h5pFixture.opens'), 1);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('导入 .h5p')).click()");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=status]')?.textContent.includes('取消')"));
  const preview = path.resolve('.ui-preview/h5p'); await fs.mkdir(preview, { recursive: true });
  const capture = async (name: string) => {
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(preview, name), (await win.webContents.capturePage()).toPNG());
  };
  await capture('library-light.png');
  await win.webContents.executeJavaScript("document.documentElement.classList.add('dark')");
  await capture('library-dark.png');
  win.setSize(480, 800);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'), true);
  await capture('library-narrow.png');
  await win.webContents.executeJavaScript("window.h5pFixture.mode='damaged';document.querySelector('[aria-label=\"刷新 H5P 场景库\"]').click()");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=alert]')?.textContent.includes('进度读取失败')"));
  assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].filter(b=>b.textContent==='打开场景' && b.disabled).length"), 2);
  await win.webContents.executeJavaScript("const reset=[...document.querySelectorAll('button')].find(b=>b.textContent==='备份进度并重新开始');reset.click();reset.click()");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=status]')?.textContent.includes('原进度未改动')"));
  assert.equal(await win.webContents.executeJavaScript('window.h5pFixture.restarts'), 1);
  await capture('library-recovery.png');
  await win.webContents.executeJavaScript("window.h5pFixture.cancelRestart=false;[...document.querySelectorAll('button')].find(b=>b.textContent==='备份进度并重新开始').click()");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=status]')?.textContent.includes('原进度已备份')"));
  assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].filter(b=>b.textContent==='打开场景' && !b.disabled).length"), 1);
  await win.webContents.executeJavaScript("window.h5pFixture.mode='error';document.querySelector('[aria-label=\"刷新 H5P 场景库\"]').click()");
  await wait(() => win.webContents.executeJavaScript("document.querySelector('[role=alert]')?.textContent.includes('合成读取失败')"));
  await win.webContents.executeJavaScript("window.h5pFixture.mode='empty';document.querySelector('[aria-label=\"刷新 H5P 场景库\"]').click()");
  await wait(() => win.webContents.executeJavaScript("Boolean(document.querySelector('.h5p-empty'))"));
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("article").length'), 0);
  win.destroy();
  console.log('PASS real React library: missing dependencies disabled, duplicate action lock, import cancellation, read error/retry, empty library, light/dark theme and narrow layout. Synthetic API only. Previews: .ui-preview/h5p');
} catch (error) { console.error(error); code = 1; }
finally {
  host?.forceClose();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  clearTimeout(timeout);
  const target = path.resolve(root);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('loginote-h5p-native-'));
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  app.exit(code);
}
}
void main().catch(error => { console.error(error); app.exit(1); });
