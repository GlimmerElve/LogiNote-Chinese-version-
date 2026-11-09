import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FlowQuestionAnswer } from '../src/components/FlowQuestionAnswer';

globalThis.fetch = async () => assert.fail('Flow answer checks never call a network or model');
const answer = String.raw`应用

\[
F(x)=e^{2x}f(x).
\]

倒推过程：把 \(\xi\) 换成 \(x\)，有 \(f'(x)+2f(x)=0\) 移项并积分：
\[\frac{f'(x)}{f(x)}=-2\quad\Rightarrow\quad\ln|f(x)|=-2x+C\]
于是 \(e^{2x}f(x)=C\)。

验证：$F'(x)=e^{2x}\bigl(f'(x)+2f(x)\bigr)$。

$$
F'(\xi)=0.
$$

[旧来源](https://example.invalid/reference#section) [L21] [1]

| 条件 | 说明 |
| --- | --- |
| 连续 | 原条件保留 |` + '\n\n' + '`' + String.raw`\(literal_code\)` + '`' + '\n\n'
  + '`'.repeat(3) + 'tex\n' + String.raw`\[do_not_render_code\]` + '\n' + '`'.repeat(3);
const original = answer;
const oldMarkup = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>);
assert.ok(!oldMarkup.includes('class="katex"'), 'Reproduce the original GFM-only answer surface');
assert.ok(oldMarkup.includes('F(x)=e^{2x}f(x).'), 'Original Markdown renderer shows raw TeX');
const html = renderToStaticMarkup(<FlowQuestionAnswer content={answer} />);
assert.equal((html.match(/class="katex"/gu) || []).length, 8, 'Inline and display TeX/dollar delimiters all render');
assert.equal((html.match(/class="katex-display"/gu) || []).length, 3, 'Display formulas keep their intended presentation');
assert.ok(!html.includes('textbook-formula-error') && !html.includes('textbook-format-error'), 'Valid formulas must not silently fall back');
assert.ok(html.includes('application/x-tex') && html.includes('<math'), 'Formula source and accessible MathML remain available');
assert.ok(html.includes('href="https://example.invalid/reference#section"') && html.includes('[L21]') && html.includes('[1]'), 'Existing reference links and markers remain');
assert.ok(html.includes('flow-md-table-wrap') && html.includes('<table>') && html.includes('原条件保留'), 'Existing Markdown tables remain');
assert.ok(html.includes('literal_code') && html.includes('do_not_render_code') && html.includes('language-tex'), 'Code remains code, not formula material');
assert.equal(answer, original, 'Rendering never mutates the saved answer');

const invalid = renderToStaticMarkup(<FlowQuestionAnswer content={String.raw`不能识别的公式 $\notARealCommand{x}$；<img src=x onerror=alert(1)> [bad](javascript:alert(1))。`} />);
assert.ok(invalid.includes('textbook-formula-error') && invalid.includes('notARealCommand'), 'Malformed math retains a readable source fallback');
assert.ok(!invalid.includes('<img') && !invalid.includes('href="javascript:') && !invalid.includes('<script'), 'Answer markup never enables raw HTML or active unsafe links');
const component = FlowQuestionAnswer as any;
assert.equal(component.$$typeof, Symbol.for('react.memo'), 'Parent timer/restatement renders are shallow-prop memoized');
const source = readFileSync('src/components/FlowMode.tsx', 'utf8');
assert.match(source, /<FlowQuestionAnswer content=\{card\.answer\} \/>/u, 'The actual Flow answer entry uses the fixed renderer');
assert.ok(source.includes('const answer = (resp.content || \'\').trim();'), 'Answer persistence keeps original model output');
console.log('PASS Flow question answers: all TeX delimiters render, Markdown/code/old citations preserved, static safe formulas, memoized display only; zero model/network/settings/notes changes.');
