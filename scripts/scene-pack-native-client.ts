import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerSceneInteractionPackIpc } from '../src/electron/sceneInteractionPackIpc';

const stateRoot = path.resolve(process.env.LOGINOTE_PACK_NATIVE_STATE!);
const bundleRoot = path.resolve(process.env.LOGINOTE_PACK_NATIVE_BUILD!);
const proof = path.resolve(process.env.LOGINOTE_PACK_NATIVE_PROOF!);
const scenario = process.env.LOGINOTE_PACK_NATIVE_CASE || 'installed';
app.setPath('userData', stateRoot);
app.disableHardwareAcceleration();
// CI/desktop hosts can lack the native GPU subprocess dependencies.
app.commandLine.appendSwitch('in-process-gpu');
void app.whenReady().then(async () => {
  const nativeLstat = fs.lstat;
  const nativeRename = fs.rename;
  const nativeRead = fs.readFile;
  let receiptBefore: Buffer | undefined;
  let initializationFailures = 0;
  if (scenario === 'receipt-retry') {
    receiptBefore = await nativeRead(path.join(stateRoot, 'scene-interaction-packs/.seed-receipt.json'));
    fs.readFile = (async (file: any, ...args: any[]) => {
      if (String(file) === path.join(stateRoot, 'scene-interaction-packs/.seed-receipt.json') && initializationFailures === 0) {
        initializationFailures++;
        throw Object.assign(new Error('SYNTHETIC_NATIVE_RECEIPT_READ_BUSY'), { code: 'EBUSY' });
      }
      return (nativeRead as any)(file, ...args);
    }) as typeof fs.readFile;
  }
  if (scenario === 'initialization-retry') fs.lstat = (async (file: any, ...args: any[]) => {
    if (String(file) === path.join(stateRoot, 'scene-interaction-packs/.initialized') && initializationFailures === 0) {
      initializationFailures++;
      throw Object.assign(new Error('SYNTHETIC_NATIVE_INITIALIZATION_BUSY'), { code: 'EBUSY' });
    }
    return (nativeLstat as any)(file, ...args);
  }) as typeof fs.lstat;
  if (scenario === 'partial-seed-failed' || scenario === 'partial-seed-refresh') fs.rename = async (from, to) => {
    if (String(to) === path.join(stateRoot, 'scene-interaction-packs/prompt-lab/0.1.0') && initializationFailures === 0) {
      initializationFailures++;
      throw Object.assign(new Error('SYNTHETIC_NATIVE_PARTIAL_SEED_BUSY'), { code: 'EBUSY' });
    }
    return nativeRename(from, to);
  };
  if (scenario === 'unmanaged-partial') fs.rename = async (from, to) => {
    if (String(to) === path.join(stateRoot, 'scene-interaction-packs/arithmetic-lab/1.0.0')) {
      initializationFailures++;
      throw new Error('SYNTHETIC_NATIVE_ARITHMETIC_SEED_BUSY');
    }
    return nativeRename(from, to);
  };
  const store = registerSceneInteractionPackIpc(ipcMain, { root: path.join(stateRoot, 'scene-interaction-packs'),
    seed: process.env.LOGINOTE_PACK_NATIVE_SEED || undefined });
  const sceneRoot = path.join(stateRoot, 'vault/scene-skills');
  await fs.mkdir(path.join(sceneRoot, 'scenes'), { recursive: true });
  const sceneFile = (id: string) => {
    assert.match(id, /^scene-[A-Za-z0-9-]+$/);
    return path.join(sceneRoot, 'scenes', id + '.json');
  };
  const readJson = async (file: string, empty: unknown) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error; }
  };
  // Scene persistence is restricted to this fixture's own synthetic vault.
  ipcMain.handle('scene-skills:get-dir', () => sceneRoot);
  ipcMain.handle('scene-skills:load-manifest', () => readJson(path.join(sceneRoot, 'manifest.json'), { version: '1.0', scenes: [] }));
  ipcMain.handle('scene-skills:save-manifest', (_event, value) => fs.writeFile(path.join(sceneRoot, 'manifest.json'), JSON.stringify(value)));
  ipcMain.handle('scene-skills:load-scene', (_event, id) => readJson(sceneFile(id), null));
  ipcMain.handle('scene-skills:save-scene', (_event, id, value) => fs.writeFile(sceneFile(id), JSON.stringify(value)));
  const window = new BrowserWindow({ title: 'S2 交互包客户端验收', show: scenario === 'inspect', width: 1450, height: 1000,
    webPreferences: { preload: path.join(bundleRoot, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, partition: 'persist:isolated-pack-client' } });
  const externalRequests: string[] = [], errors: string[] = [], layoutNotifications: string[] = [], checks: string[] = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
    externalRequests.push(details.url); done({ cancel: true });
  });
  window.webContents.on('console-message', event => {
    if (event.message === 'ResizeObserver loop completed with undelivered notifications.') layoutNotifications.push(event.message);
    else if (event.level === 'error') errors.push(event.message.slice(0, 2000));
  });
  window.webContents.on('render-process-gone', (_event, details) => console.error('Native renderer process ended:', details));
  const evaluate = (code: string) => window.webContents.executeJavaScript(code);
  const wait = async (condition: string) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error('Client condition timed out: ' + condition);
  };
  const click = async (label: string) => {
    await evaluate(`(() => {const matches=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${JSON.stringify(label)});
      const button=matches.find(x=>!x.disabled&&x.getClientRects().length); if(!button) throw Error('Visible enabled button missing: '+${JSON.stringify(label)}); button.click();})()`);
  };
  const fill = async (selector: string, value: string) => {
    await evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement) || input.disabled || !input.getClientRects().length) throw Error('Editable input missing: '+${JSON.stringify(selector)});
      input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    // Input and Enter are separate turns: React must commit the controlled
    // draft before the current keyboard handler saves it. Unlike native focus/
    // blur, this existing UI commit action also works in a hidden native window.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`);
  };
  const shot = async (name: string) => {
    await fs.mkdir(proof, { recursive: true });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    let screenshot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    for (let attempt = 0; screenshot.isEmpty() && attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      screenshot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    }
    assert(!screenshot.isEmpty()); await fs.writeFile(path.join(proof, name + '.png'), screenshot.toPNG());
  };
  const open = async (kind: string) => {
    await evaluate(`window.__packClient.open(${JSON.stringify(kind)})`);
    await wait('!!window.__packClient.latestDraft && !!document.querySelector(".s2-toolbar")');
  };
  const save = () => evaluate('window.__packClient.saveCurrent()');
  try {
    const page = path.join(bundleRoot, 'ui/scripts/fixtures/s2-pack-client.html');
    for (let attempt = 0; ; attempt++) {
      try { await window.loadFile(page); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'ERR_FAILED' || attempt >= 1) throw error;
        console.log('Retrying one initial file navigation after Chromium startup ERR_FAILED (before application code).');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    await wait('!!window.__packClient?.ready');
    if (scenario === 'inspect') {
      await wait('!!window.__packClient.latestDraft');
      window.show(); window.focus();
      console.log('ISOLATED_NATIVE_CLIENT_READY ' + stateRoot);
      window.on('closed', () => app.exit(0));
      return;
    }
    if (scenario === 'receipt-retry') {
      await wait('document.body.innerText.includes("SYNTHETIC_NATIVE_RECEIPT_READ_BUSY")');
      assert.equal(initializationFailures, 1); fs.readFile = nativeRead;
      assert.deepEqual(await fs.readFile(path.join(stateRoot, 'scene-interaction-packs/.seed-receipt.json')), receiptBefore);
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/.initialized')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/prompt-lab/0.1.0')), { code: 'ENOENT' });
      await evaluate('window.__packClient.refreshPackages()'); await open('prompt');
      await wait('!!document.querySelector(".react-flow__node[data-id=testModel] [aria-label=模型运行参数]")');
      assert.deepEqual((await store.list()).packs.map(ref => ref.id), ['prompt-lab']);
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/arithmetic-lab/1.0.0')), { code: 'ENOENT' });
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      await shot('00-receipt-refresh-delete-protected');
      checks.push('Receipt read EBUSY is visible through real IPC and stops writes; same-process refresh recovers while the user-deleted receipted version stays absent');
    } else if (scenario === 'unmanaged-partial') {
      await wait('!!window.__packClient.latestDraft && !!document.querySelector(".s2-toolbar")');
      assert(initializationFailures > 0);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot, 'scene-interaction-packs/.seed-exclusions.json'), 'utf8')),
        { version: 1, references: [{ id: 'prompt-lab', version: '0.1.0' }] });
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/.seed-receipt.json')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/.initialized')), { code: 'ENOENT' });
      fs.rename = nativeRename;
      checks.push('An unmanaged preinstalled package remains usable and is durably excluded, not adopted as seed-owned, while another seed fails');
    } else if (scenario === 'unmanaged-restarted') {
      await wait('document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
      assert.deepEqual((await store.list()).packs.map(ref => ref.id), ['arithmetic-lab']);
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/prompt-lab/0.1.0')), { code: 'ENOENT' });
      await open('arithmetic'); await click('计算并显示');
      await wait('document.querySelector(".react-flow__node[data-id=show]")?.textContent.includes("5")');
      await shot('00-unmanaged-delete-protected');
      checks.push('After user removal and real process restart, the previously unmanaged version stays absent and the other recovered package executes normally');
    } else if (scenario === 'partial-seed-failed' || scenario === 'partial-seed-refresh') {
      await wait('document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
      assert.equal(initializationFailures, 1);
      fs.rename = nativeRename;
      await assert.rejects(fs.access(path.join(stateRoot, 'scene-interaction-packs/.initialized')), { code: 'ENOENT' });
      const healthyFile = path.join(stateRoot, 'scene-interaction-packs/arithmetic-lab/1.0.0/main.js');
      const healthyBytes = await fs.readFile(healthyFile);
      if (scenario === 'partial-seed-failed') {
        checks.push('Partial first seed publishes the healthy package but no completion marker; application may close without falsely completing initialization');
      } else {
        // Same production discovery refresh used by the installed-pack picker.
        await evaluate('window.__packClient.refreshPackages()');
        await open('prompt');
        await wait('!!document.querySelector(".react-flow__node[data-id=testModel] [aria-label=模型运行参数]")');
        assert.deepEqual(await fs.readFile(healthyFile), healthyBytes);
        assert.deepEqual((await store.list()).errors, []);
        assert.equal((await store.list()).packs.length, 2);
        await fs.access(path.join(stateRoot, 'scene-interaction-packs/.initialized'));
        await shot('00-partial-seed-refresh-recovered');
        checks.push('Partial seed failure recovers via real discovery refresh and IPC in the same process, without replacing healthy package bytes');
      }
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
    } else if (scenario === 'partial-seed-restarted') {
      await wait('!!window.__packClient.latestDraft && !!document.querySelector(".s2-toolbar")');
      assert.equal((await store.list()).packs.length, 2); assert.deepEqual((await store.list()).errors, []);
      await fs.access(path.join(stateRoot, 'scene-interaction-packs/.initialized'));
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      await shot('00-partial-seed-restart-recovered');
      checks.push('A new Electron process finishes only the previously failed seed copy and opens the exact prompt package without model sends');
    } else if (scenario === 'initialization-retry') {
      await wait('document.body.innerText.includes("SYNTHETIC_NATIVE_INITIALIZATION_BUSY")');
      assert.equal(initializationFailures, 1);
      assert.equal(await evaluate('window.__packClient.latestDraft'), null);
      fs.lstat = nativeLstat;
      await open('prompt');
      await wait('!!document.querySelector(".react-flow__node[data-id=testModel] [aria-label=模型运行参数]")');
      assert.equal((await store.list()).packs.length, 2);
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      await shot('00-initialization-recovered');
      checks.push('One-shot EBUSY crosses real IPC and displays an error; re-entering recovers the same main/renderer process and store without restart or model sends');
    } else if (scenario === 'missing' || scenario === 'wrong-version') {
      await wait('document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
      assert.equal(await evaluate('window.__packClient.latestDraft'), null);
      assert.equal((await store.list()).packs.some(item => item.id === 'prompt-lab'), false);
      if (scenario === 'wrong-version') assert((await store.list()).errors.some(message => message.includes('清单与目录身份不一致')));
      await shot(scenario === 'missing' ? '02-missing-package' : '02b-version-mismatch');
      checks.push(scenario === 'missing' ? 'Restart without prompt-lab refuses load and does not silently reseed'
        : 'Restart with mismatched exact package version refuses load without changing saved scenes');
      const saved = JSON.parse(await fs.readFile(path.join(proof, '../installed.json'), 'utf8'));
      await evaluate(`window.__packClient.openSaved(${JSON.stringify(saved.savedPrompt.sceneId)})`);
      await wait('document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
      assert.equal(await evaluate('window.__packClient.latestDraft'), null);
      await open('arithmetic'); await click('计算并显示');
      await wait('document.querySelector(".react-flow__node[data-id=show]")?.textContent.includes("5")');
      checks.push('Saved prompt scene stays unavailable; independent arithmetic package still executes');
      await shot('03-independent-package-without-prompt');
    } else if (scenario === 'restored' || scenario === 'second-terminal') {
      await wait('!!window.__packClient.latestDraft');
      const saved = JSON.parse(await fs.readFile(path.join(proof, '../installed.json'), 'utf8'));
      await evaluate(`window.__packClient.openSaved(${JSON.stringify(saved.savedPrompt.sceneId)})`);
      await wait('!!window.__packClient.latestDraft && !!document.querySelector(".s2-toolbar")');
      const actual = await evaluate('window.__packClient.latestDraft');
      assert.deepEqual(actual.interactionPack, { id: 'prompt-lab', version: '0.1.0' });
      assert.deepEqual(actual.canvasWorkspace, saved.savedPrompt.canvasWorkspace);
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      await shot(scenario === 'restored' ? '04-reinstalled-scene' : '05-second-terminal');
      checks.push('Copied exact package and saved scene reopen with unchanged graph and no restored model authority/calls');
      // The old scene did not carry a package reference on disk.
      const legacy = await readJson(sceneFile(saved.savedLegacy.sceneId), null) as any;
      delete legacy.interactionPack; await fs.writeFile(sceneFile(legacy.sceneId), JSON.stringify(legacy));
      await evaluate(`window.__packClient.openSaved(${JSON.stringify(legacy.sceneId)})`);
      await wait('!!window.__packClient.latestDraft');
      assert.equal(await evaluate('window.__packClient.latestDraft.canvasWorkspace.initial.execution.nodes.length'), 3);
      checks.push('Legacy saved scene without package reference opens via compatibility entry');
    } else {
      await wait('!!window.__packClient.latestDraft && !!document.querySelector(".s2-toolbar")');
      const packCount = await evaluate('document.querySelectorAll("style[data-scene-interaction-pack]").length');
      assert.equal(packCount, 1);
      await wait('!!document.querySelector(".react-flow__node[data-id=testModel] [aria-label=模型运行参数]")');
      assert.equal(await evaluate('document.querySelector(".react-flow__node[data-id=testModel] [aria-label=输出长度上限]").disabled'), false,
        'Packaged model parameters are editable inline before any execution');
      await shot('01-installed-prompt-package');
      checks.push('Production preload and IPC load actual packaged ESM, styles and model view in sandboxed Chromium');
      const originalConfig = await evaluate('window.__packClient.latestConfig');
      await evaluate(`(() => { const summary=document.querySelector('.react-flow__node[data-id=assemble] details.s2-prompt-node-editor > summary');
        if (summary?.textContent.trim() !== '提示词结构') throw Error('Packaged compose disclosure missing'); summary.click(); })()`);
      await wait('!!document.querySelector("[aria-label=组装结构]")?.getClientRects().length');
      await fill('.react-flow__node[data-id=assemble] [aria-label="入口1标题"]', '角色说明：');
      await wait('window.__packClient.latestConfig.initial.execution.nodes.find(x=>x.id==="assemble").bindings.prefixes.value[0] === "角色说明："');
      await shot('01a-packaged-compose-editor');
      const editedConfig = await evaluate('window.__packClient.latestConfig');
      assert.deepEqual(editedConfig.initial.execution.links, originalConfig.initial.execution.links);
      for (const key of ['part1', 'part2', 'part3']) assert.deepEqual(
        editedConfig.initial.execution.nodes.find((node: any) => node.id === 'assemble').bindings[key],
        originalConfig.initial.execution.nodes.find((node: any) => node.id === 'assemble').bindings[key]);
      await evaluate(`document.querySelector('.react-flow__node[data-id=assemble] details.s2-prompt-node-editor > summary').click()`);
      checks.push('Packaged inline compose editor commits on Enter without changing source mappings or wires');
      // Match the current package's explicit per-node Test action. Editing,
      // saving and reopening must never send; there is no retired budget dialog.
      await fill('.react-flow__node[data-id=testModel] [aria-label="输出长度上限"]', '512');
      await wait('window.__packClient.latestConfig.initial.execution.nodes.find(x=>x.id==="testModel").bindings.maxOutputTokens?.value === 512');
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      const savedPrompt = await save();
      await evaluate(`window.__packClient.openSaved(${JSON.stringify(savedPrompt.sceneId)})`);
      await wait(`window.__packClient.latestDraft?.sceneId === ${JSON.stringify(savedPrompt.sceneId)} && !!document.querySelector('.s2-toolbar')`);
      await wait('document.querySelector(".react-flow__node[data-id=testModel] [aria-label=输出长度上限]")?.value === "512"');
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 0);
      await click('测试');
      await wait('window.__packClient.syntheticModelRequests.length === 1');
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests[0].maxOutputTokens'), 512);
      const request = await evaluate('window.__packClient.syntheticModelRequests[0]');
      assert(request.prompt.startsWith('角色说明：'), 'The sent request uses the real edited assembler result');
      assert.equal(request.input, originalConfig.initial.nodes.find((node: any) => node.id === 'testInput').values.content);
      await wait('document.querySelector(".react-flow__node[data-id=showResult]")?.textContent.includes("合成模型回包")');
      assert.equal(await evaluate('window.__packClient.syntheticModelRequests.length'), 1, 'Exactly one request per explicit test click');
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(x=>/^(开始试验|准备本局模型测试（不发送）|确认发送本次模型请求)$/.test(x.textContent.trim()))'), false);
      checks.push('Inline parameters and scene reopen send nothing; the explicit Test action sends exactly one synthetic request with edited prompt, original material and 512-token limit, then displays the complete result');
      await shot('01b-packaged-prompt-result');
      await open('legacy');
      const savedLegacy = await save();
      await open('base'); const savedBase = await save();
      assert.equal(savedBase.interactionPack, null);
      await evaluate(`window.__packClient.openSaved(${JSON.stringify(savedBase.sceneId)})`);
      await wait('!!window.__packClient.latestDraft');
      assert.equal(await evaluate('window.__packClient.latestDraft.interactionPack'), null);
      checks.push('Explicit plain S2 stays unbound after saving and reopening');
      await open('arithmetic'); await click('计算并显示');
      await wait('document.querySelector(".react-flow__node[data-id=show]")?.textContent.includes("5")');
      checks.push('Independent numeric package runs 2+3→5 in the same client');
      await fs.writeFile(path.join(proof, '../installed.json'), JSON.stringify({ savedPrompt, savedLegacy, savedBase }, null, 2));
    }
    assert.deepEqual(externalRequests, [], 'No network/model/provider request is permitted');
    assert.deepEqual(errors, [], 'No application exceptions or React errors');
    const report = { scenario, checks, externalRequests, rendererErrors: errors, layoutNotifications, nativeElectron: process.versions.electron,
      scope: 'Real Electron BrowserWindow, production preload/pack IPC/loader/S2 UI; isolated synthetic vault and model transport. Not the full installed application or a live model test.' };
    await fs.mkdir(proof, { recursive: true });
    await fs.writeFile(path.join(proof, 'report.json'), JSON.stringify(report, null, 2));
    console.log('NATIVE_PACK_PASS ' + scenario + ': ' + checks.join('; '));
    window.destroy(); app.exit(0);
  } catch (error) {
    fs.lstat = nativeLstat;
    fs.rename = nativeRename;
    fs.readFile = nativeRead;
    console.error(error); console.error('Renderer errors:', errors);
    const body = await Promise.race([evaluate('document.body.innerText').catch(() => ''), new Promise<string>(resolve => setTimeout(() => resolve('Renderer body unavailable'), 1000))]);
    console.error(body.slice(-7000));
    await Promise.race([shot('failure').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
    window.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
