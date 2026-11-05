import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { applyWindowTheme, connectWindowAppearance, normalizeWindowTheme, windowThemeBackground,
  type WindowAppearanceApi, type WindowTheme } from '../src/services/ui/windowAppearance';

function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(initialTheme: WindowTheme = 'dark') {
  const read = deferred(), applied: WindowTheme[] = [], errors: unknown[] = [];
  let listener: ((value: unknown) => void) | undefined, reads = 0, removed = 0;
  const api: WindowAppearanceApi = { initialTheme, getTheme: () => { reads += 1; return read.promise; },
    onThemeChanged: callback => { listener = callback; return () => { removed += 1; }; } };
  const stop = connectWindowAppearance(api, theme => applied.push(theme), error => errors.push(error));
  return { read, applied, errors, stop, emit: (theme: unknown) => listener?.(theme), counts: () => ({ reads, removed }) };
}
{
  const h = fixture(); assert.deepEqual(h.applied, ['dark'], 'preload theme is applied synchronously before rendering');
  await tick(); h.emit('light'); h.read.resolve('dark'); await tick();
  assert.deepEqual(h.applied, ['dark', 'light'], 'late initial read cannot overwrite a live theme change');
  h.emit({ theme: 'dark' }); h.emit('invalid'); assert.equal(h.applied.length, 2);
  h.stop(); h.stop(); h.emit('dark'); assert.equal(h.counts().removed, 1); assert.equal(h.applied.length, 2);
}
{
  const h = fixture('light'); await tick(); h.read.resolve('dark'); await tick();
  assert.deepEqual(h.applied, ['light', 'dark']); h.stop();
}
{
  const applied: WindowTheme[] = [];
  const stop = connectWindowAppearance({ initialTheme: 'light', getTheme: async () => 'light',
    onThemeChanged: callback => { callback('dark'); return () => {}; } }, theme => applied.push(theme));
  await tick(); assert.deepEqual(applied, ['light', 'dark'], 'an event during subscription also outranks the initial read'); stop();
}
{
  const h = fixture(); await tick(); h.stop(); h.read.resolve('light'); await tick();
  assert.deepEqual(h.applied, ['dark'], 'a closed window ignores a delayed initial result');
}
{
  const h = fixture(); h.stop(); await tick(); assert.equal(h.counts().reads, 0, 'closing before the initial read prevents unused IPC');
}
{
  const h = fixture(); await tick(); h.read.reject(new Error('原生主题读取失败')); await tick();
  assert.deepEqual(h.applied, ['dark']); assert.equal(h.errors.length, 1);
  h.emit('light'); assert.deepEqual(h.applied, ['dark', 'light'], 'live events still recover after read failure'); h.stop();
}
connectWindowAppearance(undefined, () => { throw new Error('browser mode must keep its existing theme'); })();
const root = { classList: { toggle: (name: string, on: boolean) => { assert.equal(name, 'dark'); toggled = on; } }, style: { colorScheme: '' } };
let toggled = false;
applyWindowTheme('dark', root as any); assert.equal(toggled, true); assert.equal(root.style.colorScheme, 'dark');
applyWindowTheme('light', root as any); assert.equal(toggled, false); assert.equal(root.style.colorScheme, 'light');
for (const value of [null, undefined, '', {}, ['dark'], 'system']) assert.equal(normalizeWindowTheme(value), null);
const tokens = readFileSync('src/styles/design-tokens.css', 'utf8');
assert.ok(tokens.includes(`--ln-paper-50: ${windowThemeBackground('light')}`));
assert.ok(tokens.includes(`--ln-paper-50: ${windowThemeBackground('dark')}`));

// Execute the actual main-process theme broadcaster and IPC handlers; all windows
// and settings are synthetic. No Electron instance or personal files are loaded.
const main = readFileSync('src/electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true), nodes: ts.Node[] = [];
const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); }; visit(ast);
const publish = nodes.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'publishWindowTheme'); assert.ok(publish);
const registrations = ['window:theme-get', 'window:theme-update'].map(name => {
  const call = nodes.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'ipcMain.handle'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === name); assert.ok(call); return call.getText(ast) + ';';
});
const callbacks = new Map<string, (...args: any[]) => any>(), events: any[] = [], backgrounds: string[] = [], workbenchThemes: WindowTheme[] = [], figureThemes: WindowTheme[] = [];
const sender = { mainFrame: {} }, mainWindow = { webContents: sender, isDestroyed: () => false };
const windowMock = { isDestroyed: () => false, setBackgroundColor: (color: string) => backgrounds.push(color),
  webContents: { isDestroyed: () => false, send: (name: string, theme: string) => events.push({ name, theme }) } };
const code = ts.transpileModule(`let currentWindowTheme = 'light', windowThemeReady = false; const h5pHost=undefined;
${publish.getText(ast)}\n${registrations.join('\n')}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('BrowserWindow', 'ipcMain', 'mainWindow', 'normalizeWindowTheme', 'windowThemeBackground', 'setResourceWorkbenchTheme', 'setInteractiveFigureTheme', code)(
  { getAllWindows: () => [windowMock, { isDestroyed: () => true }] },
  { handle: (name: string, fn: any) => callbacks.set(name, fn) }, mainWindow,
  normalizeWindowTheme, windowThemeBackground, (theme: WindowTheme) => workbenchThemes.push(theme), (theme: WindowTheme) => figureThemes.push(theme));
const update = callbacks.get('window:theme-update')!, get = callbacks.get('window:theme-get')!;
const event = { sender, senderFrame: sender.mainFrame };
assert.equal(update(event, 'dark'), true); assert.equal(get(), 'dark');
assert.deepEqual(events, [{ name: 'window:theme-changed', theme: 'dark' }]);
assert.deepEqual(backgrounds, [windowThemeBackground('dark')]); assert.deepEqual(workbenchThemes, ['dark']);
assert.deepEqual(figureThemes, ['dark'], 'appearance updates also reach the figure sandbox');
assert.equal(update(event, 'dark'), true); assert.equal(events.length, 1, 'unchanged settings do not repeatedly broadcast');
assert.equal(update({ sender: {}, senderFrame: {} }, 'light'), false);
assert.equal(update({ sender, senderFrame: {} }, 'light'), false, 'child frames cannot change app theme');
assert.equal(update(event, 'invalid'), false); assert.equal(get(), 'dark');
assert.equal(update(event, 'light'), true); assert.equal(get(), 'light');
assert.deepEqual(figureThemes, ['dark', 'light']);

const app = readFileSync('src/App.tsx', 'utf8'), appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let settingsInitializer: ts.Node | undefined;
function findSettings(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === '[initialSettings]' && node.initializer && ts.isCallExpression(node.initializer)) {
    settingsInitializer = node.initializer.arguments[0];
  }
  ts.forEachChild(node, findSettings);
}
findSettings(appAst); assert.ok(settingsInitializer);
const initializerCode = ts.transpileModule(`return (${settingsInitializer.getText(appAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const theme of ['dark', 'light', undefined]) {
  const initial = new Function('window', 'loadSettingsFromStorage', 'normalizeWindowTheme', initializerCode)(
    { electronAPI: { appearance: { initialTheme: theme } } }, () => ({ theme: 'dark', fontSize: 18 }), normalizeWindowTheme)();
  assert.equal(initial.theme, theme || 'dark'); assert.equal(initial.fontSize, 18, 'theme initialization preserves other settings');
}
for (const entry of ['src/resourceWorkbenchMain.tsx', 'src/argumentEditorMain.tsx']) {
  const text = readFileSync(entry, 'utf8');
  assert.ok(text.indexOf('connectWindowAppearance(') < text.indexOf('createRoot('));
  assert.match(text, /addEventListener\('pagehide', stopAppearance, \{ once: true \}\)/);
}
assert.match(readFileSync('src/electron/resourceBrowser.ts', 'utf8'), /additionalArguments: \[`--loginote-theme=\$\{resourceWorkbenchTheme\}`\]/);
assert.match(main, /additionalArguments: windowThemeReady \? \[`--loginote-theme=\$\{currentWindowTheme\}`\] : \[\]/);
console.log('PASS window appearance: synchronous preload theme, live cross-window updates, stale read/unmount guards, single owner, semantic background and initial settings preservation (memory-only)');
