import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import fileOps from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { registerHooks } from 'node:module';
import type http from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { jsPDF } from 'jspdf';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { extractTextbookHtml, extractTextbookTranscript, isTextbookPublicIp, fetchTextbookPublicBody, readTextbookBoundBody,
  type PublicFetchDependencies, type ReadWebBody } from '../src/electron/textbookWebReader';
import { TextbookStore } from '../src/electron/textbookStore';
import { readTextbookBoundBodyWithBrowser } from '../src/electron/textbookWebFallback';
import { textbookBoundUrls, textbookPublicUrl } from '../src/services/textbook/boundUrls';
import { collectBoundTextbookSources } from '../src/services/textbook/webMaterials';
import { textbookHash, projectPlanningSnapshot } from '../src/services/textbook/fingerprint';
import { prepareTextbook, generateTextbook, applyTextbookPublication, textbookConfirmation, textbookProviderSnapshot,
  collectTextbookSources, type TextbookGenerationDependencies } from '../src/services/textbook/generation';
import { textbookProgressSnapshot, initialTextbookProgress } from '../src/services/textbook/progress';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { NoteItem } from '../src/types';
import type { TextbookJob, TextbookJobCommand, TextbookContext } from '../src/services/textbook/generationTypes';
import type { TextbookBoundUrl } from '../src/services/textbook/webTypes';
import { MaterialError } from '../src/services/textbook/materialScope';
import { assembleTextbook } from '../src/services/textbook/validation';
import { isBlockingTextbookWebError, safeTextbookWebError } from '../src/services/textbook/webErrors';
import { registerTextbookTools } from '../src/services/agent/tools/textbookTools';
import { getTool } from '../src/services/agent/toolRegistry';

registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { TextbookProgressCard } = await import('../src/components/textbook/TextbookProgressCard');
const { SourceReference, readSourceEvidence } = await import('../src/components/textbook/SourceReference');

let checks = 0;
function pass(label: string) { checks++; console.log(`PASS ${label}`); }
const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-web-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
const storage = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) } });
storage.set('loginote_llm_settings', JSON.stringify({ providers: [{ id: 'deepseek-default', name: '离线测试', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', models: ['fixture'], selectedModel: 'fixture', enabled: true, createdAt: '2026-10-01' }], defaultProviderId: 'deepseek-default', workflowBinding: {} }));
const text = '选择过载是选项数量增加后，在特定条件下决策更困难或满意度降低的现象。数量并非唯一条件，需要检查偏好清晰度、信息复杂度和时间压力。例子只用于说明检查方法，不表示任何确定的数量阈值。'.repeat(3);
const html = `<!doctype html><html><head><meta name="description" content="FAKE_SNIPPET"></head><body><nav>NAV_GARBAGE</nav><article><h1>选择过载</h1><p>${text}</p><ul><li>先核对偏好</li><li>再检查条件</li></ul><table><tr><th>条件</th><th>判断</th></tr><tr><td>偏好明确</td><td>未必过载</td></tr></table><pre>if ready:\n    print("preserve indent")</pre><script>LEAK_SCRIPT</script><p hidden>HIDDEN</p></article><footer>FOOTER_GARBAGE</footer></body></html>`;
const resource = { id: 'U1', title: '已筛选概念资料', url: 'https://example.org/choice', resourceType: 'article' };
const body = (url = resource.url, bytes = Buffer.from(html), contentType = 'text/html; charset=utf-8') => ({ url, bytes, contentType });
const reader = (item: TextbookBoundUrl, signal?: AbortSignal) => readTextbookBoundBody(item, signal, async () => body(item.url));
const note = (id: string, title: string, noteType: NoteItem['noteType'] = 'project', content = ''): NoteItem => ({ id, title, noteType, content, tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' });
let project = note('web-project', '学习选择过载', 'project', '- [ ] 理解选择过载');
project.resources = [{ title: resource.title, url: resource.url, resourceType: 'article' }];
let notes = [project]; const getNotes = async () => notes;
let store = new TextbookStore(temp);
const command = (input: TextbookJobCommand) => store.command(input, 1, getNotes);
const context: TextbookContext = { project: { id: project.id, rootId: project.id, title: project.title, rootTitle: project.title, tasks: ['理解选择过载'], knowledgeTitles: [] },
  profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] };
const ctx = { getNotes: () => notes, getActiveNote: () => notes[0], ensureDataFresh: async () => {},
  publishTextbook: async (input) => { const published = await applyTextbookPublication(notes[0], notes, input); notes = notes.map(item => item.id === published.id ? published : item); return published; } } as AgentRuntimeContext;
const spec = async (overrides = {}) => ({ schemaVersion: 1 as const, projectNoteId: project.id, rootProjectId: project.id, projectTitle: project.title,
  planningHash: await textbookHash(projectPlanningSnapshot(project)), providerHash: 'a'.repeat(64), allowedDocIds: [], documentHashes: {}, knowledgeHashes: {},
  allowCloud: false, readBoundUrls: true, boundUrls: textbookBoundUrls(project), modelPolicy: defaultTextbookModelPolicy(), ...overrides });
try {
  const parsed = extractTextbookHtml(html);
  assert.ok(parsed.text.includes(text)); assert.ok(parsed.text.includes('条件 | 判断')); assert.ok(parsed.text.includes('    print'));
  for (const forbidden of ['FAKE_SNIPPET', 'NAV_GARBAGE', 'FOOTER_GARBAGE', 'LEAK_SCRIPT', 'HIDDEN']) assert.ok(!parsed.text.includes(forbidden));
  assert.equal((parsed.text.match(/选择过载是/gu) || []).length, 3);
  pass('惰性 HTML 解析读取实际正文，保留顺序/表格/代码缩进，不用 meta 摘要、不执行脚本');
  for (const shell of ['<div id="app"></div><script>load()</script>', '<p>请先登录</p>', '<p>verify you are human</p>']) assert.throws(() => extractTextbookHtml(shell), /公开正文/u);
  assert.throws(() => extractTextbookHtml('<div>'.repeat(220) + text + '</div>'.repeat(220)), /结构/u);
  pass('动态壳、登录、验证码和超深网页不作为证据');
  for (const url of ['file:///C:/private', 'https://user:pass@example.org/a', 'https://example.org:444/a', 'https://example.org/a?access_token=secret', 'https://example.org/a?token=secret', 'https://example.org/a?X-Amz-Signature=secret']) assert.throws(() => textbookPublicUrl(url));
  assert.equal(textbookPublicUrl('https://example.org/a?id=20#section'), 'https://example.org/a?id=20');
  pass('限制 HTTP/S 无凭据公开地址，保留正常检索参数，不自动剥除访问令牌后读取另一目标');
  for (const address of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd00::1', '2002:7f00::1', '2001:db8::1', '2001:0db8::1', '2001::abcd']) assert.equal(isTextbookPublicIp(address), false, address);
  assert.equal(isTextbookPublicIp('8.8.8.8'), true); assert.equal(isTextbookPublicIp('2606:4700:4700::1111'), true);
  pass('阻止内网、保留网段、IPv4 映射 IPv6 和过渡地址');
  let requests = 0; let redirectTarget = ''; let pin: unknown;
  const transport: PublicFetchDependencies = { resolve: (async (host) => [{ address: host === 'private.test' ? '127.0.0.1' : '8.8.8.8', family: 4 }]) as any,
    request: ((_url, options, callback) => {
      requests++; assert.ok(!options.headers.Cookie && !options.headers.Authorization && !options.headers.Referer);
      options.lookup('public.test', { all: true }, (_err, values) => { pin = values; });
      const request = new EventEmitter() as any;
      request.end = () => queueMicrotask(() => {
        const response = new PassThrough() as any;
        response.statusCode = redirectTarget ? 302 : 200; response.headers = redirectTarget ? { location: redirectTarget } : { 'content-type': 'text/html' };
        callback(response); if (!redirectTarget) response.end(Buffer.from(html));
      }); return request;
    }) as unknown as typeof http.request };
  await fetchTextbookPublicBody(resource.url, undefined, transport); assert.deepEqual(pin, [{ address: '8.8.8.8', family: 4 }]);
  redirectTarget = 'http://private.test/secret'; requests = 0;
  await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, transport), /不安全地址/u); assert.equal(requests, 1);
  transport.resolve = (async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]) as any; requests = 0;
  await assert.rejects(fetchTextbookPublicBody(resource.url, undefined, transport), /不安全地址/u); assert.equal(requests, 0);
  pass('生产 HTTP 传输固定已检查 DNS 地址（含 Node all 模式），重新检查每次跳转，混合公私 DNS 拒绝且无 Cookie');

  await assert.rejects(readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async () => body()), /字幕/u);
  const vtt = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:08.000\n${text}\n`;
  assert.ok(extractTextbookTranscript(vtt).includes(text)); assert.ok(!extractTextbookTranscript(vtt).includes('-->'));
  const video = await readTextbookBoundBody({ ...resource, resourceType: 'video' }, undefined, async (url) => url.endsWith('.vtt')
    ? body(url, Buffer.from(vtt), 'text/vtt') : body(url, Buffer.from('<video><track kind="subtitles" src="/captions.vtt"></video>')));
  assert.equal(video.format, 'transcript'); assert.equal(video.text, text); assert.equal(video.transcriptUrl, 'https://example.org/captions.vtt');
  pass('视频简介不是证据；真正公开字幕可读，保留字幕来源地址');
  const docx = zipSync({ 'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });
  const pptx = zipSync({ 'ppt/slides/slide1.xml': strToU8(`<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`) });
  for (const [extension, bytes] of [['docx', docx], ['pptx', pptx]] as const) {
    const document = await readTextbookBoundBody({ ...resource, url: `https://example.org/source.${extension}` }, undefined, async (url) => body(url, Buffer.from(bytes), 'application/octet-stream'));
    assert.equal(document.format, 'document'); assert.ok(document.text.includes(text)); assert.ok(document.text.includes('[位置'));
  }
  const pdf = new jsPDF(); pdf.text('Choice overload depends on preference clarity, complexity and time pressure. '.repeat(3), 10, 10);
  const pdfBody = await readTextbookBoundBody(resource, undefined, async (url) => body(url, Buffer.from(pdf.output('arraybuffer')), 'application/pdf'));
  assert.equal(pdfBody.format, 'document'); assert.ok(pdfBody.text.includes('Choice overload')); assert.ok(pdfBody.text.includes('"page":1'));
  pass('在线 DOCX/PPTX/PDF 复用真实文档解析器，保留段落/幻灯片/页码位置');
  await assert.rejects(readTextbookBoundBody(resource, undefined, async (url) => body(url, Buffer.from('scan'), 'image/png')), /不是可读取/u);
  pass('图片、音视频和不支持的二进制附件不伪装成已解析正文');

  const created = await command({ op: 'create', spec: await spec() });
  await assert.rejects(store.readBoundUrl({ jobId: created.job.id, token: 'not-owned', resourceId: 'U1' }, 1, getNotes, reader), /许可/u);
  let claimed = await command({ op: 'claim', jobId: created.job.id }); let token = claimed.token!;
  await assert.rejects(store.readBoundUrl({ jobId: created.job.id, token, resourceId: 'U2' }, 1, getNotes, reader), /批准/u);
  await assert.rejects(store.readBoundUrl({ jobId: created.job.id, token, resourceId: 'U1' }, 2, getNotes, reader), /许可/u);
  pass('Host 只接受批准的资源 ID，检查任务租约和窗口所有者，不接受任意 URL');
  let reads = 0;
  const cachedReader = async (...args: Parameters<typeof reader>) => { reads++; return reader(...args); };
  const snapshot = await store.readBoundUrl({ jobId: created.job.id, token, resourceId: 'U1' }, 1, getNotes, cachedReader);
  await command({ op: 'stop', jobId: created.job.id, token, cancelled: false, error: 'offline test' });
  store = new TextbookStore(temp); claimed = await command({ op: 'claim', jobId: created.job.id }); token = claimed.token!;
  const reused = await store.readBoundUrl({ jobId: created.job.id, token, resourceId: 'U1' }, 1, getNotes, cachedReader);
  assert.deepEqual(reused, snapshot); assert.equal(reads, 1);
  pass('每个成功 URL 独立落盘，跨进程重启/同任务恢复保持原版本，零重复请求');
  notes = [{ ...project, resources: [{ title: resource.title, url: 'https://example.org/changed' }] }];
  await assert.rejects(store.readBoundUrl({ jobId: created.job.id, token, resourceId: 'U1' }, 1, getNotes, cachedReader), /变化/u); notes = [project];
  pass('绑定资源或项目变化使读取许可失效，即使已有缓存也不能越过新范围');

  const collected = await collectBoundTextbookSources(claimed.job, token, async () => snapshot, async () => {});
  assert.equal(collected[0].kind, 'web'); assert.equal(collected[0].sourceId, 'L1');
  claimed.job.checkpoint.sources = collected;
  await command({ op: 'checkpoint', jobId: created.job.id, token, stage: 'materials', checkpoint: claimed.job.checkpoint });
  const forged = structuredClone(claimed.job.checkpoint); forged.sources![0].text += 'forged';
  await assert.rejects(command({ op: 'checkpoint', jobId: created.job.id, token, stage: 'materials', checkpoint: forged }), /快照/u);
  pass('进入模型/检查点的来源原文必须与冻结快照和坐标一致，篡改正文不能保存');
  const longText = `${text}\n\n`.repeat(40);
  const longSources = await collectBoundTextbookSources(claimed.job, token, async () => ({ ...snapshot, text: longText }), async () => {});
  assert.equal(longSources[0].web!.coverage, 'excerpt'); assert.ok(longSources[0].text.length <= 6000); assert.equal(longSources[0].text, longText.slice(0, longSources[0].textEnd));
  pass('长网页给模型最多 6000 字符且明示选段，保留精确坐标，不冒充整份资料，不额外调用模型');
  const failedJob = structuredClone(claimed.job); failedJob.spec.boundUrls!.push({ ...resource, id: 'U2', url: 'https://example.org/video', title: '视频' });
  const partial = await collectBoundTextbookSources(failedJob, token, async (input) => { if (input.resourceId === 'U2') throw new Error('视频无字幕'); return snapshot; }, async () => {});
  assert.equal(partial.length, 1); assert.deepEqual(failedJob.checkpoint.webReads!.map((item) => item.status), ['saved', 'failed']);
  const emptyWeb = await collectBoundTextbookSources(failedJob, token, async () => { throw new Error('无正文'); }, async () => {});
  assert.deepEqual(emptyWeb, []); assert.ok(failedJob.checkpoint.webReads!.every(item => item.status === 'failed'));
  pass('URL 部分失败仍保留成功来源，全部失败返回空选材并记录原因，由完整流水线决定是否还有可用本地/知识点正文');
  const wrapped403 = "Error invoking remote method 'textbook:read-bound-url': Error: 公开资源返回 HTTP 403";
  assert.equal(safeTextbookWebError(new Error(wrapped403)), '公开资源返回 HTTP 403');
  for (const ordinary of [wrapped403, '网页正文内容不足', '视频未取得公开字幕', '正文存在明显编码乱码', '公开资源连接失败']) assert.equal(isBlockingTextbookWebError(new Error(ordinary)), false);
  for (const critical of ['网页读取许可已失效', '该 URL 不在批准读取范围', '项目或绑定 URL 已变化', '网页快照与批准来源不一致',
    '网页快照版本校验失败', '已保存的网页快照丢失', '网页快照已损坏，不能复用']) assert.equal(isBlockingTextbookWebError(new Error(critical)), true);
  assert.equal(isBlockingTextbookWebError(Object.assign(new Error('private storage error'), { code: 'EPERM' })), true);
  let revokedCalls = 0;
  await assert.rejects(collectBoundTextbookSources(failedJob, token, async () => { revokedCalls++; throw new Error('网页读取许可已失效'); }, async () => {}), /许可已失效/u);
  assert.equal(revokedCalls, 1);
  pass('403/无正文/无字幕可跳过，IPC 包装清理为真实原因；许可、范围、冻结证据与存储故障仍停止且不继续发请求');
  const progressMarkup = renderToStaticMarkup(createElement(TextbookProgressCard, { progress: textbookProgressSnapshot(failedJob, false), disabled: false, onResume: () => {} }));
  assert.ok(progressMarkup.includes('已绑定 URL 读取情况')); assert.ok(progressMarkup.includes('无正文'));
  pass('真实进度卡显示每个 URL 的成功或失败原因');

  const manifest = { schemaVersion: 1 as const, textbookId: created.job.id, projectNoteId: project.id, rootProjectId: project.id, revisionId: 'rev', regionId: 'book', createdAt: 'now', updatedAt: 'now', generationJobId: created.job.id,
    sources: collected.map(({ text: _text, assets: _assets, ...pointer }) => pointer) };
  notes = [{ ...project, textbook: manifest }];
  Object.assign(globalThis, { window: { electronAPI: { ragDocs: { list: async () => [] }, textbook: { readWebEvidence: (input) => store.readWebEvidence(input, getNotes) } } } });
  const evidence = await readSourceEvidence(manifest.sources[0], notes, undefined, project.id);
  assert.equal(evidence.text, collected[0].text);
  await assert.rejects(store.readWebEvidence({ projectNoteId: project.id, sourceId: 'L1', snapshotId: snapshot.web.snapshotId, version: '0'.repeat(64) }, getNotes), /授权/u);
  await assert.rejects(store.readWebEvidence({ projectNoteId: project.id, sourceId: 'L1', snapshotId: snapshot.web.snapshotId, version: snapshot.version, cursor: -1 }, getNotes), /坐标/u);
  assert.ok(!evidence.text.includes('profile'));
  const sourceMarkup = renderToStaticMarkup(createElement(SourceReference, { sourceId: 'L1', manifest, allNotes: notes })); assert.ok(sourceMarkup.includes('查看来源 L1'));
  pass('来源阅读使用真实发布指针离线读取快照；拒绝假版本/范围，且不读取私人任务草稿');
  const cacheFile = path.join(temp, 'textbook-jobs', 'web-snapshots', `${created.job.id}-U1.json`);
  const cacheText = await readFile(cacheFile, 'utf8'); await writeFile(cacheFile, cacheText.replace(text, 'tampered'));
  await assert.rejects(store.readWebEvidence({ projectNoteId: project.id, sourceId: 'L1', snapshotId: snapshot.web.snapshotId, version: snapshot.version }, getNotes), /版本/u); await writeFile(cacheFile, cacheText);
  pass('快照文件内容变化会报错，不以当前网页或另一版本替换引用');
  notes = [project]; await command({ op: 'stop', jobId: created.job.id, token, cancelled: true, error: 'test' });
  const cancelJob = await command({ op: 'create', spec: await spec() }); const cancelLease = await command({ op: 'claim', jobId: cancelJob.job.id });
  const cancellation = store.readBoundUrl({ jobId: cancelJob.job.id, token: cancelLease.token!, resourceId: 'U1' }, 1, getNotes,
    async (_item, signal) => new Promise<ReadWebBody>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })));
  // Wait until acquisition has installed its controller, then simulate owner navigation/destruction.
  await new Promise((resolve) => setTimeout(resolve, 30)); store.releaseOwner(1);
  await assert.rejects(cancellation, /取消|许可/u);
  await assert.rejects(readFile(path.join(temp, 'textbook-jobs', 'web-snapshots', `${cancelJob.job.id}-U1.json`)), /ENOENT/u);
  pass('窗口退出会取消读取，失效租约不允许保存新快照');

  let modelCalls = 0, networkReads = 0;
  const deps: TextbookGenerationDependencies = { command, documentHash: async () => 'b'.repeat(64), providerHash: textbookProviderSnapshot,
    context: async () => structuredClone(context), sources: async () => [],
    webRead: (input) => store.readBoundUrl(input, 1, getNotes, async (item, signal) => { networkReads++; return reader(item, signal); }),
    model: async (request) => {
      modelCalls++; const input = JSON.parse(request.userInput);
      assert.equal(input.sources[0].kind, 'web');
      // Quality uses cited excerpt rows; planning/chapter generation uses text.
      const sourceText = Array.isArray(input.sources[0].text)
        ? input.sources[0].text.map((row: { ref: string; text: string }) => { assert.ok(row.ref); assert.equal(typeof row.text, 'string'); return row.text; }).join('\n')
        : input.sources[0].text;
      assert.ok(sourceText.includes('选择过载'));
      let result;
      if (request.workflow === 'textbook-blueprint') result = { title: '选择过载教材', objectives: [{ id: 'O1', text: '区分数量与成立条件' }], focuses: [], chapters: ['ch1', 'ch2'].map((id) => ({ id, title: id === 'ch1' ? '理解选择过载' : '检查成立条件', objectiveIds: ['O1'], focusIds: [], sourceIds: ['L1'], bridge: '先从选项数量进入，再核对条件。', visuals: [] })) };
      else if (request.workflow === 'textbook-chapter') result = { id: input.chapter.id, sections: Object.fromEntries(['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'].map((section) => [section, `核对偏好清晰度、复杂度与时间压力，选项数量并不能单独决定选择过载。假设情境用于说明方法，不是实证数据。[L1]`])) };
      else result = { schemaVersion: 3, passed: true, findings: [] };
      return { content: JSON.stringify(result), parsedJson: result };
    } };
  const prepared = await prepareTextbook(ctx, {}, deps) as { jobId: string };
  assert.equal(modelCalls, 0); assert.equal(networkReads, 0); assert.ok(textbookConfirmation(prepared.jobId).impacts.some((item) => item.includes('1 个已绑定公开 URL')));
  pass('URL-only 项目可以准备，准备阶段不联网/不调用模型，生成卡明确公网页读取与模型传输分别授权');
  await generateTextbook(ctx, prepared.jobId, undefined, deps);
  assert.equal(networkReads, 1); assert.equal(modelCalls, 4); assert.ok(notes[0].content.includes('公开资源正文')); assert.ok(notes[0].textbook!.sources![0].web);
  assert.equal((await command({ op: 'get', jobId: prepared.jobId })).job.stage, 'published');
  assert.deepEqual((await command({ op: 'get', jobId: prepared.jobId })).job.checkpoint.webReads?.map((item) => item.status), ['saved']);
  pass('URL-only 项目走真实教材流水线：正文进入蓝图/章节/审核，发布来源指针与正文，两章只有原有四次模型调用');
  // Independent scenario: vary approved project content instead of creating
  // a duplicate of the already published same-scope task.
  const readableScenarioProject = project;
  project = { ...project, content: `${project.content}\n\n不可读来源验收场景。` };
  notes = [project]; modelCalls = 0; networkReads = 0;
  const unavailableDeps = { ...deps, webRead: async () => { networkReads++; throw new Error(wrapped403); } };
  const noSourcesJob = await prepareTextbook(ctx, {}, unavailableDeps) as { jobId: string };
  await assert.rejects(generateTextbook(ctx, noSourcesJob.jobId, undefined, unavailableDeps), /不可读 URL 已跳过.*没有其他可用正文/u);
  assert.equal(modelCalls, 0); assert.equal(networkReads, 1); assert.equal(notes[0].textbook, undefined);
  assert.equal((await command({ op: 'get', jobId: noSourcesJob.jobId })).job.checkpoint.webReads![0].error, '公开资源返回 HTTP 403');
  pass('URL-only 且全部不可读时只报告真实物料缺口：零模型调用、不写笔记，不以模型常识伪造教材');
  project = readableScenarioProject;
  const linkedKnowledge = note('knowledge-choice', '选择过载', 'knowledge', text);
  notes = [{ ...project, content: `${project.content}\n\n[[选择过载]]`, resources: [
    { title: '百科页面一', url: 'https://baike.baidu.com/item/choice-one' },
    { title: '百科页面二', url: 'https://baike.baidu.com/item/choice-two' }] }, linkedKnowledge];
  modelCalls = 0; networkReads = 0;
  const knowledgeRequests: string[] = [];
  const knowledgeDeps: TextbookGenerationDependencies = { ...unavailableDeps, model: async request => {
    modelCalls++; knowledgeRequests.push(request.userInput); const input = JSON.parse(request.userInput);
    assert.equal(input.sources.length, 1); assert.equal(input.sources[0].sourceId, 'N1');
    assert.equal(input.sources[0].kind, 'knowledge');
    assert.equal(Array.isArray(input.sources[0].text) ? input.sources[0].text.map((row: { text: string }) => row.text).join('\n') : input.sources[0].text, text);
    const result = request.workflow === 'textbook-blueprint'
      ? { title: '选择过载教材', objectives: [{ id: 'O1', text: '区分数量与成立条件' }], focuses: [],
        chapters: ['ch1', 'ch2'].map(id => ({ id, title: id, objectiveIds: ['O1'], focusIds: [], sourceIds: ['N1'], bridge: '先理解概念，再核对条件。' })) }
      : request.workflow === 'textbook-chapter'
        ? { id: input.chapter.id, sections: Object.fromEntries(['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary']
          .map(section => [section, '选择过载需要核对偏好清晰度、复杂度与时间压力，不能只用数量判断。[N1]'])) }
        : { schemaVersion: 3, passed: true, findings: [] };
    return { content: JSON.stringify(result), parsedJson: result };
  } };
  const knowledgeJob = await prepareTextbook(ctx, {}, knowledgeDeps) as { jobId: string };
  const approvedKnowledge = (await command({ op: 'get', jobId: knowledgeJob.jobId })).job.spec.knowledgeHashes;
  assert.deepEqual(Object.keys(approvedKnowledge), [linkedKnowledge.id]);
  assert.ok(textbookConfirmation(knowledgeJob.jobId).impacts.some(item => item.includes('不可读链接记录后跳过')));
  // Reproduce an old failure, then resume that SAME approved task after the fix.
  const oldFailedLease = await command({ op: 'claim', jobId: knowledgeJob.jobId });
  await command({ op: 'stop', jobId: knowledgeJob.jobId, token: oldFailedLease.token!, cancelled: false,
    error: '已绑定 URL 均未取得可读正文：baike.baidu.com（公开资源返回 HTTP 403）' });
  store = new TextbookStore(temp);
  let stopAfterMaterials = true;
  await assert.rejects(generateTextbook(ctx, knowledgeJob.jobId, undefined, { ...knowledgeDeps, model: async request => {
    if (stopAfterMaterials) { stopAfterMaterials = false; throw new Error('synthetic blueprint interruption'); }
    return knowledgeDeps.model(request);
  } }), /synthetic blueprint interruption/u);
  const preservedKnowledge = (await command({ op: 'get', jobId: knowledgeJob.jobId })).job;
  assert.equal(networkReads, 2); assert.equal(modelCalls, 0);
  assert.equal(preservedKnowledge.checkpoint.sources![0].kind, 'knowledge');
  assert.ok(preservedKnowledge.checkpoint.progress!.history.some(item => /已跳过 2 个不可读 URL.*关联知识点正文继续/u.test(item.label)));
  store = new TextbookStore(temp);
  const knowledgePublished = await generateTextbook(ctx, knowledgeJob.jobId, undefined, knowledgeDeps) as { saved: boolean; skippedUrlCount: number; message: string };
  assert.equal(knowledgePublished.saved, true); assert.equal(knowledgePublished.skippedUrlCount, 2);
  assert.ok(knowledgePublished.message.includes('已跳过 2 个不可读 URL'));
  assert.equal(networkReads, 2); assert.equal(modelCalls, 4);
  assert.ok(knowledgeRequests.every(value => !value.includes('baike.baidu.com')));
  assert.ok(notes[0].content.includes('[N1]')); assert.ok(!notes[0].content.includes('公开资源正文'));
  assert.ok(notes[0].textbook!.sources!.every(source => source.kind === 'knowledge'));
  const publishedKnowledge = (await command({ op: 'get', jobId: knowledgeJob.jobId })).job;
  assert.equal(publishedKnowledge.stage, 'published');
  assert.deepEqual(publishedKnowledge.checkpoint.webReads!.map(item => item.status), ['failed', 'failed']);
  assert.deepEqual(publishedKnowledge.spec.knowledgeHashes, approvedKnowledge);
  pass('两个百科 403 的旧失败任务恢复：跳过 URL，用批准知识点完成蓝图/两章/校验/写入，保留失败提示；跨重启续写不重读 URL、不伪造网络引用');
  notes = [project]; modelCalls = 0; networkReads = 0;
  const noWeb = await prepareTextbook(ctx, { allowedDocIds: ['local-doc'], readBoundUrls: false }, deps) as { jobId: string };
  assert.equal((await command({ op: 'get', jobId: noWeb.jobId })).job.spec.readBoundUrls, false);
  await assert.rejects(generateTextbook(ctx, noWeb.jobId, undefined, deps), /物料不足/u); assert.equal(networkReads, 0);
  pass('明确仅本地模式不会联网，远程模型许可与已绑定 URL 读取互不代替');
  const localJob = await prepareTextbook(ctx, { allowedDocIds: ['local-doc'] }, deps) as { jobId: string };
  const localDeps = { ...deps, sources: async () => [{ sourceId: 'L1', kind: 'document' as const, id: 'local-doc', title: '本地资料', version: 'b'.repeat(64), text }],
    model: async () => { throw new Error('stop after material check'); } };
  await assert.rejects(generateTextbook(ctx, localJob.jobId, undefined, localDeps), /stop after/u);
  assert.equal(networkReads, 1); assert.equal((await command({ op: 'get', jobId: localJob.jobId })).job.checkpoint.sources![0].kind, 'document');
  pass('新任务本地物料覆盖不足时可读取绑定网页补缺，本地来源仍排在首位；旧任务和显式本地范围不扩大');
  const ragBridge = (globalThis as any).window.electronAPI.ragDocs;
  Object.assign(ragBridge, { materialList: async () => ({ ok: true, value: [] }), materialCatalog: async () => ({ ok: true, value: [] }),
    materialRead: async () => ({ ok: true, value: [] }), materialPrepare: async () => ({ ok: false, code: 'UNSUPPORTED', error: '无文本解析器' }) });
  const fallbackJob = await command({ op: 'create', spec: await spec({ allowedDocIds: ['local-doc'], documentHashes: { 'local-doc': 'b'.repeat(64) } }) });
  assert.deepEqual(await collectTextbookSources(fallbackJob.job, context, async () => { throw new Error('no selection model expected'); }), []);
  assert.equal(fallbackJob.job.checkpoint.localMaterialWarnings?.length, 1);
  ragBridge.materialPrepare = async () => ({ ok: false, code: 'OUT_OF_SCOPE', error: '资料越权' });
  await assert.rejects(collectTextbookSources(fallbackJob.job, context, async () => ({})), (error: unknown) => error instanceof MaterialError && error.code === 'OUT_OF_SCOPE');
  ragBridge.materialPrepare = async () => ({ ok: false, code: 'SOURCE_CHANGED', error: '来源变化' });
  await assert.rejects(collectTextbookSources(fallbackJob.job, context, async () => ({})), /来源变化/u);
  pass('本地不支持解析可提示并回退已绑定 URL；范围越权、版本变化仍立即停止，不以联网绕过安全门控');
  const revokedJob = await command({ op: 'create', spec: await spec() }); const revokedLease = await command({ op: 'claim', jobId: revokedJob.job.id });
  let notify!: () => void; const started = new Promise<void>((resolve) => { notify = resolve; });
  let finishNotes!: () => void; const waiting = new Promise<void>((resolve) => { finishNotes = resolve; }); let unauthorizedReads = 0;
  const revokedRead = store.readBoundUrl({ jobId: revokedJob.job.id, token: revokedLease.token!, resourceId: 'U1' }, 1,
    async () => { notify(); await waiting; return notes; }, async (item, signal) => { unauthorizedReads++; return reader(item, signal); });
  await started; store.releaseOwner(1); finishNotes(); await assert.rejects(revokedRead, /许可/u); assert.equal(unauthorizedReads, 0);
  pass('异步资料范围核验期间撤销窗口租约，实际请求前再次核对，不发失去授权的网络请求');
  const textbookBridge = (globalThis as any).window.electronAPI.textbook;
  Object.assign(textbookBridge, { command, list: (id: string) => store.list(id) }); registerTextbookTools();
  const originalOps = { lstat: fileOps.lstat, readFile: fileOps.readFile, writeFile: fileOps.writeFile };
  for (const fault of ['EPERM', 'corrupt', 'write_failure']) {
    const privacyJob = await command({ op: 'create', spec: await spec() }); const privacyLease = await command({ op: 'claim', jobId: privacyJob.job.id });
    const id = `${privacyJob.job.id}-U1`; const fakePath = 'MEMORY-ONLY/private-user-state/web-snapshots/test-secret';
    if (fault === 'EPERM') fileOps.lstat = (async (file, ...options) => {
      if (String(file).endsWith(`${id}.json`)) throw Object.assign(new Error(`EPERM: lstat '${fakePath}'`), { code: 'EPERM' });
      return originalOps.lstat(file as any, ...options as []);
    }) as typeof fileOps.lstat;
    if (fault === 'corrupt') {
      fileOps.lstat = (async (file, ...options) => String(file).endsWith(`${id}.json`)
        ? { isFile: () => true, isSymbolicLink: () => false, size: 500 } : originalOps.lstat(file as any, ...options as [])) as typeof fileOps.lstat;
      fileOps.readFile = (async (file, ...options) => String(file).endsWith(`${id}.json`)
        ? `{"PRIVATE_PAYLOAD":"${fakePath}", BROKEN` : originalOps.readFile(file as any, ...options as [])) as typeof fileOps.readFile;
    }
    if (fault === 'write_failure') fileOps.writeFile = (async (file, ...options) => {
      if (String(file).includes(id)) throw Object.assign(new Error(`EACCES: writeFile '${fakePath}'`), { code: 'EACCES' });
      return originalOps.writeFile(file as any, ...options as [any]);
    }) as typeof fileOps.writeFile;
    let failure = '';
    try {
      await collectBoundTextbookSources(privacyLease.job, privacyLease.token!, (input) => store.readBoundUrl(input, 1, getNotes, reader),
        async () => { await command({ op: 'checkpoint', jobId: privacyJob.job.id, token: privacyLease.token!, stage: 'materials', checkpoint: privacyLease.job.checkpoint }); });
    } catch (error) { failure = (error as Error).message; }
    finally { Object.assign(fileOps, originalOps); }
    assert.ok(/读写失败|损坏/u.test(failure)); assert.ok(!failure.includes(fakePath)); assert.ok(!failure.includes('PRIVATE_PAYLOAD'));
    await command({ op: 'stop', jobId: privacyJob.job.id, token: privacyLease.token!, cancelled: false, error: failure });
    const result = await getTool('query_textbook_job')!.execute({ jobId: privacyJob.job.id }, ctx);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(fakePath) && !serialized.includes('PRIVATE_PAYLOAD'));
    assert.ok(serialized.includes('failed')); assert.ok(serialized.includes(fault === 'corrupt' ? '损坏' : '读写失败'));
  }
  pass('真实 Store→collect→query：模拟 EPERM、损坏 JSON、快照写失败均明确失败，进度/工具/总错误不携带本机路径或原始 JSON');
  const missingLease = await command({ op: 'claim', jobId: created.job.id }); let missingReads = 0;
  fileOps.lstat = (async (file, ...options) => {
    if (String(file).endsWith(`${created.job.id}-U1.json`)) throw Object.assign(new Error('memory-only cache missing'), { code: 'ENOENT' });
    return originalOps.lstat(file as any, ...options as []);
  }) as typeof fileOps.lstat;
  try {
    await assert.rejects(collectBoundTextbookSources(missingLease.job, missingLease.token!, (input) => store.readBoundUrl(input, 1, getNotes,
      async (item, signal) => { missingReads++; return reader(item, signal); }), async () => {}), /快照丢失/u);
    assert.equal(missingReads, 0);
  } finally { fileOps.lstat = originalOps.lstat; }
  await command({ op: 'stop', jobId: created.job.id, token: missingLease.token!, cancelled: false, error: 'missing snapshot test' });
  pass('恢复时保留成功 URL 的身份：已保存快照丢失明确阻止，不清空状态后联网替换旧来源');
  const legacyJob = await command({ op: 'create', spec: await spec() }); const legacyLease = await command({ op: 'claim', jobId: legacyJob.job.id });
  const legacyPath = 'MEMORY-ONLY/private-user-state/web-snapshots/legacy-private';
  const windowsPath = 'C:\\Users\\PRIVATE_TEST_USER\\AppData\\legacy-cache.json';
  const ordinaryFeedback = '章节 ch3 出现 HTML/控制块类内容，保留其它章节，只修复当前小节。';
  const ordinaryEnglish = 'ch3.practice: check preference clarity; distinguish missing information from a missing causal estimate.';
  const codeExplanation = '教学示例：EPERM 表示权限错误；这里只解释错误码，不执行操作。';
  const privateProgress = { ...initialTextbookProgress(legacyLease.job), currentStage: 'materials' as const,
    label: `未读取：已绑定资料；EPERM: lstat '${legacyPath}'`,
    history: [{ at: legacyLease.job.updatedAt, stage: 'materials' as const, label: `EACCES: readFile '${windowsPath}'` },
      ...[ordinaryFeedback, ordinaryEnglish, codeExplanation].map((label) => ({ at: legacyLease.job.updatedAt, stage: 'chapters' as const, label }))] };
  const checkpoint = { progress: privateProgress, webReads: [{ id: 'U1', title: resource.title, status: 'failed' as const, error: `EPERM: lstat '${legacyPath}'` }] };
  await command({ op: 'checkpoint', jobId: legacyJob.job.id, token: legacyLease.token!, stage: 'materials', checkpoint });
  store = new TextbookStore(temp); // Project index reopens an actual persisted legacy checkpoint.
  const loadedLegacy = (await command({ op: 'get', jobId: legacyJob.job.id })).job;
  const projected = textbookProgressSnapshot(loadedLegacy, false);
  assert.ok(!JSON.stringify(projected).includes(legacyPath) && !JSON.stringify(projected).includes('PRIVATE_TEST_USER'));
  assert.equal(projected.history[1].label, ordinaryFeedback); assert.equal(projected.history[2].label, ordinaryEnglish); assert.equal(projected.history[3].label, codeExplanation);
  assert.deepEqual(loadedLegacy.checkpoint.progress, privateProgress);
  const queriedLegacy = await getTool('query_textbook_job')!.execute({ jobId: legacyJob.job.id }, ctx);
  assert.ok(!JSON.stringify(queriedLegacy).includes(legacyPath) && !JSON.stringify(queriedLegacy).includes('PRIVATE_TEST_USER'));
  assert.ok(JSON.stringify(queriedLegacy).includes('存储操作失败')); assert.ok(JSON.stringify(queriedLegacy).includes('failed'));
  assert.deepEqual((await command({ op: 'get', jobId: legacyJob.job.id })).job.checkpoint.progress, privateProgress);
  pass('真实旧持久进度→重启→snapshot/query：标题与历史中的路径诊断脱敏，失败仍可见，私人原检查点与普通中英文教学反馈原样保留');
  const currentList = textbookBridge.list;
  textbookBridge.list = async (projectId: string) => (await store.list(projectId)).map((item) => item.jobId !== legacyJob.job.id ? item : {
    ...item, progress: { ...item.progress, ...privateProgress, error: `EPERM: lstat '${legacyPath}'`,
      materialStatus: checkpoint.webReads, localMaterialWarnings: [`EACCES: readFile '${windowsPath}'`] } });
  try {
    const compatibility = await getTool('query_textbook_job')!.execute({ jobId: legacyJob.job.id }, ctx);
    const payload = JSON.stringify(compatibility);
    assert.ok(!payload.includes(legacyPath) && !payload.includes('PRIVATE_TEST_USER'));
    assert.ok(payload.includes(ordinaryFeedback) && payload.includes(ordinaryEnglish) && payload.includes(codeExplanation));
  } finally { textbookBridge.list = currentList; }
  pass('查询边界再次净化旧宿主进度摘要，完整序列化不携带旧诊断路径，不依赖宿主已更新或改写正常教学反馈');
  // New metadata travels with the exact frozen snapshot without rewriting old caches.
  notes = [project];
  const abstractDirectory = path.join(temp, 'abstract-check');
  let abstractStore = new TextbookStore(abstractDirectory);
  const abstractCreated = await abstractStore.command({ op: 'create', spec: await spec() }, 7, getNotes);
  let abstractClaimed = await abstractStore.command({ op: 'claim', jobId: abstractCreated.job.id }, 7, getNotes);
  const abstractSnapshot = await abstractStore.readBoundUrl({ jobId: abstractCreated.job.id, token: abstractClaimed.token!, resourceId: 'U1' }, 7, getNotes,
    (item, signal) => readTextbookBoundBody(item, signal, async url => body(url, Buffer.from(`<a id="abstract">摘要/Abstract</a><div name="#abstract"><p>${text}</p></div>`))));
  assert.equal(abstractSnapshot.web.contentKind, 'abstract');
  abstractStore = new TextbookStore(abstractDirectory);
  abstractClaimed = await abstractStore.command({ op: 'claim', jobId: abstractCreated.job.id }, 7, getNotes);
  const abstractAgain = await abstractStore.readBoundUrl({ jobId: abstractCreated.job.id, token: abstractClaimed.token!, resourceId: 'U1' }, 7, getNotes,
    async () => { throw new Error('No refetch permitted'); });
  assert.deepEqual(abstractAgain, abstractSnapshot);
  const abstractSources = await collectBoundTextbookSources(abstractClaimed.job, abstractClaimed.token!, async () => abstractAgain, async () => {});
  assert.equal(abstractSources[0].web!.contentKind, 'abstract');
  abstractClaimed.job.checkpoint.sources = abstractSources;
  await abstractStore.command({ op: 'checkpoint', jobId: abstractCreated.job.id, token: abstractClaimed.token!, stage: 'materials', checkpoint: abstractClaimed.job.checkpoint }, 7, getNotes);
  const sourceId = abstractSources[0].sourceId;
  const section = `摘要说明了心理账户的概念，未提供完整论文的实验细节。[${sourceId}]`;
  const referenceOnly = assembleTextbook({ title: '摘要边界', objectives: [],
    chapters: [{ id: 'ch1', title: '摘要边界', bridge: '仅核对公开摘要能够支持的概念。', sourceIds: [sourceId] }] } as any,
    [{ id: 'ch1', sections: { explanation: section, boundaries: section, workedExample: section,
      practice: section, answer: section, selfCheck: section, summary: section } }], abstractSources);
  assert.ok(referenceOnly.includes('论文摘要（非全文）'));
  pass('摘要标记贯穿真实 Host 快照、重启缓存、资料选段、坐标版本校验和教材来源区；旧快照仍可读');
  const apiMarkdown = `\\#\\# \\*\\*摘要\\*\\*：${text}\n\n公式： $\\frac{x}{y}$\n\n\`\`\`python\nx = 1\n\`\`\``;
  const apiDirectory = path.join(temp, 'api-abstract-check');
  let apiStore = new TextbookStore(apiDirectory), apiReads = 0;
  const apiCreated = await apiStore.command({ op: 'create', spec: await spec() }, 11, getNotes);
  let apiLease = await apiStore.command({ op: 'claim', jobId: apiCreated.job.id }, 11, getNotes);
  const apiSnapshot = await apiStore.readBoundUrl({ jobId: apiCreated.job.id, token: apiLease.token!, resourceId: 'U1' }, 11, getNotes,
    (item, signal) => readTextbookBoundBodyWithBrowser(item, signal, { api: {
      search: async () => { throw new Error('No unsolicited searches'); },
      fetchPage: async url => { apiReads++; assert.equal(url, resource.url); return { title: '论文摘要', content: apiMarkdown }; },
    }, direct: async () => { throw new Error('No direct fallback for supported API'); } }));
  assert.equal(apiSnapshot.text, apiMarkdown); assert.equal(apiSnapshot.web.contentKind, 'abstract');
  assert.equal(apiSnapshot.web.acquisition, 'provider_api');
  apiStore = new TextbookStore(apiDirectory);
  apiLease = await apiStore.command({ op: 'claim', jobId: apiCreated.job.id }, 11, getNotes);
  const apiCached = await apiStore.readBoundUrl({ jobId: apiCreated.job.id, token: apiLease.token!, resourceId: 'U1' }, 11, getNotes,
    async () => { throw new Error('No extra API request after restart'); });
  assert.deepEqual(apiCached, apiSnapshot); assert.equal(apiReads, 1);
  const apiSources = await collectBoundTextbookSources(apiLease.job, apiLease.token!, async () => apiCached, async () => {});
  assert.equal(apiSources[0].web!.contentKind, 'abstract'); assert.equal(apiSources[0].text, apiMarkdown);
  const apiBook = assembleTextbook({ title: 'API 摘要', objectives: [], chapters: [{ id: 'ch1', title: '摘要范围', bridge: '边界', sourceIds: [apiSources[0].sourceId] }] } as any,
    [{ id: 'ch1', sections: { explanation: section, boundaries: section, workedExample: section, practice: section, answer: section, selfCheck: section, summary: section } }], apiSources);
  assert.ok(apiBook.includes('论文摘要（非全文）') && apiBook.includes('联网 API'));
  pass('API 转义 Markdown 摘要→真实冻结/重启/选材/教材来源，公式代码原样且只抓取一次，不改旧快照');
  const renderedDirectory = path.join(temp, 'rendered-check');
  let renderedStore = new TextbookStore(renderedDirectory), renderCalls = 0;
  const renderedCreated = await renderedStore.command({ op: 'create', spec: await spec() }, 8, getNotes);
  let renderedLease = await renderedStore.command({ op: 'claim', jobId: renderedCreated.job.id }, 8, getNotes);
  const renderedSnapshot = await renderedStore.readBoundUrl({ jobId: renderedCreated.job.id, token: renderedLease.token!, resourceId: 'U1' }, 8, getNotes,
    (item, signal) => readTextbookBoundBodyWithBrowser(item, signal, {
      direct: async () => { throw new Error('公开资源返回 HTTP 403'); },
      render: async url => { renderCalls++; return body(url); },
    }));
  assert.equal(renderCalls, 1); assert.equal(renderedSnapshot.web.acquisition, 'anonymous_browser');
  assert.equal(renderedSnapshot.version, await textbookHash({ text: renderedSnapshot.text, web: renderedSnapshot.web }));
  renderedStore = new TextbookStore(renderedDirectory);
  renderedLease = await renderedStore.command({ op: 'claim', jobId: renderedCreated.job.id }, 8, getNotes);
  const reusedRendered = await renderedStore.readBoundUrl({ jobId: renderedCreated.job.id, token: renderedLease.token!, resourceId: 'U1' }, 8, getNotes,
    async () => { throw new Error('No browser or direct refetch permitted'); });
  assert.deepEqual(reusedRendered, renderedSnapshot);
  const renderLabels: string[] = [];
  const renderedSources = await collectBoundTextbookSources(renderedLease.job, renderedLease.token!, async () => reusedRendered, async label => { renderLabels.push(label); });
  assert.equal(renderedSources[0].web!.acquisition, 'anonymous_browser');
  assert.ok(renderLabels.some(label => label.includes('匿名浏览器正文快照已保存')));
  await renderedStore.command({ op: 'checkpoint', jobId: renderedCreated.job.id, token: renderedLease.token!, stage: 'materials',
    checkpoint: { ...renderedLease.job.checkpoint, sources: renderedSources } }, 8, getNotes);
  const renderedId = renderedSources[0].sourceId;
  const renderedBook = assembleTextbook({ title: '动态正文', objectives: [],
    chapters: [{ id: 'ch1', title: '动态正文', bridge: '核对冻结正文。', sourceIds: [renderedId] }] } as any,
    [{ id: 'ch1', sections: { explanation: section, boundaries: section, workedExample: section,
      practice: section, answer: section, selfCheck: section, summary: section } }], renderedSources);
  assert.ok(renderedBook.includes('匿名浏览器渲染'));
  const renderedManifest = { ...manifest, textbookId: renderedCreated.job.id, generationJobId: renderedCreated.job.id,
    sources: renderedSources.map(({ text: _text, assets: _assets, ...pointer }) => pointer) };
  const frozenEvidence = await renderedStore.readWebEvidence({ projectNoteId: project.id, sourceId: renderedId,
    snapshotId: renderedSnapshot.web.snapshotId, version: renderedSnapshot.version }, async () => [{ ...project, textbook: renderedManifest }]);
  assert.ok(renderedSnapshot.text.startsWith(frozenEvidence.text));
  pass('匿名渲染标记贯穿原解析器、Host 哈希快照、进度、教材来源和发布引用；重启零联网复用冻结正文，不改旧快照');
  for (const [index, legacyUrl] of ['https://www.bilibili.com/video/BV1234567890/',
    'https://book.douban.com/subject/123/', 'https://www.icourse163.org/course/demo',
    'https://example.org/lesson'].entries()) {
    const legacyProject = note(`legacy-web-${index}`, '旧证据兼容测试');
    legacyProject.resources = [{ title: '旧来源', url: legacyUrl, resourceType: index === 3 ? 'video' : 'article' }];
    const legacyNotes = async () => [legacyProject];
    const legacyDirectory = path.join(temp, `legacy-web-${index}`);
    let legacyStore = new TextbookStore(legacyDirectory);
    const made = await legacyStore.command({ op: 'create', spec: await spec({ projectNoteId: legacyProject.id,
      rootProjectId: legacyProject.id, projectTitle: legacyProject.title, planningHash: await textbookHash(projectPlanningSnapshot(legacyProject)),
      boundUrls: textbookBoundUrls(legacyProject) }) }, 9, legacyNotes);
    const oldWeb = { snapshotId: `${made.job.id}-U1`, url: legacyUrl, finalUrl: legacyUrl,
      readAt: '2026-10-01', contentType: 'text/html', format: 'html' as const, coverage: 'full_text' as const };
    const oldSnapshot = { schemaVersion: 1 as const, jobId: made.job.id, resourceId: 'U1', title: '旧来源',
      text, web: oldWeb, version: await textbookHash({ text, web: oldWeb }) };
    // Simulate a pre-upgrade checkpoint, with its authentic frozen hash and source range.
    const oldSources = await collectBoundTextbookSources(made.job, 'fixture-token', async () => oldSnapshot, async () => {});
    made.job.checkpoint.sources = oldSources;
    const jobFile = path.join(legacyDirectory, 'textbook-jobs', `${made.job.id}.json`);
    const cacheDirectory = path.join(legacyDirectory, 'textbook-jobs', 'web-snapshots');
    await fileOps.mkdir(cacheDirectory, { recursive: true });
    const snapshotFile = path.join(cacheDirectory, `${made.job.id}-U1.json`);
    await writeFile(snapshotFile, JSON.stringify(oldSnapshot)); await writeFile(jobFile, JSON.stringify(made.job));
    const frozen = await readFile(snapshotFile, 'utf8');
    legacyStore = new TextbookStore(legacyDirectory);
    const lease = await legacyStore.command({ op: 'claim', jobId: made.job.id }, 9, legacyNotes);
    let newReads = 0;
    await assert.rejects(legacyStore.readBoundUrl({ jobId: made.job.id, token: lease.token!, resourceId: 'U1' }, 9, legacyNotes,
      async () => { newReads++; throw new Error('No network replacement permitted'); }), /旧网页快照.*重新准备/u);
    assert.equal(newReads, 0);
    await assert.rejects(legacyStore.command({ op: 'checkpoint', jobId: made.job.id, token: lease.token!, stage: 'context',
      checkpoint: lease.job.checkpoint }, 9, legacyNotes), /旧网页快照/u);
    await assert.rejects(legacyStore.command({ op: 'finish', jobId: made.job.id, token: lease.token! }, 9, legacyNotes), /旧网页快照/u);
    assert.equal(await readFile(snapshotFile, 'utf8'), frozen);
    assert.deepEqual((await legacyStore.command({ op: 'get', jobId: made.job.id }, 9, legacyNotes)).job.checkpoint, made.job.checkpoint);
    const historical = { ...legacyProject, textbook: { ...manifest, projectNoteId: legacyProject.id,
      rootProjectId: legacyProject.id, generationJobId: made.job.id,
      sources: oldSources.map(({ text: _text, assets: _assets, ...pointer }) => pointer) } };
    const oldEvidence = await legacyStore.readWebEvidence({ projectNoteId: legacyProject.id, sourceId: 'L1',
      snapshotId: oldWeb.snapshotId, version: oldSnapshot.version }, async () => [historical]);
    assert.equal(oldEvidence.text, text);
  }
  pass('旧误分类 HTML 快照及已保存 sources：重启恢复和完成均拒绝新生成，零联网替换，原草稿/哈希保留；历史引用仍可离线读取');
  for (const format of ['document', 'transcript'] as const) {
    const admittedProject = note(`legacy-valid-${format}`, '合法旧证据');
    admittedProject.resources = [{ title: '旧正文', url: 'https://www.bilibili.com/video/BV1234567890/', resourceType: 'video' }];
    const admittedNotes = async () => [admittedProject];
    const admittedDirectory = path.join(temp, `legacy-valid-${format}`);
    let admittedStore = new TextbookStore(admittedDirectory);
    const made = await admittedStore.command({ op: 'create', spec: await spec({ projectNoteId: admittedProject.id,
      rootProjectId: admittedProject.id, planningHash: await textbookHash(projectPlanningSnapshot(admittedProject)),
      boundUrls: textbookBoundUrls(admittedProject) }) }, 10, admittedNotes);
    let lease = await admittedStore.command({ op: 'claim', jobId: made.job.id }, 10, admittedNotes);
    const valid = await admittedStore.readBoundUrl({ jobId: made.job.id, token: lease.token!, resourceId: 'U1' }, 10, admittedNotes,
      async item => ({ text, format, finalUrl: item.url, contentType: format === 'document' ? 'application/pdf' : 'text/vtt' }));
    admittedStore = new TextbookStore(admittedDirectory);
    lease = await admittedStore.command({ op: 'claim', jobId: made.job.id }, 10, admittedNotes);
    const reused = await admittedStore.readBoundUrl({ jobId: made.job.id, token: lease.token!, resourceId: 'U1' }, 10, admittedNotes,
      async () => { throw new Error('Must reuse legitimate legacy cache'); });
    assert.deepEqual(reused, valid);
    const sources = await collectBoundTextbookSources(lease.job, lease.token!, async () => reused, async () => {});
    await admittedStore.command({ op: 'checkpoint', jobId: made.job.id, token: lease.token!, stage: 'materials',
      checkpoint: { ...lease.job.checkpoint, sources } }, 10, admittedNotes);
  }
  pass('合法旧文档/真实字幕缓存恢复仍零重复请求，与已有旧文章缓存兼容检查共同覆盖，不按站点无差别失效');
  console.log(`textbook web: ${checks} groups passed; synthetic files, injected HTTP transport/model; no live network or user vault`);
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(temp, { recursive: true, force: true });
}
