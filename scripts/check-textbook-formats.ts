import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChartBlock, parseControlledTextbookBlock, parseTextbookImage, parseTextbookAnswer, parseTextbookTip, validateMermaid } from '../src/services/textbook/contentSchema';
import { parseTextbookMarkdown, remarkTextbookReferences, textbookSections, textbookUrlTransform } from '../src/services/textbook/markdown';
import { textbookHash } from '../src/services/textbook/fingerprint';
import { textbookRegionMarkers } from '../src/services/textbook/noteContent';
import type { TextbookManifest } from '../src/services/textbook/types';
import type { NoteItem } from '../src/types';
import type { TextbookReaderProps, TextbookBlockProps } from '../src/components/textbook/TextbookReader';
import type { FormulaBlockProps } from '../src/components/textbook/FormulaBlock';
import { visualTimeline } from './fixtures/textbook-visuals';

// Compile real components in memory, stripping CSS only. Native ESM avoids Node 22's
// require(ESM) namespace being double-wrapped by esbuild's CommonJS default-import helper.
async function loadRealModule<T>(relativePath: string): Promise<T> {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'native-esm-externals', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point') return;
        // A data: module has no package-resolution directory. Keep the actual installed
        // packages external, but resolve their import entry points to native file: URLs.
        return { path: import.meta.resolve(args.path), external: true };
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as T;
}
const { TextbookReader, RenderedTextbookBlock } = await loadRealModule<{
  TextbookReader: ComponentType<TextbookReaderProps>; RenderedTextbookBlock: ComponentType<TextbookBlockProps>;
}>('../src/components/textbook/TextbookReader.tsx');
const formulaModule = await loadRealModule<{ FormulaBlock: ComponentType<FormulaBlockProps> }>('../src/components/textbook/FormulaBlock.tsx');
const mermaidModule = await loadRealModule<{
  boundedMermaidReadingWidth: (viewBox: string | null) => number;
  normalizeMermaidLineBreaks: (code: string) => string;
  alignMermaidMindmapLabels: (container: HTMLElement) => void;
  textbookMermaidTheme: (dark: boolean) => any;
}>('../src/components/textbook/MermaidBlock.tsx');
const sourceModule = await loadRealModule<{
  readSourceEvidence: (source: NonNullable<TextbookManifest['sources']>[number], notes?: NoteItem[], cursor?: number) => Promise<{ text: string; nextCursor?: number }>;
}>('../src/components/textbook/SourceReference.tsx');
const now = '2026-10-06T00:00:00.000Z', version = 'a'.repeat(64);
const manifest: TextbookManifest = { schemaVersion: 1, textbookId: 'book-a', projectNoteId: 'project-a', rootProjectId: 'root-a',
  revisionId: 'revision-a', regionId: 'region-a', createdAt: now, updatedAt: now,
  sources: [{ sourceId: 'L1', kind: 'document', id: 'doc-a', title: '教材来源', version, blockId: 'block-a', textStart: 10, textEnd: 20 }],
  assets: [{ id: 'L1-image-0', sourceId: 'L1', docId: 'doc-a', version, blockId: 'block-a', imageIndex: 0, alt: '已采集图片' }],
  chapters: [{ id: 'chapter-first', title: '核心概念' }] };
const chart = { title: '练习示意', type: 'bar', labels: ['条件一', '条件二'], series: [{ name: '结果', data: [3, 5] }], sourceIds: [], simulated: true };
const scope = { sourceIds: ['L1'], assetIds: ['L1-image-0'] };
let checks = 0;
async function check(name: string, run: () => void | Promise<void>) { await run(); checks++; console.log(`PASS ${name}`); }
const fail = (run: () => unknown, message?: RegExp) => assert.throws(run, message);
await check('图表只接受有限数值白名单 schema、拒 option/脚本和超预算', () => {
  assert.deepEqual(parseChartBlock(JSON.stringify(chart)), chart);
  assert.equal(parseChartBlock(JSON.stringify({ ...chart, simulated: false, sourceIds: ['L1'] }), scope).simulated, false);
  fail(() => parseChartBlock(JSON.stringify({ ...chart, simulated: false })), /真实图表/u);
  fail(() => parseChartBlock(JSON.stringify({ ...chart, sourceIds: ['L9'] }), scope), /未授权/u);
  fail(() => parseChartBlock(JSON.stringify({ ...chart, formatter: 'return document.cookie' })), /未授权字段/u);
  fail(() => parseChartBlock(JSON.stringify({ ...chart, title: '<img src=x onerror=alert(1)>' })));
  fail(() => parseChartBlock(JSON.stringify({ ...chart, series: [{ name: '结果', data: [1e13, 2] }] })));
  fail(() => parseChartBlock(JSON.stringify({ ...chart, labels: Array(41).fill('x') })));
  fail(() => parseChartBlock(JSON.stringify({ ...chart, type: 'pie', series: [{ name: '结果', data: [-1, 2] }] })));
  fail(() => parseChartBlock('{"title":"标题","type":"bar","labels":["x"],"series":[{"name":"s","data":[1e999]}],"simulated":true,"sourceIds":[]}'));
});
await check('Mermaid仅受控四类图示，拒初始化、链接、HTML、图标、超大图', () => {
  assert.equal(validateMermaid(visualTimeline), visualTimeline);
  for (const code of ['flowchart TD\nA[条件] --> B[结果]', 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: 理解', 'mindmap\n  root((核心))\n    分支']) assert.equal(validateMermaid(code), code);
  for (const code of ['graph LR\nA-->B', 'flowchart LR\nclick A "https://example.com"', '%%{init:{securityLevel:"loose"}}%%\nflowchart LR\nA-->B', 'flowchart LR\nA[<b>HTML</b>]', 'mindmap\n root((核心))\n ::icon(fa fa-book)', '---\nconfig: test\n---\nflowchart LR\nA-->B', 'flowchart LR\nstyle A fill:url(https://example.com/x)', 'flowchart LR\nA[&#60;img&#62;]']) fail(() => validateMermaid(code));
  fail(() => validateMermaid('flowchart LR\n' + 'A'.repeat(8000)));
  fail(() => validateMermaid('flowchart LR\n' + Array.from({ length: 81 }, (_, i) => `A${i}-->B${i}`).join('\n')));
  fail(() => validateMermaid('flowchart LR\n' + Array.from({ length: 50 }, (_, i) => `A${i}-->B${i}`).join('\n')), /节点/u);
});
await check('时间轴限制时期、事件和分组，格式错误与可执行内容仍拒绝', () => {
  for (const code of ['timeline', 'timeline\n阶段', 'timeline\n: 无所属事件', 'timeline\n阶段 : 事件\nsection 新组\n: 孤立事件',
    'timeline\n阶段:事件', 'timeline\n阶段 : ', 'timeline\n时期 : 事件 : ', 'timeline\ntitle 重复\ntitle 重复\n阶段 : 事件',
    'timeline\n阶段 : 事件\ntitle 后置标题', 'timeline\n阶段 : <script>alert(1)</script>', 'timeline\n阶段 : https://example.com',
    'timeline\n阶段 : &#60;img&#62;', 'timeline\n阶段 : 事件\nclick A callback', 'timeline\n阶段 : 事件\nstyle A fill:red',
    'timeline\n' + Array.from({ length: 13 }, (_, i) => `阶段${i} : 事件`).join('\n'),
    'timeline\n阶段 : 事件\n' + Array(24).fill(': 追加事件').join('\n'),
    'timeline\n' + Array.from({ length: 13 }, (_, i) => `section 分组${i}`).join('\n') + '\n阶段 : 事件']) fail(() => validateMermaid(code));
  const full = 'timeline\n' + Array.from({ length: 12 }, (_, i) => `section 分组${i}\n阶段${i} : 事件\n: 追加事件`).join('\n');
  assert.equal(validateMermaid(full), full);
});
await check('Mermaid原尺寸阅读仅接受有界viewBox数值，布局不改变渲染安全门', () => {
  const width = mermaidModule.boundedMermaidReadingWidth;
  assert.equal(width('0 0 1181.21 260.5'), 1182, '合法小数宽度向上取整以免压缩图中文字');
  assert.equal(width('-20, 2.5, 500, 300'), 500, 'viewBox坐标与合法逗号分隔不改变宽度');
  assert.equal(width('0 0 1e3 2e2'), 1000, 'SVG合法科学记数法只转换为有限数值');
  assert.equal(width('0 0 4096 100'), 4096);
  assert.equal(width('0 0 50000 100'), 4096, '原尺寸阅读最大宽度4096px');
  assert.equal(width('0 0 1e100 100'), 4096, '有限大数也必须被布局上限截断');
  for (const invalid of [null, '', '0 0 100', '0 0 100 100 100', '0 0 NaN 100', '0 0 Infinity 100', '0 0 1e999 100',
    '0 0 100 NaN', '0 0 100 Infinity', '0 0 0 100', '0 0 100 0', '0 0 -10 100', '0 0 100 -10',
    '0 0 100px 100', '0 0 0x100 100', '0 0 calc(100vw) 100', '0 0 100; background:url(javascript:alert(1)) 100']) {
    assert.equal(width(invalid), 960, `非法或非正viewBox应使用960px布局回退：${invalid}`);
  }
});
await check('Mermaid转义换行在安全校验后转换为SVG标签换行', () => {
  const normalize = mermaidModule.normalizeMermaidLineBreaks;
  const source = 'flowchart TD\nA["第一行\\n第二行"] --> B{"判断\\r\\n下一步"}';
  assert.equal(normalize(validateMermaid(source)), 'flowchart TD\nA["第一行<br/>第二行"] --> B{"判断<br/>下一步"}');
  for (const tag of ['<br>', '<br/>', '<br />', '<BR />']) {
    const stored = `flowchart TD\nA["第一行${tag}第二行"] --> B["结束"]`;
    assert.equal(validateMermaid(stored), 'flowchart TD\nA["第一行\\n第二行"] --> B["结束"]');
    assert.equal(normalize(validateMermaid(stored)), 'flowchart TD\nA["第一行<br/>第二行"] --> B["结束"]');
    assert.ok(stored.includes(tag), 'reading compatibility never rewrites published source');
  }
  for (const unsafe of ['<br onclick="alert(1)">', '<br style="color:red">', '<br class="label">', '<br><img src="x">', '&lt;br&gt;'])
    fail(() => validateMermaid(`flowchart TD\nA["第一行${unsafe}第二行"]`), /禁止/u);
  fail(() => validateMermaid('flowchart TD\nA["第一行<br/>第二行"]\nclick A "https://example.com"'), /禁止/u);
  assert.equal(normalize(validateMermaid('timeline\n阶段 : 第一行\\n第二行')), 'timeline\n阶段 : 第一行<br>第二行');
  assert.equal(normalize(validateMermaid('timeline\n阶段 : 第一行<br/>第二行')), 'timeline\n阶段 : 第一行<br>第二行');
});
await check('思维导图按形状实际边界居中，明暗主题标签都有足够对比度', () => {
  const transforms: string[] = [];
  const nodes = [
    { label: { x: 0, y: 0, width: 80, height: 20 }, shape: { x: -55, y: -55, width: 110, height: 110 } },
    { label: { x: -2, y: 3, width: 164, height: 40 }, shape: { x: -110, y: -34, width: 220, height: 68 } },
  ].map(({ label, shape }) => ({ querySelector: (selector: string) => selector.includes('g.label')
    ? { getBBox: () => label, setAttribute: (_name: string, value: string) => transforms.push(value) }
    : { getBBox: () => shape } }));
  mermaidModule.alignMermaidMindmapLabels({ querySelectorAll: () => nodes } as unknown as HTMLElement);
  assert.deepEqual(transforms, ['translate(-40, -10)', 'translate(-80, -23)']);
  const luminance = (hex: string) => {
    const rgb = hex.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  };
  for (const dark of [false, true]) {
    const config = mermaidModule.textbookMermaidTheme(dark), theme = config.themeVariables;
    assert.equal(config.securityLevel, 'strict'); assert.equal(config.htmlLabels, false);
    const pairs = [[theme.git0, theme.gitBranchLabel0], [theme.primaryColor, theme.primaryTextColor],
      ...Array.from({ length: 12 }, (_, index) => [theme[`cScale${index}`], theme[`cScaleLabel${index}`]])];
    for (const [background, text] of pairs) {
      const a = luminance(background), b = luminance(text);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${dark ? 'dark' : 'light'} ${background}/${text}`);
    }
  }
});
await check('注释与折叠答案保留 Markdown/公式，不接受嵌套活动块', () => {
  assert.equal(parseTextbookTip('**留意边界**，$x^2$。').kind, 'tip');
  assert.equal(parseTextbookAnswer('{"title":"解析","text":"示例解释 [L1]。"}').title, '解析');
  for (const source of ['<script>alert(1)</script>', '[链接](https://example.com)', '![](data:image/svg+xml,x)', '- [ ] 伪造学习任务', '```javascript\nalert(1)\n```', '@due(2026-10-01)']) fail(() => parseTextbookTip(source));
  fail(() => parseTextbookAnswer('{"title":"解析","text":"正文","open":true}'));
});
await check('图片只能引用清单素材 ID，不接受 URL、文件路径、data/SVG', () => {
  assert.deepEqual(parseTextbookImage('{"assetId":"L1-image-0","caption":"图示"}', scope), { assetId: 'L1-image-0', caption: '图示' });
  for (const code of ['{"assetId":"unknown"}', '{"src":"https://example.com/a.png","assetId":"L1-image-0"}', '{"assetId":"file:C:/secret"}', '{"assetId":"data:image/svg+xml,x"}']) fail(() => parseTextbookImage(code, scope));
  fail(() => parseControlledTextbookBlock('unknown', 'code', scope));
});
const body = '# 完整教材\n\n## 1. 核心概念\n\n用 $x^2$ 理解。[L1]，脚注[^why]。\n\n$$\nx = \\frac{a}{b}\n$$\n\n| 条件 | 解释 |\n| --- | --- |\n| 少 | 清晰 |\n\n```python\nprint("[L1]")\n## 代码标题不算章节\n```\n\n```textbook-answer\n{"title":"参考答案","text":"说明与引用 [L1]。"}\n```\n\n## 后续练习\n\n不自动访问 [未知链接](javascript:alert(1))。\n\n[^why]: 保留真实脚注。';
await check('真实 Markdown AST 保留公式、GFM表格、脚注与围栏示例', () => {
  const tree = parseTextbookMarkdown(body), types = tree.children.map((item) => item.type);
  assert.ok(types.includes('math') && types.includes('table') && types.includes('footnoteDefinition') && types.includes('code'));
  const sections = textbookSections(body, manifest); assert.equal(sections.length, 2); assert.equal(sections[0].chapterId, 'chapter-first');
  assert.equal(textbookSections(body.replace('说明与引用', '修改正文'), manifest)[0].anchor, sections[0].anchor);
  assert.notEqual(textbookSections(body, { ...manifest, revisionId: 'revision-b' })[0].anchor, sections[0].anchor);
  remarkTextbookReferences({ manifest, sections })(tree);
  const codes = tree.children.filter((item) => item.type === 'code'); assert.ok(codes.some((item) => item.value.includes('print("[L1]")')));
  assert.equal(textbookUrlTransform('https://example.com'), ''); assert.equal(textbookUrlTransform('source:L1'), 'source:L1');
});
const [start, end] = textbookRegionMarkers(manifest.regionId);
const note: NoteItem = { id: 'project-a', title: '学习核心概念', content: `原有计划不应出现在教材阅读器。\n${start}\n${body}\n${end}\n用户私人复述不应出现在教材中。\n<LearningReviewBlock id="private" />`, textbook: manifest,
  noteType: 'project', tags: [], links: [], backlinks: [], dueDates: [], createdAt: now, updatedAt: now };
await check('共享 reader 真实 SSR 展示教材、静态公式/表格/代码/来源/脚注/折叠答案，隔离私人记录', () => {
  const html = renderToStaticMarkup(React.createElement(TextbookReader, { note, selectionSurface: 'flow' }));
  for (const token of ['katex', 'mathml', '<table>', 'textbook-code-block', 'textbook-source-reference', 'data-footnote-ref', 'textbook-answer']) {
    assert.ok(html.includes(token), `真实 reader SSR 缺少预期内容：${token}`);
  }
  assert.ok(html.includes('data-footnote-backref') && html.includes('返回正文引用') && html.includes('aria-describedby="footnote-label"'),
    '脚注引用与返回链接保留真实 GFM 属性、中文标签和可访问关联');
  assert.ok(!html.includes('原有计划不应') && !html.includes('用户私人复述') && !html.includes('LearningReviewBlock'));
  assert.ok(!html.includes('href="javascript:') && html.includes('data-selection-surface="flow"') && html.includes('data-selection-note-id="project-a"'));
  assert.ok(html.includes(`id="${textbookSections(body, manifest)[0].anchor}"`));
  assert.ok(!/class="textbook-answer" open/u.test(html));
  const invalid = renderToStaticMarkup(React.createElement(TextbookReader, { note: { ...note, content: note.content.replace(end, '') } }));
  assert.ok(invalid.includes('边界损坏') && !invalid.includes('用户私人复述'));
});
await check('格式错误可恢复源码，不执行或静默丢弃；不合法公式也可读', () => {
  const legacyBreak = renderToStaticMarkup(React.createElement(RenderedTextbookBlock, { language: 'mermaid', code: 'flowchart LR\nV1["第一行<br/>第二行"] --> V2["第三行<br />第四行"]', manifest }));
  assert.ok(!legacyBreak.includes('暂不可展示') && !legacyBreak.includes('textbook-format-fallback'), 'reader and editable fence preview accept the recovered legacy diagram');
  const invalid = renderToStaticMarkup(React.createElement(RenderedTextbookBlock, { language: 'chart', code: '{"evil":"alert(1)"}', manifest }));
  assert.ok(invalid.includes('暂不可展示') && invalid.includes('恢复 chart 源码') && invalid.includes('alert(1)'));
  const unsafe = renderToStaticMarkup(React.createElement(RenderedTextbookBlock, { language: 'mermaid', code: 'flowchart LR\nclick A "javascript:alert(1)"', manifest }));
  assert.ok(unsafe.includes('暂不可展示') && !unsafe.includes('onclick='));
  const badMath = renderToStaticMarkup(React.createElement(formulaModule.FormulaBlock, { latex: '\\notARealCommand{', displayMode: true }));
  assert.ok(badMath.includes('公式无法渲染') && badMath.includes('notARealCommand'));
  const trustedLink = renderToStaticMarkup(React.createElement(formulaModule.FormulaBlock, { latex: '\\href{javascript:alert(1)}{bad}', displayMode: true }));
  assert.ok(!trustedLink.includes('href="javascript:'));
});
await check('来源点击调用真实深读 client 精确ID/版本/块/引用范围，不访问任务草稿', async () => {
  const previousWindow = (globalThis as any).window; const calls: unknown[] = [];
  (globalThis as any).window = { electronAPI: { ragDocs: { materialCatalog: async () => {}, materialList: async () => {}, materialPrepare: async () => {},
    materialRead: async (request: any) => { calls.push(request); return { ok: true, value: { docId: 'doc-a', version, fileName: '本地来源', targetStart: 0, targetEnd: 99,
      excerpts: [{ blockId: 'block-a', textStart: 10, textEnd: 30, text: '0123456789额外内容不可展示', kind: 'paragraph', sectionPath: '', locator: { kind: 'text', charStart: 0, charEnd: 99 } }], nextCursor: 30, truncated: true } }; },
  } } };
  try {
    const evidence = await sourceModule.readSourceEvidence(manifest.sources![0]);
    assert.equal(evidence.text, '0123456789'); assert.equal(evidence.nextCursor, undefined);
    assert.deepEqual(calls[0], { allowedDocIds: ['doc-a'], docId: 'doc-a', version, target: { kind: 'block', blockId: 'block-a', neighbors: 0 }, cursor: 10, maxChars: 128 });
    await assert.rejects(() => sourceModule.readSourceEvidence({ ...manifest.sources![0], blockId: undefined }), /精确原文定位/u);
    await assert.rejects(() => sourceModule.readSourceEvidence(manifest.sources![0], [], 25), /坐标/u);
  } finally { (globalThis as any).window = previousWindow; }
});
await check('知识点来源用稳定ID与内容版本核对，缺失/变化不冒充原文', async () => {
  const knowledge: NoteItem = { ...note, id: 'knowledge-a', noteType: 'knowledge', title: '核心概念', content: '知识点原文，不是个人复述。', textbook: undefined };
  const pointer = { sourceId: 'N1', kind: 'knowledge' as const, id: knowledge.id, title: knowledge.title,
    version: await textbookHash({ title: knowledge.title, content: knowledge.content, aliases: knowledge.aliases }) };
  assert.equal((await sourceModule.readSourceEvidence(pointer, [knowledge])).text, knowledge.content);
  await assert.rejects(() => sourceModule.readSourceEvidence(pointer, [{ ...knowledge, content: '被修改' }]), /来源已变化/u);
  await assert.rejects(() => sourceModule.readSourceEvidence(pointer, []), /已不在/u);
});
await check('教材正文首行缩进两字符、宽松行距和段距仅为显示样式，编辑器按教材边界隔离', () => {
  const css = readFileSync(new URL('../src/components/textbook/textbookReader.css', import.meta.url), 'utf8');
  const rule = css.match(/([^{}]+)\{\s*text-indent:\s*2em;\s*line-height:\s*2\.05;\s*margin-block:\s*1em;\s*\}/u);
  assert.ok(rule);
  assert.ok(rule[1].includes('.textbook-prose > p'));
  assert.ok(rule[1].includes('[data-textbook-boundary="start"] ~ p:has(~ [data-textbook-boundary="end"])'));
  assert.ok(!/\b(?:li|td|th|pre|blockquote)\b/u.test(rule[1]));
  assert.ok(css.includes('> * { text-indent: 0; }'), 'Inline math and reference internals do not inherit a second indent');
  const boundary = readFileSync(new URL('../src/components/textbook/TextbookBoundaryNode.tsx', import.meta.url), 'utf8');
  assert.ok(boundary.includes('element.dataset.textbookBoundary = this.__edge'));
  const editor = readFileSync(new URL('../src/components/MdxNoteEditor.tsx', import.meta.url), 'utf8');
  assert.ok(editor.includes("textbookManifest ? ' mdxeditor-textbook-content' : ''"));
});
await check('阅读器保留键盘、主题、reduced-motion、私有位置与选择动作边界', () => {
  const css = readFileSync(new URL('../src/components/textbook/textbookReader.css', import.meta.url), 'utf8');
  assert.ok(css.includes('focus-visible') && css.includes('prefers-reduced-motion') && css.includes('var(--ln-bg-surface)') && css.includes('.dark'));
  const source = readFileSync(new URL('../src/components/textbook/TextbookReader.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('position.revisionId !== manifest?.revisionId') && source.includes('pending.callback?.(pending.value)'));
  assert.ok(!source.includes('onUpdateNote') && !source.includes('generationJobId') && !source.includes('fetch('));
  // Structural guards supplement the real SSR/client tests and the browser rerender check.
  const componentDeclaration = source.indexOf('const textbookMarkdownComponents: Components');
  assert.ok(componentDeclaration >= 0 && componentDeclaration < source.indexOf('export function TextbookMarkdown')
    && source.includes('components={textbookMarkdownComponents}'), 'Markdown renderers remain module-level identities, not recreated on reading-progress updates');
  const flow = readFileSync(new URL('../src/components/FlowMode.tsx', import.meta.url), 'utf8');
  const questionResetEffects = [...flow.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\},\s*\[([^\]]*)\]\)/gu)]
    .filter((match) => /\bsetQuestions\s*\(/u.test(match[1]));
  const legacyReset = questionResetEffects.filter(match => match[2].trim() === 'note.id');
  assert.equal(legacyReset.length, 1, 'Legacy Flow resets question cards only when switching notes');
  assert.ok(legacyReset[0][1].includes('if (!progressiveController)'), 'legacy initialization cannot overwrite progressive questions');
  const progressiveHydration = questionResetEffects.filter(match => match[2].trim() === 'progressiveCourseId');
  assert.equal(progressiveHydration.length, 1, 'Progressive Flow has one course/archive hydration effect');
  assert.ok(progressiveHydration[0][1].includes('progressiveHydrated.current === key'), 'unchanged course/archive does not overwrite draft questions');
  assert.equal(questionResetEffects.length, legacyReset.length + progressiveHydration.length, 'personal reading-state changes introduce no additional question reset');
});
console.log(`Textbook format checks passed: ${checks} groups. SSR/schema/reader client only; native diagrams and editor interaction require browser verification.`);
