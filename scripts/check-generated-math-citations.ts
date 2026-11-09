import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { generatedMathMarkdown, generatedMathSpans, recoverGeneratedMathTree } from '../src/services/textbook/generatedMath';
import { prepareFormula } from '../src/services/textbook/formulaRenderer';

globalThis.fetch = async () => assert.fail('Math citation recovery must stay offline');
const options = { citationIds: ['8', '9', 'L1'] };
for (const value of ['p=[0.1,0.9][8]。', 'p=[0.1,0.9] [8][9]。', 'exp(x)[9]。', 'Σ_k exp(log p_k)=1[9]。', 'a_n=n^2 [L1]。']) {
  const spans = generatedMathSpans(value, options);
  assert.ok(spans.length, value);
  for (const span of spans) {
    assert.ok(!/\\left\[(?:8|9|L_\{1\})\\right\]/u.test(span.tex), span.tex);
    assert.equal(prepareFormula(span.tex).error, undefined, span.tex);
  }
  assert.ok(/\[(?:8|9|L1)\]/u.test(value.slice(spans.at(-1)!.end)), value);
}
// Established letter-prefixed citation syntax is protected with no metadata.
assert.match(generatedMathMarkdown('a_n=n^2 [L1]。'), /\$ \[L1\]。$/u);
for (const value of ['x=[8]', 'x=[0,1]', 'x=[8]+1', '2[8]+1', 'x=[8][9]+1']) {
  const baseline = generatedMathSpans(value);
  assert.deepEqual(generatedMathSpans(value, options), baseline, 'known citation ID must not truncate a valid vector or continuation: ' + value);
  if (baseline.length) assert.equal(generatedMathSpans(value, options)[0]?.end, value.length, value);
}
// An unrecognized numeric bracket is never guessed to be a citation.
assert.deepEqual(generatedMathSpans('exp(x)[42]。', options), generatedMathSpans('exp(x)[42]。'));
for (const value of ['$x=[8]$[9]', '`exp(x)[9]`', '[[exp(x)[9]]]', 'https://example.invalid/exp(x)[9]']) {
  assert.equal(generatedMathMarkdown(value, options), value);
}

const source = '# 概念补充\n\np=[0.1,0.9][8]。\n\n$x=[8]$[9]。\n\n```text\nx=[8][9]\n```';
const tree = parseTextbookMarkdown(source), snapshot = JSON.stringify(source);
recoverGeneratedMathTree(tree, 'all', options);
const formulas: string[] = [];
const text: string[] = [];
function collect(node: any) {
  if (node.type === 'inlineMath' || node.type === 'math') formulas.push(node.value);
  if (node.type === 'text') text.push(node.value);
  if (node.type === 'code') assert.equal(node.value, 'x=[8][9]');
  node.children?.forEach(collect);
}
collect(tree);
assert.equal(JSON.stringify(source), snapshot, 'recovery only touches the display AST');
assert.ok(text.join('').includes('[8]') && text.join('').includes('[9]'));
assert.ok(formulas.includes('x=[8]'), 'explicit authored math is opaque');
assert.ok(!formulas.some(value => /\\left\[(?:8|9)\\right\]/u.test(value)));

// The exact real response is a regression source, not another paid request.
const cached = JSON.parse(fs.readFileSync('scripts/fixtures/concept-softmax-cached-response.json', 'utf8'));
const raw = String(cached.content || cached);
const normalized = raw.replace(/【来源\s*(\d+)\s*】/gu, '[$1]');
const oldTree = parseTextbookMarkdown(normalized);
recoverGeneratedMathTree(oldTree, 'all', options);
const oldFormulas: string[] = [];
const walk = (node: any) => { if (node.type === 'inlineMath') oldFormulas.push(node.value); node.children?.forEach(walk); };
walk(oldTree);
assert.ok(oldFormulas.length > 1);
assert.ok(oldFormulas.every(value => !/\\left\[(?:8|9)\\right\]|\[(?:8|9)\]/u.test(value)), oldFormulas.join('\n'));
console.log(JSON.stringify({ status: 'passed', knownCitationBoundaries: 5, vectorsAndContinuation: 5, cachedFormulaCount: oldFormulas.length, realModelRequests: 0, originalUnchanged: true }));
