import assert from 'node:assert/strict';
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { parseTextbookReferences, parseControlledTextbookBlock } from '../src/services/textbook/contentSchema';
import { assembleTextbook, validateTextbookContent, validateChapter } from '../src/services/textbook/validation';
import { parseTextbookMarkdown, remarkTextbookReferences, textbookSections } from '../src/services/textbook/markdown';
import { textbookRegionMarkers, readTextbookBody } from '../src/services/textbook/noteContent';
import { autoLinkMarkdown } from '../src/services/markdownAutoLink';
import { buildTextbookReferenceChunks } from '../src/electron/rag/textbookReferenceChunks';
import type { NoteItem } from '../src/types';
import type { TextbookManifest } from '../src/services/textbook/types';
import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookJob, TextbookSource } from '../src/services/textbook/generationTypes';
import type { TextbookReaderProps, TextbookBlockProps } from '../src/components/textbook/TextbookReader';

globalThis.fetch = async () => assert.fail('References checks must not access the network');
const sources: TextbookSource[] = [{ sourceId: 'N1', kind: 'knowledge', id: 'k1', title: '条件与适用范围', version: 'a'.repeat(64), text: '判断结论必须保留成立条件。' },
  { sourceId: 'L1', kind: 'document', id: 'doc1', title: '公式 List<T> 与 <安全的标题文本>', version: 'b'.repeat(64), text: '公式与教学示例均须保留假设。', locator: { page: 2 } as never },
  { sourceId: 'N2', kind: 'knowledge', id: 'unused', title: '未引用资料', version: 'c'.repeat(64), text: '这条没有进入教学蓝图。' }];
const blueprint: TeachingBlueprint = { title: '参考资料折叠测试', objectives: [{ id: 'O1', text: '核对条件并判断结论' }], focuses: [],
  chapters: [1, 2].map(i => ({ id: `ch${i}`, title: `教学步骤${i}`, objectiveIds: ['O1'], focusIds: [], sourceIds: ['N1', 'L1'], bridge: '先看条件，再解释结论。' })) };
const chapters: TextbookChapter[] = blueprint.chapters.map(plan => ({ id: plan.id, sections: {
  explanation: '解释结论前先核对条件，不省略影响结论的假设。[N1]', boundaries: '应区分已知条件与未知信息，不能自行补造条件。[N1]',
  workedExample: '假设情境中先列已知信息，再判断可以支持的结论。[L1]', practice: '请根据一个新情境列出已知条件，并说明仍需核对哪些信息。',
  answer: '先检查条件，再依据假设判断，不把未知信息当作事实。[N1]', selfCheck: '能够说明结论依据，而不是只背诵一个没有条件的结论。', summary: '本章从条件核对进入结论判断，保留尚未知的信息。',
} }));
const context: TextbookContext = { project: { id: 'p', rootId: 'r', title: blueprint.title, rootTitle: '测试计划', tasks: ['核对条件'], knowledgeTitles: [] }, profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] };
const job: TextbookJob = { schemaVersion: 1, id: 'references-fixture', stage: 'validating', attempt: 1, createdAt: '', updatedAt: '',
  spec: { schemaVersion: 1, projectNoteId: 'p', rootProjectId: 'r', projectTitle: blueprint.title, planningHash: '', allowedDocIds: ['doc1'], documentHashes: {}, knowledgeHashes: { k1: sources[0].version, unused: sources[2].version }, providerHash: '', allowCloud: false },
  checkpoint: { context, sources, blueprint, chapters } };
const manifest: TextbookManifest = { schemaVersion: 1, textbookId: 'book', projectNoteId: 'p', rootProjectId: 'r', revisionId: 'rev', regionId: 'region', createdAt: '', updatedAt: '',
  sources: sources.slice(0, 2).map(({ text, ...pointer }) => pointer), chapters: blueprint.chapters.map(({ id, title }) => ({ id, title })) };
const wrapNote = (body: string): NoteItem => {
  const [start, end] = textbookRegionMarkers('region');
  return { id: 'p', noteType: 'project', title: blueprint.title, content: `${start}\n\n${body}\n\n${end}`, textbook: manifest, tags: [], links: [], backlinks: [], createdAt: '', updatedAt: '' } as NoteItem;
};
let groups = 0; const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
const body = assembleTextbook(blueprint, chapters, sources);
const node = parseTextbookMarkdown(body).children.find(node => node.type === 'code' && node.lang === 'textbook-references');
assert.ok(node?.type === 'code');
const references = parseTextbookReferences(node.value, { sourceIds: ['L1', 'N1'] });
assert.equal(references.entries.length, 2); assert.ok(!body.includes('未引用资料'));
assert.deepEqual(references.entries.map(entry => entry.sourceId), ['N1', 'L1']);
assert.ok(references.entries[1].title.includes('List<T>') && references.entries[1].detail.includes('版本'));
assert.deepEqual(parseControlledTextbookBlock('textbook-references', node.value, { sourceIds: ['N1', 'L1'] }), references);
validateTextbookContent(job, body);
pass('正式组装只折叠实际引用来源，保留编号、完整标题、定位和版本，不增加模型调用');

for (const code of [JSON.stringify({ entries: [] }), JSON.stringify({ ...references, open: true }),
  JSON.stringify({ entries: [...references.entries, references.entries[0]] }), JSON.stringify({ entries: [{ ...references.entries[0], sourceId: 'N999' }] }),
  JSON.stringify({ entries: [{ ...references.entries[0], href: 'javascript:alert(1)' }] }), JSON.stringify({ entries: [{ ...references.entries[0], detail: {} }] })]) {
  assert.throws(() => parseTextbookReferences(code, { sourceIds: ['N1', 'L1'] }));
}
const privateBlock = JSON.stringify({ entries: [{ sourceId: 'N1', title: '个人证据 [C1]', detail: '不得把私人证据编号隐藏在格式块中。' }] }).replace('[C1]', '\\u005bC1\\u005d');
const rejected = structuredClone(chapters[0]); rejected.sections.explanation += '\n\n```textbook-references\n' + privateBlock + '\n```';
assert.throws(() => validateChapter(rejected, rejected.id, ['N1', 'L1']), /个人记录/u);
pass('白名单、重复编号、非法字段和解码后的私人证据校验仍生效，不开放任意链接或渲染选项');

const many = { entries: Array.from({ length: 100 }, (_, i) => ({ sourceId: `L${i + 1}`, title: `条目${i + 1}`, detail: `公开资源正文；https://example.test/${i}；版本 abc123` })) };
assert.equal(parseTextbookReferences(JSON.stringify(many)).entries.length, 100);
const linked = autoLinkMarkdown(node.value ? '```textbook-references\n' + node.value + '\n```' : '', [{ token: '条件', target: '条件' }]);
assert.equal(linked.updatedContent, '```textbook-references\n' + node.value + '\n```');
pass('100条来源仍完整保留，自动双链跳过参考资料源码，不改变编号和链接地址');

const referenceChunks = buildTextbookReferenceChunks({ noteId: 'p', title: blueprint.title, textbookId: 'book', revisionId: 'rev', regionId: 'region', body });
const bibliographyChunks = referenceChunks.filter(chunk => chunk.content.includes('textbook-references'));
assert.ok(bibliographyChunks.length && bibliographyChunks.every(chunk => chunk.sectionKind === 'sources'));
assert.ok(referenceChunks.every(chunk => body.slice(chunk.textStart, chunk.textEnd) === chunk.content));
pass('RAG仍将末尾块识别为来源而非知识论断，教材正文原文坐标保持准确');

const plain = assembleTextbook(blueprint, chapters, sources, { references: 'plain' });
assert.ok(plain.includes('## 资料来源\n\n- [N1]'));
validateTextbookContent(job, plain);
assert.throws(() => validateTextbookContent(job, plain.replace('条件与适用范围；', '被篡改的来源；')), /不一致/u);
pass('旧草稿的普通参考列表仍可校验和恢复，仅接受两种确定性组装结果，不放宽正文一致性');

const original = wrapNote(plain); const unchanged = original.content;
const tree = parseTextbookMarkdown(plain); const sections = textbookSections(plain, manifest);
remarkTextbookReferences({ manifest, sections })(tree);
const folded = tree.children.find(node => node.type === 'blockquote' && node.data?.hName === 'details');
assert.ok(folded?.type === 'blockquote');
assert.equal(folded.children[0].data!.hProperties!.id, sections.at(-1)!.anchor);
assert.equal(original.content, unchanged); assert.equal(readTextbookBody(original.content, manifest), plain);
for (const raw of ['## 资料来源\n\n- [N999] 未授权来源', '## 资料来源\n\n- [N1] 来源\n\n这里仍是正文，不要隐藏。', '```text\n## 资料来源\n- [N1] 只是代码\n```']) {
  const untouched = parseTextbookMarkdown(raw); remarkTextbookReferences({ manifest })(untouched);
  assert.ok(!untouched.children.some(node => node.type === 'blockquote' && node.data?.hName === 'details'));
}
pass('旧教材仅在阅读时折叠末尾授权参考列表，目录锚点保留；正文、同名章节和代码示例不误折叠，旧笔记不改写');

const bundle = await build({ entryPoints: ['src/components/textbook/TextbookReader.tsx'], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.css': 'empty' }, logLevel: 'silent', plugins: [{ name: 'native-externals', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => args.kind === 'entry-point' ? undefined : { path: import.meta.resolve(args.path), external: true }); } }] });
const { TextbookReader, RenderedTextbookBlock } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')) as {
  TextbookReader: ComponentType<TextbookReaderProps>; RenderedTextbookBlock: ComponentType<TextbookBlockProps>;
};
for (const markdown of [body, plain]) {
  const html = renderToStaticMarkup(React.createElement(TextbookReader, { note: wrapNote(markdown) }));
  assert.ok(/<details class="textbook-references[^"]*">/u.test(html));
  assert.ok(!/<details[^>]*class="textbook-references[^>]*\bopen(?:=|[ >])/u.test(html));
  assert.ok(html.includes('参考资料（共 2 条）') && html.includes('查看来源 N1') && html.includes('查看来源 L1'));
  assert.ok(html.includes('List&lt;T&gt;') && !html.includes('<安全的标题文本>'));
  assert.ok(!html.includes('格式块暂不可展示'));
}
const escaped = renderToStaticMarkup(React.createElement(RenderedTextbookBlock, { language: 'textbook-references', code: JSON.stringify({ entries: [{ sourceId: 'N1', title: '<img src=x onerror=alert(1)>', detail: 'https://example.test 不自动访问' }] }), manifest }));
assert.ok(escaped.includes('&lt;img') && !escaped.includes('<img') && !escaped.includes('<a href="https://'));
pass('真实阅读/编辑预览共用原生details，默认收起、数量准确、来源按钮保留；标题按文本转义、不自动打开URL');

const css = readFileSync('src/components/textbook/textbookReader.css', 'utf8');
assert.ok(css.includes('.textbook-references > summary:focus-visible') && css.includes('min-height: 44px'));
assert.ok(css.includes('.textbook-reference-entry') && css.includes('overflow-wrap: anywhere'));
const editor = readFileSync('src/components/textbook/TextbookCodeEditor.tsx', 'utf8');
assert.ok(editor.includes("'textbook-references': '参考资料'"));
pass('项目笔记编辑器注册同一受控块，支持键盘焦点、明暗主题和长地址换行，无新依赖');
console.log(`textbook references: ${groups} groups passed; synthetic SSR/AST/source checks, no model/network/user vault`);
