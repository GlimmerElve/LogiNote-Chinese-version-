import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// Compile the actual React/Lexical nodes, stripping styles only. No browser, vault or model is involved.
if (!process.env.LOGINOTE_EDITOR_TEST_BUNDLE) {
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const cacheRoot = path.join(workspace, 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, 'textbook-editor-check-'));
  try {
    const outfile = path.join(temporary, 'check.mjs');
    await build({ entryPoints: [fileURLToPath(import.meta.url)], outfile, bundle: true,
      platform: 'node', format: 'esm', target: 'node22', packages: 'external', loader: { '.css': 'empty' },
      plugins: [{ name: 'headless-styles', setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'empty-style' }));
        builder.onLoad({ filter: /.*/, namespace: 'empty-style' }, () => ({ contents: '', loader: 'js' }));
      } }],
      define: { 'process.env.LOGINOTE_EDITOR_TEST_BUNDLE': '"1"',
        'process.env.LOGINOTE_EDITOR_TEST_ROOT': JSON.stringify(workspace) }, logLevel: 'silent' });
    await import(pathToFileURL(outfile).href);
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(cacheRoot) + path.sep));
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  globalThis.fetch = async () => assert.fail('Editor compatibility checks must not access the network');
  const { mdxNoteContentPlugins } = await import('../src/components/mdxNoteContentPlugins');
  const { prepareMarkdownForMdx } = await import('../src/services/markdownMdxCompatibility');
  const { assertMdxNoteImportable, insertMdxMarkdownSafely, prepareMdxEditorInput, MdxNoteCompatibilityError } = await import('../src/components/mdxNotePreflight');
  const { mdxMarkdownCompatibilityPlugin } = await import('../src/components/MdxMarkdownCompatibilityPlugin');
  const workspace = process.env.LOGINOTE_EDITOR_TEST_ROOT!;
  const library = (name: string) => import(pathToFileURL(path.join(workspace, 'node_modules/@mdxeditor/editor/dist', name)).href);
  const [{ Realm }, lexical, mdx, core, importer, exporter, mathNodes, footnotes, codeEditors, mathSyntax, mathAst, gfmSyntax, gfmAst, mdast] = await Promise.all([
    import('@mdxeditor/gurx'), import('lexical'), import('@mdxeditor/editor'), library('plugins/core/index.js'),
    library('importMarkdownToLexical.js'), library('exportMarkdownFromLexical.js'),
    import('../src/components/MathNode'), import('../src/components/textbook/TextbookFootnoteNode'),
    import('../src/components/textbook/TextbookCodeEditor'), import('micromark-extension-math'),
    import('mdast-util-math'), import('micromark-extension-gfm'), import('mdast-util-gfm'), import('mdast-util-from-markdown'),
  ]);
  const realm = new Realm();
  const plugins = [core.corePlugin({ initialMarkdown: '', onChange: () => {}, onError: () => {}, trim: false }),
    ...mdxNoteContentPlugins(), mdxMarkdownCompatibilityPlugin()];
  for (const plugin of plugins) plugin.init?.(realm);
  const editor = lexical.createEditor({ namespace: 'textbook-roundtrip-test',
    nodes: realm.getValue(core.usedLexicalNodes$), onError(error: Error) { throw error; } });
  realm.pub(core.rootEditor$, editor);
  const parse = (markdown: string) => mdast.fromMarkdown(markdown, {
    extensions: [gfmSyntax.gfm(), mathSyntax.math()], mdastExtensions: [gfmAst.gfmFromMarkdown(), mathAst.mathFromMarkdown()],
  });
  const clean = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'position' || key === 'data' ? undefined : item));
  const importSource = (markdown: string) => editor.update(() => {
    lexical.$getRoot().clear();
    importer.importMarkdownToLexical({ root: lexical.$getRoot(), markdown,
      visitors: realm.getValue(core.importVisitors$), syntaxExtensions: realm.getValue(core.syntaxExtensions$),
      mdastExtensions: realm.getValue(core.mdastExtensions$),
      codeBlockEditorDescriptors: realm.getValue(core.codeBlockEditorDescriptors$),
      defaultCodeBlockLanguage: realm.getValue(core.defaultCodeBlockLanguage$),
    });
  }, { discrete: true });
  const exportSource = () => editor.getEditorState().read(() => exporter.exportMarkdownFromLexical({
    root: lexical.$getRoot(), visitors: realm.getValue(core.exportVisitors$),
    toMarkdownExtensions: realm.getValue(core.toMarkdownExtensions$), toMarkdownOptions: {},
    jsxComponentDescriptors: [], jsxIsAvailable: false,
  }));
  const multiline = String.raw`\begin{aligned}
a &= b + c \\
d &= \frac{1}{2}
\end{aligned}`;
  const fixture = [
    '# 多格式教材',
    '行内公式 $E=mc^2$，转义 \\$不是公式\\$，代码 `$code$`，脚注[^note]。',
    '$$\n' + multiline + '\n$$',
    '```mermaid stable-diagram\nflowchart LR\nA[输入] --> B[结果]\n```',
    '```chart\n{"type":"bar","title":"教学示例","dataKind":"example","labels":["A"],"series":[{"name":"值","values":[3]}]}\n```',
    '```textbook-tip\n先检查适用条件。\n```',
    '```textbook-answer\n参考答案：$a+b$。\n```',
    '```textbook-references\n' + JSON.stringify({ entries: [{ sourceId: 'L1', title: '教材 List<T> 与公式', detail: '公开资源正文；https://example.test/paper；版本 abc123' }] }) + '\n```',
    '```textbook-image\n{"assetId":"local-asset-1","alt":"教材插图"}\n```',
    '```function-plot\n{"title":"平方函数面积","variable":"x","xLabel":"x","yLabel":"y","xDomain":[0,2],"yDomain":[0,4],"curves":[{"id":"f","label":"平方函数","expression":"x^2"}],"area":{"curveId":"f","from":0,"to":2},"riemann":{"curveId":"f","from":0,"to":2,"count":8,"method":"midpoint"}}\n```',
    '```unknown-language future-format\n<script>this is preserved source, never executed</script>\n  original indentation\n```',
    '[^note]: 第一段 **加粗**、~~删除线~~ 和 $a+b$。\n\n    第二段保留缩进。\n\n    | 参数 | 值 |\n    | --- | --- |\n    | x | 1 |',
  ].join('\n\n');
  importSource(fixture);
  const saved = exportSource();
  assert.deepEqual(clean(parse(saved)), clean(parse(fixture)), 'The actual MDX importer/exporter keeps each format and footnote structure');
  assert.match(saved, /\$\$\n\\begin\{aligned\}/);
  assert.match(saved, /```unknown-language future-format/);
  const firstState = editor.getEditorState().toJSON();
  const serialized = JSON.stringify(firstState);
  assert.match(serialized, /"displayMode":true/);
  assert.match(serialized, /"displayMode":false/);
  assert.match(serialized, /"type":"textbookFootnote"/);
  assert.match(serialized, /"type":"table"/);
  importSource(saved);
  assert.deepEqual(clean(parse(exportSource())), clean(parse(saved)), 'Saving and reopening does not lose formulas, metadata or footnotes');
  assert.ok(codeEditors.textbookCodeEditorDescriptor.match('function-plot', undefined));
  assert.ok(codeEditors.textbookCodeEditorDescriptor.match('textbook-references', undefined));
  console.log('PASS real MDX/Lexical import → export → reopen: multiline/inline math, seven textbook fences including references/function/area/Riemann, unknown code and rich GFM footnotes');

  // Simulate the same node mutations used by MathLive and controlled source editors.
  editor.update(() => {
    for (const node of lexical.$getRoot().getChildren()) {
      if (mathNodes.$isMathNode(node)) node.replace(mathNodes.$createMathNode(String.raw`\begin{aligned}x&=2\\y&=3\end{aligned}`, true));
      if (mdx.$isCodeBlockNode(node) && node.getLanguage() === 'chart') node.setCode('{ invalid JSON is recoverable source }');
      if (node instanceof footnotes.TextbookFootnoteNode && node.__ast.type === 'footnoteDefinition') {
        node.replace(new footnotes.TextbookFootnoteNode(footnotes.parseFootnoteDefinition('[^note]: 用户修改的脚注 $x=2$。', 'note')));
      }
    }
  }, { discrete: true });
  const edited = exportSource();
  importSource(edited);
  assert.match(exportSource(), /invalid JSON is recoverable source/);
  assert.match(exportSource(), /用户修改的脚注/);
  assert.match(exportSource(), /x&=2/);
  assert.throws(() => footnotes.parseFootnoteDefinition('[^other]: 串号。', 'note'), /脚注编号/);
  console.log('PASS edited formula/chart/footnote → save → reopen; invalid chart source stays recoverable and footnote identity is enforced');

  // Restore a serialized editor state, matching Lexical reload rather than a markdown-only parser check.
  const restored = editor.parseEditorState(firstState);
  editor.setEditorState(restored);
  assert.deepEqual(clean(parse(exportSource())), clean(parse(saved)));
  console.log('PASS serialized Lexical state restores every math/code/footnote payload');

  importSource('$$legacy=1$$');
  assert.ok(editor.getEditorState().toJSON().root.children.some((node: any) => node.type === 'math' && node.displayMode), JSON.stringify(editor.getEditorState().toJSON()));
  assert.match(exportSource(), /\$\$\nlegacy=1\n\$\$/, 'Existing single-line toolbar templates remain display formulas');
  importSource('键入 ');
  editor.update(() => {
    const paragraph = lexical.$getRoot().getFirstChild();
    assert.ok(lexical.$isElementNode(paragraph));
    const text = paragraph.getFirstChild();
    assert.ok(lexical.$isTextNode(text)); text.setTextContent('键入 $x');
  }, { discrete: true });
  editor.update(() => {
    const paragraph = lexical.$getRoot().getFirstChild();
    assert.ok(lexical.$isElementNode(paragraph));
    const text = paragraph.getFirstChild();
    assert.ok(lexical.$isTextNode(text)); text.setTextContent('键入 $x$');
  }, { discrete: true });
  assert.match(JSON.stringify(editor.getEditorState().toJSON()), /"tex":"x"/);
  console.log('PASS legacy display templates and newly typed inline formulas keep the existing editor behavior');

  const broken = '由条件得到 k>0.1 且 k<1/9≈0.1111，不能省略参数边界。';
  assert.throws(() => mdast.fromMarkdown(broken, { extensions: realm.getValue(core.syntaxExtensions$) as any[], mdastExtensions: realm.getValue(core.mdastExtensions$) as any[] }), /Unexpected character `1`/);
  const compatible = prepareMarkdownForMdx(broken);
  assert.equal(compatible.markdown, broken.replace('<', '\\<'));
  assert.equal(compatible.patches.length, 1);
  assert.deepEqual(clean(parse(compatible.markdown)), clean(parse(broken)), 'Escaping preserves ordinary Markdown meaning');
  assertMdxNoteImportable(broken);
  assert.equal(prepareMdxEditorInput(broken), compatible.markdown);
  const partiallyFixable = broken + '\n\n<UnknownWidget />';
  assert.equal(prepareMdxEditorInput(partiallyFixable), partiallyFixable, 'Unresolved input retains exact original source, not a partially normalized version');
  importSource(compatible.markdown);
  const inequalitySaved = exportSource();
  importSource(inequalitySaved);
  assert.deepEqual(clean(parse(exportSource())), clean(parse(broken)));
  console.log('PASS exact screenshot failure → local escape → actual MDX import → save → reopen, with unchanged mathematical text');

  const controls = '<TextbookBoundary id="book-test" edge="start" />\n' + broken + '\n\n'
    + '<LearningReviewBlock id="review-test" />\n\n<ArgumentBlock id="arg-test" />\n\n'
    + '<TextbookBoundary id="book-test" edge="end" />';
  const mixed = controls + '\n\n' + fixture + '\n\n| 比较 | 条件 |\n| --- | --- |\n| 参数 | k<1/9 |\n\n- **边界**：x<2\n\n> 判断 y<3';
  const protectedBook = prepareMarkdownForMdx(mixed);
  assert.equal(protectedBook.patches.length, 4);
  const payloads = (markdown: string) => {
    const result: string[] = [];
    const visit = (node: any) => {
      if (['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) result.push(JSON.stringify(clean(node)));
      node.children?.forEach(visit);
    }; visit(parse(markdown)); return result;
  };
  assert.deepEqual(payloads(protectedBook.markdown), payloads(mixed), 'All formula/code/diagram JSON and fence payloads are exact');
  for (const marker of controls.match(/<[^>]+\/>/gu)!) assert.ok(protectedBook.markdown.includes(marker));
  assertMdxNoteImportable(mixed);
  importSource(protectedBook.markdown);
  const mixedSaved = exportSource();
  for (const marker of controls.match(/<[^>]+\/>/gu)!) assert.ok(mixedSaved.includes(marker), marker);
  assert.deepEqual(payloads(mixedSaved), payloads(protectedBook.markdown));
  importSource(mixedSaved);
  assert.deepEqual(payloads(exportSource()), payloads(mixedSaved));
  console.log('PASS no-blank-line boundary, review/argument blocks, prose/list/table/quote, math and every diagram payload survive normalization and reopening');

  for (const escaped of [String.raw`a\<1`, String.raw`a\\<1`, String.raw`a\\\<1`, '中文与😀：值<2', '值&lt;2', '集合 {1, 2}']) {
    const first = prepareMarkdownForMdx(escaped);
    assert.equal(prepareMarkdownForMdx(first.markdown).markdown, first.markdown);
    assert.equal(prepareMarkdownForMdx(first.markdown).patches.length, 0);
    assert.deepEqual(clean(parse(first.markdown)), clean(parse(escaped)));
    assertMdxNoteImportable(first.markdown);
  }
  const generic = prepareMarkdownForMdx('程序中的 List<T> 类型与值<2 是不同概念。');
  assert.equal(generic.markdown, String.raw`程序中的 List\<T> 类型与值\<2 是不同概念。`);
  assertMdxNoteImportable(generic.markdown);
  console.log('PASS escaped/already-escaped less-than, UTF-16 offsets, entities, literal braces and bounded generic notation are idempotent');

  for (const autolink of ['<https://example.com/a?q=1&b=2>', '<a@example.com>', '<https://example.com/a_(b)>']) {
    const normalized = prepareMarkdownForMdx(autolink);
    assert.equal(normalized.patches[0]?.kind, 'autolink');
    assert.deepEqual(clean(parse(normalized.markdown)), clean(parse(autolink)));
    assertMdxNoteImportable(normalized.markdown);
    importSource(normalized.markdown);
    assert.deepEqual(clean(parse(exportSource())), clean(parse(autolink)));
  }
  const opaque = ['已有 [[知识<1]] 与 $x<2$，`y<3`。', String.raw`传统公式 \(x<1\) 和 \[y<2\]`,
    '---\ntitle: 值<1\n---\n', '```text\n\\(\n```\n\n正文<1', '[链接](https://example.com/"x")'];
  for (const source of opaque.slice(0, 3)) assert.equal(prepareMarkdownForMdx(source).markdown, source);
  assert.ok(prepareMarkdownForMdx(opaque[3]).markdown.endsWith(String.raw`正文\<1`), 'An opener in code must not mask later prose');
  assert.equal(prepareMarkdownForMdx(opaque[4]).markdown, opaque[4]);
  console.log('PASS autolinks keep link semantics/URLs; existing wiki links, legacy formula delimiters, frontmatter, code and link destinations are not rewritten');

  for (const bad of ['# 标题\n\n<UnknownWidget />', '# 标题\n\n<span broken', '<LearningReviewBlock />', '<TextbookBoundary id="bad" edge="broken" />',
    '| 内容 |\n| --- |\n| <UnknownWidget /> |', '| 内容 |\n| --- |\n| <LearningReviewBlock /> |', '正文<T>']) {
    assert.equal(prepareMarkdownForMdx(bad).markdown, bad);
    assert.throws(() => assertMdxNoteImportable(bad), (error: unknown) => error instanceof MdxNoteCompatibilityError
      && /原文与已生成章节保留/.test(error.message));
  }
  assert.throws(() => assertMdxNoteImportable('# 标题\n\n<UnknownWidget />'), (error: unknown) => error instanceof MdxNoteCompatibilityError && error.line === 3);
  console.log('PASS unsupported JSX/malformed control blocks fail locally with source retained, actionable location and no guessed sanitization');

  // Exercise the real core source-mode transition (not just a helper call).
  realm.pub(core.viewMode$, 'source');
  realm.pub(core.markdownSourceEditorValue$, broken);
  realm.pub(core.viewMode$, 'rich-text');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(realm.getValue(core.markdownProcessingError$), null);
  assert.deepEqual(clean(parse(exportSource())), clean(parse(broken)));
  realm.pub(core.setMarkdown$, '<UnknownWidget />');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((realm.getValue(core.markdownProcessingError$) as { source: string } | null)?.source, '<UnknownWidget />');
  realm.pub(core.setMarkdown$, '<LearningReviewBlock />');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((realm.getValue(core.markdownProcessingError$) as { source: string } | null)?.source, '<LearningReviewBlock />', 'Plain visitor failures must preserve source rather than crash the editor');
  assert.throws(() => assertMdxNoteImportable('# 标题\n\n<LearningReviewBlock />'), (error: unknown) => error instanceof MdxNoteCompatibilityError && error.line === 3);
  const unknownCell = '| 内容 |\n| --- |\n| <UnknownWidget /> |';
  realm.pub(core.setMarkdown$, unknownCell);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((realm.getValue(core.markdownProcessingError$) as { source: string } | null)?.source, unknownCell, 'Invalid nested table content is detected before rendering, not in a later child editor');
  realm.pub(core.setMarkdown$, broken);
  realm.pub(core.setMarkdown$, '刚切换到另一份新笔记。');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(exportSource(), /刚切换到另一份新笔记/);
  assert.doesNotMatch(exportSource(), /k/);
  console.log('PASS actual source → rich-text recovery, unknown-source retention and stale recovery callback cannot overwrite new content');

  const inserted: string[] = [], rejected: Array<string | null> = [];
  assert.equal(insertMdxMarkdownSafely('<UnknownWidget />', value => inserted.push(value), value => rejected.push(value)), false);
  assert.deepEqual(inserted, []); assert.deepEqual(rejected, ['<UnknownWidget />']);
  assert.match(exportSource(), /刚切换到另一份新笔记/);
  assert.equal(insertMdxMarkdownSafely('值<1', value => inserted.push(value), value => rejected.push(value)), true);
  assert.deepEqual(inserted, [String.raw`值\<1`]); assert.equal(rejected.at(-1), null);
  console.log('PASS invalid fragment insertion is rejected before any document mutation and preserves its original source; valid fragments use the local patch');

  const editorComponent = readFileSync(path.join(workspace, 'src/components/MdxNoteEditor.tsx'), 'utf8');
  assert.match(editorComponent, /markdown=\{compatibleContent\}/);
  assert.match(editorComponent, /setMarkdown\(compatibleContent\)/);
  assert.match(editorComponent, /setMarkdown: \(md: string\) => \{\s*const prepared = prepareMdxEditorInput\(md\);[\s\S]*?editorRef\.current\?\.setMarkdown\(prepared\)/);
  assert.match(editorComponent, /insertMdxMarkdownSafely\(md, prepared => editorRef\.current\?\.insertMarkdown\(prepared\)/);
  const appSource = readFileSync(path.join(workspace, 'src/App.tsx'), 'utf8');
  const textbookWriter = appSource.slice(appSource.indexOf('publishTextbook: async (input)'), appSource.indexOf('openTextbookProject:'));
  assert.match(textbookWriter, /preflightMarkdown: async \(markdown\) =>[\s\S]*?assertMdxNoteImportable\(markdown\)/);
  const publisher = readFileSync(path.join(workspace, 'src/services/textbook/publication.ts'), 'utf8');
  assert.ok(publisher.indexOf('writer.preflightMarkdown?.(published.content)') < publisher.indexOf('await writer.saveNotes(next)'));
  console.log('PASS initial load, external refill, set/insert handles and production pre-save entry are all wired to the compatibility layer');

  const { preparePublishedTextbookEdit } = await import('../src/services/textbook/editing');
  const { writeTextbookRegion } = await import('../src/services/textbook/noteContent');
  const editedBookBody = '# 合成教材\n\n## 1. 函数与阶段\n\n讲解正文已有来源。[L1]\n\n$$\nf(x)=x^2\n$$\n\n```mermaid\ntimeline\n阶段一 : 理解条件\n阶段二 : 对照案例\n```';
  const editNote = writeTextbookRegion({ id: 'edit-preflight', title: '局部编辑检查', noteType: 'project', content: '笔记备注。\n\n<LearningReviewBlock id="review-preserved" />',
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-19', updatedAt: '2026-10-19' }, editedBookBody,
    { schemaVersion: 1, textbookId: 'book', projectNoteId: 'edit-preflight', rootProjectId: 'edit-preflight', revisionId: 'base', regionId: 'edit-region', createdAt: '2026-10-19', updatedAt: '2026-10-19',
      sources: [{ sourceId: 'L1', kind: 'document', id: 'synthetic-doc', title: '合成资料', version: 'a'.repeat(64) }] });
  const patched = preparePublishedTextbookEdit([editNote], { projectNoteId: editNote.id, expectedRevisionId: 'base',
    replacements: [{ oldText: 'f(x)=x^2', newText: 'f(x)=x^3' }, { oldText: '阶段二 : 对照案例', newText: '阶段二 : 核对适用边界' }],
    appendText: '### 补充说明\n\n仅作假设例子，值<1不代表实际研究结果。[L1]' });
  assertMdxNoteImportable(patched.after[0].content);
  assert.ok(patched.after[0].content.includes('f(x)=x^3') && patched.after[0].content.includes('timeline\n阶段一'));
  assert.ok(patched.after[0].content.includes('<LearningReviewBlock id="review-preserved" />'));
  assert.ok(patched.after[0].content.includes('值\\<1'));
  console.log('PASS real published textbook patch → formula/timeline/less-than prose → full Lexical import, preserving private review marker');
}
