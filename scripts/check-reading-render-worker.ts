import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { needsBackgroundTextbookReading } from '../src/services/textbook/readingBudget';
import { FormulaBlock } from '../src/components/textbook/FormulaBlock';
import katex, { type PreparedFormula } from '../src/services/textbook/formulaRenderer';
import { noteReadingComponents } from '../src/components/textbook/NoteReadingMarkdown';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { jsx, jsxs } from 'react/jsx-runtime';

assert.equal(needsBackgroundTextbookReading('短篇普通教材。'.repeat(300), 24_000), false);
assert.equal(needsBackgroundTextbookReading(String.raw`价格为 \$10。`.repeat(100), 24_000), false);
assert.equal(needsBackgroundTextbookReading(Array.from({ length: 65 }, () => '$f(x)=x^2$、$x\\to x_0$、$\\lim_{x\\to0}f(x)$').join('\n\n'), 24_000), true);
assert.equal(needsBackgroundTextbookReading('a'.repeat(24_001), 24_000), true);
assert.equal(needsBackgroundTextbookReading('函数 f(x)=x^2。'.repeat(40), 24_000), true, 'bare generated formulas also route to the worker');
assert.equal(needsBackgroundTextbookReading(`$${'x+'.repeat(300)}x$`, 24_000), true);
assert.equal(needsBackgroundTextbookReading(`$$${'x+'.repeat(300)}x$$`, 24_000), true);
assert.equal(needsBackgroundTextbookReading('```mermaid\nA-->B\n```\n'.repeat(3), 24_000), true);
console.log('PASS short ordinary books stay lightweight; formula/visual density routes to background independently of character count');

const bundle = await build({ stdin: { contents: "import './src/services/textbook/readingDocumentWorker.ts';", resolveDir: process.cwd() },
  platform: 'node', format: 'cjs', target: 'node22', bundle: true, write: false, logLevel: 'silent' });
const worker = new Worker(`const {parentPort}=require('node:worker_threads');
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
${bundle.outputFiles[0].text}
parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
let serial = 0;
const requests = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
worker.on('message', value => {
  const request = requests.get(value.id); if (!request) return;
  requests.delete(value.id); clearTimeout(request.timer);
  value.error ? request.reject(Error(value.error)) : request.resolve(value);
});
worker.on('error', error => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); } requests.clear(); });
const send = (payload: object): Promise<any> => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { requests.delete(id); reject(Error('reading worker timeout')); }, 15000);
  requests.set(id, { resolve, reject, timer }); worker.postMessage({ id, ...payload });
});
function formulas(tree: any): PreparedFormula[] {
  return [...(tree.data?.preparedFormula ? [tree.data.preparedFormula] : []), ...(tree.children || []).flatMap(formulas)];
}
try {
  const content = '# 合成教材\n\n' + Array.from({ length: 65 }, (_, n) => `## 概念${n}\n\n函数 $f(x)=x^2$、趋势 $x\\to x_0$，极限 $\\lim_{x\\to0}f(x)=0$。`).join('\n\n')
    + '\n\n块公式：\n\n$$\n\\int_0^1 x^2\\,dx=\\frac13\n$$\n\n化学式 $\\ce{H2O}$。\n\n异常 $\\notacommand{broken}$。';
  const opened = await send({ input: { content } });
  assert.ok(opened.index.pages.length > 8);
  assert.equal(opened.tree, undefined, 'opening transfers an index, not an expanded full-book DOM');
  const prepared: PreparedFormula[] = [];
  for (let page = 0; page < opened.index.pages.length; page++) {
    const value = await send({ page });
    assert.equal(value.cacheUnits, JSON.stringify(value.tree).length, 'expanded cache accounting is provided by the worker');
    prepared.push(...formulas(value.tree));
  }
  assert.equal(prepared.length, 198);
  assert.ok(prepared.some(value => value.displayMode && value.html?.includes('katex-display')));
  assert.ok(prepared.some(value => value.latex === '\\ce{H2O}' && value.html?.includes('katex')));
  assert.ok(prepared.find(value => value.latex.includes('notacommand'))?.error);
  assert.equal(prepared.filter(value => value.html).length, 197);
  console.log('PASS real worker: index then bounded requested pages, 198 formulas including display math/chemistry and a recoverable invalid formula');

  const original = katex.renderToString;
  try {
    katex.renderToString = () => assert.fail('foreground must not rerun KaTeX for worker-prepared math');
    for (const value of prepared) {
      const html = renderToStaticMarkup(React.createElement(FormulaBlock, { latex: value.latex, displayMode: value.displayMode, prepared: value }));
      assert.ok(value.error ? html.includes('textbook-formula-error') : html.includes('katex') && html.includes('<math'));
    }
    const page = (await send({ page: 0 })).tree;
    const rendered = renderToStaticMarkup(toJsxRuntime(page, { Fragment: React.Fragment, jsx, jsxs,
      passKeys: true, passNode: true, components: noteReadingComponents(() => {}, true) }));
    assert.ok(rendered.includes('katex') && rendered.includes('<math'));
  } finally { katex.renderToString = original; }
  console.log('PASS foreground consumes actual worker results with zero KaTeX calls and retains MathML/error source');

  await send({ input: { content: '人工段落 f(x)=x^2。\n\n### 本项目需要掌握的知识点\n\n[[导数]]：f\u0027(x)=3x^2-3。' } });
  const recovered = formulas((await send({ page: 0 })).tree);
  assert.equal(recovered.length, 1, 'only managed-section bare math is prepared, not manual prose');
  assert.ok(recovered[0].html?.includes('katex'));
  console.log('PASS worker prepares recovered generated notation too; manual prose outside its section remains unchanged');

  await send({ input: { content: '新文档 $y=7$。\n\n不可信 $\\href{javascript:alert(1)}{x}$。' } });
  const fresh = formulas((await send({ page: 0 })).tree);
  assert.ok(fresh.some(value => value.latex === 'y=7'));
  assert.ok(fresh.every(value => !value.html?.includes('<a href="javascript:')));
  assert.ok(!fresh.some(value => value.latex === 'f(x)=x^2'));
  const stale = renderToStaticMarkup(React.createElement(FormulaBlock, { latex: 'z=3', prepared: prepared[0] }));
  assert.ok(stale.includes('z=3') && !stale.includes('f(x)=x^2'));
  console.log('PASS document replacement cannot leak stale formula results; untrusted math does not gain link/script permission');
} finally {
  for (const request of requests.values()) clearTimeout(request.timer);
  await worker.terminate();
}
