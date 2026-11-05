import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  detectDocumentType,
  extractDocxText,
  extractStructuredDocument,
  extractPptxText,
  hasDocumentParser,
} from '../src/electron/documentParsers.ts';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  getDocumentPreview,
  readManifest,
  readStructuredDocumentFile,
  setDataRoot,
  writeChunksFile,
  writeStructuredDocumentFile,
} from '../src/electron/ragIndex.ts';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loginote-doc-parser-'));
try {
  const docxPath = path.join(tempRoot, 'lesson.docx');
  await writeFile(docxPath, Buffer.from(zipSync({
    'word/document.xml': strToU8(`<?xml version="1.0"?>
      <w:document xmlns:w="urn:test"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>梯度基础</w:t></w:r></w:p>
        <w:p><w:r><w:t>方向导数 &amp; 梯度</w:t></w:r></w:p>
      </w:body></w:document>`),
  })));
  const docxText = await extractDocxText(docxPath);
  assert.match(docxText, /^# 梯度基础/mu);
  assert.match(docxText, /方向导数 & 梯度/u);
  const docxStructured = await extractStructuredDocument(docxPath, 'docx', 'docx-test');
  assert.equal(docxStructured.schemaVersion, 1);
  assert.equal(docxStructured.blocks[0].kind, 'heading');
  assert.deepEqual(docxStructured.blocks[0].locator, { kind: 'docx', paragraphIndex: 0 });
  assert.equal(docxStructured.blocks[1].sectionPath, '梯度基础');

  const pptxPath = path.join(tempRoot, 'slides.pptx');
  await writeFile(pptxPath, Buffer.from(zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:t>导数定义</a:t><a:t>差商的极限</a:t></p:sld>'),
    'ppt/slides/slide2.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:t>应用</a:t><a:t>求切线斜率</a:t></p:sld>'),
    'ppt/notesSlides/notesSlide2.xml': strToU8('<p:notes xmlns:p="p" xmlns:a="a"><a:t>提醒学生联系速度</a:t></p:notes>'),
  })));
  const pptxText = await extractPptxText(pptxPath);
  assert.match(pptxText, /# 第 1 页 · 导数定义/u);
  assert.match(pptxText, /# 第 2 页 · 应用/u);
  assert.match(pptxText, /演讲者备注\n提醒学生联系速度/u);
  const pptxStructured = await extractStructuredDocument(pptxPath, 'pptx', 'pptx-test');
  assert.ok(pptxStructured.blocks.some((block) => block.locator.kind === 'pptx' && block.locator.slideIndex === 2));
  assert.ok(pptxStructured.blocks.some((block) => block.locator.kind === 'pptx' && block.locator.notes === true));

  assert.deepEqual(detectDocumentType('notes.docx'), { fileType: 'docx', extension: '.docx', indexable: true });
  assert.deepEqual(detectDocumentType('legacy.ppt'), { fileType: 'ppt', extension: '.ppt', indexable: false });
  assert.equal(hasDocumentParser('docx'), true);
  assert.equal(hasDocumentParser('ppt'), false);
  assert.equal(detectDocumentType('unknown.exe'), null);

  await mkdir(path.join(tempRoot, 'rag-index'), { recursive: true });
  await writeFile(path.join(tempRoot, 'rag-index', 'manifest.json'), JSON.stringify([
    { id: 'legacy-pdf', fileName: 'legacy.pdf', fileType: 'pdf', size: 12, status: 'ready', chunkCount: 1, totalChars: 10, uploadAt: '2026-01-01T00:00:00.000Z' },
    { id: 'legacy-ppt', fileName: 'legacy.ppt', fileType: 'ppt', size: 12, status: 'failed', chunkCount: 0, totalChars: 0, uploadAt: '2026-01-01T00:00:00.000Z' },
    { id: 'old-segmentation', fileName: 'old.pdf', fileType: 'pdf', indexSchemaVersion: 1, status: 'ready' },
    { id: 'new-segmentation', fileName: 'new.pdf', fileType: 'pdf',
      indexSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION, status: 'ready' },
  ]), 'utf-8');
  setDataRoot(tempRoot);
  await writeStructuredDocumentFile(docxStructured);
  assert.deepEqual(await readStructuredDocumentFile('docx-test'), docxStructured);
  const migrated = await readManifest();
  assert.equal(migrated[0].extension, '.pdf');
  assert.equal(migrated[0].indexable, true);
  assert.equal(migrated[0].needsReindex, true);
  assert.equal(migrated[1].extension, '.ppt');
  assert.equal(migrated[1].indexable, false);
  assert.equal(migrated[1].status, 'stored');
  assert.equal(migrated[2].needsReindex, true, 'schema 1 已有 locator 但仍需重建句界');
  assert.equal(migrated[3].needsReindex, false);
  await writeChunksFile('legacy-pdf', [{
    id: 'legacy-pdf#0',
    docId: 'legacy-pdf',
    fileName: 'legacy.pdf',
    index: 0,
    sectionPath: '第一章',
    content: '这是实际进入索引的文本。',
    sourceLocators: [{ kind: 'pdf', page: 3, bbox: [10, 20, 30, 40] }],
    embedding: [0.1, 0.2],
  }]);
  const preview = await getDocumentPreview('legacy-pdf');
  assert.equal(preview?.chunks[0].sectionPath, '第一章');
  assert.equal(preview?.chunks[0].content, '这是实际进入索引的文本。');
  assert.equal(preview?.chunks[0].contentLength, '这是实际进入索引的文本。'.length);
  assert.equal(preview?.chunks[0].contentHash, createHash('sha256').update('这是实际进入索引的文本。').digest('hex'));
  assert.deepEqual(preview?.chunks[0].sourceLocators, [{ kind: 'pdf', page: 3, bbox: [10, 20, 30, 40] }]);
  assert.equal('embedding' in (preview?.chunks[0] || {}), false, '预览接口不得暴露向量');
  const focusedPreview = await getDocumentPreview('legacy-pdf', 40, 'legacy-pdf#0');
  assert.equal(focusedPreview?.focusedChunkId, 'legacy-pdf#0');
  const longChunk = '完整资料正文。'.repeat(250);
  await writeChunksFile('legacy-pdf', [{ id: 'legacy-pdf#0', docId: 'legacy-pdf', fileName: 'legacy.pdf',
    index: 0, sectionPath: '第一章', content: longChunk, embedding: [0.1, 0.2] }]);
  const bounded = await getDocumentPreview('legacy-pdf', 40, 'legacy-pdf#0');
  assert.equal(bounded?.chunks[0].content.length, 1200);
  assert.equal(bounded?.chunks[0].contentLength, longChunk.length);
  assert.equal(bounded?.chunks[0].contentHash, createHash('sha256').update(longChunk).digest('hex'), '主进程指纹必须覆盖预览外的尾部');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('document parser and manifest migration checks passed');
