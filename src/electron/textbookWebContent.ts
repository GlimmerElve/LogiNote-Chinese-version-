import { parse, type DefaultTreeAdapterMap } from 'parse5';

type HtmlNode = DefaultTreeAdapterMap['node'];
export type HtmlContentKind = 'article' | 'abstract';
const MAX_TEXT = 200_000;
const OMIT = new Set(['script', 'style', 'nav', 'footer', 'header', 'aside', 'form', 'button', 'input', 'noscript', 'template', 'iframe', 'svg']);
const BOILERPLATE = /(?:^|[\s_-])(?:nav(?:bar|igation)?|menu|footer|sidebar|breadcrumb|share|related|recommend(?:ation)?|advert(?:isement)?|toolbar|copyright|comment(?:s)?)(?:$|[\s_-])/iu;
function children(node: HtmlNode): HtmlNode[] { return 'childNodes' in node ? node.childNodes : []; }
function tag(node: HtmlNode): string { return 'tagName' in node ? node.tagName : ''; }
function attribute(node: HtmlNode, name: string): string { return 'attrs' in node ? node.attrs.find(item => item.name === name)?.value || '' : ''; }
function hidden(node: HtmlNode): boolean {
  return OMIT.has(tag(node)) || ['navigation', 'complementary', 'contentinfo'].includes(attribute(node, 'role'))
    || attribute(node, 'aria-hidden') === 'true' || ('attrs' in node && node.attrs.some(item => item.name === 'hidden'))
    || /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attribute(node, 'style'))
    || (!['html', 'body', 'main', 'article'].includes(tag(node)) && BOILERPLATE.test(`${attribute(node, 'id')} ${attribute(node, 'class')}`));
}
function flatten(node: HtmlNode, depth = 0): string {
  if (depth > 180) throw new Error('网页结构过深，无法安全解析');
  if (hidden(node)) return '';
  if ('value' in node && node.nodeName === '#text') return node.value;
  if (tag(node) === 'br') return '\n';
  return children(node).map(child => flatten(child, depth + 1)).join('');
}
function descendants(root: HtmlNode, includeScripts = false): HtmlNode[] {
  const result: HtmlNode[] = [], pending: Array<[HtmlNode, number]> = [[root, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (depth > 180 || result.length > 50_000) throw new Error('网页结构超出解析上限');
    if (hidden(node) && !(includeScripts && tag(node) === 'script')) continue;
    result.push(node); for (const child of [...children(node)].reverse()) pending.push([child, depth + 1]);
  }
  return result;
}
function rawText(node: HtmlNode): string {
  return children(node).filter(child => child.nodeName === '#text').map(child => 'value' in child ? child.value : '').join('');
}
/** Article images only; no icons, tracking pixels, arbitrary scripts or link crawling. */
export function extractTextbookImageLinks(html: string, pageUrl: string): Array<{ url: string; alt: string }> {
  const nodes = descendants(parse(html));
  const root = nodes.find(n => tag(n) === 'article') || nodes.find(n => tag(n) === 'main')
    || nodes.filter(n => /(?:^|[\s_-])(?:mw-parser-output|lemma-content|article[-_]?content|entry-content|post-content|richtext)(?:$|[\s_-])/iu.test(`${attribute(n, 'class')} ${attribute(n, 'id')}`))
      .sort((a, b) => flatten(b).length - flatten(a).length)[0]
    || nodes.find(n => tag(n) === 'body');
  if (!root) return [];
  return descendants(root).filter(n => tag(n) === 'img').flatMap(n => {
    let parent = 'parentNode' in n ? n.parentNode : undefined, caption: HtmlNode | undefined;
    for (let depth = 0; parent && depth < 4; depth++, parent = 'parentNode' in parent ? parent.parentNode : undefined) {
      if (tag(parent) === 'figure' || /(?:^|\s)thumb(?:\s|$)/u.test(attribute(parent, 'class'))) {
        caption = descendants(parent).find(c => tag(c) === 'figcaption' || /thumbcaption/u.test(attribute(c, 'class'))); break;
      }
    }
    let alt = `${attribute(n, 'alt')} ${caption ? flatten(caption) : ''}`.replace(/\s+/gu, ' ').trim().slice(0, 300);
    // Many public rich-text articles omit alt text entirely. A scoped image may
    // still be displayed, but its generic caption must not invent image facts.
    if (!alt) {
      let context = 'parentNode' in n ? n.parentNode : undefined;
      for (let depth = 0; context && context !== root && depth < 4; depth++, context = 'parentNode' in context ? context.parentNode : undefined) {
        if (flatten(context).length >= 100) { alt = '原网页配图（未作图像识别）'; break; }
      }
    }
    if (alt.length < 2 || /logo|avatar|icon|二维码|头像|广告/iu.test(alt)
      || ['width', 'height'].some(key => /^\d+$/u.test(attribute(n, key)) && Number(attribute(n, key)) < 80)) return [];
    const sizes = (attribute(n, 'data-srcset') || attribute(n, 'srcset')).split(',').flatMap(item => {
      const match = /^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/u.exec(item.trim());
      return match ? [{ url: match[1], size: Number(match[2]) * (match[3] === 'x' ? 640 : 1) }] : [];
    }).filter(item => item.size <= 1200).sort((a, b) => b.size - a.size);
    const source = sizes[0]?.url || attribute(n, 'data-original') || attribute(n, 'data-src') || attribute(n, 'data-actualsrc') || attribute(n, 'data-lazy-src') || attribute(n, 'src');
    if (/(?:^|[/_.-])(?:logo|avatar|qrcode|icon|share)(?:[_.\/-]|$)/iu.test(source)) return [];
    try { return [{ url: new URL(source, pageUrl).href, alt }]; } catch { return []; }
  }).slice(0, 6);
}
export function extractTextbookMarkdownImages(text: string, pageUrl: string): Array<{ url: string; alt: string }> {
  const content = text.replace(/```[^\n]*\n[\s\S]*?```/gu, '');
  return [...content.matchAll(/!\[([^\]\n]{2,300})\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)].slice(0, 6).flatMap(match => {
    if (/logo|avatar|icon|二维码|头像|广告/iu.test(match[1])) return [];
    try { return [{ url: new URL(match[2], pageUrl).href, alt: match[1] }]; } catch { return []; }
  });
}
export function assertReadableText(text: string): void {
  const replacements = (text.match(/\uFFFD/gu) || []).length;
  if (replacements > 2 && replacements / Math.max(1, text.length) > 0.002) throw new Error('正文存在明显编码乱码，未作为教材证据；请下载正确编码的本地资料');
  if (text.trim().length < 100) throw new Error('正文内容不足（扫描 PDF 可能需要先 OCR），不能作为教材证据');
  if (text.length > MAX_TEXT) throw new Error('资源正文超过 20 万字，请下载为本地资料后按目录选择');
}
/** BOM, HTTP charset, HTML meta charset, then strict UTF-8 / legacy Chinese fallback. */
export function decodeTextbookBody(bytes: Buffer, contentType: string): string {
  const prefix = bytes.subarray(0, 8192).toString('latin1');
  const httpCharset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1];
  const metaCharset = /<meta\b[^>]*\bcharset\s*=\s*["']?([a-z0-9_-]+)/iu.exec(prefix)?.[1];
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : undefined;
  const candidates = [...new Set([bom, httpCharset, metaCharset, 'utf-8', ...(!bom && !httpCharset && !metaCharset ? ['gb18030'] : [])].filter(Boolean))] as string[];
  for (const charset of candidates) {
    // Unknown explicit charsets must not be silently interpreted as UTF-8.
    try { new TextDecoder(charset); } catch { throw new Error('网页正文字符编码不受支持'); }
    try {
      const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
      if (text.includes('\u0000')) throw new Error('binary');
      return text;
    } catch { /* Try the next declared encoding, but never publish replacement-character garbage. */ }
  }
  throw new Error('网页正文字符编码无效或包含乱码，未作为教材证据');
}

/** Inert DOM extraction. No JavaScript, images, browser cookies or automatic link crawling. */
export function extractTextbookHtml(html: string, requireBody = true): { text: string; tracks: string[]; contentKind: HtmlContentKind; hasVideo: boolean; hasArticle: boolean; tables: string[] } {
  const document = parse(html), nodes = descendants(document);
  const contentName = (node: HtmlNode) => `${attribute(node, 'id')} ${attribute(node, 'class')} ${attribute(node, 'name') === '#abstract' ? 'abstract' : ''}`;
  const article = nodes.find(node => tag(node) === 'article');
  const named = nodes.filter(node => /(?:^|[\s_-])(?:article[-_]?body|article[-_]?content|mw-parser-output|lemma-content|richtext|vsbcontent|v_news_content|entry-content|post-content|text-body|read-content|abstract|ans-cc|contentDescriptionBox|blockquote-list)(?:$|[\s_-])/iu.test(contentName(node)))
    .slice(0, 64).map(node => ({ node, length: flatten(node).length })).filter(item => item.length >= 100 && tag(item.node) !== 'a').sort((a, b) => b.length - a.length);
  const root = article || named[0]?.node
    || nodes.find(node => tag(node) === 'main' || attribute(node, 'role') === 'main') || nodes.find(node => tag(node) === 'body') || document;
  const parts: string[] = [], tables: string[] = []; let prose = 0, structured = 0, linkText = 0;
  const walk = (node: HtmlNode, depth = 0) => {
    if (depth > 180) throw new Error('网页结构过深，无法安全解析');
    if (hidden(node)) return;
    const name = tag(node);
    if (name === 'table') {
      const tableNodes = descendants(node);
      const hasHeader = tableNodes.some(child => tag(child) === 'th');
      const layout = !hasHeader && tableNodes.some(child => ['ul', 'ol', 'div', 'section', 'article', 'table'].includes(tag(child)) && child !== node);
      if (layout) { for (const child of children(node)) walk(child, depth + 1); return; }
      const cells = tableNodes.filter(child => tag(child) === 'tr').map(row => children(row)
        .filter(cell => ['td', 'th'].includes(tag(cell))).map(cell => flatten(cell).trim().replace(/\s+/gu, ' ').replace(/\|/gu, '\\|')));
      const merged = tableNodes.some(child => ['colspan', 'rowspan'].some(key => Number(attribute(child, key) || 1) > 1));
      const rectangular = !merged && cells.length > 1 && cells[0].length > 0 && cells.every(row => row.length === cells[0].length);
      const rows = hasHeader && rectangular ? [cells[0].join(' | '), cells[0].map(() => '---').join(' | '), ...cells.slice(1).map(row => row.join(' | '))]
        : [...(merged ? ['原表包含合并单元格，以下仅保留逐行文本，不推定缺省单元格。'] : []), ...cells.map(row => row.join(' | '))];
      const text = rows.join('\n'), anchors = tableNodes.filter(child => tag(child) === 'a').reduce((total, child) => total + flatten(child).length, 0);
      if (hasHeader && rectangular) tables.push(text);
      parts.push(text); linkText += anchors; if (anchors < text.length * 0.5) structured += text.length; return;
    }
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'blockquote', 'pre', 'figcaption', 'math'].includes(name)) {
      const text = name === 'pre' ? flatten(node).trim() : flatten(node).replace(/\s+/gu, ' ').trim();
      const anchors = descendants(node).filter(child => tag(child) === 'a').reduce((total, child) => total + flatten(child).length, 0);
      linkText += anchors;
      if (text) parts.push(/^h\d$/u.test(name) ? `${'#'.repeat(Number(name[1]))} ${text}` : name === 'li' ? `- ${text}` : text);
      if (['pre', 'math'].includes(name)) structured += text.length;
      else if (!/^h\d$/u.test(name) && text.length >= 40 && anchors < text.length * 0.65) prose += text.length - anchors;
      return;
    }
    if (node.nodeName === '#text' && 'value' in node && node.value.trim()) {
      const text = node.value.replace(/\s+/gu, ' ').trim(); parts.push(text);
      if (text.length >= 80 && /[。！？；.!?;]/u.test(text)) prose += text.length;
      if ('parentNode' in node && tag(node.parentNode!) === 'a') linkText += text.length;
    } else for (const child of children(node)) walk(child, depth + 1);
  };
  walk(root);
  const text = parts.join('\n\n').trim();
  if (requireBody) {
    if (text.length < 100 || (prose + structured < 80) || (linkText > text.length * 0.65 && prose < 300 && structured < 100)
      || (text.length < 1600 && /验证码|完成安全验证|请先登录|enable javascript|access denied|checking your browser|verify you are human/iu.test(text))) {
      throw new Error('未取得足够的公开正文（可能只有导航、目录、加载占位或需要登录/验证码）；请下载后绑定本地资料');
    }
    assertReadableText(text);
  }
  const tracks = nodes.filter(node => tag(node) === 'track' && ['subtitles', 'captions'].includes(attribute(node, 'kind')))
    .sort((a, b) => Number(/^zh/iu.test(attribute(b, 'srclang'))) - Number(/^zh/iu.test(attribute(a, 'srclang'))))
    .map(node => attribute(node, 'src')).filter(Boolean);
  // Explicit downloadable caption links only; no arbitrary links/PDFs/videos are followed.
  for (const node of nodes) if (tag(node) === 'a' && /\.(?:vtt|srt|ttml)(?:\?|$)/iu.test(attribute(node, 'href'))) tracks.push(attribute(node, 'href'));
  const contentKind = /(?:^|[\s_-])abstract(?:$|[\s_-])/iu.test(contentName(root)) ? 'abstract' : 'article';
  return { text, tracks, contentKind, hasVideo: nodes.some(node => tag(node) === 'video'), hasArticle: Boolean(article || named[0]), tables };
}

/** Only explicitly published VideoObject transcript/caption data, never arbitrary script execution. */
export function extractPublicVideoData(html: string, pageUrl: string): { transcript?: string; captions: string[]; hasVideo: boolean } {
  const scripts = descendants(parse(html), true).filter(node => tag(node) === 'script' && attribute(node, 'type').toLowerCase() === 'application/ld+json');
  const videos: Record<string, unknown>[] = [];
  const scan = (value: unknown, depth = 0) => {
    if (depth > 20 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => scan(item, depth + 1)); return; }
    const item = value as Record<string, unknown>;
    if ([item['@type']].flat().some(type => type === 'VideoObject' || type === 'https://schema.org/VideoObject')) videos.push(item);
    if (item['@graph']) scan(item['@graph'], depth + 1);
    if (item.mainEntity) scan(item.mainEntity, depth + 1);
  };
  for (const script of scripts.slice(0, 8)) {
    const raw = rawText(script); if (raw.length > 500_000) continue;
    try { scan(JSON.parse(raw)); } catch { /* Malformed structured data is not executable fallback. */ }
  }
  const samePage = (raw: unknown) => { try { const u = new URL(String(raw), pageUrl), p = new URL(pageUrl); return u.origin === p.origin && u.pathname.replace(/\/$/u, '') === p.pathname.replace(/\/$/u, '')
    && u.searchParams.get('v') === p.searchParams.get('v') && (u.searchParams.get('p') || '1') === (p.searchParams.get('p') || '1'); } catch { return false; } };
  const identity = (item: Record<string, unknown>) => [item.url, item['@id'], item.embedUrl].filter(value => typeof value === 'string');
  const video = videos.find(item => identity(item).some(samePage)) || (videos.length === 1 && !identity(videos[0]).length ? videos[0] : undefined);
  const captions: string[] = [];
  if (video && video.requiresSubscription !== true && video.isAccessibleForFree !== false) {
    for (const caption of [video.caption].flat().slice(0, 3)) if (caption && typeof caption === 'object') {
      const item = caption as Record<string, unknown>; if (typeof item.contentUrl === 'string') captions.push(item.contentUrl);
    }
    if (typeof video.transcript === 'string' && video.transcript.trim().length >= 100) {
      const transcript = extractTextbookHtml(`<article>${video.transcript}</article>`, false).text;
      assertReadableText(transcript); return { transcript, captions, hasVideo: true };
    }
  }
  return { captions, hasVideo: Boolean(video) };
}

export function extractTextbookTranscript(value: string): string {
  const text = value.replace(/^\uFEFF/u, '').trim();
  if (text.startsWith('{')) {
    let json: { body?: { from: number; to: number; content: string }[]; events?: { tStartMs: number; dDurationMs: number; segs?: { utf8: string }[] }[] };
    try { json = JSON.parse(text); } catch { throw new Error('字幕 JSON 格式无效'); }
    if (Array.isArray(json.body) && json.body.length <= 50_000 && json.body.every(cue => Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.from >= 0 && cue.to > cue.from && typeof cue.content === 'string')) {
      return json.body.map(cue => cue.content.trim()).filter(Boolean).join('\n');
    }
    if (Array.isArray(json.events) && json.events.length <= 50_000) {
      const cues = json.events.filter(cue => cue.segs?.length);
      if (cues.length && cues.every(cue => Number.isFinite(cue.tStartMs) && cue.tStartMs >= 0 && cue.segs!.every(seg => typeof seg.utf8 === 'string'))) return cues.map(cue => cue.segs!.map(seg => seg.utf8).join('').trim()).filter(Boolean).join('\n');
    }
    throw new Error('字幕 JSON 未提供有效带时间信息的文字稿');
  }
  if (/^<\?xml|^<(?:tt:)?tt\b/iu.test(text)) {
    const validTime = (value: string) => /^(?:\d+(?:\.\d+)?(?:h|m|s|ms|f|t)|\d{2,}:\d{2}:\d{2}(?:\.\d+|:\d{2}(?:\.\d+)?)?)$/u.test(value);
    const cues = descendants(parse(text)).filter(node => ['p', 'tt:p'].includes(tag(node))
      && validTime(attribute(node, 'begin')) && (validTime(attribute(node, 'end')) || validTime(attribute(node, 'dur'))));
    if (!cues.length) throw new Error('TTML 未提供带时间信息的文字字幕');
    return cues.map(cue => flatten(cue).trim()).filter(Boolean).join('\n');
  }
  const seconds = (value: string): number => {
    const values = value.replace(',', '.').split(':').map(Number);
    if (values.some(part => !Number.isFinite(part)) || values.at(-1)! >= 60 || values.at(-2)! >= 60) return NaN;
    return values.reduce((total, part) => total * 60 + part, 0);
  };
  const cleaned: string[] = [];
  // Only payload AFTER a valid cue timeline is evidence. File headers, arbitrary
  // untimed descriptions and string cue IDs must not inflate an otherwise tiny subtitle.
  for (const block of text.replace(/\r\n?/gu, '\n').split(/\n[\t ]*\n/u)) {
    if (/^(?:NOTE|STYLE|REGION)\b/u.test(block.trim())) continue;
    const lines = block.split('\n'), index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const timing = /^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:[\t ].*)?$/u.exec(lines[index]);
    if (!timing || !(seconds(timing[2]) > seconds(timing[1]))) continue;
    cleaned.push(...lines.slice(index + 1).map(line => line.replace(/<[^>]*>/gu, '').trim()).filter(Boolean));
  }
  if (!cleaned.length) throw new Error('字幕未提供有效时间轴；不以页面简介充当文字稿');
  return cleaned.filter((line, index) => line !== cleaned[index - 1]).join('\n');
}

export function isTextbookVideoPage(raw: string, resourceType?: string): boolean {
  const url = new URL(raw), host = url.hostname;
  return resourceType === 'video' || /(?:^|\.)(?:bilibili\.com|youtube\.com|youtu\.be|youku\.com|vimeo\.com|icourse163\.org|open\.163\.com|xuetangx\.com)$/iu.test(host)
    || (/(?:^|\.)163\.com$/iu.test(host) && /\/opencourse\//u.test(url.pathname))
    || (host === 'nerc.edu.cn' && /\/media\/media_detail/iu.test(url.pathname));
}

/** Landing/catalog pages are useful recommendations, but are not lecture/book text. */
export function isTextbookCatalogPage(raw: string): boolean {
  const url = new URL(raw), host = url.hostname;
  return (host === 'higher.smartedu.cn' && /^\/(?:h5\/)?course\//u.test(url.pathname))
    || (/(?:^|\.)chinaooc\.com\.cn$/iu.test(host) && /^\/(?:h5\/)?course\//u.test(url.pathname))
    || (host === 'mooc1.chaoxing.com' && /\/course\/(?:portal|\d)/u.test(url.pathname))
    || (host === 'book.douban.com' && /^\/subject\/\d+\/?$/u.test(url.pathname))
    || (host === 'read.douban.com' && /^\/ebook\/\d+\/?$/u.test(url.pathname))
    || (host === 'www.queshu.com' && /^\/book\//u.test(url.pathname))
    || (host === 'www.wsgph.com' && /\/bookshow\.asp$/iu.test(url.pathname))
    || host === 'www.jd.com';
}
