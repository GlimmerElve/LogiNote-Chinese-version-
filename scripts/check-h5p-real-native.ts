import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createH5pStore } from '../src/electron/h5pStore';
import { registerH5pHost } from '../src/electron/h5pHost';

// Explicit opt-in acceptance against original public packages, never user data.
// Only the OS picker/trust dialog are replaced; import, windows, HTTP, content
// scripts, interactions, persistence and recovery all use production code.
const fixtures = [
  { file: 'fill-in-the-blanks-837.h5p', id: '0eaf030d4ca0a8a799d960fc17d6fcf58632bb074162b38ccdfe224c985a49de', kind: 'blanks' },
  { file: 'true-false-question-34806.h5p', id: '088b932daf65e80fbd4bf79332634272ae81760463bf7191ad4aac1921239273', kind: 'true-false' },
] as const;
async function main() {
const root = process.env.LOGINOTE_H5P_REAL_ROOT!, output = process.env.LOGINOTE_H5P_REAL_OUTPUT!;
const fixtureDir = process.env.LOGINOTE_H5P_REAL_FIXTURES!, phase = process.env.LOGINOTE_H5P_REAL_PHASE!;
if (!root || !output || !fixtureDir || !['prepare', 'restore'].includes(phase)) throw Error('Use scripts/run-h5p-real-native.mjs with explicit fixture directory');
assert.equal(path.dirname(path.dirname(path.resolve(root))), path.resolve(os.tmpdir()));
assert.ok(path.basename(path.dirname(root)).startsWith('loginote-h5p-real-runner-'), 'never run acceptance against user data');
app.setPath('userData', path.join(root, 'electron-profile'));
app.on('window-all-closed', () => {});
let host: ReturnType<typeof registerH5pHost> | undefined;
let selected = '', confirmations = 0;
const originalPicker = dialog.showOpenDialog, originalConfirm = dialog.showMessageBox;
const deadline = setTimeout(() => { console.error('Real H5P test deadline'); app.exit(1); }, 60000);
const reports: unknown[] = [];
let exitCode = 0;

async function waitFor(win: BrowserWindow, script: string) {
  for (let i = 0; i < 220; i++) {
    if (await win.webContents.executeJavaScript(script)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Player not ready: ' + await win.webContents.executeJavaScript('document.body.innerText'));
}
const documentExpression = `(document.querySelector('#player iframe')?.contentDocument || document)`;
const readyExpression = `!document.getElementById('save').disabled`;
async function capture(win: BrowserWindow, name: string) {
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const image = await win.webContents.capturePage();
  await fs.writeFile(path.join(output, name), image.toPNG());
}
async function answerBlanks(win: BrowserWindow, answers: string[]) {
  await win.webContents.executeJavaScript(`(()=>{const doc=${documentExpression};const inputs=doc.querySelectorAll('input[type="text"]');if(inputs.length!==3)throw Error('Expected three real blanks');for(const [i,value]of ${JSON.stringify(answers)}.entries()){inputs[i].focus();inputs[i].value=value;inputs[i].dispatchEvent(new Event('input',{bubbles:true}));inputs[i].dispatchEvent(new Event('change',{bubbles:true}));inputs[i].blur();}})();true`);
}
async function values(win: BrowserWindow, kind: string) {
  return await win.webContents.executeJavaScript(kind === 'blanks'
    ? `Array.from(${documentExpression}.querySelectorAll('input[type="text"]')).map(e=>e.value)`
    : `Array.from(${documentExpression}.querySelectorAll('[role="radio"]')).map(e=>({text:e.textContent,checked:e.getAttribute('aria-checked')}))`);
}
async function clickSave(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`document.getElementById('save').click();true`);
  await waitFor(win, `document.getElementById('status').textContent==='进度已保存'`);
}
async function close(win: BrowserWindow) {
  const closed = new Promise<void>(resolve => win.once('closed', resolve));
  win.close(); await closed;
}

async function checkQuestionLayout(win: BrowserWindow, kind: string, label: string) {
  const layout = await win.webContents.executeJavaScript(`(()=>{
    const doc=${documentExpression}, css=Array.from(doc.styleSheets).find(sheet=>sheet.href?.endsWith('/content-layout.css'));
    if(!css)throw Error('Host content layout stylesheet not loaded inside the player');
    const root=doc.querySelector('.h5p-content.h5p-no-frame > .h5p-question');
    if(!root)throw Error('Expected standalone question root');
    const measure=()=>{
      const bounds=root.getBoundingClientRect(), image=root.querySelector('.h5p-question-image img');
      return {width:bounds.width, imageWidth:image?.getBoundingClientRect().width,
        sections:Array.from(root.children).filter(el=>el.matches('.h5p-question-introduction,.h5p-question-content,.h5p-question-buttons')).map(el=>{
          const style=doc.defaultView.getComputedStyle(el), rect=el.getBoundingClientRect();
          return {className:el.className,left:parseFloat(style.marginLeft),right:parseFloat(style.marginRight),rightOverflow:Math.max(0,rect.right-bounds.right)};
        })};
    };
    const actual=measure();css.disabled=true;const original=measure();css.disabled=false;
    return {actual,original};
  })()`);
  assert(layout.actual.sections.length >= 3);
  if (kind === 'true-false') {
    for (const section of layout.actual.sections) {
      assert(section.left >= 16 && section.left <= 24, `${label}: left gutter ${JSON.stringify(section)}`);
      assert(section.right >= 16 && section.right <= 24, `${label}: right gutter ${JSON.stringify(section)}`);
      assert(section.rightOverflow <= 1, `${label}: answer section overflows`);
    }
    assert(layout.original.sections.every((section: any) => section.left === 0), 'The original no-frame package removes gutters');
    assert(Math.abs(layout.actual.imageWidth - layout.original.imageWidth) < 1, 'Host gutters never shrink the full-bleed image');
  } else assert.deepEqual(layout.actual, layout.original, 'Other question types retain their original layout');
  reports.push({ layout: label, kind, ...layout });
}

try {
  await app.whenReady();
  const handlers = new Map<string, Function>(), store = createH5pStore(root);
  (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  (dialog as any).showMessageBox = async (_parent: unknown, options: { title: string }) => {
    assert.equal(options.title, '导入第三方 H5P 场景', 'an unexpected failure/close dialog must fail acceptance');
    confirmations++; return { response: 1 };
  };
  host = registerH5pHost({ handle: ((name: string, fn: Function) => handlers.set(name, fn)) as any }, {
    root: () => root, current: () => 'real-public-package-acceptance', parent: () => null,
    allowed: event => event.sender.id === 987, visible: false,
    assets: path.resolve('node_modules/h5p-standalone/dist'), styles: path.resolve('src/styles/design-tokens.css'),
  });
  const event = { sender: { id: 987 } };
  const windows = new Map<string, BrowserWindow>();
  for (const fixture of fixtures) {
    const bytes = await fs.readFile(path.join(fixtureDir, fixture.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.id, 'test original unmodified official bytes');
    if (phase === 'prepare') {
      selected = path.join(fixtureDir, fixture.file);
      const result = await handlers.get('h5p:import')!(event);
      assert.equal(result.package.id, fixture.id); assert.deepEqual(result.package.missing, []);
      assert.deepEqual(await fs.readFile(path.join(root, 'h5p', 'packages', `${fixture.id}.h5p`)), bytes);
    }
    const before = new Set(BrowserWindow.getAllWindows().map(win => win.id));
    await handlers.get('h5p:open')!(event, fixture.id);
    const win = BrowserWindow.getAllWindows().find(win => !before.has(win.id))!;
    assert.ok(win); windows.set(fixture.kind, win);
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('CONTENT', fixture.kind, event.message); });
    await waitFor(win, readyExpression);
    console.log('PLAY', fixture.kind, 'ready in isolated real Electron player');
  }
  assert.equal(windows.size, 2);
  const blanks = windows.get('blanks')!, tf = windows.get('true-false')!;
  await checkQuestionLayout(tf, 'true-false', 'normal');
  await checkQuestionLayout(blanks, 'blanks', 'other-content-unchanged');
  if (phase === 'prepare') {
    const originalSize = tf.getSize(); tf.setSize(420, 800);
    await waitFor(tf, `document.documentElement.clientWidth < 500`);
    await checkQuestionLayout(tf, 'true-false', 'narrow');
    await capture(tf, 'true-false-narrow.png');
    tf.setSize(originalSize[0], originalSize[1]);
    await waitFor(tf, `document.documentElement.clientWidth > 500`);
    await tf.webContents.executeJavaScript(`(()=>{const doc=${documentExpression};const button=doc.querySelector('.h5p-enable-fullscreen');if(!button)throw Error('Missing fullscreen control');button.click();})();true`);
    await waitFor(tf, `Boolean(document.querySelector('.h5p-fullscreen,.h5p-semi-fullscreen') || ${documentExpression}.querySelector('.h5p-fullscreen,.h5p-semi-fullscreen'))`);
    await checkQuestionLayout(tf, 'true-false', 'fullscreen');
    await capture(tf, 'true-false-fullscreen.png');
    await tf.webContents.executeJavaScript(`(()=>{const doc=${documentExpression};const button=doc.querySelector('.h5p-disable-fullscreen') || document.querySelector('.h5p-disable-fullscreen');if(!button)throw Error('Missing fullscreen exit');button.click();})();true`);
    await waitFor(tf, `!document.querySelector('.h5p-fullscreen,.h5p-semi-fullscreen') && !${documentExpression}.querySelector('.h5p-fullscreen,.h5p-semi-fullscreen')`);
    await answerBlanks(blanks, ['blue', 'Cloud', '']);
    await tf.webContents.executeJavaScript(`(()=>{const doc=${documentExpression};const radios=Array.from(doc.querySelectorAll('[role="radio"]'));if(radios.length!==2)throw Error('Expected true/false controls');radios[1].click();})();true`);
    console.log('INTERACT', JSON.stringify(await values(blanks, 'blanks')), JSON.stringify(await values(tf, 'true-false')));
    await Promise.all([clickSave(blanks), clickSave(tf)]);
    const blankState = await store.progress(fixtures[0].id), tfState = await store.progress(fixtures[1].id);
    console.log('SAVED', JSON.stringify(blankState), JSON.stringify(tfState));
    assert.deepEqual(blankState?.state, ['blue', 'Cloud', '']);
    assert.equal((tfState?.state as any)?.answer, false, 'false is a saved answer, not missing progress');
    const persisted = { blanks: blankState, tf: tfState, values: { blanks: await values(blanks, 'blanks'), tf: await values(tf, 'true-false') } };
    await fs.writeFile(path.join(output, 'expected-state.json'), JSON.stringify(persisted, null, 2));
    await capture(blanks, 'blanks-saved.png'); await capture(tf, 'true-false-saved.png');
    await close(blanks);
    assert.deepEqual((await store.progress(fixtures[1].id))?.state, tfState!.state, 'closing blanks must not alter true/false');
    await close(tf);
    assert.equal(confirmations, 2); reports.push({ phase, imported: 2, playing: 2, saved: 2, closed: 2, persisted });
  } else {
    const expected = JSON.parse(await fs.readFile(path.join(output, 'expected-state.json'), 'utf8'));
    assert.deepEqual(await values(blanks, 'blanks'), expected.values.blanks, 'real text inputs restored from disk in a new Electron process');
    assert.deepEqual(await values(tf, 'true-false'), expected.values.tf, 'real radio selection restored from disk in a new Electron process');
    await Promise.all([clickSave(blanks), clickSave(tf)]);
    assert.deepEqual((await store.progress(fixtures[0].id))?.state, expected.blanks.state);
    assert.deepEqual((await store.progress(fixtures[1].id))?.state, expected.tf.state);
    await capture(blanks, 'blanks-restored.png'); await capture(tf, 'true-false-restored.png');
    // Finish the resumed real activity and let the actual ten-second autosave
    // persist it, without calling the checkpoint or changing its internal state.
    await answerBlanks(blanks, ['blue', 'Cloud', 'black']);
    for (let i = 0; i < 150; i++) {
      if (JSON.stringify((await store.progress(fixtures[0].id))?.state) === JSON.stringify(['blue', 'Cloud', 'black'])) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual((await store.progress(fixtures[0].id))?.state, ['blue', 'Cloud', 'black'], 'real ten-second autosave persists continued work');
    await capture(blanks, 'blanks-completed.png');
    await close(tf); await close(blanks);
    assert.deepEqual((await store.progress(fixtures[1].id))?.state, expected.tf.state);
    assert.equal(confirmations, 0); reports.push({ phase, restoredInputsAndSelection: true, partialAndFalseStateRestored: true,
      resavedWithoutRollback: true, continuedWorkAutosaved: true, independentClose: true });
  }
  await host.shutdown(); assert.equal(BrowserWindow.getAllWindows().length, 0);
  const listing = await store.list(); assert.equal(listing.packages.length, 2); assert.deepEqual(listing.errors, []);
  await fs.writeFile(path.join(output, `${phase}-results.json`), JSON.stringify({ fixtures, reports,
    scope: 'real Electron and original official packages; OS file picker and trust confirmation stubbed, not manual dialog automation' }, null, 2));
  console.log('PASS REAL H5P', phase);
} catch (error) { console.error(error); exitCode = 1; }
finally {
  clearTimeout(deadline); host?.forceClose();
  dialog.showOpenDialog = originalPicker; dialog.showMessageBox = originalConfirm;
  app.exit(exitCode);
}
}
void main().catch(error => { console.error(error); app.exit(1); });
