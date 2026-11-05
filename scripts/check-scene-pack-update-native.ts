import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerSceneInteractionPackIpc } from '../src/electron/sceneInteractionPackIpc';
async function main() {
  const root = process.env.LOGINOTE_S2_UPDATE_TEST_ROOT!;
  assert(root && path.basename(root).startsWith('loginote-s2-update-'));
  app.setPath('userData', path.join(root, 'profile')); await app.whenReady();
  console.log('S2 update: isolated Electron ready');
  let win: BrowserWindow;
  let selected = path.join(root, 'v1.zip'), confirms = 0;
  (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  (dialog as any).showMessageBox = async (_parent: unknown, options: any) => { assert.equal(options.title, '安装可信 S2 交互包'); confirms++; return { response: 1 }; };
  const store = registerSceneInteractionPackIpc(ipcMain, { root: path.join(root, 'packages'), parent: () => win,
    allowed: event => event.sender === win?.webContents, current: () => 'isolated' });
  win = new BrowserWindow({ show: false, width: 1040, height: 860, webPreferences: { preload: path.join(root, 'preload.cjs'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const external: string[] = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => { external.push(request.url); done({ cancel: true }); });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error('RENDERER', event.message); });
  const js = async (code: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([win.webContents.executeJavaScript(code), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('JavaScript timed out: ' + code)), 15000); })]); }
    catch (error) { console.error('FAILED JS', code); throw error; }
    finally { clearTimeout(timer); }
  };
  const wait = async (code: string) => {
    for (let i = 0; i < 250; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw Error('Timeout ' + code + '\n' + await js('document.body.innerText'));
  };
  const click = async (name: string) => js(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim().startsWith(${JSON.stringify(name)})||e.getAttribute('aria-label')===${JSON.stringify(name)});if(!button||button.disabled)throw Error('Button unavailable '+${JSON.stringify(name)});button.click();})();true`);
  let exitCode = 0;
  try {
    await win.loadFile(path.join(root, 'client.html'));
    console.log('S2 update: client loaded');
    await wait('!!window.__s2Update && !!document.querySelector("#app button")');
    await js(`(()=>{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'隔离更新验收');input.dispatchEvent(new Event('input',{bubbles:true}));})();true`);
    await click('下一步'); await click('通用画布（试验）');
    await wait('!!document.querySelector("select") && !document.querySelector("select").disabled');
    await click('导入或更新 S2 交互包');
    await wait('Array.from(document.querySelectorAll("option")).some(e=>e.value==="arithmetic-lab@1.0.0")');
    console.log('S2 update: first package imported');
    await js('window.__s2Update.beginOld()');
    await wait('typeof window.__oldRelease === "function"');
    assert.equal(await js('window.__s2Update.sharedResult()'), 'pass');
    await js(`(()=>{const root=document.createElement('section');root.dataset.scenePack='arithmetic-lab@1.0.0';root.innerHTML='<span class="update-style-probe">old animation</span>';document.body.appendChild(root);})();true`);
    await wait(`getComputedStyle(document.querySelector('.update-style-probe')).color==='rgb(0, 128, 0)'`);
    await js(`window.__oldAnimation=document.querySelector('.update-style-probe').getAnimations()[0];window.__oldAnimationStart=window.__oldAnimation.startTime;true`);
    selected = path.join(root, 'v2.zip');
    await click('导入或更新 S2 交互包');
    await wait('document.querySelector("select").value==="arithmetic-lab@2.0.0"');
    console.log('S2 update: second package imported without restart');
    await js('window.__s2Update.loadNew()');
    assert.equal(await js('window.__s2Update.sharedResult()'), 'pass', 'new package cannot revoke an existing base scene public capability');
    assert.equal(await js('window.__s2Update.newResult()'), '105');
    await js('window.__oldRelease();true');
    assert.equal(await js('window.__s2Update.oldResult()'), '5', 'in-flight old code finishes unchanged after new code activation');
    await js(`(()=>{const root=document.createElement('section');root.dataset.scenePack='arithmetic-lab@2.0.0';root.innerHTML='<span class="update-style-probe">new animation</span>';document.body.appendChild(root);})();true`);
    await wait(`Array.from(document.querySelectorAll('.update-style-probe')).map(e=>getComputedStyle(e).color).join('|')==='rgb(0, 128, 0)|rgb(128, 0, 128)'`);
    const colors = await js(`Array.from(document.querySelectorAll('.update-style-probe')).map(e=>getComputedStyle(e).color)`);
    assert.deepEqual(colors, ['rgb(0, 128, 0)', 'rgb(128, 0, 128)']);
    const animationNames = await js(`Array.from(document.querySelectorAll('.update-style-probe')).map(e=>getComputedStyle(e).animationName)`);
    assert.notEqual(animationNames[0], animationNames[1]);
    assert.equal(await js(`document.querySelector('.update-style-probe').getAnimations()[0]===window.__oldAnimation && window.__oldAnimation.startTime===window.__oldAnimationStart`), true, 'loading new animation must not restart the old animation');
    assert.equal((await store.list()).packs.length, 2); assert.equal(confirms, 2);
    assert.deepEqual(external, []);
    assert.equal(await fs.readFile(path.join(root, 'existing-scene.json'), 'utf8'), await fs.readFile(path.join(root, 'expected-scene.json'), 'utf8'));
    await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await fs.mkdir('.ui-preview/s2-update', { recursive: true });
    await fs.writeFile('.ui-preview/s2-update/installed-update.png', (await win.webContents.capturePage()).toPNG());
    await fs.writeFile('.ui-preview/s2-update/results.json', JSON.stringify({
      trustedNativeImport: true, uiSelectedNewVersion: true, oldInFlightResult: '5', newVersionResult: '105',
      releaseScopedColors: colors, existingSceneBytesUnchanged: true, applicationRestarted: false,
      sameNamedAnimationsIsolated: true, animationNames, oldAnimationNotRestarted: true, sharedBuiltinCallsUnchanged: true,
      externalRequests: external, nativeFilePickerAndTrustDialogs: 'test doubles',
      runtime: `Electron ${process.versions.electron}`, fullInstalledApplicationTested: false,
    }, null, 2));
    console.log('PASS native S2 install/update UI: real preload+IPC+ZIP+ESM, old in-flight result5/new result105, same-named animations isolated, shared builtin calls unchanged, scene bytes unchanged, zero external requests and no restart');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { win!.destroy(); app.exit(exitCode); }
}
void main().catch(error => { console.error(error); app.exit(1); });
