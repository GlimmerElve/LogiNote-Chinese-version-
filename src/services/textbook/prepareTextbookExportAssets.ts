import { parseTextbookImage } from './contentSchema';
import { exportVisualKey, type StyledExportAssets } from './exportAssetTypes';
import type { TextbookManifest } from './types';
import type { ExportBlock } from './exportAssetsClient';

type AssetWorker = {
  plan(body: string, sourceIds?: string[]): Promise<ExportBlock[]>;
  image(dataUrl: string): Promise<{ extension: string; bytes: Uint8Array }>;
  svg(svg: string): Promise<{ dataUrl: string }>;
  close(): void;
};
export interface ExportAssetDependencies {
  createWorker(): AssetWorker;
  readImage: typeof import('../documentRagClient').readLocalMaterialImage;
  renderVisual(language: 'mermaid' | 'function-plot' | 'chart' | 'molecule', code: string): Promise<string>;
}

/** Explicit export only. The only readable image pointers come from this textbook's manifest. */
export async function prepareTextbookExportAssets(body: string, manifest: TextbookManifest | undefined, deps: ExportAssetDependencies) {
  const files: Record<string, Uint8Array> = {}, assets: StyledExportAssets = { visuals: {}, images: {}, sourceIds: manifest?.sources?.map(s => s.sourceId) || [] };
  let missingImages = 0, missingVisuals = 0, savedImages = 0, savedVisuals = 0, assetError = '';
  const worker = deps.createWorker();
  try {
    const items = await worker.plan(body, assets.sourceIds);
    missingVisuals += items.filter(item => item.language === 'science-diagram' && item.error).length;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const images = new Map<string, { file: string; dataUrl: string }>();
    let totalBytes = 0;
    for (const item of items.filter(item => item.language === 'textbook-image')) {
      let replacement = '（此资料原图未能随教材导出，请在原项目中查看。）';
      try {
        const ref = parseTextbookImage(item.code, { assetIds: manifest?.assets?.map(asset => asset.id) });
        const asset = manifest?.assets?.find(value => value.id === ref.assetId);
        const source = manifest?.sources?.find(value => value.sourceId === asset?.sourceId);
        const webImage = source?.kind === 'web' && !!asset?.attachmentHash && asset.blockId === `${source.id}:web-image:${asset.imageIndex}`;
        if (!asset || !source || (!webImage && (source.kind !== 'document' || source.blockId !== asset.blockId)) || source.id !== asset.docId || source.version !== asset.version)
          throw Error('资料版本或来源不匹配');
        let image = images.get(asset.id);
        if (!image) {
          if (images.size >= 32) throw Error('本次原图数量达到上限');
          const result = await deps.readImage({ allowedDocIds: [asset.docId], docId: asset.docId, version: asset.version, blockId: asset.blockId, imageIndex: asset.imageIndex,
            ...(asset.attachmentHash ? { attachmentHash: asset.attachmentHash } : {}) });
          const raster = await worker.image(result.dataUrl);
          if (totalBytes + raster.bytes.byteLength > 24 * 1024 * 1024) throw Error('本次原图体积达到上限');
          totalBytes += raster.bytes.byteLength;
          const file = `assets/material-${images.size + 1}.${raster.extension}`;
          files[file] = raster.bytes; image = { file, dataUrl: result.dataUrl }; images.set(asset.id, image); assets.images![file] = result.dataUrl; savedImages++;
        }
        const alt = (ref.caption || asset.alt || '资料原图').replace(/[\r\n]+/gu, ' ').replace(/([\\\[\]])/gu, '\\$1').slice(0, 400);
        replacement = `![${alt}](${image.file})`;
      } catch { missingImages++; }
      replacements.push({ start: item.start, end: item.end, value: replacement });
    }
    for (const entry of replacements.sort((a, b) => b.start - a.start)) body = body.slice(0, entry.start) + entry.value + body.slice(entry.end);
    const seen = new Set<string>(); let totalSvgBytes = 0;
    for (const item of items.filter(item => ['mermaid', 'function-plot', 'chart', 'molecule'].includes(item.language))) {
      // The share projection removes private/local citation markers everywhere,
      // including figure labels. Match the exact code that reaches HTML rendering.
      const key = exportVisualKey(item.language, item.code.replace(/\[(?:S|L)\d+\]/gu, ''));
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 80) { missingVisuals++; continue; }
      try {
        const svg = await deps.renderVisual(item.language as 'mermaid' | 'function-plot' | 'chart' | 'molecule', item.code);
        const dataUrl = (await worker.svg(svg)).dataUrl;
        if (totalSvgBytes + dataUrl.length > 24 * 1024 * 1024) throw Error('本次图示体积达到上限');
        totalSvgBytes += dataUrl.length; assets.visuals![key] = dataUrl; savedVisuals++;
      } catch { missingVisuals++; }
    }
  } catch { assetError = '素材分析未完成，图示或原图可能未能导出'; }
  finally { worker.close(); }
  return { body, files, assets, missingImages, missingVisuals, savedImages, savedVisuals, assetError };
}

export async function productionTextbookExportAssets(body: string, manifest?: TextbookManifest) {
  const [{ createTextbookExportAssetWorker }, { readLocalMaterialImage }, { renderMermaidInFrame }, { textbookVisualRenderQueue }] = await Promise.all([
    import('./exportAssetsClient'), import('../documentRagClient'), import('../ui/mermaidFrameRenderer'), import('../ui/textbookVisualQueue'),
  ]);
  return prepareTextbookExportAssets(body, manifest, { createWorker: createTextbookExportAssetWorker, readImage: readLocalMaterialImage,
    renderVisual: async (kind, code) => {
      const task = textbookVisualRenderQueue.enqueue(context => renderMermaidInFrame({ id: `export-${crypto.randomUUID()}`, code, dark: false,
        ...(kind === 'mermaid' ? {} : { visualKind: kind, width: 800 }), signal: context.signal }));
      return (await task.result).svg;
    },
  });
}
