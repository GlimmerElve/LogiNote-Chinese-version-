import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { jsPDF } from 'jspdf';
import type { KnowledgeEntityCatalog, UploadedDocument } from '../src/types';
import type { KnowledgeShard } from '../src/electron/rag/knowledgeStore.ts';
import { readManifest, setDataRoot, setModelsDir, vectorizeDocument, writeChunksFile, writeManifest,
  writeStructuredDocumentFile, deleteManifestEntry, getDocumentPreview, searchDocuments } from '../src/electron/ragIndex.ts';
import { updateManifest } from '../src/electron/ragIndex.ts';
import { prepareMaterial, loadMaterial, materialHash, materialVersion } from '../src/electron/materialStore.ts';
import { getMaterialCatalog, listMaterialDocuments, materialResult, prepareLocalMaterial, readMaterialPage } from '../src/electron/materialReader.ts';
import { buildTextStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { scopeKnowledgeCatalog } from '../src/electron/rag/knowledgeRetrieval.ts';
import { assembleLocalMaterialPacket } from '../src/services/textbook/materialPacket.ts';
import { MaterialError } from '../src/services/textbook/materialScope.ts';
import { readLocalMaterialCatalog, readLocalMaterialPage } from '../src/services/documentRagClient.ts';
import { setBackgroundRagCompute, getBackgroundRagCompute } from '../src/electron/rag/backgroundComputeBridge.ts';

const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-materials-'));
const scope = { allowedDocIds: ['doc-lesson'] };
const original = ['# 选择过载', '选择过载不等于选项越多一定越差。', '## 条件与边界',
  ...Array.from({ length: 140 }, (_, i) => `条件 ${i}：需要结合难度、偏好清晰度与信息负荷。`),
  '```python\n# 这是代码注释，不是新章节\nif True:\n    print("keep indentation")\n```',
  '| 条件 | 结果 |\n| --- | --- |\n| 偏好明确 | 不一定过载 |', '$$p = \\frac{a}{b}$$',
  '![示意](https://example.invalid/no-fetch.png)', '# 第二章', '与本章无关的内容。'].join('\n\n');
const entry = (id: string, extension = '.md', fileType: UploadedDocument['fileType'] = 'md'): UploadedDocument => ({
  id, fileName: `${id}${extension}`, extension, fileType, indexable: !['image', 'ppt'].includes(fileType),
  size: 100, status: 'pending', chunkCount: 0, totalChars: 0, uploadAt: '2026-10-06T00:00:00.000Z',
});
const rejectCode = async (fn: () => Promise<unknown>, code: string) => {
  await assert.rejects(fn, (error: unknown) => error instanceof MaterialError && error.code === code);
};
let checks = 0;
function pass(message: string) { checks++; process.stdout.write(`PASS ${message}\n`); }
try {
  setDataRoot(temp);
  setModelsDir(path.join(temp, 'no-model-installed'));
  await mkdir(path.join(temp, 'documents'));
  await writeManifest([entry('doc-lesson'), { ...entry('doc-other'), status: 'ready' }, entry('doc-slides', '.pptx', 'pptx'),
    entry('doc-word', '.docx', 'docx'), entry('doc-pdf', '.pdf', 'pdf'), entry('doc-image', '.png', 'image')]);
  await writeFile(path.join(temp, 'documents', 'doc-lesson.md'), original);
  await writeFile(path.join(temp, 'documents', 'doc-other.md'), '# 私有范围外\n\n范围外正文。');
  await rejectCode(() => prepareMaterial(scope, 'doc-other'), 'OUT_OF_SCOPE');
  await rejectCode(() => getMaterialCatalog({ allowedDocIds: [], docId: 'doc-lesson' }), 'OUT_OF_SCOPE');
  await rejectCode(() => prepareMaterial({ allowedDocIds: ['../escape'] }, '../escape'), 'INVALID_REQUEST');
  await rejectCode(() => listMaterialDocuments({} as any), 'INVALID_REQUEST');
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', target: { kind: 'section', sectionId: 'x' } } as any), 'INVALID_REQUEST');
  await rejectCode(() => prepareMaterial(scope, 'file:///C:/secret.md'), 'INVALID_REQUEST');
  pass('文档范围缺省/为空不退回全库；越界 ID 和任意路径均拒绝');

  const structured = await prepareMaterial(scope, 'doc-lesson');
  const saved = (await readManifest()).find((doc) => doc.id === 'doc-lesson')!;
  assert.equal(saved.parseStatus, 'ready'); assert.equal(saved.status, 'pending');
  const catalog = await getMaterialCatalog({ ...scope, docId: 'doc-lesson' });
  const version = catalog.document.version!;
  assert.equal(version, materialVersion(structured));
  assert.equal(catalog.sections.length, 3);
  assert.ok(!catalog.sections.some((section) => section.title.includes('这是代码注释')));
  assert.ok(structured.normalizedText.includes('    print("keep indentation")'));
  assert.deepEqual(new Set(catalog.assets.map((asset) => asset.kind)), new Set(['code', 'table', 'formula', 'image_reference']));
  assert.equal(catalog.assets.find((asset) => asset.kind === 'image_reference')!.availability, 'reference_only');
  assert.ok(!JSON.stringify(catalog).includes(temp));
  // Desktop inference runs in a utility process. Inject its missing-model reply;
  // do not boot Transformers' concurrent loaders with intentionally absent files.
  setBackgroundRagCompute({ vectorize: async () => { throw new Error('测试缺失本地向量模型'); } } as unknown as NonNullable<ReturnType<typeof getBackgroundRagCompute>>);
  try { await assert.rejects(() => vectorizeDocument('doc-lesson', saved.fileName, structured.normalizedText, structured), /缺失本地向量模型/); }
  finally { setBackgroundRagCompute(null); }
  await updateManifest('doc-lesson', { status: 'failed', error: '测试缺失本地向量模型' });
  assert.equal((await loadMaterial(scope, 'doc-lesson', version)).version, version);
  assert.equal((await listMaterialDocuments(scope))[0].indexStatus, 'failed');
  assert.equal((await listMaterialDocuments(scope))[0].parseStatus, 'ready');
  pass('解析状态与向量状态独立；后台返回缺失模型时仍能深读，代码缩进/公式/表格/图片引用保留');

  const target = { kind: 'section' as const, sectionId: catalog.sections[0].id };
  const pieces: Array<{ start: number; end: number; text: string }> = [];
  let cursor: number | undefined;
  let pages = 0;
  do {
    const page = await readMaterialPage({ ...scope, docId: 'doc-lesson', version, target, cursor, maxChars: 256 });
    pages++;
    assert.equal(page.truncated, page.nextCursor !== undefined);
    assert.ok(page.excerpts.length <= 80);
    for (const excerpt of page.excerpts) {
      assert.equal(excerpt.text, structured.normalizedText.slice(excerpt.textStart, excerpt.textEnd));
      assert.equal(excerpt.excerptHash, materialHash(excerpt.text));
      pieces.push({ start: excerpt.textStart, end: excerpt.textEnd, text: excerpt.text });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages < 100);
  assert.ok(pages > 1 && pages < 100);
  assert.ok(pieces.some((item) => item.text.includes('条件 139')));
  assert.ok(!pieces.some((item) => item.text.includes('与本章无关')));
  for (const block of structured.blocks.filter((item) => item.textStart < catalog.sections[0].textEnd)) {
    const actual = pieces.filter((piece) => piece.start >= block.textStart && piece.end <= block.textEnd).map((piece) => piece.text).join('');
    assert.equal(actual, structured.normalizedText.slice(block.textStart, block.textEnd), '不能漏读章节尾部或条件段落');
  }
  pass('完整章节递归包含子章节与条件段落，分页不漏尾文、不串下一章；每段哈希/坐标可复核');

  const fullPieces: typeof pieces = [];
  cursor = undefined; pages = 0;
  do {
    const page = await readMaterialPage({ ...scope, docId: 'doc-lesson', version, target: { kind: 'document' }, cursor, maxChars: 256 });
    pages++;
    assert.equal(page.targetStart, 0); assert.equal(page.targetEnd, structured.normalizedText.length);
    fullPieces.push(...page.excerpts.map(excerpt => ({ start: excerpt.textStart, end: excerpt.textEnd, text: excerpt.text })));
    assert.ok(page.nextCursor === undefined || page.nextCursor > (cursor || 0));
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages < 100);
  assert.equal(cursor, undefined);
  for (const block of structured.blocks) assert.equal(fullPieces.filter(piece => piece.start >= block.textStart && piece.end <= block.textEnd).map(piece => piece.text).join(''),
    structured.normalizedText.slice(block.textStart, block.textEnd));
  assert.ok(fullPieces.some(piece => piece.text.includes('与本章无关的内容')));
  await rejectCode(() => readMaterialPage({ allowedDocIds: ['doc-other'], docId: 'doc-lesson', version, target: { kind: 'document' } }), 'OUT_OF_SCOPE');
  pass('心流全文分段覆盖所有同级章节、代码和末尾正文；分页有界且沿用文档范围与版本校验');

  const tinyCatalog = await getMaterialCatalog({ ...scope, docId: 'doc-lesson', limit: 1 });
  const catalogAgain = await getMaterialCatalog({ ...scope, docId: 'doc-lesson', version, offset: tinyCatalog.nextOffset, limit: 1 });
  assert.equal(catalogAgain.sections[0].title, '条件与边界');
  await rejectCode(() => getMaterialCatalog({ ...scope, docId: 'doc-lesson', offset: 1 }), 'INVALID_REQUEST');
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', version, target, cursor: -1 }), 'INVALID_REQUEST');
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', version, target, maxChars: 100_000 }), 'INVALID_REQUEST');
  const code = structured.blocks.find((block) => block.kind === 'code')!;
  const codePage = await readMaterialPage({ ...scope, docId: 'doc-lesson', version, target: { kind: 'block', blockId: code.id, neighbors: 0 } });
  assert.equal(codePage.excerpts.length, 1);
  assert.deepEqual(codePage.excerpts[0].locator, code.locator);
  const focused = structured.blocks.find((block) => structured.normalizedText.slice(block.textStart, block.textEnd).startsWith('条件 50'))!;
  await writeChunksFile('doc-lesson', [{ id: 'hit', docId: 'doc-lesson', fileName: saved.fileName, index: 0,
    sectionPath: focused.sectionPath, content: structured.normalizedText.slice(focused.textStart, focused.textEnd),
    textStart: focused.textStart, textEnd: focused.textEnd, embedding: [] }]);
  const hit = await readMaterialPage({ ...scope, docId: 'doc-lesson', version, target: { kind: 'chunk', chunkId: 'hit', neighbors: 1 } });
  assert.equal(hit.excerpts.length, 3);
  assert.ok(hit.excerpts[0].text.includes('条件 49') && hit.excerpts[2].text.includes('条件 51'));
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', version, target: { kind: 'chunk', chunkId: 'doc-other#1' } }), 'TARGET_MISSING');
  pass('目录分页绑定版本；块与真实检索命中可扩读邻近条件，不接受旧命中或越界游标');

  // 使用生产 renderer client + 主进程服务封装；这是内存 bridge，不声称原生 Electron IPC 验收。
  (globalThis as any).window = { electronAPI: { ragDocs: {
    materialList: (input: any) => materialResult(() => listMaterialDocuments(input)),
    materialPrepare: (input: any, id: string) => materialResult(() => prepareLocalMaterial(input, id)),
    materialCatalog: (input: any) => materialResult(() => getMaterialCatalog(input)),
    materialRead: (input: any) => materialResult(() => readMaterialPage(input)),
  } } };
  assert.equal((await readLocalMaterialCatalog({ ...scope, docId: 'doc-lesson' })).document.version, version);
  await rejectCode(() => readLocalMaterialPage({ allowedDocIds: [], docId: 'doc-lesson', version, target }), 'OUT_OF_SCOPE');
  const packet = await assembleLocalMaterialPacket({ ...scope, projectNoteId: 'project-real-id', selections: [{ docId: 'doc-lesson', version, target }] });
  assert.equal(packet.projectNoteId, 'project-real-id'); assert.equal(packet.coverage[0].complete, true);
  assert.equal(packet.gaps.length, 0); assert.ok(packet.untrustedSourceContent);
  assert.ok(packet.citations.every((item) => item.docId === 'doc-lesson' && item.version === version));
  const bounded = await assembleLocalMaterialPacket({ ...scope, projectNoteId: 'project-real-id', maxChars: 512, selections: [{ docId: 'doc-lesson', version, target }] });
  assert.equal(bounded.coverage[0].complete, false); assert.equal(bounded.gaps[0].reason, 'budget_exhausted');
  assert.ok(bounded.citations.reduce((sum, item) => sum + item.text.length, 0) <= 512);
  pass('生产 client/服务可组装项目绑定的本地原文包；预算不足明确留下未读缺口，不生成或写入教材');

  await rejectCode(() => assembleLocalMaterialPacket({ ...scope, projectNoteId: 'p', selections: [{ docId: 'doc-lesson', version, target }] }, {
    catalog: getMaterialCatalog,
    page: async (input) => { const page = await readMaterialPage(input); page.excerpts[0].text = 'x'.repeat(page.excerpts[0].text.length); return page; },
  }), 'INVALID_SOURCE');
  await writeFile(path.join(temp, 'documents', 'doc-lesson.md'), original.replace('条件 139', '条件 999'));
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', version, target }), 'SOURCE_CHANGED');
  assert.equal((await listMaterialDocuments(scope))[0].parseStatus, 'stale');
  await prepareMaterial(scope, 'doc-lesson');
  await rejectCode(() => getMaterialCatalog({ ...scope, docId: 'doc-lesson', version }), 'SOURCE_CHANGED');
  pass('引用文本被改动、原文件尾部变化与重新解析后旧版本均拒绝，失效状态明确');

  await writeFile(path.join(temp, 'documents', 'doc-word.docx'), zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>条件</w:t></w:r></w:p><w:p><w:r><w:t>必须结合情境</w:t></w:r></w:p></w:body></w:document>') }));
  await writeFile(path.join(temp, 'documents', 'doc-slides.pptx'), zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>实验</a:t><a:t>比较样本</a:t></p:sld>'),
    'ppt/notesSlides/notesSlide1.xml': strToU8('<p:notes><a:t>不要遗漏限制条件</a:t></p:notes>'),
  }));
  const pdf = new jsPDF(); pdf.text('First page evidence', 15, 20); pdf.addPage(); pdf.text('Second page boundary', 15, 20);
  await writeFile(path.join(temp, 'documents', 'doc-pdf.pdf'), new Uint8Array(pdf.output('arraybuffer')));
  for (const [id, expected] of [['doc-word', 'docx'], ['doc-slides', 'pptx'], ['doc-pdf', 'pdf']] as const) {
    const scoped = { allowedDocIds: [id] };
    await prepareMaterial(scoped, id);
    const book = await getMaterialCatalog({ ...scoped, docId: id });
    assert.ok(book.sections.every((section) => section.locator.kind === expected));
    const page = await readMaterialPage({ ...scoped, docId: id, version: book.document.version!, target: { kind: 'section', sectionId: book.sections[0].id } });
    assert.ok(page.excerpts.every((item) => item.locator.kind === expected));
    if (expected === 'pptx') assert.ok(page.excerpts.some((item) => item.kind === 'notes' && item.text.includes('限制条件')));
    if (expected === 'pdf') assert.equal(book.sections.length, 2);
  }
  pass('真实合成 DOCX/PPTX/PDF 经已有解析器准备和深读，保留段落/幻灯片/备注/页码定位');

  const imageScope = { allowedDocIds: ['doc-image'] };
  await rejectCode(() => prepareMaterial(imageScope, 'doc-image'), 'UNSUPPORTED');
  assert.equal((await listMaterialDocuments(imageScope))[0].parseStatus, 'unsupported');
  const old = buildTextStructuredDocument('doc-other', '# 私有范围外\n\n范围外正文。');
  await writeStructuredDocumentFile(old);
  await rejectCode(() => loadMaterial({ allowedDocIds: ['doc-other'] }, 'doc-other'), 'NOT_PARSED');
  const deletedVersion = (await getMaterialCatalog({ ...scope, docId: 'doc-lesson' })).document.version!;
  await deleteManifestEntry('doc-lesson');
  await rejectCode(() => readMaterialPage({ ...scope, docId: 'doc-lesson', version: deletedVersion, target }), 'SOURCE_MISSING');
  pass('未知附件明确未支持；无来源版本旧缓存需准备；删除资料后即使缓存残留也不能继续引用');

  for (const mode of ['passage', 'auto', 'entity', 'argument'] as const) {
    assert.deepEqual(await searchDocuments('选择过载', 5, { mode, allowedDocIds: [] }), []);
    // The DOCX above now has ready structured text, which is a valid retrieval
    // source even without vectors. Use the genuinely unparsed image fixture.
    assert.deepEqual(await searchDocuments('选择过载', 5, { mode, allowedDocIds: ['doc-image'] }, { embed: async () => assert.fail('No readable scoped source should start a model') }), []);
  }
  await rejectCode(() => searchDocuments('选择过载', 5, { allowedDocIds: ['../escape'] }), 'INVALID_REQUEST');
  const sourceMain = await readFile(new URL('../src/electron/main.ts', import.meta.url), 'utf8');
  assert.ok(sourceMain.indexOf('const structured = await prepareMaterial') < sourceMain.indexOf('const chunks = await vectorizeDocument'));
  assert.ok(sourceMain.includes("'ragDocs:material-read'"));
  assert.equal((await getDocumentPreview('doc-other'))!.chunks.length, 0);
  pass('四种 RAG 模式均显式限域，空/无 ready 文档不启动向量模型；旧 preview 保持原接口');

  const catalogFixture: KnowledgeEntityCatalog = { schemaVersion: 1, generatedAt: '', entities: [{
    id: 'global-id', memberEntityIds: ['local-id', 'outside-id'], canonicalName: '范围外名称', normalizedKey: 'global',
    entityType: 'concept', aliases: ['范围外别名', '选择过载'], mentionIds: ['m1', 'm2'], docIds: ['allowed', 'outside'], embedding: [1],
  }] };
  const shard = { entityMentions: [{ id: 'm1', canonicalEntityId: 'local-id', surfaceText: '选择过载', aliases: ['选项过载'],
    docId: 'allowed', chunkId: 'allowed#1', admission: 'admitted' }], entityRelations: [], argumentUnits: [], argumentEdges: [] } as unknown as KnowledgeShard;
  const scopedCatalog = scopeKnowledgeCatalog(catalogFixture, [shard]);
  assert.equal(scopedCatalog.entities[0].canonicalName, '选择过载');
  assert.deepEqual(scopedCatalog.entities[0].aliases, ['选项过载']);
  assert.deepEqual(scopedCatalog.entities[0].docIds, ['allowed']);
  pass('限域 knowledge 检索的名称与别名只取范围内提及，不泄露全库合并名称');

  const extraScope = { allowedDocIds: ['doc-extra'] };
  await writeManifest([...(await readManifest()), entry('doc-extra')]);
  const extraText = '# 多素材章\n\n' + Array.from({ length: 110 }, (_, i) => `公式 ${i} $a=b$ 😀`).join('\n\n');
  await writeFile(path.join(temp, 'documents', 'doc-extra.md'), extraText);
  await prepareMaterial(extraScope, 'doc-extra');
  const extraCatalog = await getMaterialCatalog({ ...extraScope, docId: 'doc-extra', limit: 100 });
  assert.equal(extraCatalog.sections.length, 1); assert.equal(extraCatalog.assets.length, 100);
  const extraNext = await getMaterialCatalog({ ...extraScope, docId: 'doc-extra', version: extraCatalog.document.version,
    offset: extraCatalog.nextOffset, limit: 100 });
  assert.equal(extraNext.sections.length, 0); assert.equal(extraNext.assets.length, 10);
  assert.equal(extraNext.nextOffset, undefined);
  const extraTarget = { kind: 'section' as const, sectionId: extraCatalog.sections[0].id };
  const extraPage = await readMaterialPage({ ...extraScope, docId: 'doc-extra', version: extraCatalog.document.version!, target: extraTarget, maxChars: 12_000 });
  assert.equal(extraPage.excerpts.length, 80); assert.equal(extraPage.truncated, true);
  const remainingPage = await readMaterialPage({ ...extraScope, docId: 'doc-extra', version: extraCatalog.document.version!, target: extraTarget,
    cursor: extraPage.nextCursor, maxChars: 12_000 });
  assert.equal(remainingPage.truncated, false); assert.equal(remainingPage.excerpts.length, 31);
  const extraPacket = await assembleLocalMaterialPacket({ ...extraScope, projectNoteId: 'p', maxChars: 120_000,
    selections: [{ docId: 'doc-extra', version: extraCatalog.document.version!, target: extraTarget }] });
  assert.equal(extraPacket.citations.length, 111);
  await rejectCode(() => assembleLocalMaterialPacket({ ...extraScope, projectNoteId: 'p',
    selections: [{ docId: 'doc-extra', version: extraCatalog.document.version!, target: extraTarget }] }, {
    page: readMaterialPage,
    catalog: async (input) => {
      await writeFile(path.join(temp, 'documents', 'doc-extra.md'), extraText + '\n\n来源组装后变化');
      return getMaterialCatalog(input);
    },
  }), 'SOURCE_CHANGED');
  await writeFile(path.join(temp, 'documents', 'doc-extra.md'), '');
  await rejectCode(() => prepareMaterial(extraScope, 'doc-extra'), 'INVALID_SOURCE');
  assert.equal((await readManifest()).find((doc) => doc.id === 'doc-extra')?.parseStatus, 'failed');
  pass('素材比章节多时仍可分页，80 块上限可续读；组装结束复核变化、空原文解析失败均不伪报成功');
} finally {
  assert.equal(path.dirname(temp), os.tmpdir());
  assert.ok(path.basename(temp).startsWith('loginote-textbook-materials-'));
  await rm(temp, { recursive: true, force: true });
}
process.stdout.write(`\n${checks} local textbook material checks passed (synthetic temporary disk; no cloud/user vault writes; native IPC and generation not tested).\n`);
