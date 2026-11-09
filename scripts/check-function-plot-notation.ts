/** Exact user-supplied plot configuration + synthetic spelling/safety fixtures.
 * Optional --svg input is produced by the native isolated drawing process. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileTextbookFunction, parseFunctionPlot } from '../src/services/textbook/functionPlot';
import { sampleTextbookCurve } from '../src/services/textbook/curveSampling';
import { FunctionPlotBlock } from '../src/components/textbook/FunctionPlotBlock';
import { parseControlledTextbookBlock } from '../src/services/textbook/contentSchema';
import { prepareTextbookExportAssets } from '../src/services/textbook/prepareTextbookExportAssets';
import { renderStyledTextbookHtml } from '../src/services/textbook/styledTextbookHtml';

const code = (await fs.readFile('scripts/fixtures/function-plot-notation.json', 'utf8')).trim();
const original = JSON.parse(code), checks: string[] = [];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const expressions = [original.curves[0].expression, 'x^{4}-2x^{2}', 'x⁴−2x²', '$x^{4}-2\\cdot x^{2}$',
  '\\(x^{4}-2\\times x^{2}\\)', 'x**4-2*x**2', 'x^4-2(x)^2', '\\left(x\\right)^{4}-2x^{2}'];
for (const expression of expressions) {
  const plot = parseFunctionPlot(JSON.stringify({ ...original, curves: [{ ...original.curves[0], expression }] }));
  const fn = compileTextbookFunction(plot.curves[0].expression, plot.variable, plot.parameters);
  for (const [x, y] of [[-2, 8], [-1, -1], [0, 0], [1, -1], [2, 8]]) near(fn.evaluate(x), y);
  const segments = sampleTextbookCurve(plot, 0);
  assert.equal(segments.length, 1); assert.equal(segments[0].length, 601);
  near(segments[0][0][0], -2.4); near(segments[0].at(-1)![0], 2.4);
  for (const [, y] of segments[0]) assert.ok(y >= plot.yDomain[0] && y <= plot.yDomain[1]);
}
assert.equal(JSON.parse(code).curves[0].expression, 'x^4-2x^2', 'The saved Markdown JSON source must not be rewritten');
assert.ok(parseControlledTextbookBlock('function-plot', code));
const reader = renderToStaticMarkup(React.createElement(FunctionPlotBlock, { code }));
assert.ok(reader.includes('data-function-plot="true"')); assert.ok(!reader.includes('函数图暂未绘制'));
checks.push('The exact provided configuration and seven bounded equivalent spellings enter the actual plot component, sample one complete curve, preserve all five stated values and fit the unchanged x-window');

for (const expression of ['1/2x', '1/-2x', '1/2(x+1)', 'x/(x+1)x']) {
  assert.throws(() => parseFunctionPlot(JSON.stringify({ ...original, curves: [{ ...original.curves[0], expression }] })), /歧义/u);
}
for (const expression of ['xy', 'f(x)', 'a*x', 'x.constructor', 'Math.pow(x,2)', 'x;fetch(1)', 'x=1', 'x[0]', '\\unknown{x}', '2 3']) {
  assert.throws(() => parseFunctionPlot(JSON.stringify({ ...original, curves: [{ ...original.curves[0], expression }] })));
}
for (const [expression, expected] of [['1/(2x)', .25], ['(1/2)x', 1], ['2x/3', 4 / 3], ['1/2+2x', 4.5]] as const) {
  const plot = parseFunctionPlot(JSON.stringify({ ...original, xDomain: [.5, 2], curves: [{ ...original.curves[0], expression }] }));
  near(compileTextbookFunction(plot.curves[0].expression, 'x').evaluate(2), expected);
}
// The lower-level compiler remains strict and retains its old safety contract.
assert.throws(() => compileTextbookFunction('2x', 'x'));
assert.throws(() => parseFunctionPlot(JSON.stringify({ ...original, curves: [{ ...original.curves[0], expression: 'x'.repeat(401) }] })));
assert.throws(() => parseFunctionPlot(JSON.stringify({ ...original, curves: [{ ...original.curves[0], expression: '('.repeat(25) + '2x' + ')'.repeat(25) }] })));
checks.push('Ambiguous denominator shorthand, undeclared/multi-letter variables, unknown functions and script syntax reject; explicitly grouped fractions and the original AST limits remain intact');

const svgIndex = process.argv.indexOf('--svg'), svgFile = svgIndex >= 0 ? path.resolve(process.argv[svgIndex + 1]) : undefined;
const root = svgFile ? path.dirname(svgFile) : await fs.mkdtemp(path.resolve('build/function-plot-notation-'));
if (svgFile) {
  const svg = await fs.readFile(svgFile, 'utf8'); assert.match(svg, /^\s*<svg[\s>]/u); assert.ok(svg.includes('<path'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'); let reply: any;
  const worker: any = { postMessage: (value: unknown) => { reply = value; } };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
  try {
    await import('../src/services/textbook/exportAssets.worker');
    const invoke = (data: unknown) => { reply = undefined; worker.onmessage({ data }); assert.ok(reply && !reply.error, reply?.error); return reply; };
    const body = '# 多项式函数\n\n```function-plot\n' + code + '\n```';
    const prepared = await prepareTextbookExportAssets(body, undefined, {
      createWorker: () => ({ plan: async text => invoke({ op: 'plan', body: text }).items,
        svg: async input => invoke({ op: 'svg', svg: input }), image: async () => { throw Error('Unexpected image read'); }, close() {} }),
      readImage: async () => { throw Error('Unexpected image read'); },
      renderVisual: async (language, source) => { assert.equal(language, 'function-plot'); assert.deepEqual(JSON.parse(source), original); return svg; },
    });
    assert.equal(prepared.savedVisuals, 1); assert.equal(prepared.missingVisuals, 0); assert.equal(prepared.body, body);
    const html = renderStyledTextbookHtml('多项式函数', prepared.body, prepared.assets);
    assert.ok(html.includes('data:image/svg+xml;base64,') && !html.includes('图示未能导出'));
    assert.ok(!/<script\b/iu.test(html));
    await fs.writeFile(path.join(root, 'polynomial-offline.html'), html);
    checks.push('The real export worker, asset assembler and styled HTML exporter embed the actual native-rendered SVG with no scripts or external image dependency, while leaving the Markdown fence intact');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
}
const result = { passed: true, root, checks, exactConfiguration: original, equivalentSpellings: expressions.length,
  nativeSvgExported: Boolean(svgFile), realModelRequests: 0, networkCalls: 0, realUserDataAccessed: false };
await fs.writeFile(path.join(root, 'function-plot-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
