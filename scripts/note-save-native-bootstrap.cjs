// Test host for the unmodified production main/preload/renderer. All paths are
// synthetic; only the vault IPC timing/failure boundary is instrumented.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, ipcMain, session, dialog, BrowserWindow, utilityProcess, nativeImage } = require('electron');
const root = path.resolve(process.env.LOGINOTE_SAVE_NATIVE_ROOT);
const appRoot = process.env.LOGINOTE_SAVE_NATIVE_PACKAGE || path.join(root, 'app');
const state = path.join(root, 'state');
const home = path.join(root, 'home');
for (const directory of [state, home, path.join(root, 'app-data'), path.join(root, 'logs')]) fs.mkdirSync(directory, { recursive: true });
os.homedir = () => home;
app.setPath('home', home);
app.setPath('appData', path.join(root, 'app-data'));
app.setPath('userData', state);
app.setPath('sessionData', state);
app.setAppLogsPath(path.join(root, 'logs'));
app.setAppPath(appRoot);
if (process.env.SAVE_NATIVE_GPU !== '1') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const control = globalThis.saveNativeTest = { hold: false, failures: 0, events: [], dialogs: [], blockedNetwork: [] };
const trace = name => fs.appendFileSync(path.join(root, 'native.log'), `${Date.now()} ${process.pid} ${name}\n`);
for (const name of ['before-quit', 'will-quit', 'quit', 'window-all-closed']) app.on(name, () => trace(name));
process.on('exit', code => trace('process-exit ' + code));
const register = ipcMain.handle.bind(ipcMain);
const pressureWorkers = [];
register('save-test:command', async (_event, input) => {
  if (input?.op === 'inspect-offline-figure' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1') {
    const win = new BrowserWindow({ show:false, width:900, height:700, webPreferences:{ sandbox:true, nodeIntegration:false, contextIsolation:true } });
    try {
      const share = path.join(root, 'offline-share'), figure = path.join(share, 'figures', 'figure-1.html');
      await win.loadFile(path.join(share, '教材.html'));
      const href = await win.webContents.executeJavaScript("document.querySelector('a[href=\"figures/figure-1.html\"]')?.href || ''");
      const expected = require('node:url').pathToFileURL(figure).href;
      if (href !== expected) throw Error('offline figure link did not resolve to exported attachment');
      const blockedBefore = control.blockedNetwork.length;
      await win.loadURL(href);
      const frame = win.webContents.mainFrame.frames[0]; if (!frame) throw Error('offline figure sandbox missing');
      const state = await frame.executeJavaScript(`(() => {const slider=document.querySelector('input[type=range]');if(!slider)throw Error('missing slider');slider.value='550';slider.dispatchEvent(new Event('input',{bubbles:true}));return {value:document.querySelector('[data-readout-value]')?.textContent,svg:document.querySelectorAll('svg').length,math:document.querySelectorAll('.katex').length,node:typeof process,bridge:typeof electronAPI}})()`);
      return { ...state, linked:true, blocked:control.blockedNetwork.length-blockedBefore };
    } finally { win.destroy(); }
  }
  if (input?.op === 'inspect-offline-export' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1') {
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    try {
      await win.loadFile(path.join(root, 'offline-export.html'));
      const result = await win.webContents.executeJavaScript(`(async () => {const images=[...document.images];await Promise.all(images.map(image=>{image.loading='eager';return image.decode().catch(()=>{})}));return {count:images.length,failed:images.filter(image=>!image.naturalWidth).length,svg:images.filter(image=>image.src.startsWith('data:image/svg+xml')).length,png:images.filter(image=>image.src.startsWith('data:image/png')).length,scripts:document.scripts.length}})()`);
      fs.writeFileSync(path.join(root, 'offline-export.png'), (await win.webContents.capturePage()).toPNG());
      return result;
    } finally { win.destroy(); }
  }
  if (input?.op === 'figure-inspect' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1') {
    const child = BrowserWindow.getAllWindows()[0]?.contentView.children.find(view => view.webContents);
    if (!child) return { found: false, calls: control.figureCalls || 0 };
    return { found: true, calls: control.figureCalls || 0, visible: child.getVisible(),
      value: await child.webContents.executeJavaScript("document.querySelector('#value, [data-readout-value]')?.textContent || ''") };
  }
  if (input?.op === 'figure-adjust' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1') {
    const child = BrowserWindow.getAllWindows()[0]?.contentView.children.find(view => view.webContents);
    if (!child) throw Error('figure is not open');
    await child.webContents.executeJavaScript("const s=document.querySelector('#slider, input[type=range]');s.value=s.id==='slider'?'7':'550';s.dispatchEvent(new Event('input'))");
  }
  if (input?.op === 'figure-capture' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1') {
    const win = BrowserWindow.getAllWindows()[0], child = win?.contentView.children.find(view => view.webContents);
    if (!child || !win) throw Error('figure is not open');
    win.showInactive();
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const image = await child.webContents.capturePage();
      fs.writeFileSync(path.join(root, 'interactive-guest.png'), image.toPNG());
      return { width: image.getSize().width, height: image.getSize().height };
    } finally { win.hide(); }
  }
  if (input?.op === 'pressure-start') {
    if (!process.env.SAVE_NATIVE_PRESSURE_MODELS) throw Error('Synthetic pressure model directory is missing');
    control.pressure = { completed: 0, errors: [], widths: [] };
    for (let index = 0; index < 2; index++) {
      const worker = utilityProcess.fork(path.join(appRoot, 'dist-electron/rag-compute.cjs'), [], { serviceName: '合成后台压力验收', stdio: 'ignore' });
      pressureWorkers.push(worker);
      let replied = false;
      worker.on('exit', code => { if (!replied) { replied = true; control.pressure.errors.push(`worker exited before reply: ${code}`); control.pressure.completed++; } });
      worker.on('message', message => {
        if (message.id !== index + 1 || message.type === 'progress') return;
        if (replied) return; replied = true;
        if (!message.ok) control.pressure.errors.push(message.error);
        else control.pressure.widths.push(message.value[0]?.length);
        control.pressure.completed++;
      });
      worker.postMessage({ id: index + 1, operation: 'embed', args: { texts: Array.from({ length: 64 }, (_, n) => `合成段落${n}：函数与极限、导数与积分。`.repeat(8)) },
        configuration: { modelsDir: process.env.SAVE_NATIVE_PRESSURE_MODELS, pdfExtractScript: path.join(root, 'unused-pdf-extract.py') } });
    }
  }
  if (input?.op === 'pressure-stop') for (const worker of pressureWorkers.splice(0)) worker.kill();
  if (input?.op === 'hold') control.hold = Boolean(input.value);
  if (input?.op === 'fail') control.failures = input.value;
  if (input?.op === 'close') setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 0);
  return { ...control, userData: app.getPath('userData'), enabled: BrowserWindow.getAllWindows()[0]?.isEnabled() };
});
ipcMain.handle = (channel, listener) => register(channel, channel === 'ragDocs:material-image' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1' ? async (event, request) => {
  if (request?.docId === 'fixture-doc' && request?.blockId === 'fixture-block' && request?.version === 'fixture-v1' && request?.imageIndex === 0 && request?.allowedDocIds?.length === 1 && request.allowedDocIds[0] === 'fixture-doc') return { ok: true, value: { dataUrl: nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toDataURL(), alt: '合成原图' } };
  return listener(event, request);
} : channel === 'textbook:figure-approval' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1' ? async (event, request) => {
  if (request?.jobId === 'figure-fixture-job') {
    const job = JSON.parse(fs.readFileSync(path.join(root, 'figure-fixture-job.json'), 'utf8')).job;
    const digest = require('node:crypto').createHash('sha256').update(job.checkpoint.body.trim(), 'utf8').digest('hex');
    if (request.projectId !== job.spec.projectNoteId || request.bodyDigest !== digest || job.stage !== 'published' || job.spec.promptVersion < 7) throw Error('fixture approval mismatch');
    return { allowCloud: job.spec.allowCloud, providerHash: job.spec.providerHash, modelPolicy: job.spec.modelPolicy };
  }
  return listener(event, request);
} : channel === 'textbook:command' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1' ? async (event, request) => {
  if (request?.op === 'get' && request.jobId === 'figure-fixture-job') return JSON.parse(fs.readFileSync(path.join(root, 'figure-fixture-job.json'), 'utf8'));
  return listener(event, request);
} : channel === 'llm:request' && process.env.SAVE_NATIVE_INTERACTIVE_FIXTURE === '1' ? async (_event, request) => {
  if (request.systemPrompt.includes('只读复核员')) {
    control.figureReviewCalls = (control.figureReviewCalls || 0) + 1;
    return { content: JSON.stringify({ assessment: 'issues', findings: [{ message: '合成问题：核对图与说明是否一致。', quote: '平方函数探索' }] }), diagnostics: { finishReason: 'stop' } };
  }
  control.figureCalls = (control.figureCalls || 0) + 1;
  if (process.env.SAVE_NATIVE_FAIL_FIRST_FIGURE === '1' && control.figureCalls === 1) throw Error('合成计划图生成失败');
  const localFunction = request.systemPrompt.includes('本地程序负责曲线');
  if ((!localFunction && !request.systemPrompt.includes('交互教学图')) || !request.userInput.includes('观察平方')) throw Error('unexpected fixture request');
  const html = '<div style="font-family:system-ui;max-width:700px;margin:2rem auto;padding:1rem"><h2>平方函数探索</h2><p>先预测：输入翻倍时，输出会怎样变化？</p><label>输入 x <input id="slider" type="range" min="0" max="10" value="2"></label><p>输出 y = x² = <strong id="value">4</strong></p><svg viewBox="0 0 500 260" style="width:100%;border:1px solid #ccd8d0;border-radius:8px"><line x1="40" y1="220" x2="480" y2="220" stroke="#777"/><line x1="40" y1="20" x2="40" y2="220" stroke="#777"/><polyline points="40,220 84,218 128,212 172,202 216,188 260,170 304,148 348,122 392,92 436,58 480,20" fill="none" stroke="#287b59" stroke-width="3"/><circle id="point" cx="128" cy="212" r="6" fill="#b75e42"/></svg><p>拖动滑块，观察曲线上的点与输出如何同时变化。</p></div><script>document.querySelector("#slider").oninput=e=>{const x=Number(e.target.value);document.querySelector("#value").textContent=x*x;document.querySelector("#point").setAttribute("cx",40+44*x);document.querySelector("#point").setAttribute("cy",220-2*x*x)}</script>';
  const goal = JSON.parse(request.userInput).goal;
  const design = { anchor: goal, goal: '理解平方函数', action: '调整输入', observation: '观察输出', model: '平方关系', prediction: '预测输出', caveat: '教学示例', transfer: '换一个数' };
  if (localFunction) return { content: JSON.stringify({ design, plot: { title: '平方函数探索', variable: 'x', xLabel: 'x', yLabel: 'y', xDomain: [-4, 8], yDomain: [-1, 65], curves: [{ id: 'f', label: 'y=x^2', expression: 'x^2' }] } }), diagnostics: { finishReason: 'stop' } };
  const controls = '<input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换个数预测</p>';
  return { content: JSON.stringify({ html: html + controls, design }), diagnostics: { finishReason: 'stop' } };
} : ['vault:save', 'vault:save-delta'].includes(channel) ? async (event, ...args) => {
  const notes = channel === 'vault:save-delta' ? args[0].upserts.map(entry => entry.note) : args[0];
  const contents = notes.map(note => ({ id: note.id, content: note.content }));
  control.events.push({ phase: 'start', channel, at: Date.now(), contents });
  while (control.hold) await new Promise(resolve => setTimeout(resolve, 20));
  if (control.failures > 0) { control.failures--; control.events.push({ phase: 'failure', at: Date.now() }); throw Error('合成磁盘故障：保存验收'); }
  const result = await listener(event, ...args);
  control.events.push({ phase: 'ack', channel, at: Date.now(), contents });
  return result;
} : listener);
// No native modal can authorize force quit. Expected failure/IME-close dialogs
// return to the existing editor so assertions can inspect the retained draft.
const originalMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = async (...args) => {
  control.dialogs.push(args.at(-1));
  if (process.env.SAVE_NATIVE_REAL_DIALOG === '1') return originalMessageBox(...args);
  if (process.env.SAVE_NATIVE_REAL_DIALOG === 'auto') {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 350);
    try { return await originalMessageBox(...args.slice(0, -1), { ...args.at(-1), signal: abort.signal }); }
    finally { clearTimeout(timer); }
  }
  return { response: 0, checkboxChecked: false };
};
dialog.showMessageBoxSync = (...args) => { control.dialogs.push(args.at(-1)); return 0; };
app.on('browser-window-created', (_event, window) => {
  window.setTitle('LogiNote 独立保存验收');
  if (process.env.SAVE_NATIVE_REAL_DIALOG !== '1') window.hide();
  window.webContents.setBackgroundThrottling(false);
  window.on('close', () => trace('window-close'));
  window.on('closed', () => trace('window-closed'));
  window.webContents.on('render-process-gone', (_event, details) => fs.appendFileSync(path.join(root, 'native.log'), 'RENDERER GONE ' + JSON.stringify(details) + '\n'));
});
app.whenReady().then(() => {
  if (process.env.LOGINOTE_SAVE_NATIVE_PACKAGE) session.defaultSession.registerPreloadScript({
    type: 'frame', filePath: path.join(root, 'test-control-preload.cjs'),
  });
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
  const cancel = !/^(file|data|blob|devtools):/u.test(request.url);
  if (cancel) control.blockedNetwork.push(request.url);
  done({ cancel });
  });
});
require(path.join(appRoot, 'dist-electron/main.cjs'));
