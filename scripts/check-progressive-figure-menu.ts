/** Real React reader/menu lifecycle with unrelated heavy display children stubbed.
 * Tests stale selection admission, not Markdown rendering or the full desktop. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await fs.mkdtemp(path.resolve('build/progressive-figure-menu-'));
const entry = path.join(root, 'fixture.tsx'), bundle = path.join(root, 'fixture.js');
const actualReader = path.resolve('src/components/progressive/ProgressiveCourseReader.tsx').replace(/\\/gu, '/');
const paragraph = '这是用于检查选区归属的正文。同一位置不能仅凭位移正负判断速度方向，还需要知道它处于哪一段运动。';
await fs.writeFile(entry, `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProgressiveCourseReader} from ${JSON.stringify(actualReader)};
const body=${JSON.stringify(paragraph)},hash='a'.repeat(64);
let live={phase:'ready',error:null,saveError:null,page:{id:'main-1',title:'合成选区',body,hook:null},plan:{title:'合成课程',objectives:[],pages:[{id:'main-1',title:'合成选区',objectives:[]}]},blocks:[body],pendingText:'',course:{id:'course',projectNoteId:'note',plan:null,generation:{pageId:'main-1'},pages:[{id:'main-1',mainlineIndex:0,kind:'mainline',contentHash:hash}],progress:{currentPageId:'main-1',scrollTop:0},sourcePackets:[],page:{id:'main-1',body,questions:[]}}};
const calls=[];const controller={getSnapshot:()=>live,next:async()=>{}};
function App(){const [snapshot,setSnapshot]=useState(live);window.menuAudit={calls,update:(letter,render)=>{live={...live,course:{...live.course,pages:[{...live.course.pages[0],contentHash:letter.repeat(64)}]}};if(render)setSnapshot(live)},current:()=>live};return <ProgressiveCourseReader snapshot={snapshot} active controller={controller} onFigure={scope=>calls.push(scope)} onRetry={()=>{}} onRetrySave={()=>{}} onReadingPosition={()=>{}}/>}
createRoot(document.getElementById('root')).render(<App/>);`);
const stubs: Record<string, string> = {
  TextbookReader: `import React from 'react';export const TextbookMarkdown=({body})=><p data-audit-paragraph>{body}</p>;`,
  ProgressiveQuiz: `export const ProgressiveQuiz=()=>null;`,
  QuickCheckText: `import React from 'react';export const QuickCheckText=({text})=><span>{text}</span>;`,
  ReadingPresentation: `import React from 'react';export const ReadingPresentationContext=React.createContext(null);export const useReaderPresentation=()=>null;`,
  ReadingWorkerContext: `export const ReadingWorkerProvider=({children})=>children;`,
};
await build({ entryPoints: [entry], bundle: true, outfile: bundle, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.css': 'empty' }, logLevel: 'silent', plugins: [{ name: 'unrelated-reader-display-stubs', setup(plugin) {
    plugin.onResolve({ filter: /(?:TextbookReader|ProgressiveQuiz|QuickCheckText|ReadingPresentation|ReadingWorkerContext)$/ }, args => {
      const key = path.basename(args.path); return key in stubs ? { path: key, namespace: 'reader-display-stub' } : undefined;
    });
    plugin.onLoad({ filter: /.*/, namespace: 'reader-display-stub' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: process.cwd() }));
  } }] });
await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="./fixture.js"></script></body></html>');
const { chromium } = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/menu-scope-test.cjs'))('playwright');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report: any = { root, modelRequests: 0, externalRequests: 0, actualReactReaderAndMenu: true,
  unrelatedDisplaysStubbed: Object.keys(stubs), checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } }), errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route(/^https?:/u, (route: any) => { report.externalRequests++; return route.abort(); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  const article = page.locator('[data-audit-paragraph]'); await article.waitFor();
  const openMenu = async (selected: boolean) => {
    await page.evaluate((selected: boolean) => {
      const paragraph = document.querySelector('[data-audit-paragraph]')!, selection = getSelection()!;
      selection.removeAllRanges();
      if (selected) { const range = document.createRange(); range.setStart(paragraph.firstChild!, 0); range.setEnd(paragraph.firstChild!, 14); selection.addRange(range); }
      paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 180 }));
    }, selected);
    await page.getByRole('menu').waitFor();
  };
  const count = () => page.evaluate(() => (window as any).menuAudit.calls.length);
  await openMenu(true);
  await page.getByRole('menuitem', { name: '为选中内容生成交互图', exact: true }).click();
  assert.equal(await count(), 1);
  const first = await page.evaluate(() => (window as any).menuAudit.calls[0]);
  assert.equal(first.pageHash, 'a'.repeat(64)); assert.equal(first.text, paragraph.slice(0, 14));
  report.checks.push('有效选区通过真实React菜单，精确保留所选文本及当前页面hash');

  await openMenu(false);
  await page.evaluate(() => (window as any).menuAudit.update('b', true));
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.equal(await count(), 1);
  report.checks.push('同一course/page内容hash改变后旧菜单自动关闭，不调用生成入口');

  await openMenu(true);
  await page.evaluate(() => (window as any).menuAudit.update('c', false));
  await page.getByRole('menuitem', { name: '为选中内容生成交互图', exact: true }).click();
  assert.equal(await count(), 1, 'Controller changed before React rerender: old selection must not be admitted');
  report.checks.push('controller先变而UI仍旧的竞态点击也会按实时hash拒绝，未执行onFigure');

  await page.evaluate(() => (window as any).menuAudit.update('d', true));
  // Let the real reader commit the changed descriptor and run its menu-closing
  // effect before opening a new menu. The previous check intentionally skipped
  // this commit to exercise the controller/UI race.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
  await openMenu(false);
  await page.screenshot({ path: path.join(root, 'fresh-menu.png') });
  await page.getByRole('menuitem', { name: '为本页生成交互图', exact: true }).click();
  assert.equal(await count(), 2);
  assert.equal(await page.evaluate(() => (window as any).menuAudit.calls[1].pageHash), 'd'.repeat(64));
  report.checks.push('正文更新完成后重新打开整页菜单仍可正常生成，防护不阻断新请求');
  assert.deepEqual(errors, []); assert.equal(report.externalRequests, 0); report.status = 'passed';
} finally { await browser.close(); await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
