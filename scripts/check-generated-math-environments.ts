import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { generatedMathMarkdown, generatedMathSpans, recoverGeneratedMathTree, remarkGeneratedMath } from '../src/services/textbook/generatedMath';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { prepareFormula } from '../src/services/textbook/formulaRenderer';
import { prepareReadingDocument } from '../src/services/textbook/readingDocument';
import { createReadingFormulaPreparer } from '../src/services/textbook/readingFormula';
import { prepareMarkdownForMdx } from '../src/services/markdownMdxCompatibility';

globalThis.fetch = async () => assert.fail('Formula recovery must remain offline');
const cases = String.raw`m(a)= \begin{cases} 0 & a<0 \\ -a^2 & 0\le a\le2 \\ 4-4a & a>2. \end{cases}`;
const multiline = String.raw`m(a)=\begin{cases}
0 & a<0 \\
-a^2 & 0\le a\le2 \\
4-4a & a>2.
\end{cases}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function formulas(node: any): string[] {
  return [...(node.type === 'math' || node.type === 'inlineMath' ? [node.value] : []), ...(node.children || []).flatMap(formulas)];
}
function recover(source: string) {
  const before = hash(source), tree = parseTextbookMarkdown(source);
  recoverGeneratedMathTree(tree, 'all', { source, citationIds: ['8', 'L1'] });
  assert.equal(hash(source), before, 'display recovery must not modify stored source identity');
  return tree;
}
const sources = [
  `因此 [ ${cases} ] 边界(a=0,2)并入中间段时公式仍然一致。[L1]`,
  `因此\n[\n${multiline}\n]\n分段条件保持一致。[8]`,
  `> 要点\n>\n> 因此 [\n> ${multiline.replace(/\n/gu, '\n> ')}\n> ] 条件保持一致。`,
  `- 因此 [\n  ${multiline.replace(/\n/gu, '\n  ')}\n  ] 条件保持一致。`,
  String.raw`因此 \[ ${cases} \] 条件保持一致。`,
  `因此 ${cases}，条件保持一致。`,
  `实体 &amp; 转义 \\* 保留；[ ${cases} ] 然后 [ ${cases} ]。`,
  `[ ${cases} ][8][L1]。`,
  `[ ${cases} ] (边界归入中间分段)。`,
];
for (const source of sources) {
  const tree = recover(source), found = formulas(tree).filter(value => value.includes('\\begin{cases}'));
  assert.equal(found.length, source.includes('然后') ? 2 : 1, source);
  for (const latex of found) {
    assert.equal((latex.match(/\\\\/gu) || []).length, 2, 'all three rows retain their exact separators');
    const prepared = prepareFormula(latex);
    assert.equal(prepared.error, undefined, latex);
    assert.equal((prepared.html!.match(/<mtr>/gu) || []).length, 3, 'actual KaTeX MathML has three cases rows');
    assert.ok(latex.includes('0\\le a\\le2') && latex.includes('a>2.'), 'conditions and source punctuation stay exact');
    assert.ok(!latex.includes('> \\end'), 'Markdown container prefixes never enter TeX');
  }
}
const mdxPrepared=prepareMarkdownForMdx(sources[0]).markdown;
assert.ok(mdxPrepared.includes('a\\<0'), 'exercise the real editor compatibility escape');
assert.ok(formulas(recover(mdxPrepared)).includes(cases), 'MDX comparison escaping must not become invalid TeX');
const matrix=String.raw`A=\begin{pmatrix}1&2\\3&4\end{pmatrix}`;
assert.deepEqual(formulas(recover(`[ ${matrix} ]`)),[matrix]);
assert.equal(prepareFormula(formulas(recover(`[ ${matrix} ]`))[0]).error,undefined);

// The string adapter emits standard math Markdown; a save/reparse round-trip
// preserves TeX instead of losing one slash in each row through CommonMark.
const normalized = generatedMathMarkdown(`[ ${cases} ]`);
assert.equal(normalized, `$${cases}$`);
assert.deepEqual(formulas(parseTextbookMarkdown(normalized)), [cases]);
assert.equal(generatedMathMarkdown(normalized), normalized);
const explicit = `$$\n${multiline}\n$$`;
assert.deepEqual(formulas(recover(explicit)), [multiline]);
for (const value of ['[普通说明] [8] [L1]', '`[ ' + cases + ' ]`', `[ ${cases} ](https://example.invalid/a?q=1)`, `![ ${cases} ](image.png)`, `[ ${cases} ][source]`]) {
  assert.equal(generatedMathMarkdown(value, { citationIds: ['8', 'L1'] }), value, value);
}
for (const value of [
  '```tex\n[ ' + cases + ' ]\n```', '~~~tex\n[ ' + cases + ' ]\n~~~',
  '`[ ' + cases + ' ]`', `[ ${cases} ](https://example.invalid/a?q=1)`,
  `![ ${cases} ](image.png)`, `[ ${cases} ][source]\n\n[source]: https://example.invalid`,
]) assert.equal(formulas(recover(value)).length, 0, 'code, link labels, image alt text and destinations are opaque');
const damaged = `[ ${cases.replace(/\\\\/gu, '\\')} ]`;
assert.equal(generatedMathSpans(damaged).length, 0, 'never guess row separators from downgraded cases text');
const withoutSource = parseTextbookMarkdown(`[ ${cases} ]`);
recoverGeneratedMathTree(withoutSource, 'all');
assert.equal(formulas(withoutSource).length, 0, 'without original source, leave the entire cases environment intact');

// The actual short reader plugin receives its original vfile, and the long
// reader passes its once-parsed source into the exact same recovery helper.
const shortHtml = renderToStaticMarkup(createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, remarkMath, [remarkGeneratedMath, { scope: 'all' }]],
  components: { code: ({ children, className }: any) => {
    if (!className?.includes('math-inline')) return createElement('code', null, children);
    const prepared = prepareFormula(String(children));
    assert.equal(prepared.error, undefined);
    return createElement('span', { dangerouslySetInnerHTML: { __html: prepared.html! } });
  } },
  children: sources[0],
}));
assert.ok(shortHtml.includes('katex') && (shortHtml.match(/<mtr>/gu) || []).length === 3);
const longSource = `# 分段函数\n\n${sources[0]}\n\n` + '连续滚动正文。'.repeat(4_500);
const document = prepareReadingDocument({ content: longSource, fragmentKind: 'textbook' });
const preparePage = createReadingFormulaPreparer();
const preparedCases: any[] = [];
function collectPrepared(node: any) {
  if (node.data?.preparedFormula?.latex.includes('\\begin{cases}')) preparedCases.push(node.data.preparedFormula);
  node.children?.forEach(collectPrepared);
}
document.pages.map(preparePage).forEach(collectPrepared);
assert.equal(preparedCases.length, 1);
assert.equal(preparedCases[0].error, undefined);
assert.equal((preparedCases[0].html.match(/<mtr>/gu) || []).length, 3);
assert.ok(document.pages.length > 1, 'exercise the long continuous-scroll worker preparation path');
console.log(JSON.stringify({ status: 'passed', recoveredSourceVariants: sources.length, casesRows: 3,
  shortReader: true, longReader: true, storedSourceUnchanged: true, realModelRequests: 0 }));
