import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { lookup } from 'node:dns/promises';
import { readTextbookBoundBodyWithBrowser, shouldRenderTextbookPage } from '../src/electron/textbookWebFallback';
import { startTextbookBrowserProxy } from '../src/electron/textbookBrowserProxy';
import { fetchTextbookPublicBody } from '../src/electron/textbookWebReader';
import type { TextbookBoundUrl } from '../src/services/textbook/webTypes';

const resource: TextbookBoundUrl = { id: 'U1', title: '已批准网页', url: 'https://example.org/lesson', resourceType: 'article' };
const text = '心理账户是人们对金钱进行分类、记账和评估的过程，不同账户的主观价值可能不同。需要结合情境核对成立条件，不能把教学例子当作研究证据。'.repeat(3);
const html = `<article><h1>心理账户</h1><p>${text}</p><pre>if ready:\n    compare()</pre></article>`;
const http403 = new Error('公开资源返回 HTTP 403');
let checks = 0; const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
let renders = 0;
const render = async (url: string, signal: AbortSignal) => { renders++; assert.equal(url, resource.url); signal.throwIfAborted();
  return { url, bytes: Buffer.from(html), contentType: 'text/html; charset=utf-8' }; };
const direct = async () => { throw http403; };
const result = await readTextbookBoundBodyWithBrowser(resource, undefined, { direct, render });
assert.equal(renders, 1); assert.equal(result.acquisition, 'anonymous_browser'); assert.equal(result.format, 'html');
assert.ok(result.text.includes(text) && result.text.includes('    compare()'));
pass('直接 403 后仅渲染原批准 URL；真实正文通过原解析器，保留代码及浏览器采集标记');
renders = 0;
const directOk = await readTextbookBoundBodyWithBrowser(resource, undefined, { direct: async () => ({ text, format: 'html', finalUrl: resource.url, contentType: 'text/html' }), render });
assert.equal(renders, 0); assert.equal(directOk.acquisition, undefined);
for (const message of ['资源 URL 含访问凭据', '资源域名指向内网、保留或不安全地址', '公开资源返回 HTTP 429',
  '公开资源返回 HTTP 404', '网页快照版本校验失败', '网页读取许可已失效', '该链接仅是课程/书籍介绍或目录页']) {
  await assert.rejects(readTextbookBoundBodyWithBrowser(resource, undefined, { direct: async () => { throw new Error(message); }, render }));
}
assert.equal(renders, 0);
for (const url of ['https://user:pass@example.org/a', 'file:///C:/private', 'https://example.org/a?access_token=x', 'https://example.org/a.pdf',
  'https://www.bilibili.com/video/BV1234567890/', 'https://book.douban.com/subject/123/']) assert.equal(shouldRenderTextbookPage({ ...resource, url }, http403), false);
pass('直连成功不启动浏览器；范围/凭据/内网/存储错误、429/404、已知视频/目录/二进制不借后备绕过');
for (const shell of ['<meta name="description" content="' + text + '"><div>加载中</div>', '<nav><p>' + text + '</p></nav>', '<h1>登录</h1>', '<div id="app"></div>']) {
  await assert.rejects(readTextbookBoundBodyWithBrowser(resource, undefined, { direct, render: async url => ({ url, bytes: Buffer.from(shell), contentType: 'text/html' }) }), /匿名浏览器/u);
}
pass('浏览器结果仍要求真实正文：meta 摘要、导航、登录壳和空 SPA 不充当教材证据');
const aborter = new AbortController();
await assert.rejects(readTextbookBoundBodyWithBrowser(resource, aborter.signal, { direct: async () => { aborter.abort(); throw http403; }, render }), error => (error as Error).name === 'AbortError');
assert.equal(renders, 0);
pass('取消后不启动后备，不以新窗口绕过已撤销的读取');

const publicDns = (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof lookup;
let connections = 0; const pins: string[] = [];
const connect = ((options: net.NetConnectOpts) => {
  connections++; pins.push((options as net.TcpNetConnectOpts).host!);
  const socket = new PassThrough() as unknown as net.Socket;
  queueMicrotask(() => socket.emit('connect')); return socket;
}) as typeof net.connect;
const controller = new AbortController(); const proxy = await startTextbookBrowserProxy(controller.signal, { resolve: publicDns, connect });
const tunnel = (target: string) => new Promise<{ status: number; socket: net.Socket }>((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
  request.on('connect', (response, socket) => resolve({ status: response.statusCode!, socket })); request.on('error', reject); request.end();
});
try {
  const pinned = await tunnel('example.org:443'); assert.equal(pinned.status, 200); pinned.socket.destroy();
  assert.deepEqual(pins, ['8.8.8.8']);
  for (const target of ['localhost:443', 'example.org:444', 'user:pass@example.org:443', 'example.org:443/path']) {
    const blocked = await tunnel(target); assert.equal(blocked.status, 403); blocked.socket.destroy();
  }
  assert.equal(connections, 1);
} finally { await proxy.close(); }
pass('浏览器网关使用已核验 IP 建立真实 socket 参数，非标准端口、凭据及 localhost 隧道拒绝');
const privateProxy = await startTextbookBrowserProxy(new AbortController().signal, { resolve: (async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup, connect });
try {
  const denied = await new Promise<number>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: privateProxy.port, method: 'CONNECT', path: 'public-looking.example:443' });
    request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!); }); request.on('error', reject); request.end();
  });
  assert.equal(denied, 403); assert.equal(connections, 1);
} finally { await privateProxy.close(); }
await assert.rejects(fetchTextbookPublicBody('http://localhost/private'), /内网/u);
pass('DNS 指向内网在真正建立隧道前拒绝，和直接下载共用公开地址校验');
// Exercise the HTTP branch with an actual local server, not a mock Agent. Only
// the already-pinned test socket is redirected; default DNS/network is never used.
const fixtureHeaders: http.IncomingHttpHeaders[] = [];
const fixture = http.createServer((request, response) => { fixtureHeaders.push(request.headers); response.end(text); });
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixturePort = (fixture.address() as net.AddressInfo).port;
const httpPins: net.TcpNetConnectOpts[] = [];
const httpProxy = await startTextbookBrowserProxy(new AbortController().signal, { resolve: publicDns,
  connect: ((options: net.TcpNetConnectOpts) => { httpPins.push(options); return net.connect({ host: '127.0.0.1', port: fixturePort }); }) as typeof net.connect });
try {
  const plain = (url: string, method = 'GET') => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: httpProxy.port, path: url, method,
      headers: { Authorization: 'NO_USER_AUTH', 'Proxy-Authorization': 'NO_PROXY_AUTH' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, text: body }));
    }); request.on('error', reject); request.end();
  });
  assert.deepEqual(await plain('http://example.org/lesson'), { status: 200, text });
  assert.equal((await plain('http://example.org:443/lesson')).status, 200);
  assert.deepEqual(httpPins.map(item => [item.host, item.port]), [['8.8.8.8', 80], ['8.8.8.8', 443]]);
  assert.equal(fixtureHeaders[0].host, 'example.org'); assert.equal(fixtureHeaders[1].host, 'example.org:443');
  assert.ok(fixtureHeaders.every(item => !item.authorization && !item['proxy-authorization']));
  assert.equal((await plain('http://example.org/write', 'POST')).status, 403); assert.equal(httpPins.length, 2);
} finally { await httpProxy.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
pass('真实 HTTP 代理保留目标 Host/已批准端口，socket 固定公网 IP，删除认证头并拒绝 POST；不依赖 Agent 假桩');
const cancelled = new AbortController(); const cancelProxy = await startTextbookBrowserProxy(cancelled.signal, { resolve: publicDns, connect });
cancelled.abort(); await cancelProxy.close();
await assert.rejects(new Promise<void>((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: cancelProxy.port }); socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
}));
pass('取消和完成均关闭本次专用监听器及隧道，不修改系统代理、不残留后台连接');
console.log(`textbook browser fallback: ${checks} groups passed; injected rendering/public DNS and local gateway only, no live sites/model/user vault`);
