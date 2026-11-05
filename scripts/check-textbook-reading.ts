import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteItem, UploadedDocument } from '../src/types';
import type { TextbookJob, TextbookContext } from '../src/services/textbook/generationTypes';
import { patchTextbookReadingPosition } from '../src/services/textbook/readingState';
import { embeddedLocalImages, isLocalRasterDataUrl, MAX_TEXTBOOK_GIF_FRAMES } from '../src/services/textbook/localImages';
import { readLocalMaterialImage } from '../src/services/documentRagClient';
import { setDataRoot, setModelsDir, writeManifest } from '../src/electron/ragIndex';
import { getMaterialCatalog, listMaterialDocuments, prepareLocalMaterial, readMaterialPage, readMaterialImage, materialResult } from '../src/electron/materialReader';
import { collectTextbookSources } from '../src/services/textbook/generation';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { deserializeVault } from '../src/services/vaultFsService';
import { splitSharableFields, splitUserStateFields, mergeNote, deserializeUserStateFile, USER_STATE_FILES } from '../src/services/userStateService';

const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-reading-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is forbidden in reading checks'); };
let checks = 0;
const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
try {
  const manifest = { schemaVersion: 1 as const, textbookId: 'book', projectNoteId: 'project', rootProjectId: 'root', revisionId: 'revision-1',
    regionId: 'book-region', createdAt: '2026-10-06', updatedAt: '2026-10-06' };
  const note: NoteItem = { id: 'project', title: '选择过载效应', noteType: 'project', parentId: 'root', content: '用户最新备注\n<LearningReviewBlock id="review" />',
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-01', updatedAt: '2026-10-05', textbook: manifest };
  const notes = [note, { ...note, id: 'other', textbook: undefined, content: '同名但不同项目' }];
  const next = patchTextbookReadingPosition(notes, 'project', 'revision-1', { blockAnchor: 'chapter-2', scrollTop: 610 }, '2026-10-06T01:00:00Z');
  assert.equal(next[0].content, note.content); assert.equal(next[0].updatedAt, note.updatedAt); assert.equal(next[1], notes[1]);
  assert.equal(patchTextbookReadingPosition(next, 'project', 'revision-1', { blockAnchor: 'chapter-2', scrollTop: 610 }), next);
  assert.equal(patchTextbookReadingPosition(next, 'project', 'old-revision', { scrollTop: 0 }), next);
  assert.equal(patchTextbookReadingPosition(next, 'other', 'revision-1', { scrollTop: 0 }), next);
  for (const scrollTop of [-1, NaN, Infinity, 1e10]) assert.equal(patchTextbookReadingPosition(next, 'project', 'revision-1', { scrollTop }), next);
  assert.ok(!JSON.stringify(splitSharableFields(next[0])).includes('textbookReadingState'));
  assert.equal(splitUserStateFields(next[0]).textbookReadingState!.blockAnchor, 'chapter-2');
  pass('阅读进度只按稳定ID和修订写个人状态，保留最新正文/记录，不串同名项目，不触完成或更新时间');
  const vault = path.join(temp, 'vault'), state = path.join(temp, 'user-state');
  await saveVaultSnapshot(vault, state, next); await recoverVaultSnapshot(vault, state);
  const files = new Map<string, string>(); for (const item of next) files.set(`${item.id}.md`, await readFile(path.join(vault, 'notes', `${item.id}.md`), 'utf8'));
  const states = deserializeUserStateFile(await readFile(path.join(state, USER_STATE_FILES.noteStates), 'utf8'));
  const reloaded = deserializeVault(await readFile(path.join(vault, 'metadata.json'), 'utf8'), files).map((item) => mergeNote(item, states[item.id]));
  assert.deepEqual(reloaded[0].textbookReadingState, next[0].textbookReadingState); assert.equal(reloaded[0].content, note.content);
  pass('实际临时磁盘保存与重读恢复章节/滚动位置，分享字段不带阅读记录');

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
  assert.equal(isLocalRasterDataUrl(png), true);
  const oversizedPng = Buffer.from(png.split(',')[1], 'base64');
  oversizedPng.writeUInt32BE(100_000, 16); oversizedPng.writeUInt32BE(100_000, 20);
  assert.equal(isLocalRasterDataUrl(`data:image/png;base64,${oversizedPng.toString('base64')}`), false);
  assert.equal(isLocalRasterDataUrl('data:image/png;base64,iVBORw0KGgo='), false);
  for (const value of ['https://example.invalid/image.png', 'file:///C:/secret.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHNjcmlwdD4=']) assert.equal(isLocalRasterDataUrl(value), false);

  // Container/header probes only: never hand malicious raster dimensions to a browser decoder.
  const rasterUrl = (kind: string, bytes: Uint8Array) => `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
  const gif = Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', gif)), true);
  const gifFrameAt = gif.indexOf(0x2c), gifFrame = gif.subarray(gifFrameAt, gif.length - 1);
  const forgedFrame = Buffer.from(gif);
  forgedFrame.writeUInt16LE(65535, gifFrameAt + 5); forgedFrame.writeUInt16LE(65535, gifFrameAt + 7);
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', forgedFrame)), false, 'A tiny logical canvas cannot hide a huge image descriptor');
  const escapedRect = Buffer.from(gif); escapedRect.writeUInt16LE(1, gifFrameAt + 1);
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', escapedRect)), false, 'Frame rectangles must stay inside the bounded canvas');
  const multiGif = (frames: number, side = 1) => {
    const header = Buffer.from(gif.subarray(0, gifFrameAt)); header.writeUInt16LE(side, 6); header.writeUInt16LE(side, 8);
    return Buffer.concat([header, ...Array.from({ length: frames }, () => gifFrame), Buffer.from([0x3b])]);
  };
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', multiGif(MAX_TEXTBOOK_GIF_FRAMES))), true);
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', multiGif(MAX_TEXTBOOK_GIF_FRAMES + 1))), false, 'GIF frame count is bounded');
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', multiGif(4, 2000))), true);
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', multiGif(5, 2000))), false, 'GIF budget counts full composited canvas pixels, not only tiny subrectangles');
  assert.equal(isLocalRasterDataUrl(rasterUrl('gif', gif.subarray(0, gif.length - 2))), false, 'Truncated GIF sub-blocks cannot pass');

  const chunk = (kind: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.write(kind, 0, 4, 'ascii'); header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.from([0])] : [])]);
  };
  const webp = (...chunks: Buffer[]) => {
    const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), header = Buffer.alloc(8);
    header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
  };
  const lossless = (width: number, height: number) => {
    const data = Buffer.alloc(5); data[0] = 0x2f; data.writeUInt32LE((width - 1) + (height - 1) * 0x4000, 1); return chunk('VP8L', data);
  };
  const lossy = (width: number, height: number) => {
    const data = Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
    data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8); return chunk('VP8 ', data);
  };
  const extended = (width: number, height: number, flags = 0) => {
    const data = Buffer.alloc(10); data[0] = flags;
    data.writeUIntLE(width - 1, 4, 3); data.writeUIntLE(height - 1, 7, 3); return chunk('VP8X', data);
  };
  const staticWebp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89', 'base64');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', staticWebp)), true, 'A complete small static WebP stays available');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1), staticWebp.subarray(12)))), true, 'A matching VP8X and actual VP8 raster stays available');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(lossless(1, 1)))), true, 'Bounded standalone VP8L headers remain supported');
  for (const actual of [lossless(5000, 5000), lossy(5000, 5000)]) {
    assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1), actual))), false, 'VP8X cannot hide oversized VP8/VP8L dimensions');
  }
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1), lossless(2, 1)))), false, 'Declared and actual WebP dimensions must agree');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1), chunk('EXIF', Buffer.from([1])), lossless(1, 1)))), true, 'Padded ancillary chunks do not hide the actual raster');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1)))), false, 'A VP8X canvas without an actual raster is not an image');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1, 2), lossless(1, 1)))), false, 'Animated VP8X is unsupported and fails closed');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(extended(1, 1), chunk('ANMF', Buffer.alloc(0)), lossless(1, 1)))), false, 'Animation chunks cannot bypass the flag check');
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', webp(lossless(1, 1), lossless(1, 1)))), false, 'Multiple WebP rasters cannot evade allocation bounds');
  const forgedRiff = Buffer.from(staticWebp); forgedRiff.writeUInt32LE(1, 4);
  assert.equal(isLocalRasterDataUrl(rasterUrl('webp', forgedRiff)), false, 'RIFF length must match the complete payload');
  pass('GIF逐帧矩形/帧数/累计画布像素及WebP实际栅格尺寸完整校验，动画WebP明确拒绝；恶意样本不解码');
  const body = `# 图片来源\n\n![尚未采集](https://example.invalid/no-fetch.png)\n\n![决策示意](${png})\n\n\`\`\`md\n![代码中的图片](${png})\n\`\`\``;
  assert.equal(embeddedLocalImages(body).length, 1);
  setDataRoot(temp); setModelsDir(path.join(temp, 'no-model')); await mkdir(path.join(temp, 'documents'));
  const document = { id: 'image-source', fileName: 'local.md', extension: '.md', fileType: 'md', indexable: true, size: body.length,
    status: 'pending', chunkCount: 0, totalChars: 0, uploadAt: '2026-10-06' } as UploadedDocument;
  await writeManifest([document]); await writeFile(path.join(temp, 'documents', 'image-source.md'), body);
  const scope = { allowedDocIds: ['image-source'] }; await prepareLocalMaterial(scope, 'image-source');
  const catalog = await getMaterialCatalog({ ...scope, docId: 'image-source' }); const version = catalog.document.version!;
  const asset = catalog.assets.find((item) => item.availability === 'local_embedded')!;
  assert.ok(asset);
  const imageRequest = { ...scope, docId: 'image-source', version, blockId: asset.blockId, imageIndex: 0 };
  Object.assign(globalThis, { window: { electronAPI: { ragDocs: {
    materialList: (request: any) => materialResult(() => listMaterialDocuments(request)),
    materialPrepare: (request: any, id: string) => materialResult(() => prepareLocalMaterial(request, id)),
    materialCatalog: (request: any) => materialResult(() => getMaterialCatalog(request)),
    materialRead: (request: any) => materialResult(() => readMaterialPage(request)),
    materialImage: (request: any) => materialResult(() => readMaterialImage(request)),
    search: async () => { throw new Error('offline model not installed'); },
  } } } });
  assert.deepEqual(await readLocalMaterialImage(imageRequest), { dataUrl: png, alt: '决策示意' });
  await assert.rejects(readMaterialImage({ ...imageRequest, allowedDocIds: [] }), /范围/);
  await assert.rejects(readMaterialImage({ ...imageRequest, blockId: 'image-source:block:1' }), /缓存/);
  await assert.rejects(readMaterialImage({ ...imageRequest, imageIndex: -1 }), /编号/);
  const job = { spec: { ...scope, projectNoteId: 'project' } } as unknown as TextbookJob;
  const sources = await collectTextbookSources(job, { project: { title: '图片示意', knowledgeTitles: [] } } as unknown as TextbookContext,
    async () => ({ selections: [{ docId: 'image-source', sectionId: catalog.sections[0].id }] }));
  const collected = sources.flatMap((item) => item.assets || []);
  assert.equal(collected.length, 1); assert.equal(collected[0].docId, 'image-source');
  assert.ok(!JSON.stringify(sources).includes(png)); assert.ok(sources.some((item) => item.text.includes('仅供显示')));
  assert.ok(sources.some((item) => item.blockId && item.textStart !== undefined && item.textEnd !== undefined));
  pass('真实MD解析→限定版本图片IPC/client→素材ID采集；模型只收到指针，不把图像当已理解事实，不读任意路径/网络');
  await writeFile(path.join(temp, 'documents', 'image-source.md'), `${body}\n\n已修改`);
  await assert.rejects(readMaterialImage(imageRequest), /变化|旧|版本/);
  pass('图片原始来源变更明确拒绝，未缓存引用不自动抓取，不静默替换旧图片');
  console.log(`教材阅读与本地图片检查：${checks} 组通过`);
} finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
