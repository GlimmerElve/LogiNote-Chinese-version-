import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import { renderTextbookPublicPage } from '../src/electron/textbookBrowser';
import { readTextbookBoundBodyWithBrowser } from '../src/electron/textbookWebFallback';
import { readTextbookBoundBody } from '../src/electron/textbookWebReader';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';

app.setPath('userData', process.env.LOGINOTE_BROWSER_TEST_STATE!);
app.on('window-all-closed', () => {});
const text = '心理账户是对金钱进行分类与记账的心理过程。它不意味着钱的客观价值改变，而是说明人们可能按账户标签作出不同判断。核对案例时必须保留情境条件，不把假设例子当作实证数据。'.repeat(3);
const target = 'https://8.8.8.8/approved-lesson';
let checks = 0; const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function main() {
  await app.whenReady();
  let staleSession: Electron.Session | undefined, writes = 0, fixtureMode = 'dynamic'; const destinations: string[] = [];
  const fixture = https.createServer({ key: await readFile(process.env.LOGINOTE_BROWSER_TEST_KEY!), cert: await readFile(process.env.LOGINOTE_BROWSER_TEST_CERT!) }, (request, response) => {
    if (request.method !== 'GET') writes++;
    if (request.url === '/api/body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ text })); return; }
    if (request.url === '/slow-script') { const timer = setTimeout(() => { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(''); }, 5000); response.once('close', () => clearTimeout(timer)); return; }
    if (fixtureMode === 'forbidden') { response.writeHead(403); response.end(text); return; }
    if (fixtureMode === 'download') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=fixture.txt' }); response.end(text); return; }
    if (fixtureMode === 'redirect' && request.url === '/approved-lesson') { response.writeHead(302, { Location: '/final-lesson' }); response.end(); return; }
    if (fixtureMode === 'private-redirect') { response.writeHead(302, { Location: 'https://127.0.0.1/private' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (fixtureMode === 'empty') { response.end('<div>加载中</div>'); return; }
    if (fixtureMode === 'challenge') { response.end('<title>安全验证</title><article><p>' + text + '</p></article>'); return; }
    if (fixtureMode === 'interrupted') { response.end('<article><p>' + text + '</p></article><script async src="/slow-script"></script><script>document.addEventListener("DOMContentLoaded",()=>setTimeout(()=>window.stop(),50))</script>'); return; }
    response.end(`<html><head><meta name="description" content="FAKE_METADATA"><style>.invisible{display:none}</style></head><body><main id="lesson">加载中</main>
      <p class="invisible">HIDDEN_PRIVATE_COPY</p><script>setTimeout(async()=>{
        const data=await fetch('/api/body').then(r=>r.json());document.querySelector('#lesson').innerHTML='<article><p>'+data.text+'</p><pre>if ready:\\n    compare()</pre></article>';
        document.body.dataset.userCookie=String(document.cookie.includes('loginSecret'));
        document.cookie='anonymous=ok'; localStorage.setItem('test','temporary'); document.body.dataset.popupDenied=String(window.open('https://8.8.8.8/other')===null);
        fetch('https://8.8.8.8/write',{method:'POST',body:'forbidden'}).catch(()=>{});
        fetch('https://127.0.0.1/private').catch(()=>{});
      },650)</script></body></html>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.address() as net.AddressInfo).port;
  // Only the test socket destination is redirected. Production still validates
  // and pins 8.8.8.8; no protocol interception bypasses webRequest callbacks.
  const network = { connect: ((options: net.TcpNetConnectOpts) => {
    destinations.push(options.host!); assert.equal(options.host, '8.8.8.8'); assert.equal(options.port, 443);
    return net.connect({ host: '127.0.0.1', port: fixturePort });
  }) as typeof net.connect };
  const trustFixture = async (isolated: Electron.Session) => isolated.setCertificateVerifyProc((request, callback) => callback(request.hostname === '8.8.8.8' ? 0 : -2));
  try {
  await session.defaultSession.cookies.set({ url: target, name: 'loginSecret', value: 'fixture-user-login' });
  const body = await renderTextbookPublicPage(target, undefined, async isolated => {
    staleSession = isolated; assert.equal(isolated.isPersistent(), false);
    assert.deepEqual(await isolated.cookies.get({}), []);
    await trustFixture(isolated);
    isolated.on('will-download', () => { throw new Error('Unexpected download'); });
  }, network);
  const parsed = await readTextbookBoundBody({ id: 'U1', title: '动态正文', url: target }, undefined, async () => body);
  assert.ok(parsed.text.includes(text)); assert.ok(!parsed.text.includes('FAKE_METADATA') && !parsed.text.includes('HIDDEN_PRIVATE_COPY'));
  assert.ok(destinations.length > 0); assert.ok(destinations.every(host => host === '8.8.8.8')); assert.equal(writes, 0, 'write requests');
  assert.ok(body.bytes.toString().includes('data-popup-denied="true"')); assert.ok(body.bytes.toString().includes('data-user-cookie="false"'));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.deepEqual(await staleSession!.cookies.get({}), []);
  assert.equal(await staleSession!.getCacheSize(), 0);
  pass('真实隐藏 Chromium 执行延迟 JS/XHR 后读取正文；不读 meta/隐藏文字，POST/内网请求与弹窗不产生访问');
  pass('本次窗口关闭，独立非持久会话 Cookie/缓存清空；未借用用户目录或登录容器');
  fixtureMode = 'empty';
  const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
  await assert.rejects(renderTextbookPublicPage(target, controller.signal, trustFixture, network));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('等待动态正文期间取消，真实窗口关闭，不继续后台提取');
  fixtureMode = 'challenge';
  await assert.rejects(renderTextbookPublicPage(target, undefined, trustFixture, network), /安全验证/u);
  pass('即使验证码页面带有长文本，也不会作为教材正文');
  fixtureMode = 'forbidden';
  await assert.rejects(renderTextbookPublicPage(target, undefined, trustFixture, network), /匿名浏览器返回 HTTP 403/u);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('浏览器仍返回 403 时立即跳过，保留准确 HTTP 诊断，不把错误正文当证据');
  fixtureMode = 'redirect';
  const redirected = await renderTextbookPublicPage(target, undefined, trustFixture, network);
  assert.equal(redirected.url, 'https://8.8.8.8/final-lesson'); assert.ok(redirected.bytes.toString().includes(text));
  fixtureMode = 'private-redirect'; const beforeRedirect = destinations.length;
  await assert.rejects(renderTextbookPublicPage(target, undefined, trustFixture, network), /内网|安全限制/u);
  assert.equal(destinations.length - beforeRedirect, 1); assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('真实 302 公开跳转保留最终 URL；内网跳转在建立连接前拒绝');
  fixtureMode = 'download';
  await assert.rejects(renderTextbookPublicPage(target, undefined, trustFixture, network), /附件/u);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('附件响应不落盘，不打开下载窗口，明确跳过而不误报为网页正文');
  fixtureMode = 'interrupted';
  const interrupted = await renderTextbookPublicPage(target, undefined, trustFixture, network);
  assert.ok(interrupted.bytes.toString().includes(text)); assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('已提交 DOM 后页面停止加载，仍只校验当前批准 URL 的稳定实际正文，不因附属加载中断丢弃可读来源');
  } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
  if (process.argv.includes('--live')) {
    const anchor = JSON.parse(await readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'), 'utf8'));
    const metadata = JSON.parse(await readFile(path.join(anchor.dataRoot, 'vault', 'metadata.json'), 'utf8'));
    const urls = [...new Set(Object.values(metadata.notesMeta).flatMap((raw: any) => (raw.resources || [])
      .filter((item: any) => !item.documentId && /https?:\/\/baike\.baidu\.com\//u.test(item.url || '')).map((item: any) => item.url)))] as string[];
    const results: unknown[] = [];
    const limit = process.argv.includes('--first-only') ? 1 : 4;
    for (const [index, url] of urls.slice(0, limit).entries()) {
      const resource = { id: `U${index + 1}`, title: '已绑定百科', url, resourceType: 'article' }; const start = Date.now();
      let directError = '', directChars = 0, browserError = '', browserChars = 0;
      const browserResponses: { status: number; contentType?: string }[] = [];
      const browserEvents: { event: string; code?: number; description?: string; url?: string }[] = [];
      try { directChars = (await readTextbookBoundBody(resource)).text.length; } catch (error) { directError = (error as Error).message; }
      try {
        const answer = await readTextbookBoundBodyWithBrowser(resource, undefined, {
          direct: async () => { throw new Error(directError || '公开资源返回 HTTP 403'); },
          render: async (url, signal) => {
            const created = (_event: Electron.Event, contents: Electron.WebContents) => {
              contents.on('did-start-navigation', details => { if (details.isMainFrame) browserEvents.push({ event: 'start-navigation', url: details.url }); });
              contents.on('did-navigate', (_event, url) => browserEvents.push({ event: 'navigate', url }));
              contents.on('dom-ready', () => browserEvents.push({ event: 'dom-ready' }));
              contents.on('did-fail-load', (_event, code, description, url, main) => { if (main) browserEvents.push({ event: 'fail-load', code, description, url }); });
            };
            app.on('web-contents-created', created);
            try { return await renderTextbookPublicPage(url, signal, async isolated => {
              isolated.webRequest.onResponseStarted(details => {
                if (details.resourceType !== 'mainFrame') return;
                const key = Object.keys(details.responseHeaders || {}).find(header => header.toLowerCase() === 'content-type');
                browserResponses.push({ status: details.statusCode, contentType: key ? details.responseHeaders![key]?.[0] : undefined });
              });
            }); } finally { app.removeListener('web-contents-created', created); }
          },
        });
        browserChars = answer.text.length;
      } catch (error) { browserError = (error as Error).message; }
      const result = { url, directChars, directError, browserChars, browserError, browserResponses, browserEvents, milliseconds: Date.now() - start };
      results.push(result); console.log(JSON.stringify(result));
    }
    const directory = path.join(process.env.LOGINOTE_BROWSER_TEST_ROOT!, 'data', 'textbook-browser-tests', new Date().toISOString().replace(/[:.]/gu, '-'));
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'results.json'), JSON.stringify({ method: 'same bound URL, direct versus unique anonymous Chromium; no LLM/search/user vault writes', results }, null, 2));
    console.log(`REPORT ${path.join(directory, 'results.json')}`);
  }
  console.log(`native textbook browser: ${checks} groups passed; real Electron and local HTTPS fixtures; no model/user vault writes`);
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
