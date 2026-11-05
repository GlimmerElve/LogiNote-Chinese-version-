/** Real Block/cache regression: a component changes source/theme while its old
 * SVG is reused by another instance. Never opens a vault or loads a model. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'mermaid-cache.cjs'))('playwright');
const parent = path.resolve('.tmp-textbook-check'); await fs.mkdir(parent, { recursive: true });
const directory = await fs.mkdtemp(path.join(parent, 'mermaid-cache-native-'));
const assets = path.join(directory, 'assets');
const fixture = path.join(directory, 'fixture.html');
await fs.writeFile(fixture, '<!doctype html><html><head><meta charset="UTF-8"><base href="/"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
await fs.writeFile(path.join(directory, 'fixture.tsx'), `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MermaidBlock} from '../../src/components/textbook/MermaidBlock';
import {namespaceMermaidSvg} from '../../src/services/ui/mermaidSvgIds';
import '../../src/components/textbook/textbookReader.css';
import '../../src/components/progressive/progressiveCourse.css';
const initial = 'flowchart TD\\nA["甲图X"] --> B["共同终点"]';
function Fixture() {
  const [first,setFirst] = useState(initial), [second,setSecond] = useState<string | null>(null);
  (window as any).cacheProbe = {setFirst,setSecond,namespaceMermaidSvg,setTheme:(dark:boolean)=>document.documentElement.classList.toggle('dark',dark)};
  return <main><section data-first><MermaidBlock code={first}/></section><section data-second>{second!==null&&<MermaidBlock code={second}/>}</section></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
`);
await build({ configFile: false, base: './', plugins: [react()], logLevel: 'warn',
  resolve: { alias: { 'decode-named-character-reference': path.resolve('node_modules/decode-named-character-reference/index.js') } },
  build: { outDir: assets, emptyOutDir: false, rollupOptions: { input: [fixture, path.resolve('mermaid-renderer.html')] } } });
const server = await preview({ configFile: false, build: { outDir: assets }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const address = server.httpServer.address(); assert(address && typeof address !== 'string');
const fixturePath = path.relative(process.cwd(), fixture).replaceAll(path.sep, '/');
const url = `http://127.0.0.1:${address.port}/${fixturePath}`;
const proof = { directory, stages: [], errors: [] };
let child, browser;
const bounded = (promise, ms, label) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); };
try {
  const env = { ...process.env, DIAGRAM_FREEZE_STATE: path.join(directory, 'state'), DIAGRAM_FREEZE_URL: url, DIAGRAM_FREEZE_GPU: '1', DIAGRAM_FREEZE_SHOW: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  child = spawn(require('electron'), ['--no-sandbox', '--remote-debugging-port=0', path.resolve('scripts/diagram-freeze-native.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = ''; child.once('error', reject);
    child.stderr.on('data', value => { output += String(value); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u); if (match) resolve(match[1]); });
  }), 30000, 'native endpoint');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  const page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => proof.errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const x = 'flowchart TD\nA["甲图X"] --> B["共同终点"]', y = 'flowchart TD\nA["乙图Y"] --> B["另一终点"]';
  const waitDiagram = async (section, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await page.evaluate(async ({ section, label }) => {
        const image = document.querySelector(`[data-${section}] .textbook-diagram-svg img`);
        return !!image && image.complete && image.naturalWidth > 0 && (await (await fetch(image.src)).text()).includes(label);
      }, { section, label })) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`${section} image did not decode with expected label ${label}`);
  };
  const collect = async name => {
    const result = await page.evaluate(async () => {
      const images = [...document.querySelectorAll('.textbook-diagram-svg img')];
      // Inspect each image in its own detached document, like the browser does.
      const roots = await Promise.all(images.map(async image => new DOMParser().parseFromString(await (await fetch(image.src)).text(), 'image/svg+xml').documentElement));
      const broken = [], referenced = [];
      for (const svg of roots) for (const node of [svg, ...svg.querySelectorAll('*')]) for (const attribute of [...node.attributes]) {
        const references = [...attribute.value.matchAll(/url\(["']?#([\w:.-]+)["']?\)/gu)].map(match => match[1]);
        if (['aria-labelledby', 'aria-describedby'].includes(attribute.name)) references.push(...attribute.value.split(/\s+/u));
        if (/^(?:xlink:)?href$/u.test(attribute.name) && attribute.value.startsWith('#')) references.push(attribute.value.slice(1));
        referenced.push(...references);
        for (const id of references) if (id && !svg.querySelector(`[id="${id}"]`)) broken.push(id);
      }
      return { rootIds: roots.map(svg => svg.id), imageUrls: images.map(image => image.src), decoded: images.map(image => image.complete && image.naturalWidth > 0), brokenReferences: broken,
        inlineNodes: document.querySelectorAll('.textbook-diagram-svg svg, .textbook-diagram-svg style').length,
        text: roots.map(svg => svg.textContent) };
    });
    proof.stages.push({ name, ...result });
    assert.equal(result.inlineNodes, 0, name + ' keeps SVG DOM and styles out of the application');
    assert.ok(result.decoded.length > 0 && result.decoded.every(Boolean), name + ' images decode');
    assert.deepEqual(result.brokenReferences, [], name + ' keeps each SVG reference local');
    return result;
  };
  await waitDiagram('first', '甲图X'); const original = await collect('initial-X');
  await page.locator('[data-first]').getByRole('button', { name: '原尺寸阅读', exact: true }).click();
  assert.equal(await page.locator('[data-first] .is-native-size').count(), 1);
  await page.locator('[data-first]').getByRole('button', { name: '适应页面', exact: true }).click();
  await page.locator('[data-first] summary').click();
  assert.ok((await page.locator('[data-first] code').innerText()).includes('甲图X'), 'source remains readable');
  await page.locator('[data-first] summary').click();
  await page.evaluate(code => window.cacheProbe.setFirst(code), y); await waitDiagram('first', '乙图Y');
  await page.evaluate(code => window.cacheProbe.setSecond(code), x); await waitDiagram('second', '甲图X');
  const switched = await collect('A-X-to-Y-B-reuses-cached-X');
  assert.equal(switched.rootIds[1], original.rootIds[0], 'B actually reuses the original cached X SVG');
  assert.notEqual(switched.rootIds[0], switched.rootIds[1], 'A source change receives a fresh render namespace');
  await page.evaluate(() => window.cacheProbe.setTheme(true));
  await page.waitForFunction(urls => { const images = [...document.querySelectorAll('.textbook-diagram-svg img')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0 && !urls.includes(image.src)); }, switched.imageUrls);
  await waitDiagram('first', '乙图Y'); await waitDiagram('second', '甲图X'); const dark = await collect('dark-theme-both-instances');
  await page.evaluate(() => window.cacheProbe.setTheme(false));
  await page.waitForFunction(urls => { const images = [...document.querySelectorAll('.textbook-diagram-svg img')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0 && !urls.includes(image.src)); }, dark.imageUrls);
  await waitDiagram('first', '乙图Y'); await waitDiagram('second', '甲图X'); const light = await collect('light-theme-cache-revisit');
  assert.deepEqual(light.rootIds, switched.rootIds, 'light theme reuses the original cached SVGs');
  for (const [name,code,label] of [
    ['two-mindmaps','mindmap\n  root((共同主题))\n    第一分支\n    第二分支','共同主题'],
    ['two-sequences','sequenceDiagram\n  participant A as 学生\n  participant B as 老师\n  A->>B: 共同问题\n  B-->>A: 回答','共同问题'],
    ['two-timelines','timeline\n  title 共同阶段\n  2020 : 开始\n  2021 : 后续','共同阶段'],
  ]) {
    await page.evaluate(code => { window.cacheProbe.setFirst(code); window.cacheProbe.setSecond(code); },code);
    await waitDiagram('first',label); await waitDiagram('second',label); await collect(name);
    if (name === 'two-mindmaps') await page.screenshot({ path: path.join(directory, 'two-mindmaps.png'), fullPage: true });
  }
  await page.screenshot({ path: path.join(directory, 'two-timelines.png'), fullPage: true });
  const beforeRemoval = await collect('before-unmount');
  await page.evaluate(() => window.cacheProbe.setSecond(null));
  await page.waitForFunction(() => document.querySelectorAll('.textbook-diagram-svg img').length === 1);
  const afterRemoval = await collect('sibling-survives-unmount');
  assert.equal(afterRemoval.imageUrls[0], beforeRemoval.imageUrls[0], 'unmounting one image leaves its sibling URL alive');
  assert.notEqual(beforeRemoval.imageUrls[0], beforeRemoval.imageUrls[1], 'instances own distinct image URLs');
  await page.evaluate(() => {
    document.querySelector('main').classList.add('progressive-course-reader');
    document.querySelector('main').style.width = '760px';
    window.cacheProbe.setFirst('flowchart TD\n' + Array.from({ length: 12 }, (_, i) => `N${i}[概念${i}] --> N${i + 1}[概念${i + 1}]`).join('\n'));
  });
  await waitDiagram('first', '概念12');
  const fittedHeight = await page.locator('[data-first] .textbook-diagram-svg img').evaluate(image => image.getBoundingClientRect().height);
  assert.ok(fittedHeight <= 577, 'progressive page keeps tall images within the existing fitted-height budget');
  await page.locator('[data-first]').getByRole('button', { name: '原尺寸阅读', exact: true }).click();
  const nativeHeight = await page.locator('[data-first] .textbook-diagram-svg img').evaluate(image => image.getBoundingClientRect().height);
  assert.ok(nativeHeight > fittedHeight, 'native-size mode exposes the full tall diagram');
  proof.tallImage = { fittedHeight, nativeHeight };
  proof.namespace = await page.evaluate(() => {
    const input = String.raw`<svg id="old" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <style>#old #a,#ab,#a\:b,#\31 23 {fill:#abc;stroke:url("#abc");content:"url(#abc)"} #dup {opacity:.5} [data-note="#a"] {fill:#abcdef}</style>
      <defs><marker id="abc" data-original="marker"/></defs>
      <g id="a" data-original="a"/><g id="ab" data-original="ab"/><g id="a:b" data-original="escaped"/><g id="123" data-original="numeric"/>
      <g id="dup" data-original="duplicate1"/><g id="dup" data-original="duplicate2"/>
      <text id="label" data-original="label">标签</text><path marker-end="url(#abc)" style="fill:#abc;stroke:url('#abc')" aria-labelledby="label missingLabel"/>
      <use href="#a" xlink:href="#ab"/></svg>`;
    const svg = window.cacheProbe.namespaceMermaidSvg(input, 'test-namespace');
    const doc = new DOMParser().parseFromString(svg,'image/svg+xml'), root=doc.documentElement;
    return { names:Object.fromEntries([...root.querySelectorAll('[data-original]')].map(element=>[element.getAttribute('data-original'),element.id])),
      style:root.querySelector('style').textContent, path:Object.fromEntries([...root.querySelector('path').attributes].map(attribute=>[attribute.name,attribute.value])),
      use:Object.fromEntries([...root.querySelector('use').attributes].map(attribute=>[attribute.name,attribute.value])) };
  });
  const { names, style, path:attributes, use } = proof.namespace;
  for (const name of ['a','ab','escaped','numeric']) assert.ok(style.includes('#'+names[name]), 'exact/overlapping/escaped CSS selector '+name+' is rewritten');
  assert.ok(style.includes(`:is(#${names.duplicate1},#${names.duplicate2})`), 'duplicate original IDs preserve CSS selection of every element');
  assert.ok(style.includes('fill:#abc')); assert.ok(style.includes('fill:#abcdef')); assert.ok(style.includes('[data-note="#a"]'), 'quoted selector text is preserved');
  assert.ok(style.includes(`url("#${names.marker}")`)); assert.ok(style.includes('content:"url(#abc)"'), 'URL-like ordinary string is untouched');
  assert.equal(attributes['marker-end'],`url(#${names.marker})`); assert.equal(attributes.style,`fill:#abc;stroke:url('#${names.marker}')`);
  assert.equal(attributes['aria-labelledby'],`${names.label} missingLabel`, 'original missing ARIA reference is preserved without inventing nodes');
  assert.equal(use.href,'#'+names.a); assert.equal(use['xlink:href'],'#'+names.ab);
  assert.deepEqual(proof.errors, []); proof.ok = true;
  console.log('PASS real Mermaid images: decoded source/theme/cache reuse, local references, isolated styles and sibling unmount lifetime');
} catch (error) { proof.error = String(error.stack || error); process.exitCode = 1; console.error(proof.error); }
finally {
  await browser?.close().catch(() => {}); if (child?.exitCode === null) child.kill();
  await new Promise(resolve => server.httpServer.close(resolve));
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(proof, null, 2));
  console.log('Mermaid cache proof: ' + directory);
}
