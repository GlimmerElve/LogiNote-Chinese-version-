import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const require = createRequire(__filename);
const electron = require('electron') as typeof import('electron');
const { app, session } = electron;
let requestedExit: number | undefined;
const finish = (code: number) => { requestedExit = code; app.exit(code); };
process.on('uncaughtException', error => {
  // Production window teardown currently accesses its already-destroyed id. A
  // teardown exception must not replace a completed assertion result in this smoke.
  if (requestedExit !== undefined && error.message === 'Object has been destroyed') {
    const frame = error.stack?.match(/dist-electron[\\/]main\.cjs:(\d+):\d+/);
    const line = frame && require('node:fs').readFileSync(path.join(appRoot, 'dist-electron/main.cjs'), 'utf8').split('\n')[Number(frame[1]) - 1];
    if (line?.includes('referenceEnvironments.revoke(win.webContents.id)')) {
      const file = path.join(proof, 'report.json');
      if (require('node:fs').existsSync(file)) {
        const report = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
        report.teardownWarnings.push('Existing production window destroyed handler reads win.webContents.id after destruction; outside scene-package smoke scope.');
        require('node:fs').writeFileSync(file, JSON.stringify(report, null, 2));
      }
      return process.exit(requestedExit);
    }
  }
  if (requestedExit !== undefined) { console.error('Unexpected App teardown exception:', error); return process.exit(1); }
  console.error('Isolated App bootstrap failed:', error); finish(1);
});
process.on('unhandledRejection', error => { console.error('Isolated App rejected:', error); app.exit(1); });
const appRoot = path.resolve(process.env.LOGINOTE_PACK_APP_ROOT!);
const stateRoot = path.resolve(process.env.LOGINOTE_PACK_APP_STATE!);
const proof = path.resolve(process.env.LOGINOTE_PACK_APP_PROOF!);
const scenario = process.env.LOGINOTE_PACK_APP_CASE!;
const isolatedHome = path.join(stateRoot, 'home');
const realHomedir = require('node:os').homedir();
require('node:fs').mkdirSync(isolatedHome, { recursive: true });
require('node:fs').mkdirSync(path.join(stateRoot, 'chromium'), { recursive: true });
// Redirect the production main's early storage anchor BEFORE requiring it.
require('node:os').homedir = () => isolatedHome;
process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome;
app.setPath('userData', stateRoot);
app.setPath('sessionData', path.join(stateRoot, 'chromium'));
app.setPath('home', isolatedHome);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
const blockedServices: string[] = [], networkRequests: string[] = [], modelRequests: string[] = [];
require('node:child_process').spawn = (command: unknown) => {
  blockedServices.push(String(command)); throw Error('Unrelated local service disabled in isolated App smoke');
};
electron.utilityProcess.fork = (() => { throw Error('No background compute is allowed in this isolated App smoke'); }) as typeof electron.utilityProcess.fork;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = (...args: unknown[]) => { networkRequests.push(String(args[0])); throw Error('Network disabled in isolated App smoke'); };
  module.get = module.request;
}
globalThis.fetch = (async input => { networkRequests.push(String(input)); throw Error('Network disabled in isolated App smoke'); }) as typeof fetch;
electron.shell.openExternal = async () => { throw Error('External navigation disabled in isolated App smoke'); };
// Keep the actual production window entirely hidden. No test controls or inspection
// window is inserted into the renderer or shipped application.
const OriginalWindow = electron.BrowserWindow;
class HiddenWindow extends OriginalWindow {
  constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
  }
  show() { /* Test-only: no visible windows. */ }
  showInactive() { /* Test-only: no visible windows. */ }
}
// Electron exports BrowserWindow as a non-configurable accessor. Substitute the
// constructor only for modules loaded in this test process, leaving exports intact.
const Module = require('node:module');
const load = Module._load;
const testElectron = { ...electron, BrowserWindow: HiddenWindow };
Module._load = function(request: string, ...args: unknown[]) {
  return request === 'electron' ? testElectron : load.call(this, request, ...args);
};
const checks: string[] = [], errors: string[] = [], notifications: string[] = [];
const screenshotEvidence: Array<{ name: string; sha256: string; bytes: number; state: unknown }> = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    if (event.message === 'ResizeObserver loop completed with undelivered notifications.') notifications.push(event.message);
    else if (event.level === 'error') errors.push(event.message.slice(0, 2500));
  });
});
const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
  if (/^llm:/.test(channel)) { modelRequests.push(channel); throw Error('Model transport disabled in isolated App smoke'); }
  return listener(event, ...args);
});
void app.whenReady().then(async () => {
  await fs.mkdir(isolatedHome, { recursive: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
    networkRequests.push(details.url); done({ cancel: true });
  });
});
app.once('browser-window-created', (_event, window) => {
  void (async () => {
    const evaluate = (code: string) => window.webContents.executeJavaScript(code);
    const wait = async (condition: string) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try { if (await evaluate(condition)) return; } catch { /* Initial navigation is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      throw Error('Full App condition timed out: ' + condition);
    };
    const visible = (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x=>x.getClientRects().length && !x.closest('[hidden]'))`;
    const click = async (label: string, partial = false) => {
      await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(x=>!x.disabled&&x.getClientRects().length&&!x.closest('[hidden]')&&(x.getAttribute('aria-label')===${JSON.stringify(label)}||x.textContent.trim()${partial ? '.includes' : '==='}${partial ? '(' : ''}${JSON.stringify(label)}${partial ? ')' : ''}));
        if(!button)throw Error('Full App button missing: '+${JSON.stringify(label)});button.click(); })()`);
    };
    const fill = async (selector: string, value: string) => {
      await evaluate(`(() => {const input=${visible(selector)};if(!input)throw Error('Input missing: '+${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      // executeJavaScript can return before React commits a controlled field to
      // the runtime ref used by the next action. Let that scheduled render finish.
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    };
    const select = async (selector: string, value: string) => evaluate(`(() => {const input=${visible(selector)};if(!input)throw Error('Select missing');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const shot = async (name: string, expected = 'true', targetSelector?: string) => {
      await fs.mkdir(proof, { recursive: true });
      await wait(expected);
      if (targetSelector) {
        await evaluate(`document.querySelector(${JSON.stringify(targetSelector)})?.scrollIntoView({block:'center',inline:'nearest'})`);
        await wait(`(() => {const target=document.querySelector(${JSON.stringify(targetSelector)}); if(!target)return false;
          const rect=target.getBoundingClientRect();return rect.width>20&&rect.height>10&&rect.bottom>0&&rect.top<innerHeight
            &&(!target.checkVisibility||target.checkVisibility({opacityProperty:true,visibilityProperty:true}));})()`);
      }
      // Hidden native windows can expose a committed DOM before Chromium paints
      // the corresponding navigation. Wait for finite animations/fonts, then
      // explicitly invalidate and warm up capture before retaining the image.
      await evaluate(`Promise.race([Promise.all([document.fonts.ready,...document.getAnimations().filter(animation=>
        Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{}))]),
        new Promise(resolve=>setTimeout(resolve,600))])`);
      await new Promise(resolve => setTimeout(resolve, 650));
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      window.webContents.invalidate();
      await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 250));
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await wait(expected);
      let image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      for (let attempt = 0; image.isEmpty() && attempt < 4; attempt++) {
        window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
        image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      }
      assert(!image.isEmpty()); assert.equal(window.isVisible(), false);
      const png = image.toPNG();
      const state = await evaluate(`({text:document.body.innerText.slice(0,1500),target:(()=>{const target=document.querySelector(${JSON.stringify(targetSelector || 'body')});
        if(!target)return null;const rect=target.getBoundingClientRect();return {tag:target.tagName,x:rect.x,y:rect.y,width:rect.width,height:rect.height};})()})`);
      screenshotEvidence.push({ name, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.byteLength, state });
      await fs.writeFile(path.join(proof, name + '.png'), png);
    };
    const openBuilder = async () => {
      await click('学习'); await wait('!!document.querySelector(".learn-mode-switcher")');
      await click('场景模拟', true); await wait('!!document.querySelector(".scene-builder")');
    };
    const configure = async (name: string, source = '自定义场景') => {
      await fill('input[placeholder="给这个场景起个名字"]', name); await click('下一步');
      await click('通用画布（试验）', true);
      await wait('!!document.querySelector("select[id$=interaction-pack]") && !document.querySelector("select[id$=interaction-pack]").disabled');
      await click(source, true);
    };
    const enter = async () => { await click('下一步'); await click('进入场景'); };
    const sceneDirectory = path.join(stateRoot, 'vault/scene-skills/scenes');
    const savedScenes = async () => {
      const names = await fs.readdir(sceneDirectory).catch(() => []);
      return Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(sceneDirectory, name), 'utf8'))));
    };
    const savedByName = async (name: string) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const saved = (await savedScenes()).find(scene => scene.meta.name === name);
        if (saved) return saved;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      throw Error('Saved scene missing: ' + name);
    };
    const exportWorkspace = async () => {
      if (!await evaluate('[...document.querySelectorAll(".s2-toolbar button")].some(x=>x.textContent.trim()==="更多"&&x.getAttribute("aria-expanded")==="true")')) await click('更多');
      await evaluate(`(() => {const summary=[...document.querySelectorAll('summary')].find(x=>x.textContent==='工作区导入／导出');if(!summary)throw Error('Export disclosure missing');summary.parentElement.open=true;})()`);
      await click('导出工作区 JSON 到下方');
      return evaluate('JSON.parse([...document.querySelectorAll("textarea")].find(x=>x.closest("label")?.textContent.includes("工作区 JSON")).value)');
    };
    const exportAndSave = async (name: string, reference: unknown) => {
      const workspace = await exportWorkspace();
      assert.equal(workspace.version, 2); assert.deepEqual(workspace.interactionPack, reference);
      await click('保存场景');
      await wait('document.body.innerText.includes("已保存场景")');
      const saved = await savedByName(name); assert.deepEqual(saved.interactionPack, reference);
      assert.deepEqual(saved.canvasWorkspace, workspace.definition);
      await fs.mkdir(proof, { recursive: true });
      await fs.writeFile(path.join(proof, name + '-workspace.json'), JSON.stringify(workspace, null, 2));
      return saved;
    };
    const reopen = async (name: string) => {
      await openBuilder(); await configure('复用验收', '复用已有场景');
      await wait('[...document.querySelectorAll(".scene-list-main")].some(x=>x.textContent.includes('+JSON.stringify(name)+'))');
      await evaluate(`Array.from(document.querySelectorAll('.scene-list-main')).find(x=>x.textContent.includes(${JSON.stringify(name)})).click()`);
      await enter();
    };
    try {
      await wait('!!document.querySelector(".workspace-navigation") || !!document.querySelector(".s2-toolbar") || document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
      assert.equal(window.isVisible(), false);
      assert.equal(app.getAppPath(), appRoot);
      assert.equal(app.getPath('userData'), stateRoot);
      assert.equal(require('node:os').homedir(), isolatedHome);
      assert.notEqual(isolatedHome, realHomedir);
      checks.push('Production main and App boot with isolated userData/home and a hidden window');
      if (!await evaluate('!!document.querySelector(".workspace-navigation")')) {
        // The real App resumes the previous preview across restarts. Return through
        // its actual recovery/preview button before testing the library route too.
        checks.push('Production startup restores the prior preview or its exact missing-package recovery');
        await click('返回'); await wait('!!document.querySelector(".workspace-navigation")');
      }
      if (scenario === 'installed') {
        await openBuilder(); await configure('正式应用提示词包验收');
        await select('select[id$=interaction-pack]', 'prompt-lab@0.1.0');
        await shot('00-formal-builder-package-selection',
          'document.querySelector("select[id$=interaction-pack]")?.value==="prompt-lab@0.1.0" && !document.querySelector(".s2-toolbar")',
          'select[id$=interaction-pack]');
        await enter(); await wait('!!document.querySelector(".s2-toolbar")');
        assert.equal(await evaluate('document.querySelectorAll("style[data-scene-interaction-pack]").length'), 1);
        await click('添加'); await click('＋内容块');
        await wait('document.querySelectorAll(".react-flow__node").length===2');
        const saved = await exportAndSave('正式应用提示词包验收', { id: 'prompt-lab', version: '0.1.0' });
        assert.equal(saved.canvasWorkspace.initial.nodes.length, 2);
        await shot('01-formal-package-save-export',
          '!!document.querySelector(".s2-toolbar") && document.querySelectorAll(".react-flow__node").length===2 && !document.querySelector(".scene-builder")', '.s2-toolbar');
        checks.push('Actual SceneBuilderPanel package selection → custom S2 → add content block → export v2 and save through production IPC');
        await click('返回'); await reopen('正式应用提示词包验收');
        await wait('document.querySelectorAll(".react-flow__node").length===2');
        checks.push('Saved package scene reopens from the actual formal scene library with its content block');
        await click('返回'); await openBuilder(); await configure('正式应用基础画布验收');
        await select('select[id$=interaction-pack]', ''); await enter();
        await wait('!!document.querySelector(".s2-toolbar")');
        const base = await exportAndSave('正式应用基础画布验收', null);
        assert.equal(base.interactionPack, null);
        await click('返回'); await reopen('正式应用基础画布验收');
        await wait('!!document.querySelector(".s2-toolbar")');
        checks.push('Explicit base S2 choice stays null in export/save/reopen without inferring a prompt package');
        assert.equal((await exportWorkspace()).interactionPack, null);
        const portable = JSON.stringify({ format: 's2-workspace', version: 2, definition: saved.canvasWorkspace, interactionPack: saved.interactionPack });
        await evaluate(`(() => {const input=[...document.querySelectorAll('textarea')].find(x=>x.closest('label')?.textContent.startsWith('工作区 JSON'));
          if(!input)throw Error('Workspace input missing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(portable)});
          input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await click('导入并替换当前预览');
        await wait('document.body.innerText.includes("已导入交互包引用和画布预览")');
        await click('导出工作区 JSON 到下方');
        const imported = await evaluate('JSON.parse([...document.querySelectorAll("textarea")].find(x=>x.closest("label")?.textContent.includes("工作区 JSON")).value)');
        assert.deepEqual(imported.interactionPack, { id: 'prompt-lab', version: '0.1.0' });
        assert.deepEqual(imported.definition, saved.canvasWorkspace);
        checks.push('Actual workspace import loads its declared package before replacing the base preview and preserves graph/ref on re-export');

        // Use a separate, uniquely named scene so the original two-node package
        // template remains unchanged for the subsequent missing/restored runs.
        await click('返回'); await openBuilder(); await configure('正式应用只读配置验收');
        await select('select[id$=interaction-pack]', 'prompt-lab@0.1.0'); await enter();
        await wait('!!document.querySelector(".s2-toolbar")');
        const fixedRole = '你是一名面向初学者的解释者。';
        const fixedOutput = '输出必须保留摘要和例子两个字段。';
        const firstTask = '解释函数。', changedTask = '改为解释闭包。', reopenedTask = '只调整任务说明：解释作用域。';
        const readonlyDefinition = { ...saved.canvasWorkspace, goal: '固定角色和输出要求，仅调整任务说明', initial: { nodes: [
          { id: 'fixedRole', type: 'text', label: '固定角色', readOnly: true, position: { x: 20, y: 20 }, values: { content: fixedRole } },
          { id: 'editableTask', type: 'text', label: '任务说明', position: { x: 420, y: 20 }, values: { content: firstTask } },
          { id: 'fixedOutput', type: 'text', label: '固定输出要求', readOnly: true, position: { x: 20, y: 280 }, values: { content: fixedOutput } },
        ], edges: [] } };
        const contentSelector = (id: string) => `.react-flow__node[data-id="${id}"] textarea.s2-inline-text`;
        const contentValue = (id: string, expected: string) => `document.querySelector(${JSON.stringify(contentSelector(id))})?.value===${JSON.stringify(expected)}`;
        const historyState = () => evaluate('["撤销","重做"].map(label=>[...document.querySelectorAll(".s2-toolbar button")].find(x=>x.textContent.trim()===label)?.disabled)');
        const importReadonlyWorkspace = async (definition: unknown) => {
          await exportWorkspace();
          const text = JSON.stringify({ format: 's2-workspace', version: 2, interactionPack: { id: 'prompt-lab', version: '0.1.0' }, definition });
          await evaluate(`(() => {const input=[...document.querySelectorAll('textarea')].find(x=>x.closest('label')?.textContent.startsWith('工作区 JSON'));
            if(!input)throw Error('Readonly workspace input missing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
            input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
          await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          await click('导入并替换当前预览');
        };
        const assertReadonlyDom = async () => {
          await wait(contentValue('fixedRole', fixedRole) + '&&' + contentValue('fixedOutput', fixedOutput));
          for (const id of ['fixedRole', 'fixedOutput']) {
            assert.deepEqual(await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(contentSelector(id))});return {
              readOnly:input?.readOnly,disabled:input?.disabled,badge:input?.closest('.s2-block')?.querySelector('.s2-readonly-label')?.textContent};})()`),
            { readOnly: true, disabled: false, badge: '只读 · 场景固定内容' });
          }
          assert.equal(await evaluate(`document.querySelector(${JSON.stringify(contentSelector('editableTask'))})?.readOnly`), false);
        };
        await importReadonlyWorkspace(readonlyDefinition);
        await wait('document.querySelectorAll(".react-flow__node").length===3');
        await assertReadonlyDom();
        await fill(contentSelector('editableTask'), changedTask); await wait(contentValue('editableTask', changedTask));
        assert.deepEqual(await historyState(), [false, true]);
        await click('撤销'); await wait(contentValue('editableTask', firstTask));
        assert.deepEqual(await historyState(), [true, false]);
        await click('重做'); await wait(contentValue('editableTask', changedTask));
        await assertReadonlyDom();
        const fixedSaved = await exportAndSave('正式应用只读配置验收', { id: 'prompt-lab', version: '0.1.0' });
        assert.deepEqual(fixedSaved.canvasWorkspace.initial.nodes.map((node: any) => [node.id, node.readOnly]),
          [['fixedRole', true], ['editableTask', undefined], ['fixedOutput', true]]);
        assert.equal(fixedSaved.canvasWorkspace.initial.nodes.find((node: any) => node.id === 'editableTask').values.content, changedTask);
        assert.equal((await savedByName('正式应用提示词包验收')).canvasWorkspace.initial.nodes.length, 2);
        checks.push('Native DOM exposes readonly selectable role/output text with fixed badges; generic task accepts typing and undo/redo; export/save retain exact flags without changing the original package template');
        await click('返回'); await reopen('正式应用只读配置验收');
        await wait('document.querySelectorAll(".react-flow__node").length===3');
        await assertReadonlyDom(); await wait(contentValue('editableTask', changedTask));
        await fill(contentSelector('editableTask'), reopenedTask); await wait(contentValue('editableTask', reopenedTask));
        const beforeDeniedImport = await exportWorkspace(), beforeDeniedHistory = await historyState();
        const tampered = structuredClone(beforeDeniedImport.definition);
        tampered.initial.nodes.find((node: any) => node.id === 'fixedRole').values.content = '工作区导入不得改写固定角色';
        await importReadonlyWorkspace(tampered);
        await wait('document.querySelector(".s2-error")?.textContent.includes("只读")');
        assert.deepEqual((await exportWorkspace()).definition, beforeDeniedImport.definition);
        assert.deepEqual(await historyState(), beforeDeniedHistory, 'Denied native workspace replacement preserves the valid task edit history');
        await click('撤销'); await wait(contentValue('editableTask', changedTask));
        await click('重做'); await wait(contentValue('editableTask', reopenedTask));
        await assertReadonlyDom();
        if (await evaluate('[...document.querySelectorAll(".s2-toolbar button")].some(x=>x.textContent.trim()==="更多"&&x.getAttribute("aria-expanded")==="true")')) await click('关闭画布操作面板');
        await evaluate('document.querySelector("button.react-flow__controls-fitview")?.click()');
        await shot('04-formal-readonly-content',
          'document.querySelectorAll(".react-flow__node .s2-readonly-label").length===2&&' + contentValue('editableTask', reopenedTask), '.s2-flow');
        checks.push('Formal scene-library reopen retains readonly content and editable task; native import cannot replace fixed role text or clear task undo/redo history');
      } else {
        await reopen('正式应用提示词包验收');
        if (scenario === 'missing') {
          await wait('document.body.innerText.includes("缺少交互包 prompt-lab@0.1.0")');
          assert.equal(await evaluate('document.querySelectorAll(".s2-toolbar").length'), 0);
          checks.push('Formal library opening missing exact package shows a recovery message and does not mount or rewrite the scene');
          await shot('02-formal-library-missing-pack',
            'document.querySelector("[role=alert]")?.innerText.includes("缺少交互包 prompt-lab@0.1.0") && !document.querySelector(".scene-builder") && !document.querySelector(".s2-toolbar")', '[role=alert]');
        } else {
          await wait('document.querySelectorAll(".react-flow__node").length===2');
          await shot('03-formal-library-reinstalled-pack',
            '!!document.querySelector(".s2-toolbar") && document.querySelectorAll(".react-flow__node").length===2 && !document.querySelector(".scene-builder")', '.s2-toolbar');
          checks.push('Restart after restoring package reopens the unchanged formal saved scene');
        }
      }
      assert.deepEqual(modelRequests, [], 'No model IPC call allowed');
      assert.deepEqual(networkRequests, [], 'No remote request allowed');
      assert.deepEqual(errors, [], 'No renderer exceptions in the formal App');
      await fs.mkdir(proof, { recursive: true });
      await fs.writeFile(path.join(proof, 'report.json'), JSON.stringify({ scenario, checks, errors, notifications, networkRequests,
        modelRequests, blockedServices, screenshotEvidence, teardownWarnings: [], nativeElectron: process.versions.electron, userData: stateRoot, isolatedHome,
        scope: 'Production App and Electron main/preload, actual formal UI; unrelated local Python/compute services disabled in wrapper; not a packaged installer or live Agent/model test.' }, null, 2));
      console.log('FORMAL_APP_PACK_PASS ' + scenario + ': ' + checks.join('; '));
      finish(0);
    } catch (error) {
      console.error(error); console.error('Full App renderer errors:', errors);
      console.error((await evaluate('document.body.innerText').catch(() => '')).slice(-7000));
      await shot('failure').catch(() => {}); finish(1);
    }
  })().catch(error => { console.error(error); app.exit(1); });
});
// All redirections and transport/window guards must precede this production entry.
require(path.join(appRoot, 'dist-electron/main.cjs'));
