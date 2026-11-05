import { createHash } from 'node:crypto';
import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { isLocalRasterDataUrl, MAX_TEXTBOOK_IMAGE_BYTES } from '../services/textbook/localImages';
import type { TextbookSupplementGap, TextbookSupplementPolicy, TextbookSupplementResult } from '../services/textbook/supplement';
import { textbookHash } from '../services/textbook/fingerprint';
import { safeTextbookWebError } from '../services/textbook/webErrors';
import { webAcquisition, type WebSearchHit } from './webAcquisition';
import { readTextbookBoundBodyWithBrowser } from './textbookWebFallback';
import { fetchTextbookPublicBody, type ReadWebBody } from './textbookWebReader';
import { saveTextbookImageAttachment } from './textbookImageAttachments';
import { assertReadableText, isTextbookCatalogPage, isTextbookVideoPage } from './textbookWebContent';
import { hasTeachingTable, textbookTeachingBodyIssue } from '../services/textbook/webMaterialAssessment';
import { textbookSupplementQuery } from '../services/textbook/supplement';
import { discoverTextbookPublicImages } from './textbookImageDiscovery';
import { discoverTextbookPublicTable } from './textbookTableDiscovery';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { attemptWebApi } from './webApiFallback';

export interface TextbookSupplementDependencies {
  search?: typeof webAcquisition.search;
  browserSearch?: (query: string, signal: AbortSignal) => Promise<WebSearchHit[]>;
  read?: typeof readTextbookBoundBodyWithBrowser;
  image?: typeof fetchTextbookPublicBody;
  saveImage?: typeof saveTextbookImageAttachment;
  discoverImages?: typeof discoverTextbookPublicImages;
  discoverTable?: typeof discoverTextbookPublicTable;
}
/** Optional, bounded discovery. Only frozen public terms leave this process;
 * never send profiles, note prose, cognition or local source text to search. */
export async function collectTextbookSupplement(jobId: string, policy: TextbookSupplementPolicy, gaps: TextbookSupplementGap[],
  caller: AbortSignal, deps: TextbookSupplementDependencies = {}): Promise<TextbookSupplementResult> {
  const result: TextbookSupplementResult = { snapshots: [], warnings: [], queries: [] };
  const signal = AbortSignal.any([caller, AbortSignal.timeout(45_000)]);
  const seen = new Set<string>(); let reads = 0, images = 0;
  const plans = gaps.filter(g => policy.topics.includes(g.term)).slice(0, 2);
  for (const [planIndex, original] of plans.entries()) {
    if (signal.aborted) break;
    if (result.snapshots.length >= 3 || reads >= 6) break;
    const missingTopic = !result.snapshots.some(s => s.text.includes(original.term));
    const missingTable = policy.tables && !result.snapshots.some(s => hasTeachingTable(s.text));
    const missingImage = policy.images && images === 0;
    if (planIndex > 0 && !missingTopic && !missingTable && !missingImage) break;
    const reason = planIndex > 0 && !missingTopic ? missingTable ? 'table' : missingImage ? 'image' : original.reason : original.reason;
    const gap = { ...original, reason, query: textbookSupplementQuery(policy, original.term, reason) };
    result.queries.push(gap.query);
    try {
      const attempt = await attemptWebApi(abort => (deps.search || webAcquisition.search)(gap.query, 'textbook-blueprint', { count: 12, signal: abort }), { signal });
      let hits = attempt.value;
      if (hits === null) {
        if (attempt.fallbackReason === 'transient') result.warnings.push('联网 API 暂时不可用，已降级到内置浏览器检索');
        const browser = deps.browserSearch || (async (query, abort) => (await import('./resourceBrowser')).searchTextbookLinksInBrowser(query, abort));
        hits = await browser(gap.query, signal);
      }
      // Reserve one source slot and read attempt for a second missing format,
      // rather than filling the entire quota with the first search's prose.
      const sourceCap = planIndex === 0 && plans.length > 1 ? 2 : 3;
      const readCap = planIndex === 0 && plans.length > 1 ? 4 : 6;
      const rank = (hit: WebSearchHit) => (/课程|course|目录|大纲|馆藏|出版社|图书/iu.test(hit.title) ? 4 : 0)
        - (/百科|科普|定义|原理|overview/iu.test(hit.title) ? 2 : 0)
        - (hit.title.trim() === gap.term ? 2 : 0)
        - (gap.reason === 'table' && /参数|数据|比较|对照/u.test(hit.title) ? 2 : 0)
        + (gap.reason === 'table' && /(?:lat|lng|tz)=/iu.test(hit.url) ? 4 : 0)
        + (gap.reason === 'table' && /构建.*表|创建.*表|table.*(?:tutorial|markup)|html.*table/iu.test(hit.title) ? 4 : 0);
      const ranked = [...hits].sort((a, b) => rank(a) - rank(b));
      for (const hit of ranked) {
        if (result.snapshots.length >= sourceCap || reads >= readCap || signal.aborted) break;
        // Search snippets choose candidates only; they never become textbook evidence.
        if (!`${hit.title} ${hit.snippet}`.includes(gap.term)) continue;
        let url: string; try { url = textbookPublicUrl(hit.url); } catch { continue; }
        if (isTextbookCatalogPage(url) || isTextbookVideoPage(url)) continue;
        const target = new URL(url);
        let decodedPath: string; try { decodedPath = decodeURIComponent(target.pathname); } catch { continue; }
        if (/\/opac\/(?:book|search)\//iu.test(target.pathname)
          || /(?:^|\.)wikipedia\.org$/iu.test(target.hostname) && (target.searchParams.has('diff')
            || /\/(?:wiki|zh(?:-[a-z]+)?)\/(?:Portal|Category|Special|Talk|Template|File|主题|主題|专题|分類|分类|讨论|討論|模板|文件|檔案):/iu.test(decodedPath))) continue;
        if (/\.(?:wtt|zip|rar|7z|mp[34]|png|jpe?g|webp|gif|svg)$/iu.test(new URL(url).pathname)) continue;
        if (seen.has(url)) continue; seen.add(url); reads++;
        try {
          const resourceId = `S${result.snapshots.length + 1}`;
          let body: ReadWebBody = await (deps.read || readTextbookBoundBodyWithBrowser)({ id: resourceId, url, title: hit.title },
            AbortSignal.any([signal, AbortSignal.timeout(8000)]));
          signal.throwIfAborted(); assertReadableText(body.text);
          if (!body.text.includes(gap.term)) continue;
          const issue = textbookTeachingBodyIssue(body.text); if (issue) { result.warnings.push(issue); continue; }
          if (gap.reason === 'table' && !hasTeachingTable(body.text)) {
            if (body.acquisition === 'provider_api' && ['html', 'text'].includes(body.format)) {
              try { body = await (deps.discoverTable || discoverTextbookPublicTable)(body.finalUrl, gap.term, signal) || body; }
              catch { caller.throwIfAborted(); }
            }
            // A plain article/code tutorial cannot consume the last table slot.
            if (!hasTeachingTable(body.text)) { result.warnings.push('该候选未取得有效教学表格，继续尝试其它来源'); continue; }
          }
          const web = { snapshotId: `${jobId}-${resourceId}`, url, finalUrl: textbookPublicUrl(body.finalUrl), readAt: new Date().toISOString(),
            contentType: body.contentType, format: body.format, coverage: 'full_text' as const,
            contentKind: body.contentKind || inferWebEvidenceKind(url, body.text), acquisition: body.acquisition,
            ...(body.transcriptUrl ? { transcriptUrl: body.transcriptUrl } : {}) };
          // Store exactly the retrieved body, not summaries and not model paraphrases.
          const version = await textbookHash({ text: body.text, web });
          const snapshot = { schemaVersion: 1 as const, jobId, resourceId, title: hit.title.slice(0, 300), web, text: body.text, version,
            assets: [] as NonNullable<import('../services/textbook/webTypes').TextbookWebSnapshot['assets']> };
          const attemptedImages = new Set<string>();
          const saveCandidates = async (candidates: Array<{ url: string; alt: string }>) => {
            for (const image of candidates.slice(0, 6)) {
              if (images >= 3 || snapshot.assets.length >= 2 || signal.aborted) break;
              try {
                const originUrl = textbookPublicUrl(image.url);
                if (attemptedImages.has(originUrl)) continue;
                attemptedImages.add(originUrl);
                const raw = await (deps.image || fetchTextbookPublicBody)(originUrl, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
                signal.throwIfAborted();
                if (raw.bytes.length > MAX_TEXTBOOK_IMAGE_BYTES) throw new Error('图片超过大小限制');
                const type = raw.contentType.split(';')[0].toLowerCase().trim();
                const dataUrl = `data:${type};base64,${raw.bytes.toString('base64')}`;
                if (!isLocalRasterDataUrl(dataUrl)) throw new Error('图片超过像素或安全格式限制');
                const imageIndex = snapshot.assets.length, blockId = `${resourceId}:web-image:${imageIndex}`;
                const saved = await (deps.saveImage || saveTextbookImageAttachment)({ allowedDocIds: [resourceId], docId: resourceId, version, blockId, imageIndex },
                  { dataUrl, alt: image.alt.slice(0, 300) });
                if (!saved.attachmentHash) throw new Error('图片未保存为本地附件');
                snapshot.assets.push({ id: `web-image-${createHash('sha256').update(`${jobId}:${resourceId}:${imageIndex}`).digest('hex').slice(0, 24)}`,
                  sourceId: resourceId, docId: resourceId, version, blockId, imageIndex, attachmentHash: saved.attachmentHash, originUrl, alt: image.alt.slice(0, 300) });
                images++;
              } catch { caller.throwIfAborted(); result.warnings.push('部分在线图片无法安全下载，已跳过图片，保留可用文字和表格'); }
            }
          };
          await saveCandidates(body.images || []);
          // Missing metadata and wholly unusable API links need the same fallback.
          // Try the same page only once, under the existing deadline and quotas.
          if (!snapshot.assets.length && policy.images && images === 0 && !signal.aborted && ['html', 'text'].includes(body.format)) {
            try { await saveCandidates(await (deps.discoverImages || discoverTextbookPublicImages)(body.finalUrl, gap.term, signal)); }
            catch { caller.throwIfAborted(); result.warnings.push('该正文未取得可用原网页图片，已跳过图片，继续文字和表格'); }
          }
          result.snapshots.push(snapshot);
        } catch (error) { caller.throwIfAborted(); result.warnings.push(`补缺网页已跳过：${safeTextbookWebError(error)}`); }
      }
    } catch (error) { caller.throwIfAborted(); result.warnings.push(`联网补缺未完成，使用已有物料继续：${safeTextbookWebError(error)}`); }
  }
  caller.throwIfAborted();
  if (signal.aborted) result.warnings.push('联网补缺达到 45 秒时限，保留已取得物料并继续生成');
  if (!result.snapshots.length) result.warnings.push('联网补缺未取得可用正文，继续使用已有本地资料及关联知识点');
  if (result.snapshots.length && policy.images && !images) result.warnings.push('本轮在线补充未取得可用配图，继续使用已有正文、表格或本地图片');
  if (result.snapshots.length && policy.tables && !result.snapshots.some(s => hasTeachingTable(s.text))) result.warnings.push('本轮在线补充未取得有效教学表格，继续使用已有物料，不编造数据');
  result.warnings = [...new Set(result.warnings)].slice(0, 8);
  return result;
}
