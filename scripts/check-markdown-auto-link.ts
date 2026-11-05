import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { autoLinkMarkdown, type MarkdownAutoLinkEntry } from '../src/services/markdownAutoLink';
import { autoLink } from '../src/electron/apiHandlers';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { parseControlledTextbookBlock } from '../src/services/textbook/contentSchema';
import { readTextbookBody, textbookRegionMarkers } from '../src/services/textbook/noteContent';
import { personalProjectContent, projectMaterialRows } from '../src/services/ragSourcePolicy';
import type { Nodes } from 'mdast';
import type { TextbookManifest } from '../src/services/textbook/types';
import type { NoteItem } from '../src/types';

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
  await run(); checks++; console.log(`PASS ${name}`);
}
const titles = (values: string[]): MarkdownAutoLinkEntry[] => values.map((title) => ({ token: title, target: title }));
const entries = titles(['心理账户效应', '心理账户', '账户', '选择过载', 'C++']);
const link = (content: string, values: readonly MarkdownAutoLinkEntry[] = entries) => autoLinkMarkdown(content, values);
const idempotent = (source: string, values: readonly MarkdownAutoLinkEntry[] = entries) => {
  const first = link(source, values), second = link(first.updatedContent, values);
  assert.equal(second.updatedContent, first.updatedContent, 'A second scan must not nest or rewrite existing links');
  assert.deepEqual(second.addedLinks, []);
  return first;
};
function protectedSource(content: string): Array<{ type: string; raw: string }> {
  const result: Array<{ type: string; raw: string }> = [];
  const visit = (node: Nodes) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link', 'linkReference', 'image', 'imageReference',
      'definition', 'footnoteReference'].includes(node.type)) {
      result.push({ type: node.type, raw: content.slice(node.position!.start.offset, node.position!.end.offset) });
    } else if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(parseTextbookMarkdown(content));
  return result;
}

await check('正文、标题、强调、引用、列表与表格建立双链，保留所有原始排版', () => {
  const source = ['# 心理账户', '**心理账户**与*选择过载*，~~账户~~，C++。',
    '> 心理账户', '- 心理账户\n  - 选择过载', '1. 心理账户\n2. 选择过载', '- [ ] 心理账户',
    '| 概念 | 说明 |\n| :--- | ---: |\n| 心理账户 | 选择过载 |'].join('\n\n');
  const expected = ['# [[心理账户]]', '**[[心理账户]]**与*[[选择过载]]*，~~[[账户]]~~，[[C++]]。',
    '> [[心理账户]]', '- [[心理账户]]\n  - [[选择过载]]', '1. [[心理账户]]\n2. [[选择过载]]', '- [ ] [[心理账户]]',
    '| 概念 | 说明 |\n| :--- | ---: |\n| [[心理账户]] | [[选择过载]] |'].join('\n\n');
  assert.equal(idempotent(source).updatedContent, expected);
});

await check('长标题和别名一次性最长匹配，正则字符作为字面量，不嵌套双链', () => {
  const values = [...entries, ...titles(['心理']), { token: 'Mental Accounting', target: '心理账户' },
    { token: 'Mental Accounting', target: '其他知识点' }, ...titles(['(账户)', 'A.B', 'C++'])];
  const result = idempotent('心理账户效应 心理账户 心理 账户 Mental Accounting (账户) A.B C++', values);
  assert.equal(result.updatedContent, '[[心理账户效应]] [[心理账户]] [[心理]] [[账户]] [[Mental Accounting]] [[(账户)]] [[A.B]] [[C++]]');
  assert.ok(result.addedLinks.includes('心理账户'));
  assert.ok(!result.addedLinks.includes('其他知识点'));
  assert.equal(result.addedLinks.filter((item) => item === '心理账户').length, 1);
});

await check('已有双链、别名、锚点及跨强调节点的链接整体保持不变', () => {
  const existing = '[[心理账户效应]] [[心理账户#机制|账户]] [[其他笔记|心理 *账户*]] ![[心理账户]] [[其他\n心理账户]]';
  const result = idempotent(`${existing}\n\n心理账户`);
  assert.equal(result.updatedContent, `${existing}\n\n[[心理账户]]`);
  assert.deepEqual(result.addedLinks, ['心理账户']);
  assert.equal(link('[[心理账户 尚未闭合\n\n选择过载').updatedContent, '[[心理账户 尚未闭合\n\n[[选择过载]]');
});

await check('字面方括号和转义双链不制造错误目标，附近正常文本仍可关联', () => {
  const source = '[心理账户]、\\[\\[心理账户\\]\\]，心理账户。';
  assert.equal(idempotent(source).updatedContent, '[心理账户]、\\[\\[心理账户\\]\\]，[[心理账户]]。');
});

await check('行内代码、围栏、长围栏、波浪围栏、缩进代码和嵌套列表源码不变', () => {
  const source = ['`心理账户`、``选择过载 ` 心理账户``。',
    '```python 心理账户\nprint("心理账户 选择过载")\n```',
    '~~~~mermaid\nflowchart LR\nA[心理账户] --> B[选择过载]\n~~~~',
    '````unknown 心理账户\n```\n心理账户\n```\n````',
    '    心理账户\n    选择过载',
    '- 示例\n\n  ```python\n  心理账户\n  ```',
    '> ```chart\n> {"title":"心理账户"}\n> ```',
    // An unfinished wiki opener in code must not protect unrelated later prose.
    '```text\n[[心理账户\n```', '心理账户，选择过载。'].join('\n\n');
  const result = idempotent(source);
  assert.deepEqual(protectedSource(result.updatedContent), protectedSource(source));
  assert.ok(result.updatedContent.endsWith('[[心理账户]]，[[选择过载]]。'));
  assert.equal((result.updatedContent.match(/\[\[选择过载\]\]/gu) || []).length, 1);
});

await check('行内/块公式、单行双美元模板与导入的 LaTeX 分隔符不变', () => {
  const source = ['$\\text{心理账户}+选择过载$ 与心理账户。', '$$\\text{心理账户}$$',
    '$$\n\\begin{aligned}\n心理账户 &= 选择过载 \\\\\n\\end{aligned}\n$$',
    String.raw`\(\text{心理账户}\) 和 \[选择过载\]`, '选择过载。'].join('\n\n');
  const result = idempotent(source);
  assert.deepEqual(protectedSource(result.updatedContent), protectedSource(source));
  assert.ok(result.updatedContent.includes(String.raw`\(\text{心理账户}\) 和 \[选择过载\]`));
  assert.ok(result.updatedContent.includes('与[[心理账户]]。'));
  assert.ok(result.updatedContent.endsWith('[[选择过载]]。'));
});

await check('Markdown/引用链接、URL、图片、脚注编号与教材引用编号不被改写', () => {
  const source = ['[心理账户](https://example.test/心理账户 "选择过载")', '[心理账户][账户]',
    '[账户]: https://example.test/选择过载 "心理账户"', '![心理账户](https://example.test/账户.png)',
    '<https://example.test/心理账户> https://example.test/选择过载 www.example.test/账户',
    'source:L1 file:///资料/心理账户.pdf mailto:账户@example.test',
    '来源 [L1] [N2] [123] [1, 2] [L1,N2] 与脚注[^账户]。', '[^账户]: 心理账户与选择过载。', '心理账户。'].join('\n\n');
  const values = [...entries, ...titles(['L1', 'N2', '123', '1', '2', 'source', 'file', 'mailto', 'example'])];
  const result = idempotent(source, values);
  assert.deepEqual(protectedSource(result.updatedContent), protectedSource(source));
  assert.ok(result.updatedContent.includes('来源 [L1] [N2] [123] [1, 2] [L1,N2] 与脚注[^账户]。'));
  assert.ok(result.updatedContent.includes('source:L1 file:///资料/心理账户.pdf mailto:账户@example.test'));
  assert.ok(result.updatedContent.includes('[^账户]: [[心理账户]]与[[选择过载]]。'));
});

await check('实体、转义、表格内的代码和公式保持原样，仅改可读文本', () => {
  const source = '&amp; &#123; &#x123; 心理账户\\*选择过载\\*。\n\n'
    + '| 内容 | 说明 |\n| --- | --- |\n| `心理账户` | $选择过载$ |\n| 心理账户 | 选择过载\\|账户 |';
  const values = [...entries, ...titles(['amp', '123', 'x123'])];
  const result = idempotent(source, values);
  assert.deepEqual(protectedSource(result.updatedContent), protectedSource(source));
  assert.ok(result.updatedContent.startsWith('&amp; &#123; &#x123; [[心理账户]]\\*[[选择过载]]\\*。'));
  assert.ok(result.updatedContent.endsWith('| [[心理账户]] | [[选择过载]]\\|[[账户]] |'));
  assert.equal(link('\\心理账户与\\\\选择过载').updatedContent, '\\心理账户与\\\\[[选择过载]]');
});

await check('HTML、前置元数据、MDX 控制标记与 UTF-16/CRLF 坐标保持不变', () => {
  const source = ['---', 'title: 心理账户', 'aliases: [选择过载]', '---', '',
    '<div title="心理账户">选择过载</div>', '', '<!-- 心理账户 -->', '',
    '<TextbookBoundary id="账户😀" edge="start" />', '心理账户😀选择过载。', '',
    '<LearningReviewBlock id="心理账户" />', '', '<ArgumentBlock id="选择过载" />', '',
    '<TextbookBoundary\n id={"心理账户"}\n edge="end" />', '心理账户。'].join('\r\n');
  const result = idempotent(source);
  assert.ok(result.updatedContent.startsWith('---\r\ntitle: 心理账户\r\naliases: [选择过载]\r\n---'));
  assert.ok(result.updatedContent.includes('<TextbookBoundary id="账户😀" edge="start" />\r\n[[心理账户]]😀[[选择过载]]。'));
  for (const marker of ['<LearningReviewBlock id="心理账户" />', '<ArgumentBlock id="选择过载" />',
    '<TextbookBoundary\n id={"心理账户"}\n edge="end" />']) assert.ok(result.updatedContent.includes(marker));
  assert.ok(result.updatedContent.endsWith('[[心理账户]]。'));
  assert.equal(link('---\ntitle: 心理账户').updatedContent, '---\ntitle: 心理账户');
});

await check('真实教材五类受控块在关联后仍通过原格式校验，区域边界有效', () => {
  const codes = [
    ['mermaid', 'flowchart LR\nA[心理账户] --> B[选择过载]'],
    ['chart', JSON.stringify({ title: '心理账户', type: 'bar', labels: ['选择过载'],
      series: [{ name: '账户', data: [3] }], simulated: true, sourceIds: [] })],
    ['textbook-tip', '**心理账户**与$选择过载$，引用 [L1]。'],
    ['textbook-answer', JSON.stringify({ title: '心理账户', text: '参考答案：选择过载，来源 [L1]。' })],
    ['textbook-image', JSON.stringify({ assetId: 'asset-account', caption: '心理账户' })],
  ];
  const scope = { sourceIds: ['L1'], assetIds: ['asset-account'] };
  const blocks = codes.map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\``);
  const [start, end] = textbookRegionMarkers('心理账户');
  const source = [start, '# 心理账户', '心理账户与选择过载 [L1]。', ...blocks, end,
    '<LearningReviewBlock id="账户" />'].join('\n\n');
  const result = idempotent(source);
  assert.deepEqual(protectedSource(result.updatedContent), protectedSource(source));
  for (const [index, [language, code]] of codes.entries()) {
    assert.ok(result.updatedContent.includes(blocks[index]), `${language} source stays byte-for-byte exact`);
    assert.deepEqual(parseControlledTextbookBlock(language, code, scope), parseControlledTextbookBlock(language,
      parseTextbookMarkdown(result.updatedContent).children.filter((node) => node.type === 'code')[index].value, scope));
  }
  const manifest = { regionId: '心理账户' } as TextbookManifest;
  const body = readTextbookBody(result.updatedContent, manifest);
  assert.ok(body?.startsWith('# [[心理账户]]'));
  assert.ok(body.includes('[[心理账户]]与[[选择过载]] [L1]。'));
  assert.ok(!body.includes('LearningReviewBlock'));
});

await check('只有受保护内容或没有候选词时不写入、不新增关联', () => {
  for (const source of ['', '`心理账户`', '$心理账户$', '```textbook-answer\n心理账户\n```',
    '<TextbookBoundary id="心理账户" edge="start" />', '[[心理账户]]', '[心理账户](https://example.test)']) {
    assert.deepEqual(link(source), { updatedContent: source, addedLinks: [] });
  }
  assert.deepEqual(link('心理账户', []), { updatedContent: '心理账户', addedLinks: [] });
  assert.deepEqual(link('心理账户', titles(['', ' ', '[账户]', '账户|别名', '心理\n账户'])),
    { updatedContent: '心理账户', addedLinks: [] });
});

await check('编辑器按钮与 Electron IPC 共用同一结构化关联逻辑', async () => {
  const source = '心理账户\n\n```mermaid\nflowchart LR\nA[心理账户]\n```';
  assert.deepEqual(await autoLink({ content: source, existingNoteTitles: entries.map((entry) => entry.token) }), link(source));
  const editor = readFileSync(new URL('../src/components/NoteEditor.tsx', import.meta.url), 'utf8');
  const handler = editor.slice(editor.indexOf('const handleAutoLinkScan ='), editor.indexOf('/** 展开/收起「更多」菜单'));
  assert.ok(handler.includes('autoLinkMarkdown(activeContent, matchEntries, activeNote.generatedContentBlocks)'));
  assert.ok(handler.includes('generatedContentBlocks: result.generatedContentBlocks'));
  assert.ok(!handler.includes('new RegExp(') && !handler.includes('updatedContent.replace('));
  assert.ok(handler.includes('noteType === "knowledge"'));
});

await check('AI 来源标记随相同源坐标补丁更新，用户复述仍保留且重复扫描幂等', () => {
  const ai = '心理账户属于自动生成的讲授内容。';
  const user = '我用心理账户理解自己今天的消费。';
  const source = `${ai}\n\n${user}`;
  const blocks = [ai];
  const result = autoLinkMarkdown(source, entries, blocks);
  assert.deepEqual(blocks, [ai], 'Original ownership metadata must not be mutated');
  assert.deepEqual(result.generatedContentBlocks, [ai, '[[心理账户]]属于自动生成的讲授内容。']);
  const note = { id: 'p', title: '合成项目', noteType: 'project' as const,
    content: result.updatedContent, generatedContentBlocks: result.generatedContentBlocks };
  assert.equal(personalProjectContent(note), '我用[[心理账户]]理解自己今天的消费。');
  assert.deepEqual(projectMaterialRows(note).map((row) => row.text), ['我用[[心理账户]]理解自己今天的消费。']);
  assert.deepEqual(autoLinkMarkdown(result.updatedContent, entries, result.generatedContentBlocks),
    { ...result, addedLinks: [] });
  assert.equal(personalProjectContent({ ...note, content: source }), user, 'Undo keeps the original source marker valid');
});

await check('重复来源片段使用全篇 AST 上下文，围栏与正文的标记均保留，不独立重扫片段', () => {
  const ai = '心理账户讲解与选择过载比较。';
  const source = `\`\`\`text\n${ai}\n\`\`\`\n\n${ai}\n\n我正在理解心理账户。`;
  const result = autoLinkMarkdown(source, entries, [ai, '已不存在的旧片段']);
  assert.ok(result.updatedContent.startsWith(`\`\`\`text\n${ai}\n\`\`\``));
  assert.deepEqual(result.generatedContentBlocks, [ai, '已不存在的旧片段', '[[心理账户]]讲解与[[选择过载]]比较。']);
  const remaining = personalProjectContent({ id: 'p', title: '合成项目', noteType: 'project',
    content: result.updatedContent, generatedContentBlocks: result.generatedContentBlocks });
  assert.ok(!remaining.includes('讲解与') && remaining.includes('我正在理解[[心理账户]]。'));
  assert.deepEqual(autoLinkMarkdown(source, [], [ai]).generatedContentBlocks, [ai]);
});

await check('不跨 AI 片段边界扩张归属，不从陈旧标记猜测用户文字', () => {
  const source = '心理账户效应，选择过载。';
  const result = autoLinkMarkdown(source, entries, ['心理账户']);
  assert.equal(result.updatedContent, '心理账户效应，[[选择过载]]。');
  assert.deepEqual(result.addedLinks, ['选择过载']);
  assert.deepEqual(result.generatedContentBlocks, ['心理账户']);
  const stale = autoLinkMarkdown('我自己的心理账户观点。', entries, ['旧的 AI 讲解']);
  assert.deepEqual(stale.generatedContentBlocks, ['旧的 AI 讲解']);
  assert.equal(personalProjectContent({ id: 'p', title: '项目', noteType: 'project',
    content: stale.updatedContent, generatedContentBlocks: stale.generatedContentBlocks }), '我自己的[[心理账户]]观点。');
});

await check('执行真实编辑器扫描处理器：正文、双链、AI 归属原子写入，即时索引无 AI 复述行', () => {
  const editor = readFileSync(new URL('../src/components/NoteEditor.tsx', import.meta.url), 'utf8');
  const handler = editor.slice(editor.indexOf('const handleAutoLinkScan ='), editor.indexOf('/** 展开/收起「更多」菜单'));
  const js = ts.transpileModule(`${handler}\nhandleAutoLinkScan();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const ai = '心理账户属于自动生成的讲授内容。';
  let active: NoteItem = { id: 'project', title: '合成项目', noteType: 'project',
    content: `${ai}\n\n我正在用心理账户分析自己的支出。`, generatedContentBlocks: [ai],
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z' };
  const knowledge: NoteItem = { ...active, id: 'knowledge', title: '心理账户', noteType: 'knowledge', aliases: [] };
  const noteRef = { current: active }, contentRef = { current: active.content };
  let writes = 0;
  const execute = new Function('autoLinkMarkdown', 'latestNoteRef', 'latestContentRef', 'allNotesRef',
    'showToast', 'onUpdateNote', 'setContent', 'mdxEditorRef', 'isLocalTypingRef', js);
  const update = (note: NoteItem) => {
    writes++; active = note; noteRef.current = note; contentRef.current = note.content;
    assert.deepEqual(projectMaterialRows(note).map((row) => row.text), ['我正在用[[心理账户]]分析自己的支出。']);
  };
  const scan = () => execute(autoLinkMarkdown, noteRef, contentRef, { current: [active, knowledge] },
    () => undefined, update, () => undefined, { current: null }, { current: false });
  scan();
  assert.equal(writes, 1);
  assert.deepEqual(active.links, ['心理账户']);
  assert.ok(active.generatedContentBlocks?.includes('[[心理账户]]属于自动生成的讲授内容。'));
  scan();
  assert.equal(writes, 1, 'Idempotent scan must not write or reindex');
});

console.log(`\nMarkdown auto-link checks passed: ${checks}`);
