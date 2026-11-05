import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createResourceSessionCleanup } from '../src/electron/resourceSessionCleanup';

// Execute the actual Electron handlers with deferred, memory-only IO. Never load
// Electron, contact a website, download a file, or touch the user's vault.
function source(file: string) {
  const text = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  return { text, ast, nodes };
}
const browser = source('src/electron/resourceBrowser.ts');
const main = source('src/electron/main.ts');
function compile(node: ts.Node, ast: ts.SourceFile, env: Record<string, any>) {
  const expression = node.getText(ast).replace(/^export\s+/u, '');
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
function declaration(name: string) {
  const node = browser.nodes.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `production function ${name} exists`); return node;
}
function handler(channel: string) {
  const call = main.nodes.find(n => ts.isCallExpression(n) && n.expression.getText(main.ast) === 'ipcMain.handle'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === channel) as ts.CallExpression;
  assert.ok(call, `production IPC ${channel} exists`); return call.arguments[1];
}
function windowHandler(event: string) {
  const call = browser.nodes.find(n => ts.isCallExpression(n) && n.expression.getText(browser.ast) === 'win.on'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === event) as ts.CallExpression;
  assert.ok(call); return call.arguments[1];
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness() {
  const notices: any[] = [], sent: any[] = [], dialogs: ReturnType<typeof deferred>[] = [];
  const targetListeners = new Map<string, Set<(...args: any[]) => void>>();
  const downloads: ReturnType<typeof deferred>[] = [], imports: ReturnType<typeof deferred>[] = [];
  const cleaned: string[] = [], timers: any[] = [];
  let hostDestroyed = false, mainDestroyed = false, hostFocused = true, focusCount = 0;
  const sender = { isDestroyed: () => hostDestroyed, send: (_channel: string, value: any) => notices.push(value), focus: () => { focusCount += 1; } };
  const targetSender = { isDestroyed: () => mainDestroyed, send: (_channel: string, value: any) => sent.push(value),
    on: (name: string, fn: (...args: any[]) => void) => {
      if (!targetListeners.has(name)) targetListeners.set(name, new Set()); targetListeners.get(name)!.add(fn);
    },
    removeListener: (name: string, fn: (...args: any[]) => void) => targetListeners.get(name)?.delete(fn),
  };
  const guest = { isDestroyed: () => hostDestroyed, getURL: () => 'https://synthetic.invalid/',
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }, close: () => {} };
  const host: any = { webContents: sender, isDestroyed: () => hostDestroyed, isFocused: () => hostFocused };
  const target = { webContents: targetSender, isDestroyed: () => mainDestroyed };
  const resource = { title: '合成资料', url: 'https://synthetic.invalid/test.pdf', candidateId: 'a',
    downloadable: true, fileExtension: 'pdf', knowledgeTitles: ['原知识点'] };
  const state: any = { id: 'test', window: host, browserView: { webContents: guest }, feedbackTarget: null,
    request: { draftSessionId: 'draft', source: 'note-editor' }, persistent: true,
    candidates: new Map([['a', resource]]), pendingDecisions: new Map([['a', 'selected']]),
    pendingDownloadCandidateIds: new Set<string>(), nextCandidateNumber: 2,
    query: '测试', searchPageUrl: 'https://synthetic.invalid/', busy: false };
  const sessions = new Map([['test', state]]), pendingResourceWorkbenchCommits = new Map<string, string>();
  const env: Record<string, any> = { sessions, path, clearTimeout: (timer: unknown) => timers.push(timer),
    state, view: state.browserView, guest, resourceSessionCleanup: createResourceSessionCleanup(),
    normalizeBrowserCandidates: (raw: any[]) => raw,
    classifyBrowserResource: (value: any) => ({ ...value, downloadable: true, fileExtension: 'pdf' }),
    inferResourceIsFree: () => true, sanitizeSourcePageUrl: (value: string) => value,
    findCandidateByUrl: (input: any, url: string) => [...input.candidates.values()].find((item: any) => item.url === url),
  };
  for (const name of ['assertResourceSessionEditable', 'cancelResourceSessionCommit', 'resourceWorkbenchState',
    'pushResourceWorkbenchState', 'getResourceWorkbenchPendingCommit', 'beginResourceWorkbenchCommit',
    'isResourceWorkbenchCommitActive', 'updateResourceWorkbenchCommitState', 'completeResourceWorkbenchCommit',
    'restoreResourceWorkbenchFocus',
    'setResourceWorkbenchDecision', 'setResourceWorkbenchDownload', 'closeResourceBrowserSession', 'disposeResourceBrowserSessions']) {
    env[name] = compile(declaration(name), browser.ast, env);
  }
  const closed = compile(windowHandler('closed'), browser.ast, env);
  host.close = () => { hostDestroyed = true; closed(); };
  const closing = compile(windowHandler('close'), browser.ast, env);
  const mainEnv: Record<string, any> = { ...env, pendingResourceWorkbenchCommits, mainWindow: target,
    BrowserWindow: { fromWebContents: (input: unknown) => input === sender ? host : null },
    dialog: { showMessageBox: () => { const next = deferred(); dialogs.push(next); return next.promise; } },
    downloadResourceCandidate: () => { const next = deferred(); downloads.push(next); return next.promise; },
    importRagDocumentPaths: () => { const next = deferred(); imports.push(next); return next.promise; },
    fs: { unlink: async (value: string) => { cleaned.push(value); }, rmdir: async (value: string) => { cleaned.push(value); } },
  };
  const commit = compile(handler('resource-workbench:commit'), main.ast, mainEnv);
  const applied = compile(handler('resource-workbench:commit-applied'), main.ast, mainEnv);
  const close = compile(handler('resource-browser:close'), main.ast, mainEnv);
  return { env, state, host, target, sender, targetSender, sessions, pendingResourceWorkbenchCommits,
    resource, notices, sent, dialogs, downloads, imports, cleaned, timers, targetListeners,
    emitTarget: (name: string, ...args: any[]) => { for (const fn of [...targetListeners.get(name) || []]) fn(...args); },
    commit: (event = { sender }, id: unknown = 'test') => commit(event, id),
    applied: (raw: any, event = { sender: targetSender }) => applied(event, raw),
    close: () => close({ sender }, 'test'),
    closing, destroyMain: () => { mainDestroyed = true; }, focusCount: () => focusCount,
    blurHost: () => { hostFocused = false; } };
}

// The native confirmation itself is single-flight, not only the renderer button.
{
  const h = harness(), first = h.commit();
  assert.equal(h.dialogs.length, 1); assert.equal(h.state.commit.phase, 'confirming');
  assert.equal(h.notices.at(-1).busy, true);
  const duplicate = await h.commit(); assert.equal(duplicate.ok, false); assert.equal(h.dialogs.length, 1);
  assert.throws(() => h.env.setResourceWorkbenchDecision('test', 'a', null), /正在确认或写回/);
  assert.throws(() => h.env.setResourceWorkbenchDownload('test', 'a', true), /正在确认或写回/);
  h.env.pushResourceWorkbenchState(h.state, undefined, false);
  assert.equal(h.notices.at(-1).busy, true, 'late navigation completion cannot unlock a commit');
  h.dialogs[0].resolve({ response: 0 }); assert.equal((await first).canceled, true);
  assert.equal(h.focusCount(), 1, 'native confirmation returns keyboard to the active workbench controls');
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0); assert.equal(h.state.commit, undefined);
  assert.equal([...h.targetListeners.values()].flatMap(items => [...items]).length, 0, 'cancel removes target listeners');
  assert.equal(h.notices.at(-1).busy, false); assert.equal(h.state.pendingDecisions.get('a'), 'selected');
  assert.equal(h.sent.length, 0); assert.equal(h.downloads.length, 0);
  const retry = h.commit(); assert.equal(h.dialogs.length, 2);
  h.dialogs[1].resolve({ response: 0 }); await retry;
}
{
  const h = harness(), job = h.commit(); h.blurHost(); h.dialogs[0].resolve({ response: 0 }); await job;
  assert.equal(h.focusCount(), 0, 'confirm completion cannot steal focus from another window/application');
  h.env.restoreResourceWorkbenchFocus('missing'); assert.equal(h.focusCount(), 0);
}
for (const mode of ['empty', 'wrong-window', 'missing-session', 'main-unavailable']) {
  const h = harness();
  if (mode === 'empty') h.state.pendingDecisions.clear();
  if (mode === 'main-unavailable') h.destroyMain();
  const result = await h.commit(mode === 'wrong-window' ? { sender: {} } as any : undefined,
    mode === 'missing-session' ? 'missing' : 'test');
  assert.equal(result.ok, false, mode); assert.equal(h.dialogs.length, 0);
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0); assert.equal(h.state.commit, undefined);
}
{
  const h = harness(), job = h.commit();
  h.dialogs[0].reject(new Error('原生确认框失败'));
  assert.match((await job).error, /原生确认框失败/);
  assert.equal(h.state.commit, undefined); assert.equal(h.state.busy, false);
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0); assert.equal(h.sent.length, 0);
}
{
  const h = harness(), job = h.commit();
  await h.close(); h.dialogs[0].resolve({ response: 1 });
  assert.match((await job).error, /已关闭/);
  assert.equal(h.downloads.length, 0); assert.equal(h.imports.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0);
}
{
  const h = harness(), job = h.commit();
  h.destroyMain(); h.dialogs[0].resolve({ response: 1 });
  assert.match((await job).error, /主窗口不可用/);
  assert.equal(h.downloads.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.state.commit, undefined);
}
{
  const h = harness(); h.state.pendingDownloadCandidateIds.add('a');
  const job = h.commit(); h.dialogs[0].resolve({ response: 1 }); await tick();
  assert.equal(h.downloads.length, 1); assert.equal((await h.commit()).ok, false);
  await h.close(); h.downloads[0].resolve({ filePath: '/synthetic/temp/download.pdf' });
  assert.match((await job).error, /已关闭/); assert.equal(h.imports.length, 0);
  assert.deepEqual(h.cleaned, ['/synthetic/temp/download.pdf', '/synthetic/temp']);
  assert.equal(h.sent.length, 0); assert.equal(h.pendingResourceWorkbenchCommits.size, 0);
}
{
  const h = harness(); h.state.pendingDownloadCandidateIds.add('a');
  const job = h.commit(); h.dialogs[0].resolve({ response: 1 }); await tick();
  h.downloads[0].resolve({ filePath: '/synthetic/temp/download.pdf' }); await tick();
  assert.equal(h.imports.length, 1);
  await h.close(); h.imports[0].resolve({ ok: true, documents: [{ id: 'already-started' }] });
  assert.match((await job).error, /已关闭/); assert.equal(h.sent.length, 0);
  // An already-started library import cannot be rolled back; no project-write event follows it.
  assert.equal(h.imports.length, 1); assert.equal(h.cleaned.length, 2);
}
for (const failure of ['download', 'import']) {
  const h = harness(); h.state.pendingDownloadCandidateIds.add('a');
  const job = h.commit(); h.dialogs[0].resolve({ response: 1 }); await tick();
  if (failure === 'download') h.downloads[0].reject(new Error('下载失败'));
  else { h.downloads[0].resolve({ filePath: '/synthetic/temp/a.pdf' }); await tick();
    h.imports[0].resolve({ ok: false, error: '入库失败' }); }
  assert.equal((await job).pendingApply, true);
  assert.equal(h.sent[0].downloadErrors.length, 1); assert.equal(h.sent[0].downloadedResources.length, 0);
  assert.equal(h.sent[0].selectedResources.length, 1, 'download failure still keeps the chosen URL');
  h.applied({ ...h.sent[0], ok: false, message: '项目暂时不可写' });
  assert.equal(h.state.commit, undefined); assert.equal(h.notices.at(-1).busy, false);
  assert.equal(h.state.pendingDownloadCandidateIds.has('a'), true); assert.equal(h.pendingResourceWorkbenchCommits.size, 0);
}
{
  const h = harness(), job = h.commit(), token = h.pendingResourceWorkbenchCommits.get('test');
  assert.equal(h.applied({ sessionId: 'test', commitId: token, ok: true }), false, 'cannot acknowledge before handoff');
  h.resource.title = '确认之后修改的标题'; h.resource.knowledgeTitles.push('后来添加');
  h.dialogs[0].resolve({ response: 1 }); assert.equal((await job).pendingApply, true);
  assert.equal(h.sent[0].selectedResources[0].title, '合成资料');
  assert.deepEqual(h.sent[0].selectedResources[0].knowledgeTitles, ['原知识点']);
  assert.equal(h.state.commit.phase, 'applying');
  assert.equal(await h.close(), false); assert.equal(h.sessions.size, 1);
  let prevented = false; h.closing({ preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
  assert.equal(h.applied({ ...h.sent[0], ok: true }, { sender: h.sender } as any), false, 'only main window may confirm saved data');
  assert.equal(h.applied({ ...h.sent[0], commitId: 'stale', ok: true }), false);
  assert.equal(h.applied({ ...h.sent[0], ok: true }), true);
  assert.equal(h.state.pendingDecisions.size, 0); assert.equal(h.sessions.size, 0);
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0); assert.equal(h.applied({ ...h.sent[0], ok: true }), false);
  assert.equal([...h.targetListeners.values()].flatMap(items => [...items]).length, 0, 'successful acknowledgement removes target listeners');
}
{
  const h = harness(), job = h.commit();
  h.dialogs[0].resolve({ response: 1 }); await job;
  h.applied({ ...h.sent[0], ok: false });
  const retry = h.commit(); h.dialogs[1].resolve({ response: 1 }); await retry;
  assert.notEqual(h.sent[0].commitId, h.sent[1].commitId);
  assert.equal(h.applied({ ...h.sent[0], ok: true }), false, 'late previous acknowledgement cannot clear the retry');
  assert.equal(h.state.commit.id, h.sent[1].commitId);
  h.applied({ ...h.sent[1], ok: true });
}
{
  const h = harness(), job = h.commit();
  h.dialogs[0].resolve({ response: 1 }); await job;
  let canceled = 0, rejected = 0;
  h.state.pendingDownload = { timer: 1, reject: () => { rejected += 1; }, cancel: () => { canceled += 1; } };
  await h.env.disposeResourceBrowserSessions();
  assert.equal(h.sessions.size, 0); assert.equal(h.pendingResourceWorkbenchCommits.size, 0);
  assert.equal(rejected, 1); assert.equal(canceled, 1); assert.equal(h.timers.length, 1);
}

for (const event of ['destroyed', 'render-process-gone', 'reload']) {
  const h = harness(), job = h.commit(); h.dialogs[0].resolve({ response: 1 }); await job;
  h.emitTarget('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  h.emitTarget('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.equal(h.state.commit.phase, 'applying', 'route/hash changes and child frames do not interrupt save');
  if (event === 'reload') h.emitTarget('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  else h.emitTarget(event);
  assert.equal(h.state.commit, undefined); assert.equal(h.state.busy, false);
  assert.equal(h.pendingResourceWorkbenchCommits.size, 0); assert.match(h.notices.at(-1).notice, /结果未能确认/);
  assert.equal(h.state.pendingDecisions.get('a'), 'selected'); assert.equal(h.applied({ ...h.sent[0], ok: true }), false);
  assert.equal([...h.targetListeners.values()].flatMap(items => [...items]).length, 0);
  assert.equal(await h.close(), true, 'lost main-window acknowledgement cannot trap the workbench open');
}
{
  const h = harness(); h.state.pendingDownloadCandidateIds.add('a');
  const job = h.commit(); h.dialogs[0].resolve({ response: 1 }); await tick();
  let canceled = 0;
  h.state.pendingDownload = { timer: 1, reject: h.downloads[0].reject, cancel: () => { canceled += 1; } };
  h.emitTarget('render-process-gone'); assert.match((await job).error, /已失效/);
  assert.equal(canceled, 1); assert.equal(h.state.pendingDownload, undefined);
  assert.equal(h.imports.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.state.busy, false);
}
{
  const h = harness(), job = h.commit();
  h.targetSender.send = () => { throw new Error('主窗口消息发送失败'); };
  h.dialogs[0].resolve({ response: 1 }); assert.match((await job).error, /消息发送失败/);
  assert.equal(h.state.commit, undefined); assert.equal(h.state.busy, false); assert.equal(h.pendingResourceWorkbenchCommits.size, 0);
  assert.equal([...h.targetListeners.values()].flatMap(items => [...items]).length, 0);
}

// An already-open native menu and an in-flight URL check cannot change a frozen selection.
{
  const h = harness(), health = deferred(), menus: any[][] = [];
  const env = { ...h.env, win: h.host,
    assertSafePublicUrl: async (value: string) => new URL(value), checkPublicResourceUrl: () => health.promise,
    Menu: { buildFromTemplate: (items: any[]) => { menus.push(items); return { popup: () => {} }; } } };
  const register = compile(declaration('registerCandidateUrl'), browser.ast, env);
  const contextCall = browser.nodes.find(n => ts.isCallExpression(n) && n.expression.getText(browser.ast) === "guest.on"
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'context-menu') as ts.CallExpression;
  assert.ok(contextCall);
  const context = compile(contextCall.arguments[1], browser.ast, { ...env, registerCandidateUrl: register });
  h.state.persistent = false;
  const adding = register(h.state, 'https://synthetic.invalid/new', '迟到候选', 'https://synthetic.invalid/');
  await tick();
  context({}, { pageURL: 'https://synthetic.invalid/new', selectionText: '可复制的正文' });
  const job = h.commit();
  menus[0][0].click(); await tick(); assert.equal(h.state.candidates.size, 1);
  context({}, { pageURL: 'https://synthetic.invalid/new', selectionText: '正文' });
  assert.equal(menus[1][0].enabled, false); assert.equal(menus[1][1].enabled, false);
  assert.equal(menus[1][3].role, 'copy'); assert.equal(menus[1][3].visible, true);
  health.resolve({ status: 'available', finalUrl: 'https://synthetic.invalid/new' });
  await assert.rejects(adding, /正在确认或写回/);
  assert.equal(h.state.candidates.size, 1); assert.equal(h.state.pendingDecisions.size, 1);
  h.dialogs[0].resolve({ response: 0 }); await job;
}
for (const stage of ['snapshot', 'health']) {
  const h = harness(), page = deferred(), health = deferred();
  const scan = compile(declaration('scanResourceBrowserSession'), browser.ast, { ...h.env,
    extractPageSnapshot: () => page.promise, assertSafePublicUrl: async (url: string) => new URL(url),
    checkPublicResourceUrl: () => health.promise,
  });
  h.state.persistent = false;
  const job = scan('test');
  if (stage === 'health') {
    page.resolve({ title: '晚到页面', url: 'https://synthetic.invalid/new', links: [] }); await tick();
  }
  h.env.beginResourceWorkbenchCommit('test', 'scan-freeze', () => {});
  if (stage === 'snapshot') page.resolve({ title: '晚到页面', url: 'https://synthetic.invalid/new', links: [] });
  else health.resolve({ status: 'available', finalUrl: 'https://synthetic.invalid/new' });
  await assert.rejects(job, /正在确认或写回/);
  assert.equal(h.state.candidates.size, 1, 'late scan cannot mutate the confirmation snapshot');
  const navigate = compile(declaration('navigateResourceWorkbench'), browser.ast, h.env);
  await assert.rejects(navigate('test', 'reload'), /正在确认或写回/);
  const authorize = compile(declaration('openAuthenticatedCandidate'), browser.ast, h.env);
  await assert.rejects(authorize('test', 'a'), /正在确认或写回/);
}

// Run the real downloader with synthetic filesystem/session methods. Closing at
// either mkdir boundary must prevent Chromium's downloadURL from being called.
for (const boundary of ['root', 'directory', 'active', 'synchronous-failure']) {
  const h = harness(), gate = deferred(), timerCallbacks: (() => void)[] = [], cleaned: string[] = [];
  let started = 0;
  h.state.browserSession = { downloadURL: () => { started += 1;
    if (boundary === 'synchronous-failure') throw new Error('浏览器下载启动失败'); } };
  const download = compile(declaration('downloadResourceCandidate'), browser.ast, { ...h.env,
    MAX_DOWNLOAD_BYTES: 100 * 1024 * 1024, os: { tmpdir: () => '/synthetic' },
    safeAttachmentFileName: () => 'test.pdf', setTimeout: (callback: () => void) => { timerCallbacks.push(callback); return 1; },
    fs: { mkdir: () => boundary === 'root' ? gate.promise : Promise.resolve(),
      mkdtemp: () => boundary === 'directory' ? gate.promise : Promise.resolve('/synthetic/download-one'),
      unlink: async (value: string) => { cleaned.push(value); }, rmdir: async (value: string) => { cleaned.push(value); } },
  });
  const commitId = 'test-download';
  h.env.beginResourceWorkbenchCommit('test', commitId, () => {});
  const job = download('test', 'a', h.host, true);
  await tick();
  if (boundary !== 'synchronous-failure') {
    await h.close(); gate.resolve('/synthetic/download-one');
  }
  await assert.rejects(job, boundary === 'synchronous-failure' ? /下载启动失败/ : /已关闭/);
  assert.equal(started, boundary === 'active' || boundary === 'synchronous-failure' ? 1 : 0, boundary);
  if (boundary === 'directory') assert.deepEqual(cleaned, ['/synthetic/download-one']);
  if (boundary === 'active' || boundary === 'synchronous-failure') {
    assert.deepEqual(cleaned, [path.join('/synthetic/download-one', 'test.pdf'), '/synthetic/download-one']);
    assert.equal(h.state.pendingDownload, undefined);
  }
  if (timerCallbacks.length) {
    const later = { targetPath: '/synthetic/later.pdf' };
    h.state.pendingDownload = later; timerCallbacks[0]();
    assert.equal(h.state.pendingDownload, later, 'expired earlier timer cannot cancel a newer download');
  }
}
{
  const h = harness(), sessionEvents = new Map<string, any>(), itemEvents = new Map<string, any>();
  let canceled = 0, rejected = 0;
  const pending: any = { url: h.resource.url, targetPath: '/synthetic/file.pdf', timer: 1,
    resolve: () => {}, reject: () => { rejected += 1; } };
  h.state.pendingDownload = pending;
  h.state.browserSession = { setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {},
    webRequest: { onBeforeSendHeaders: () => {}, onBeforeRequest: () => {} },
    on: (name: string, callback: any) => sessionEvents.set(name, callback) };
  compile(declaration('installSessionGuards'), browser.ast, { ...h.env, MAX_DOWNLOAD_BYTES: 100 * 1024 * 1024 })(h.state);
  const item = { getURLChain: () => [h.resource.url], getURL: () => h.resource.url, setSavePath: () => {},
    on: (name: string, callback: any) => itemEvents.set(name, callback),
    once: (name: string, callback: any) => itemEvents.set(name, callback), cancel: () => { canceled += 1; } };
  sessionEvents.get('will-download')({ preventDefault: () => {} }, item);
  await h.close(); assert.equal(canceled, 1); assert.equal(rejected, 1);
  const later = { url: 'https://synthetic.invalid/later' }; h.state.pendingDownload = later;
  itemEvents.get('done')({}, 'cancelled');
  assert.equal(h.state.pendingDownload, later, 'late Chromium completion cannot clear a newer download');
}
console.log('PASS resource workbench native commit ownership, cancellation, acknowledgement, selection freeze and retry (memory-only actual handlers)');
