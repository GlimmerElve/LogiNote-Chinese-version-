import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { jsPDF } from 'jspdf';
import { fetchTextbookPublicBody, readTextbookBoundBody, decodeTextbookBody, extractTextbookHtml,
  extractTextbookTranscript, type PublicFetchDependencies } from '../src/electron/textbookWebReader';
import { extractPublicVideoData } from '../src/electron/textbookWebContent';
import { textbookPublicUrl } from '../src/services/textbook/boundUrls';
import type { TextbookBoundUrl } from '../src/services/textbook/webTypes';

let checks = 0;
function pass(label: string) { checks++; console.log(`PASS ${label}`); }
const text = '心理账户是对金钱进行分类、记账和评估的心理过程。不同来源的金钱可能被分配到不同的账户，而其客观价值并没有改变。需要核对情境条件，并区分描述性观点与已经证实的因果结论。'.repeat(3);
const html = `<article><h1>心理账户</h1><p>${text}</p><pre>if ready:\n    use_example()</pre></article>`;
const resource: TextbookBoundUrl = { id: 'U1', title: '公开教学资料', url: 'https://example.org/read' };
const body = (url: string, value = html, contentType = 'text/html; charset=utf-8') => ({ url, bytes: Buffer.from(value), contentType });
const vtt = `WEBVTT\n\nNOTE not a caption\nnotes must not enter the transcript\n\n1\n00:00:01.000 --> 00:00:10.000\n${text}\n`;

function wire(bytes: Buffer, encoding = 'identity', headers: Record<string, string> = {}, stalled = false) {
  let response: PassThrough | undefined, count = 0;
  const deps: PublicFetchDependencies = {
    resolve: (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as PublicFetchDependencies['resolve'],
    request: ((_url: URL, options: { headers: Record<string, string> }, callback: (value: any) => void) => {
      count++; assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => queueMicrotask(() => {
        response = new PassThrough(); Object.assign(response, { statusCode: 200, headers: { 'content-encoding': encoding, 'content-type': 'text/html', ...headers } });
        callback(response); if (!stalled) response.end(bytes);
      }); return request;
    }) as unknown as PublicFetchDependencies['request'],
  };
  return { deps, response: () => response, count: () => count };
}
for (const [encoding, bytes] of [['gzip', gzipSync(Buffer.from(html))], ['deflate', deflateSync(Buffer.from(html))], ['br', brotliCompressSync(Buffer.from(html))]] as const) {
  const transport = wire(bytes, encoding); const response = await fetchTextbookPublicBody(resource.url, undefined, transport.deps);
  assert.equal(response.bytes.toString('utf8'), html); assert.equal(transport.count(), 1);
}
pass('生产下载器真实流式解压 gzip/deflate/br，仍不传 Cookie/Authorization');
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, wire(Buffer.from('corrupt'), 'gzip').deps), /压缩正文损坏/u);
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, wire(Buffer.from(html), 'gzip, br').deps), /压缩格式/u);
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, wire(Buffer.from(html), 'unknown').deps), /压缩格式/u);
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, wire(Buffer.from(html), 'identity', { 'content-length': '12000001' }).deps), /超过 12 MB/u);
pass('损坏、多重/未知压缩及广告长度超限均明确拒绝');
const large = Buffer.alloc(12_000_001, 97);
const bomb = wire(gzipSync(large), 'gzip');
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, bomb.deps), /解压后超过 12 MB/u);
assert.ok(bomb.response()!.destroyed);
const tooManyWireBytes = wire(large);
await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, tooManyWireBytes.deps), /超过 12 MB/u);
assert.ok(tooManyWireBytes.response()!.destroyed);
pass('小压缩包膨胀超限、实际网络字节超限都终止流，不只信任 Content-Length');
const controller = new AbortController(), stall = wire(Buffer.alloc(0), 'gzip', {}, true);
const waiting = fetchTextbookPublicBody(resource.url, controller.signal, stall.deps);
await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
await assert.rejects(waiting, error => (error as Error).name === 'AbortError'); assert.ok(stall.response()!.destroyed);
pass('取消时销毁响应及解压流，不留下后台下载');

const legacy = Buffer.concat([Buffer.from('<meta content="text/html; charset=gb2312" http-equiv="Content-Type"><article><p>'),
  ...Array.from({ length: 90 }, () => Buffer.from([0xd0, 0xc4, 0xc0, 0xed])), Buffer.from('.</p></article>')]);
const decoded = decodeTextbookBody(legacy, 'text/html'); assert.ok(decoded.includes('心理'.repeat(90)));
const decodedBody = await readTextbookBoundBody(resource, undefined, async url => ({ url, bytes: legacy, contentType: 'text/html' }));
assert.ok(decodedBody.text.includes('心理')); assert.ok(!decodedBody.text.includes('\uFFFD'));
assert.equal(decodeTextbookBody(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), 'text/plain'), text);
assert.throws(() => decodeTextbookBody(Buffer.from([0xff, 0xff]), 'text/plain; charset=utf-8'), /编码/u);
await assert.rejects(readTextbookBoundBody(resource, undefined, async url => body(url, `<p>${'\uFFFD'.repeat(150)}</p>`)), /乱码|公开正文/u);
pass('HTML meta 识别 GB2312/GBK，BOM 支持 UTF-16，严格解码并拒绝乱码');

for (const shell of [
  `<h1>目标文章</h1><div class="navigation">${'<a href="/x">目录与导航</a>'.repeat(100)}</div><div>正文</div><div class="copyright">${text}</div>`,
  `<h1>导图</h1><p>正在加载思维导图...</p><div class="footer">${text}</div>`,
  '<ul>' + '<li><a href="/chapter">第1章：心理学课程目录与学习进度</a></li>'.repeat(30) + '</ul>',
  '<table><tr><td><ul>' + '<li><a href="/chapter">第1章：心理学课程目录与学习进度</a></li>'.repeat(30) + '</ul></td></tr></table>',
]) assert.throws(() => extractTextbookHtml(shell), /公开正文/u);
const clean = extractTextbookHtml(`<div class="navbar">NAV</div><div class="mw-parser-output">${html.replace(/<\/?article>/gu, '')}</div><div class="related">RELATED</div>`);
assert.ok(clean.text.includes(text)); assert.ok(!clean.text.includes('RELATED')); assert.ok(!clean.text.includes('NAV'));
const abstract = extractTextbookHtml(`<a id="abstract">摘要/Abstract</a><div name="#abstract"><p>摘要：</p><p>${text}</p></div>`);
assert.equal(abstract.contentKind, 'abstract'); assert.ok(abstract.text.includes(text));
assert.ok(extractTextbookHtml(`<html class="book-new-nav"><body class="navigation-with-keyboard">${html}</body></html>`).text.includes(text));
const courseLesson = extractTextbookHtml(`<ul>${'<li><a href="/lesson">章节目录与学习进度</a></li>'.repeat(200)}</ul><div class="ans-cc"><p>${text}</p></div>`);
assert.ok(courseLesson.text.includes(text)); assert.ok(!courseLesson.text.includes('章节目录与学习进度'));
pass('目录/纯导航/空导图拒绝；百科正文去噪；摘要锚点不冒充正文，摘要单独标注');
for (const url of ['https://www.icourse163.org/course/demo', 'https://www.163.com/opencourse/detail/video-1',
  'https://higher.smartedu.cn/course/123', 'https://book.douban.com/subject/123/', 'https://read.douban.com/ebook/123/']) {
  await assert.rejects(readTextbookBoundBody({ ...resource, url }, undefined, async value => body(value, html)), /简介|目录|介绍/u);
}
const realLesson = await readTextbookBoundBody({ ...resource, url: 'https://mooc1.chaoxing.com/mooc-ans/nodedetailcontroller/visitnodedetail?courseId=1' }, undefined, async url => body(url, html));
assert.ok(realLesson.text.includes(text));
const articleWithVideo = await readTextbookBoundBody(resource, undefined, async url => body(url, `${html}<video></video>`));
assert.ok(articleWithVideo.text.includes(text));
pass('课程/书籍落地页不充当讲授内容，实际课程章节和配视频的正文仍可读');

assert.ok(extractTextbookTranscript(vtt).includes(text)); assert.ok(!extractTextbookTranscript(vtt).includes('notes must'));
assert.equal(extractTextbookTranscript(JSON.stringify({ body: [{ from: 0, to: 4, content: text }] })), text);
assert.equal(extractTextbookTranscript(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] })), text);
assert.equal(extractTextbookTranscript(`<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="10s">${text}</p></div></body></tt>`), text);
assert.throws(() => extractTextbookTranscript(JSON.stringify({ body: [{ content: text }] })), /时间/u);
assert.throws(() => extractTextbookTranscript(`<p>${text}</p>`), /时间/u);
assert.throws(() => extractTextbookTranscript(`<tt><p begin="intro" end="later">${text}</p></tt>`), /时间/u);
assert.throws(() => extractTextbookTranscript(`WEBVTT\n\n${text}\n\ncue-id\n00:00:10.000 --> 00:00:01.000\n${text}`), /时间/u);
const timedOnly = extractTextbookTranscript(`WEBVTT\n\n${text}\n\nstring-cue-id\n00:00:01.000 --> 00:00:10.000\n真实字幕`);
assert.equal(timedOnly, '真实字幕');
await assert.rejects(readTextbookBoundBody({ ...resource, url: 'https://example.org/a.vtt' }, undefined,
  async url => body(url, `WEBVTT\n\n${text}\n\ncue-id\n00:00:01.000 --> 00:00:10.000\n很短的字幕`, 'text/vtt')), /正文内容不足/u);
pass('VTT/SRT 时间轴、TTML、Bilibili/YouTube 定时 JSON 字幕可读；JSON 简介不能充当字幕');
const captioned = await readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async url => url.endsWith('.srt')
  ? body(url, `1\n00:00:00,000 --> 00:00:10,000\n${text}`, 'text/plain') : body(url, '<a href="/public.srt">Download transcript</a>'));
assert.equal(captioned.format, 'transcript'); assert.equal(captioned.transcriptUrl, 'https://example.org/public.srt');
const retries: string[] = [];
const recovered = await readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async url => {
  retries.push(url);
  if (url.endsWith('bad.vtt')) return body(url, 'Log in', 'text/html');
  if (url.endsWith('good.vtt')) return body(url, vtt, 'text/vtt');
  return body(url, '<video><track kind="subtitles" src="/bad.vtt"><track kind="subtitles" src="/good.vtt"></video>');
});
assert.equal(recovered.text, text); assert.equal(retries.length, 3);
for (const url of ['http://localhost/c.vtt', 'https://example.org/c.vtt?auth_key=secret']) {
  let calls = 0;
  await assert.rejects(readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async value => {
    calls++; if (calls > 1) throw new Error('unexpected request'); return body(value, `<video><track kind="subtitles" src="${url}"></video>`);
  }));
  // The default transport does DNS/IP guarding; token URLs must be refused before injected transport too.
  if (url.includes('auth_key')) assert.equal(calls, 1);
}
pass('公开字幕链接和坏轨道后备可读，最多三轨道；凭据字幕在请求前拒绝');

const structured = `<script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: resource.url, transcript: text })}</script><p>视频简介不是证据</p>`;
const videoData = await readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async url => body(url, structured));
assert.equal(videoData.format, 'transcript'); assert.equal(videoData.text, text); assert.equal(videoData.transcriptUrl, resource.url);
assert.ok(!extractPublicVideoData(`<script>globalThis.steal()</script><script type="application/ld+json">{broken}</script>`, resource.url).transcript);
assert.ok(!extractPublicVideoData(structured.replace('"transcript":', '"description":'), resource.url).transcript);
assert.ok(!extractPublicVideoData(structured.replace('"transcript":', '"requiresSubscription":true,"transcript":'), resource.url).transcript);
assert.ok(!extractPublicVideoData(structured.replace(resource.url, 'https://example.org/another-video'), resource.url).transcript);
let privateTrackRequests = 0;
await assert.rejects(readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async (url, signal) => {
  if (url === resource.url) return body(url, '<video><track kind="subtitles" src="http://localhost/private.vtt"></video>');
  privateTrackRequests++; return fetchTextbookPublicBody(url, signal, wire(Buffer.from(vtt), 'identity').deps);
}), /内网/u);
assert.equal(privateTrackRequests, 1); // Attempted guard, never a socket request to localhost.
pass('公开 VideoObject.transcript 可读，只解析 JSON 不执行脚本，不把 description/订阅内容当文字稿');

const bili = { ...resource, url: 'https://www.bilibili.com/video/BV1234567890/?p=2', resourceType: 'video' };
const biliCalls: string[] = [];
const biliResult = await readTextbookBoundBody(bili, undefined, async url => {
  biliCalls.push(url);
  if (url.includes('/x/web-interface/view')) return body(url, JSON.stringify({ code: 0, data: { cid: 99, pages: [{ page: 1, cid: 99 }, { page: 2, cid: 88 }] } }), 'application/json');
  if (url.includes('/x/player/wbi/v2')) { assert.ok(url.includes('cid=88')); return body(url, JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://example.org/caption.json' }] } } }), 'application/json'); }
  if (url.endsWith('caption.json')) return body(url, JSON.stringify({ body: [{ from: 0, to: 9, content: text }] }), 'application/json');
  return body(url, '<html><body>视频简介</body></html>');
});
assert.equal(biliResult.text, text); assert.equal(biliCalls.length, 4); assert.equal(biliResult.transcriptUrl, 'https://example.org/caption.json');
let restrictedCaptions = 0;
await assert.rejects(readTextbookBoundBody(bili, undefined, async url => {
  if (url.includes('/x/web-interface/view')) return body(url, JSON.stringify({ code: 0, data: { pages: [{ page: 2, cid: 88 }] } }), 'application/json');
  if (url.includes('/x/player/wbi/v2')) return body(url, JSON.stringify({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [{ subtitle_url: 'https://example.org/secret.json' }] } } }), 'application/json');
  if (url.endsWith('secret.json')) restrictedCaptions++;
  return body(url, '<html><body>视频简介</body></html>');
}), /需要登录/u);
assert.equal(restrictedCaptions, 0);
pass('Bilibili 匿名接口按当前分集读取真正定时字幕；需要登录则停止，绝不请求受限字幕');

const pdf = new jsPDF(); pdf.text('Public lesson body is actual text, not a preview description. '.repeat(5), 10, 10);
const magicPdf = await readTextbookBoundBody({ ...resource, url: 'https://example.org/downloadArticleFile.do?id=1' }, undefined,
  async url => ({ url, bytes: Buffer.from(pdf.output('arraybuffer')), contentType: 'application/octet-stream' }));
assert.equal(magicPdf.format, 'document'); assert.ok(magicPdf.text.includes('Public lesson'));
await assert.rejects(readTextbookBoundBody({ ...resource, url: 'https://example.org/book.pdf' }, undefined, async url => body(url, '<p>download unavailable</p>', 'text/html')), /未返回有效 PDF/u);
pass('按 PDF 文件签名识别无后缀/错误 MIME 下载；HTML 错误页不再误送 PDF/OCR');

// Local captures are optional diagnostic fixtures, never required and never fetched by these tests.
try {
  const captured = await readFile('data/textbook-url-tests/2026-10-08T11-33-46-447Z/body-T9.html');
  const actual = extractTextbookHtml(decodeTextbookBody(captured, 'text/html'));
  assert.equal(actual.contentKind, 'abstract'); assert.ok(actual.text.includes('心理账户理论指出'));
  const encoded = await readFile('data/textbook-url-tests/2026-10-08T11-33-46-447Z/body-T98.html');
  assert.ok(!decodeTextbookBody(encoded, 'text/html').includes('\uFFFD'));
  pass('本次真实期刊摘要与 GB2312 书目页离线回放：正文不误拒绝且无乱码');
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
try {
  for (const id of ['T13', 'T78', 'T136']) {
    const captured = await readFile(`data/textbook-url-tests/2026-10-08T11-38-16-879Z/body-${id}.html`);
    assert.ok(extractTextbookHtml(decodeTextbookBody(captured, 'text/html')).text.length >= 100);
  }
  pass('真实技术文档、图书原文摘录、课程章节离线回放：主题导航类名和超长目录不会误拒绝正文');
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
assert.throws(() => textbookPublicUrl('https://example.org/a?auth_token=secret'));
console.log(`textbook web content: ${checks} groups passed; injected transport/fixtures only, no live network or model`);
