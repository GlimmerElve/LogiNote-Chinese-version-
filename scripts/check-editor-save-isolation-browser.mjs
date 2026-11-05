/** Narrow real-browser regression: production RetainedNoteEditor + actual
 * MdxNoteEditor/MDXEditor/Lexical. Only NoteEditor's business shell is replaced
 * in memory. Never starts the App, Electron, a vault, model, API or installed app. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch {
  playwright = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/interaction-audit.cjs'))('playwright');
}
const root = process.cwd();
const executable = path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
await fs.access(executable);
const sourceFiles = [
  'src/components/RetainedNoteEditor.tsx', 'src/components/NoteEditor.tsx', 'src/components/MdxNoteEditor.tsx',
  'src/components/MdxEditorRuntime.ts', 'src/components/mdxNoteContentPlugins.ts', 'src/components/IncrementalMarkdownPlugin.ts',
  'src/components/incrementalMarkdownExport.ts', 'src/components/EditorCompositionPlugin.tsx',
  'src/components/MdxMarkdownCompatibilityPlugin.tsx', 'src/components/mdxRuntime.ts', 'src/services/ui/noteSnapshotPublication.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const sourceHashes = await hashes();
await fs.mkdir(path.join(root, 'output'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'output/editor-save-isolation-'));
const profile = path.join(output, 'fresh-chrome-profile'), temporary = path.join(output, 'runtime-temp');
await fs.mkdir(temporary);

const shell = String.raw`
import React, {useEffect,useRef,useState} from 'react';
import {MdxNoteEditor} from './MdxNoteEditor';
export function NoteEditor(props:any) {
  const editor=useRef<any>(null), version=useRef(props.contentVersion);
  const [content,setContent]=useState(props.note.content);
  useEffect(()=>{window.editorSaveAudit.mounts++;return()=>{window.editorSaveAudit.unmounts++;};},[]);
  useEffect(()=>{const a=window.editorSaveAudit;a.shellCommits++;a.currentHandle=editor.current;if(!a.originalHandle)a.originalHandle=editor.current;});
  useEffect(()=>{
    if(props.contentVersion===version.current)return;
    version.current=props.contentVersion;window.editorSaveAudit.externalApplications++;
    editor.current.setMarkdown(props.note.content);setContent(props.note.content);
  },[props.contentVersion,props.note.content]);
  return <section data-test-note-shell><MdxNoteEditor ref={editor} content={content} active={props.isActive}
    allNotes={props.allNotes} mathRecovery="all" onChange={md=>props.onEditNote(props.note.id,{content:md})}
    getArgumentDoc={props.getArgumentDoc} onWikiLinkClick={props.onSelectNoteByTitle}/></section>;
}`;
const fixture = String.raw`
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RetainedNoteEditor} from './src/components/RetainedNoteEditor';
const initial={id:'fixture-note',title:'Synthetic editor',noteType:'knowledge',content:'Initial editable paragraph.',
  tags:[],links:[],backlinks:[],dueDates:[],createdAt:'synthetic',updatedAt:'synthetic'};
const settings={theme:'light'};
window.editorSaveAudit={mounts:0,unmounts:0,shellCommits:0,changes:0,externalApplications:0,imports:0,
  callbacks:[],originalHandle:null,currentHandle:null};
function Fixture(){
  const [note,setNote]=useState(initial),[notes,setNotes]=useState([initial]);
  const [publication,setPublication]=useState(notes),[saveState,setSaveState]=useState('saved');
  const [tick,setTick]=useState(0),[visible,setVisible]=useState(true),[active,setActive]=useState(true),[version,setVersion]=useState(0);
  const draft=useRef(initial.content);
  const save=()=>{const saved={...note,content:draft.current,updatedAt:'saved-'+tick};const next=[saved];setNote(saved);setNotes(next);setSaveState('saved');};
  const external=()=>{const saved={...note,content:'External authorized replacement.',updatedAt:'external'};
    const next=[saved];draft.current=saved.content;setNote(saved);setNotes(next);setPublication(next);setVersion(v=>v+1);};
  return <><nav className="fixture-controls">
    <button data-testid="save" onClick={save}>Save body only</button>
    <button data-testid="publish" onClick={()=>setPublication([...notes])}>Publish directory token</button>
    <button data-testid="callbacks" onClick={()=>setTick(v=>v+1)}>Refresh unrelated callbacks</button>
    <button data-testid="visibility" onClick={()=>setVisible(v=>!v)}>{visible?'Hide surface':'Show surface'}</button>
    <button data-testid="agent" onClick={()=>setActive(v=>!v)}>{active?'Open Agent overlay':'Close Agent overlay'}</button>
    <button data-testid="external" onClick={external}>Apply external body/version</button>
    <output data-testid="status" data-tick={tick} data-visible={visible} data-active={active} data-version={version}>{saveState}</output>
  </nav><div data-testid="surface" style={{visibility:visible?'visible':'hidden'}} inert={!visible}>
    <RetainedNoteEditor note={note} allNotes={notes} publication={publication} settings={settings}
      isVisible={visible} isActive={visible&&active} saveState={saveState} contentVersion={version}
      onUpdateNote={()=>{}} onEditNote={(_id,patch)=>{draft.current=patch.content;const a=window.editorSaveAudit;
        a.changes++;a.callbacks.push(tick);setSaveState('pending');}}
      onFinishEditing={()=>{}} getArgumentDoc={()=>undefined} onSelectNoteByTitle={()=>{}}/>
  </div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
`;
let replacedShells = 0;
const bundle = await build({ stdin: { contents: fixture, sourcefile: 'editor-save-isolation-fixture.tsx', resolveDir: root, loader: 'tsx' },
  outdir: path.join(output, 'memory-build'), entryNames: 'fixture', bundle: true, write: false, metafile: true,
  format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  alias: { 'decode-named-character-reference': path.join(root, 'node_modules/decode-named-character-reference/index.js') },
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  plugins: [{ name: 'synthetic-note-editor-shell-only', setup(builder) {
    builder.onLoad({ filter: /[\\/]NoteEditor\.tsx$/ }, ({ path: file }) => {
      assert.equal(path.resolve(file), path.join(root, 'src/components/NoteEditor.tsx'));
      replacedShells++; return { contents: shell, loader: 'tsx', resolveDir: path.dirname(file) };
    });
  } }],
});
assert.equal(replacedShells, 1);
assert.deepEqual(await hashes(), sourceHashes, 'production sources changed during fixture bundling');
const assets = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.contents]));
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')), css = bundle.outputFiles.find(file => file.path.endsWith('.css'));
assert(js && css);
const report = {
  status: 'running', syntheticOnly: true, privateDataUsed: false, productionMode: true, minified: true,
  boundary: 'Actual RetainedNoteEditor + MdxNoteEditor/MDXEditor/Lexical and production content plugins; NoteEditor business shell replaced in memory. Not full App, storage/IPC, Windows IME, or installed Electron acceptance.',
  browser: 'fresh headless Chrome persistent context', profile, sourceHashes, sourceHashesStable: false,
  externalNetworkAllowed: false, externalRequests: [], blockedWebSockets: 0, pageErrors: [], checks: [],
};
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/fixture.html') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/${path.basename(css.path)}"><style>
      body{margin:0;font:14px system-ui;background:#fff;color:#222}.fixture-controls{display:flex;gap:8px;flex-wrap:wrap;padding:12px;border-bottom:1px solid #ddd}.fixture-controls button{padding:8px}
      [data-testid=surface]{padding:16px;height:560px}.mdxeditor-content-editable{min-height:280px;padding:16px}
    </style></head><body><div id="root"></div><script type="module" src="/${path.basename(js.path)}"></script></body></html>`); return;
  }
  const bytes = assets.get(pathname);
  if (!bytes) { response.statusCode = 404; response.end(); return; }
  response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(bytes);
});
let context, page;
const pass = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS ' + name); };
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await playwright.chromium.launchPersistentContext(profile, { executablePath: executable, headless: true,
    viewport: { width: 1360, height: 850 }, serviceWorkers: 'block',
    env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  await context.routeWebSocket('**/*', route => { report.blockedWebSockets++; route.close(); });
  page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + '/fixture.html', { waitUntil: 'domcontentloaded' });
  const editor = page.locator('.mdxeditor-content-editable'); await editor.waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.editorSaveAudit.currentHandle && document.querySelector('.mdxeditor-content-editable')?.textContent.includes('Initial editable paragraph.'));
  const baseline = (await editor.innerText()).trimEnd();
  await page.evaluate(() => {
    const dom = document.querySelector('.mdxeditor-content-editable'), lexical = dom.__lexicalEditor;
    if (!lexical) throw Error('real Lexical root identity unavailable');
    window.editorSaveIdentity = { dom, lexical };
    lexical.registerUpdateListener(payload => { if (payload.tags.has('loginote-markdown-import')) window.editorSaveAudit.imports++; });
  });
  const identity = () => page.evaluate(() => {
    const dom = document.querySelector('.mdxeditor-content-editable'), a = window.editorSaveAudit, before = window.editorSaveIdentity;
    return { sameDom: dom === before.dom, sameLexical: dom?.__lexicalEditor === before.lexical,
      sameHandle: a.originalHandle === a.currentHandle, mounts: a.mounts, unmounts: a.unmounts,
      shellCommits: a.shellCommits, imports: a.imports, externalApplications: a.externalApplications, changes: a.changes };
  });
  const assertIdentity = async label => {
    const state = await identity(); assert(state.sameDom && state.sameLexical && state.sameHandle, label);
    assert.equal(state.mounts, 1, label); assert.equal(state.unmounts, 0, label); return state;
  };
  const refresh = async count => {
    let tick = Number(await page.getByTestId('status').getAttribute('data-tick'));
    for (let i = 0; i < count; i++) {
      await page.getByTestId('callbacks').click(); tick++;
      await page.waitForFunction(value => document.querySelector('[data-testid=status]').dataset.tick === String(value), tick);
    }
  };
  const type = async token => { await editor.click(); await page.keyboard.press('Control+End'); await editor.pressSequentially(token, { delay: 18 }); };
  // MDXEditor uses Radix single-toggle groups: these actual toolbar buttons
  // expose role="radio", not the implicit button role.
  const undo = page.locator('button[aria-label^="Undo "]'), redo = page.locator('button[aria-label^="Redo "]');
  const undoRedoTo = async (before, after) => {
    let steps = 0;
    while ((await editor.innerText()).trimEnd() !== before.trimEnd() && steps < 8) {
      await undo.waitFor({ state: 'visible' }); assert.equal(await undo.isDisabled(), false, 'real toolbar Undo must be enabled');
      await undo.click(); steps++;
      await page.waitForTimeout(35);
    }
    assert(steps > 0); assert.equal((await editor.innerText()).trimEnd(), before.trimEnd());
    for (let i = 0; i < steps; i++) { assert.equal(await redo.isDisabled(), false); await redo.click(); await page.waitForTimeout(35); }
    assert.equal((await editor.innerText()).trimEnd(), after.trimEnd()); return steps;
  };

  await type(' SAVE_ISOLATION_ONE');
  const firstText = await editor.innerText(); assert(firstText.includes('SAVE_ISOLATION_ONE'));
  await page.getByTestId('save').click(); await page.getByTestId('publish').click();
  const beforeChurn = await identity(); await refresh(50);
  const afterChurn = await assertIdentity('body save + publication + callback churn');
  assert.equal(afterChurn.shellCommits, beforeChurn.shellCommits, '50 unrelated callbacks must not commit the retained shell');
  assert.equal(afterChurn.imports, 0, 'saving/publishing our own live draft must not reimport it');
  assert.equal(await editor.innerText(), firstText);
  const saveUndoSteps = await undoRedoTo(baseline, firstText);
  pass('real typing -> body save/publication + 50 callback commits preserves DOM/Lexical/handle and toolbar undo/redo', { callbacks: 50, undoSteps: saveUndoSteps, identity: afterChurn });

  await type(' HIDE_SHOW_TWO'); const hiddenText = await editor.innerText();
  await page.getByTestId('visibility').click(); await refresh(10); await page.getByTestId('publish').click();
  await assertIdentity('hidden surface');
  await page.getByTestId('visibility').click(); await editor.waitFor({ state: 'visible' });
  assert.equal(await editor.innerText(), hiddenText); const shown = await assertIdentity('reshown surface');
  const hideUndoSteps = await undoRedoTo(firstText, hiddenText);
  pass('hidden updates and reopening retain the same editor, text and real toolbar undo/redo', { callbacksWhileHidden: 10, undoSteps: hideUndoSteps, identity: shown });

  await page.getByTestId('agent').click(); await refresh(10); await page.getByTestId('publish').click();
  assert.equal(await page.getByTestId('status').getAttribute('data-visible'), 'true');
  assert.equal(await page.getByTestId('status').getAttribute('data-active'), 'false');
  assert.equal(await editor.innerText(), hiddenText); await assertIdentity('Agent overlay inactive-but-visible');
  await page.getByTestId('agent').click(); assert.equal(await editor.innerText(), hiddenText);
  const agent = await assertIdentity('Agent reactivated'); assert.equal(agent.imports, 0);
  pass('isVisible=true / isActive=false/true does not replace the editor or roll back live text', { identity: agent });

  const beforeExternal = await identity(); await page.getByTestId('external').click();
  await page.waitForFunction(() => document.querySelector('.mdxeditor-content-editable')?.textContent.trim() === 'External authorized replacement.');
  await refresh(10); const external = await assertIdentity('authorized external body/version');
  assert.equal(external.externalApplications - beforeExternal.externalApplications, 1);
  assert.equal(external.imports - beforeExternal.imports, 1, 'one real external update must cause exactly one Lexical Markdown import');
  assert.equal((await editor.innerText()).trim(), 'External authorized replacement.');
  await type(' LATEST_CALLBACK');
  const callback = await page.evaluate(() => window.editorSaveAudit.callbacks.at(-1));
  assert.equal(callback, Number(await page.getByTestId('status').getAttribute('data-tick')));
  pass('authorized contentVersion/body replacement imports exactly once and latest callback proxy remains live', { identity: external });

  assert.equal(report.externalRequests.length, 0); assert.equal(report.blockedWebSockets, 0); assert.equal(report.pageErrors.length, 0);
  assert.deepEqual(await hashes(), sourceHashes, 'production sources changed during browser regression');
  report.sourceHashesStable = true; report.status = 'passed'; report.finalIdentity = await identity();
  await page.screenshot({ path: path.join(output, 'editor-final.png') });
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.availableButtons = await page.locator('button').evaluateAll(elements => elements.map(element => ({ text: element.textContent, label: element.getAttribute('aria-label'), title: element.title, disabled: element.disabled }))).catch(() => []);
    report.failureIdentity = await page.evaluate(() => ({ text: document.querySelector('.mdxeditor-content-editable')?.textContent,
      audit: window.editorSaveAudit ? { ...window.editorSaveAudit, originalHandle: undefined, currentHandle: undefined } : null })).catch(() => null);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  console.error(error);
} finally {
  if (context) await context.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  report.afterSourceHashes = await hashes(); report.sourceHashesStable = JSON.stringify(report.afterSourceHashes) === JSON.stringify(sourceHashes);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, sourceHashesStable: report.sourceHashesStable, checks: report.checks.length,
    externalRequests: report.externalRequests.length, boundary: report.boundary }));
}
