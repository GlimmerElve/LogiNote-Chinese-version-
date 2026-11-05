import type { LlmImageInput } from '../../types.ts';
import type { TextbookSource } from './generationTypes.ts';
import { readLocalMaterialImage } from '../documentRagClient.ts';
import { MAX_LLM_IMAGES, MAX_LLM_IMAGE_BYTES, validateLlmImages } from '../llmImages.ts';
import { MaterialError } from './materialScope.ts';
import { PDF_FORMULA_IMAGE_INDEX, PDF_PAGE_IMAGE_INDEX } from './localImages.ts';

export interface TextbookVisualInput {
  images: LlmImageInput[];
  materials: Array<{ assetId: string; sourceId: string; status: 'attached' | 'display_only' | 'unavailable' }>;
}
/** No OCR and no new inference stage. Bytes live only for this request. */
export async function collectTextbookVisualInput(sources: TextbookSource[], allowedDocIds: string[], enabled: boolean,
  readImage = readLocalMaterialImage, signal?: AbortSignal): Promise<TextbookVisualInput> {
  const result: TextbookVisualInput = { images: [], materials: [] }; let bytes = 0;
  const candidates = sources.flatMap(source => (source.assets || []).map(asset => ({ source, asset })));
  const priority = (imageIndex: number) => imageIndex >= PDF_FORMULA_IMAGE_INDEX ? 0 : imageIndex === PDF_PAGE_IMAGE_INDEX ? 2 : 1;
  candidates.sort((a, b) => priority(a.asset.imageIndex) - priority(b.asset.imageIndex));
  for (const { source, asset } of candidates) {
    const webImage = source.kind === 'web' && /^S[1-3]$/u.test(source.id) && /^[a-f0-9]{64}$/u.test(asset.attachmentHash || '')
      && asset.blockId === `${source.id}:web-image:${asset.imageIndex}`;
    if ((!webImage && (source.kind !== 'document' || !allowedDocIds.includes(source.id) || source.blockId !== asset.blockId)) || source.id !== asset.docId
      || source.sourceId !== asset.sourceId || source.version !== asset.version) {
      throw new MaterialError('OUT_OF_SCOPE', '图片物料不属于本次批准的来源');
    }
    const item = { assetId: asset.id, sourceId: source.sourceId, status: 'display_only' as const };
    if (!enabled || result.images.length >= MAX_LLM_IMAGES) { result.materials.push(item); continue; }
    signal?.throwIfAborted();
    try {
      const image = await readImage({ allowedDocIds: webImage ? [asset.docId] : allowedDocIds, docId: asset.docId, version: asset.version, blockId: asset.blockId, imageIndex: asset.imageIndex,
        ...(webImage ? { attachmentHash: asset.attachmentHash } : {}) });
      signal?.throwIfAborted();
      const input = { assetId: asset.id, dataUrl: image.dataUrl };
      validateLlmImages([input]);
      const size = image.dataUrl.split(',')[1].length * 3 / 4;
      if (bytes + size > MAX_LLM_IMAGE_BYTES) { result.materials.push(item); continue; }
      bytes += size; result.images.push(input); result.materials.push({ ...item, status: 'attached' });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MaterialError && ['OUT_OF_SCOPE', 'SOURCE_CHANGED', 'SOURCE_MISSING'].includes(error.code)) throw error;
      result.materials.push({ ...item, status: 'unavailable' });
    }
  }
  return result;
}

/** Deterministic source-image appendix, also present when the author is text-only.
 * Never claim that a screenshot has been recognised or that its formula is valid. */
export function textbookSourceImageAppendix(sources: TextbookSource[], body: string): string[] {
  const used = new Set<string>();
  // Avoid confusing a prose mention of an ID with an actual displayed image.
  for (const match of body.matchAll(/```textbook-image\s*\n([\s\S]*?)\n```/gu)) {
    try { const value = JSON.parse(match[1]); if (typeof value.assetId === 'string') used.add(value.assetId); } catch { /* normal gate handles bad blocks */ }
  }
  const images = sources.flatMap(source => (source.assets || []).filter(asset => !used.has(asset.id))
    .map(asset => `\`\`\`textbook-image\n${JSON.stringify({ assetId: asset.id, caption: '资料原图：请对照原页阅读；截图保留不代表公式已识别或验证。' })}\n\`\`\`\n\n[${source.sourceId}]`));
  return images.length ? ['## 资料原图', '以下保留已采集的公式／图示原图。无法识别的部分以原图为准，不据此补造推导。', ...images] : [];
}
