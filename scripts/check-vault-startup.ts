import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createVaultStartup } from '../src/components/useVaultStartup';
import { VaultStartupView } from '../src/components/VaultStartupView';

function getFunction(file: string, name: string, env: Record<string, any>) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }; visit(source);
  assert.ok(found, name);
  const code = ts.transpileModule(found.getText(source).replace(/^export /, '') + `\nreturn ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let reads = 0, loaded: any[] = [], request = deferred<string[]>();
const controller = createVaultStartup(() => { reads++; return request.promise; }, value => loaded.push(value));
let notifications = 0; const unsubscribe = controller.subscribe(() => notifications++);
const first = controller.retry(); assert.equal(controller.retry(), first);
await Promise.resolve(); assert.equal(reads, 1); request.reject(new Error('cannot read original vault'));
await first; assert.equal(controller.getSnapshot().status, 'error'); assert.equal(loaded.length, 0);
request = deferred(); const second = controller.retry(); assert.equal(controller.getSnapshot().status, 'loading');
request.resolve(['original']); await second; assert.equal(controller.getSnapshot().status, 'ready');
assert.deepEqual(loaded, [['original']]); await controller.retry(); assert.equal(reads, 2);
unsubscribe(); const previous = notifications; controller.cancel(); assert.equal(notifications, previous);
const late = deferred<string[]>(); let commits = 0;
const cancelled = createVaultStartup(() => late.promise, () => commits++);
const cancelledRead = cancelled.retry(); cancelled.cancel(); late.resolve(['stale']); await cancelledRead; assert.equal(commits, 0);
await cancelled.retry(); assert.equal(commits, 1, 'cleanup/restart accepts only the live request');
const empty = createVaultStartup(async () => [], () => {}); await empty.retry(); assert.equal(empty.getSnapshot().status, 'ready', 'a successful empty read is not a failure');

// Execute actual storage functions with injected memory-only IO, never import App/storage runtime.
async function storageScenario(options: { desktop?: any; cache?: string | null; indexedError?: boolean; saveError?: boolean; canonical?: boolean; indexed?: any[] }) {
  let writes = 0, indexedReads = 0;
  const vault = { loadVault: async () => {
    if (options.desktop instanceof Error) throw options.desktop; return options.desktop;
  } };
  const load = getFunction('src/services/storage.ts', 'loadNotesFromStorage', {
    window: { electronAPI: options.desktop === undefined ? undefined : { vault } },
    localStorage: { getItem: () => options.cache ?? null }, console: { warn() {} },
    recalculateBacklinks: (value: any) => value, migrateNoteData: (value: any) => value,
    prepareNotesMetadata: async (value: any) => value,
    refreshKnowledgeLifecycle: async () => {},
    readBrowserVault: async () => { indexedReads++; if (options.indexedError) throw new Error('indexed unreadable');
      return { initialized: options.canonical || false, notes: options.indexed || [] }; },
    useStorageOwner() {}, noteSaveBaseline: { acknowledge() {} }, browserVaultInitialized: false, browserDirectoryInitialized: false,
    vaultSaveQueue: Promise.resolve(), storageOwner: vault, unconfirmedNativeSave: undefined,
    LEGACY_NOTES_KEY: 'loginote_vault_notes',
    createInitialNotes: () => ['synthetic-seed'], saveAllNotesToStorage: async () => { writes++; if (options.saveError) throw new Error('save failure'); },
  });
  let result: any, failed = false; try { result = await load(); } catch { failed = true; }
  return { writes, indexedReads, result, failed };
}
for (const options of [{ desktop: new Error('denied') }, { desktop: {} }, { cache: '' }, { cache: '{broken' }, { cache: '{}' }, { indexedError: true }]) {
  const result = await storageScenario(options); assert.equal(result.failed, true); assert.equal(result.writes, 0, 'unreadable data never falls through to seed writes');
}
assert.deepEqual((await storageScenario({ desktop: ['original'] })).result, ['original']);
assert.deepEqual((await storageScenario({ desktop: [], cache: '["stale"]' })).result, [], 'a native empty vault cannot revive a browser cache');
assert.deepEqual((await storageScenario({ canonical: true, cache: '["stale"]' })).result, [], 'canonical empty IDB wins over legacy JSON');
assert.deepEqual((await storageScenario({ cache: '["legacy"]' })).result, ['legacy']);
assert.equal((await storageScenario({ cache: '["legacy"]', saveError: true })).failed, true);
assert.equal((await storageScenario({ saveError: true })).failed, true, 'initialization needs write acknowledgement');
assert.deepEqual((await storageScenario({})).result, ['synthetic-seed']);

async function desktopScenario(kind: string) {
  let writes = 0;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const load = getFunction('src/electron/main.ts', 'loadMergedNotes', {
    referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 0,
    getVaultRoot: () => '/synthetic/vault', getUserStateDir: () => '/synthetic/state', path,
    withSavedVaultSnapshot: async (_root: any, _state: any, reader: any) => reader(),
    fs: { mkdir: async () => {}, readdir: async () => kind === 'first-use' ? [] : ['a.md'], readFile: async (file: string) => {
      if (file.endsWith('metadata.json')) {
        if (kind === 'permission') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (kind === 'first-use' || kind === 'lost-index') throw missing();
        if (kind === 'bad-index') return '{}';
        if (kind === 'missing-body') return '{"notesMeta":{"absent":{}}}';
        return '{"notesMeta":{"a":{"id":"a"}}}';
      }
      if (file.endsWith('a.md')) { if (kind === 'body-denied') throw new Error('denied'); return 'original body'; }
      if (kind === 'state-denied') throw new Error('state denied');
      if (kind === 'state-corrupt') return '{broken';
      if (kind === 'state-shape') return '{}';
      throw missing();
    } },
    deserializeVault: (text: string, map: Map<string, string>) => Object.keys(JSON.parse(text).notesMeta).map(id => ({ id, content: map.get(id + '.md') })),
    splitUserStateFields: () => ({}), hasAnyUserState: () => false,
    USER_STATE_FILES: { noteStates: 'note-states.json' }, deserializeUserStateFile: (text: string) => JSON.parse(text).noteStates,
    mergeNote: (note: any) => note, writeUserStateFileUnlocked: async () => writes++, atomicWriteTextFile: async () => writes++,
  });
  let failed = false, result: any; try { result = await load(); } catch { failed = true; }
  assert.equal(writes, 0, 'failed startup cannot migrate or overwrite an unreadable vault');
  return { failed, result };
}
for (const kind of ['permission', 'lost-index', 'bad-index', 'missing-body', 'body-denied', 'state-denied', 'state-corrupt', 'state-shape']) assert.equal((await desktopScenario(kind)).failed, true, kind);
assert.deepEqual((await desktopScenario('first-use')).result, []);
assert.deepEqual((await desktopScenario('valid')).result, [{ id: 'a', content: 'original body' }]);

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const error = renderToStaticMarkup(createElement(VaultStartupView, { status: 'error', error: '<unsafe>', onRetry() {} }));
  assert.match(error, /role="alert"/); assert.match(error, /重新读取/); assert.match(error, /&lt;unsafe&gt;/);
  assert.doesNotMatch(error, /contenteditable|textarea|新建笔记/);
  const loading = renderToStaticMarkup(createElement(VaultStartupView, { status: 'loading', error: '', onRetry() {} }));
  assert.match(loading, /role="status"/); assert.doesNotMatch(loading, /重新读取/);
} finally { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); }
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /const notesHydrated = vaultStartup.status === 'ready'/);
assert.match(app, /if \(!notesHydrated\) return React.createElement\(VaultStartupView/);
assert.ok(app.indexOf('if (!notesHydrated) return React.createElement(VaultStartupView') < app.indexOf('if (isLearningCompletionDemo) return'));
assert.match(app, /notesReadyRef.current && reviewExitGuard.allowNavigation/);
assert.match(app, /if \(!notesReadyRef.current\) throw new Error/);
assert.doesNotMatch(app, /setNotesHydrated\(true\)/);
console.log('PASS vault startup: failure isolation, single retry, unmount generation, safe empty reads, legacy/seed acknowledgments and desktop read integrity; synthetic IO only');
