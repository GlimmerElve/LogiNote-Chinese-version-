import { findInteractiveFigureEntries } from './interactiveFigureMarker';
import { figureLesson, interactiveFigureKey } from './interactiveFigure';
import { chemistryPredictionForDisplay } from './interactiveFigurePredictionGate';
import { sharedTeachingBody } from '../progressiveLearning/share';
import type { FigureArtifact } from '../../electron/interactiveFigureStore';
import type { TextbookManifest } from './types';
import type { StyledExportAssets } from './exportAssetTypes';
import type { prepareTextbookExportAssets } from './prepareTextbookExportAssets';

export interface FigureShareApi {
  read(key: string): Promise<FigureArtifact | null>;
  portable(html: string): Promise<{ html: string; license: string }>;
  preflight?(html: string): Promise<void>;
}

/** Explicit export of the visible teaching region only; no vault or profile. */
export async function buildInteractiveFigureShare(input: { noteId: string; title: string; body: string; manifest?: TextbookManifest; manualFigures?: Array<{ brief: string }> }, api: FigureShareApi,
  renderHtml?: (title: string, body: string, assets?: StyledExportAssets) => Promise<string>,
  prepareAssets?: (body: string, manifest?: TextbookManifest) => Promise<Awaited<ReturnType<typeof prepareTextbookExportAssets>>>) {
  if (!input.noteId || !input.body || input.body.length > 5_000_000) throw Error('教材为空或过大，未导出');
  const original = findInteractiveFigureEntries(input.body);
  const manual = (input.manualFigures || []).filter(item => item.brief && item.brief.length <= 1200 && !original.some(entry => entry.brief === item.brief));
  if (original.length + manual.length > 30) throw Error('单次最多导出 30 个交互探索，请拆分教材后重试');
  const { zip, strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array> = {}, byBrief = new Map<string, string>();
  let license = '', missing = 0;
  for (const entry of [...original, ...manual]) {
    if (byBrief.has(entry.brief)) continue;
    const key = await interactiveFigureKey(input.noteId, input.body, entry.brief);
    const saved = await api.read(key);
    if (!saved || saved.status !== 'ready') { missing++; continue; }
    let display: string;
    try {
      display = chemistryPredictionForDisplay(saved.html, figureLesson(input.body, entry.brief), entry.brief, saved.design?.prediction);
      if (display !== saved.html && api.preflight) await api.preflight(display);
    } catch { missing++; continue; }
    const portable = await api.portable(display);
    if (!portable || typeof portable.html !== 'string' || portable.html.length > 1_000_000 || typeof portable.license !== 'string') throw Error('交互图导出失败');
    const file = `figures/figure-${byBrief.size + 1}.html`;
    files[file] = strToU8(portable.html); byBrief.set(entry.brief, file); license ||= portable.license;
  }
  let assetResult: Awaited<ReturnType<typeof prepareTextbookExportAssets>> = { body: input.body, files: {}, assets: {}, missingImages: 0, missingVisuals: 0, savedImages: 0, savedVisuals: 0, assetError: '' };
  try {
    const prepare = prepareAssets || (await import('./prepareTextbookExportAssets')).productionTextbookExportAssets;
    assetResult = await prepare(input.body, input.manifest);
    Object.assign(files, assetResult.files);
  } catch { assetResult.assetError = '素材分析未完成，图示或原图可能未能导出'; }
  let body = sharedTeachingBody(assetResult.body, { includeFigureAttachments: true });
  const positions = findInteractiveFigureEntries(body);
  for (const entry of positions.reverse()) {
    const file = byBrief.get(entry.brief);
    const suffix = file ? `\n\n[打开离线交互图](${file})` : '\n\n（此交互图尚未生成或未能随包导出。）';
    body = body.slice(0, entry.end) + suffix + body.slice(entry.end);
  }
  if (manual.length) {
    body += '\n\n## 补充交互探索\n';
    for (const entry of manual) {
      const file = byBrief.get(entry.brief);
      const label = entry.brief.replace(/\s+/gu, ' ').slice(0, 100).replace(/[\\`*_{}[\]<>]/gu, '\\$&');
      body += `\n- ${label}：${file ? `[打开离线交互图](${file})` : '（此交互图尚未生成或未能随包导出。）'}\n`;
    }
  }
  const title = input.title.replace(/[\r\n]/gu, ' ').trim().slice(0, 160) || '学习教材';
  files['教材.md'] = strToU8(`# ${title}\n\n${body.trim()}\n`);
  let htmlError = '';
  try {
    const render = renderHtml || (await import('./styledTextbookHtmlClient')).renderStyledTextbookHtmlInWorker;
    files['教材.html'] = strToU8(await render(title, body, assetResult.assets));
  } catch (error) { htmlError = error instanceof Error ? error.message : 'HTML 导出失败'; }
  files['说明.txt'] = strToU8(`解压后打开“教材.html”离线阅读，或打开“教材.md”。HTML 的函数图及黎曼柱为教材初始参数的静态画面；可展开查看图示源码。Markdown 保留图示源码，并通过相对路径引用导出的原图。点击链接打开已生成的离线交互图。分享前请核对内容和附件。${assetResult.missingImages ? `\n未能读取的原图：${assetResult.missingImages} 张。` : ''}${assetResult.missingVisuals ? `\n未能渲染的图示：${assetResult.missingVisuals} 张，HTML 保留源码。` : ''}${assetResult.assetError ? `\n${assetResult.assetError}` : ''}${htmlError ? `\nHTML 未生成：${htmlError}` : ''}\n`);
  if (license) files['figures/ANATOMY-LICENSE.txt'] = strToU8(license);
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 0 }, (error, result) => error ? reject(error) : resolve(result)));
  return { bytes, included: byBrief.size, missing, htmlError, missingImages: assetResult.missingImages, missingVisuals: assetResult.missingVisuals, assetError: assetResult.assetError, name: `${title.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/u, '') || '学习教材'}-教材.zip` };
}

export function downloadInteractiveFigureShare(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
