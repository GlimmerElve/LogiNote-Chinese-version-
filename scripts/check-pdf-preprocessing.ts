import assert from 'node:assert/strict';
import { normalizePdfReadingText, preprocessPdfBlocks, type PdfRawBlock } from '../src/electron/pdfPreprocessing.ts';
import { buildStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { chunkStructuredDocument } from '../src/electron/rag/chunking.ts';

const raw: PdfRawBlock[] = [
  {
    id: 'p1:b0', page: 1, blockIndex: 0, bbox: [30, 80, 520, 120], pageHeight: 800,
    kind: 'paragraph', rawText: 'Duxbury 的研究结\n果与本研究', text: 'Duxbury 的研究结\n果与本研究',
  },
  {
    id: 'p1:b1', page: 1, blockIndex: 1, bbox: [30, 130, 520, 260], pageHeight: 800,
    tableIndex: 0, kind: 'table', rawText: '条件\t均值\nA\t3.2',
    text: '| 条件 | 均值 |\n| --- | --- |\n| A | 3.2 |',
  },
  {
    id: 'p1:b2', page: 1, blockIndex: 2, bbox: [30, 270, 520, 310], pageHeight: 800,
    kind: 'paragraph', rawText: '相同，其中差异主要来自条件设置。', text: '相同，其中差异主要来自条件设置。',
  },
  {
    id: 'p1:b3', page: 1, blockIndex: 3, bbox: [30, 720, 520, 750], pageHeight: 800,
    kind: 'paragraph', rawText: '注：该数值仅用于演示。', text: '注：该数值仅用于演示。',
  },
  {
    id: 'p2:b0', page: 2, blockIndex: 0, bbox: [30, 60, 520, 100], pageHeight: 800,
    kind: 'paragraph', rawText: '乱码���份保持原样。', text: '乱码���份保持原样。',
  },
];

assert.equal(normalizePdfReadingText('心理账户系\n统的构成', 'paragraph'), '心理账户系统的构成');
const result = preprocessPdfBlocks(raw, 'test-engine');
assert.equal(result.metadata.rawBlockCount, 5);
assert.equal(result.metadata.sourceCoverage, 1);
assert.ok(result.metadata.issues.some((issue) => issue.code === 'table_interruption'));
assert.ok(result.metadata.issues.some((issue) => issue.code === 'suspicious_character'));

const merged = result.blocks.find((block) => block.sourceFragments.length === 2);
assert.ok(merged);
assert.equal(merged?.text, 'Duxbury 的研究结果与本研究相同，其中差异主要来自条件设置。');
assert.deepEqual(merged?.sourceFragments.map((fragment) => fragment.locator.kind === 'pdf'
  ? [fragment.locator.page, fragment.locator.blockIndex] : []), [[1, 0], [1, 2]]);
assert.equal(result.blocks.filter((block) => block.kind === 'table').length, 1, '表格必须独立保留');
assert.equal(result.blocks.find((block) => block.sourceFragments[0].rawText.startsWith('注：'))?.kind, 'notes');

const completeSentence = preprocessPdfBlocks([
  { id: 'a', page: 1, blockIndex: 0, kind: 'paragraph', rawText: '结论已经完整。', text: '结论已经完整。' },
  { id: 't', page: 1, blockIndex: 1, kind: 'table', rawText: 'A\tB', text: '| A | B |' },
  { id: 'b', page: 1, blockIndex: 2, kind: 'paragraph', rawText: '下一段独立开始。', text: '下一段独立开始。' },
], 'test-engine');
assert.equal(completeSentence.blocks.length, 3, '完整句不得仅因表格相隔而被强行合并');

const visualLines = preprocessPdfBlocks([
  {
    id: 'v1', page: 6, blockIndex: 1, bbox: [106, 110, 538, 123], pageHeight: 800,
    kind: 'paragraph', rawText: '表2 为不同绝对节省水平下,被试在相对节省率上的独立样本t检验结果.由此表可以看出,在绝',
    text: '表2 为不同绝对节省水平下,被试在相对节省率上的独立样本t检验结果.由此表可以看出,在绝',
  },
  {
    id: 'v2', page: 6, blockIndex: 2, bbox: [86, 126, 543, 139], pageHeight: 800,
    kind: 'paragraph', rawText: '对节省水平一定的情况下,表现在相对节省值上的差异并不明显,绝对节省水平为20分钟时,',
    text: '对节省水平一定的情况下,表现在相对节省值上的差异并不明显,绝对节省水平为20分钟时,',
  },
  {
    id: 'v3', page: 6, blockIndex: 3, bbox: [86, 142, 299, 155], pageHeight: 800,
    kind: 'paragraph', rawText: '平均值差异为2.91元。', text: '平均值差异为2.91元。',
  },
  {
    id: 'v4', page: 6, blockIndex: 4, bbox: [106, 175, 538, 188], pageHeight: 800,
    kind: 'paragraph', rawText: '根据被试给出的值,分别进行了多因素方差分', text: '根据被试给出的值,分别进行了多因素方差分',
  },
  {
    id: 'v5', page: 6, blockIndex: 5, bbox: [86, 191, 300, 204], pageHeight: 800,
    kind: 'paragraph', rawText: '析,结果如表3所示。', text: '析,结果如表3所示。',
  },
  {
    id: 'v6', page: 6, blockIndex: 6, bbox: [86, 230, 538, 250], pageHeight: 800,
    tableIndex: 1, kind: 'table', rawText: '项目\tF\tp', text: '| 项目 | F | p |',
  },
], 'test-engine');
assert.equal(visualLines.blocks.filter((block) => block.kind === 'paragraph').length, 2,
  '相邻视觉行应合并为两个完整语义段落');
assert.equal(visualLines.blocks[0].kind, 'paragraph', '包含“由此表可以看出”的分析正文不得误标为表题');
assert.equal(visualLines.blocks[0].sourceFragments.length, 3);
assert.equal(visualLines.blocks[1].sourceFragments.length, 2);
assert.ok(visualLines.metadata.issues.some((issue) => issue.code === 'visual_line_merge'));
assert.equal(visualLines.metadata.sourceCoverage, 1);

assert.equal(normalizePdfReadingText('some-\nthing useful', 'paragraph', new Set(['something'])), 'something useful');
assert.equal(normalizePdfReadingText('well-\nknown result', 'paragraph', new Set(['something'])), 'well-known result');
assert.equal(normalizePdfReadingText('co-\noperate', 'paragraph', new Set(['cooperate', 'co-operate'])), 'co-operate');
assert.equal(normalizePdfReadingText('discre\u00ad\ntionary', 'paragraph'), 'discretionary');
assert.equal(normalizePdfReadingText('some-\nthing', 'code'), 'some-\nthing');

const layoutRaw: PdfRawBlock[] = [
  { id: 'print', page: 1, blockIndex: 0, kind: 'notes', rawText: 'printer.qxp Page 1', text: 'printer.qxp Page 1', layoutRole: 'print_furniture' },
  { id: 'contents', page: 1, blockIndex: 1, kind: 'list', rawText: 'Chapter topics', text: 'Chapter topics', layoutRole: 'contents' },
  { id: 'cap', page: 1, blockIndex: 2, kind: 'paragraph', bbox: [295, 351, 328, 400], rawText: 'T', text: 'T', layoutRole: 'drop_cap' },
  { id: 'prose', page: 1, blockIndex: 3, kind: 'paragraph', bbox: [295, 358, 571, 775], rawText: 'he human being.\nA complete paragraph.', text: 'he human being.\nA complete paragraph.' },
  { id: 'note', page: 1, blockIndex: 4, kind: 'notes', rawText: 'Meaningful footnote', text: 'Meaningful footnote' },
];
const layout = preprocessPdfBlocks(layoutRaw, 'fixture');
const body = layout.blocks.find(block => block.text.startsWith('The human'));
assert.ok(body, '下沉首字应回接正文而非独立标题');
assert.equal(body.sourceFragments.length, 2);
assert.deepEqual(body.sourceFragments.map(fragment => fragment.rawText), ['T', layoutRaw[3].rawText]);
assert.equal(layout.metadata.sourceCoverage, 1);
const structured = buildStructuredDocument('fixture', layout.blocks.map(block => ({ ...block,
  locator: { kind: 'pdf' as const, page: block.page, blockIndex: block.blockIndex, bbox: block.bbox } })), { preprocessing: layout.metadata });
const chunks = chunkStructuredDocument(structured);
assert.ok(structured.normalizedText.includes('printer.qxp'), '辅助信息仍保留于结构文档');
assert.ok(chunks.some(chunk => chunk.content.startsWith('The human')));
assert.ok(chunks.some(chunk => chunk.content.includes('Meaningful footnote')), '不应排除所有注释');
assert.ok(chunks.every(chunk => !/printer.qxp|Chapter topics/u.test(chunk.content)), '仅明确标记的辅助版面不进入正文向量');
for (const chunk of chunks) assert.equal(structured.normalizedText.slice(chunk.textStart, chunk.textEnd), chunk.content);

const ambiguous = preprocessPdfBlocks([...layoutRaw, { ...layoutRaw[3], id: 'duplicate', blockIndex: 5 }], 'fixture');
assert.ok(ambiguous.blocks.some(block => block.text === 'T'), '多个候选时不得猜测首字归属');
console.log('pdf semantic preprocessing checks passed');
