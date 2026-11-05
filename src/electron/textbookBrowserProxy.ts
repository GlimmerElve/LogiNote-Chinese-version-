import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { lookup } from 'node:dns/promises';
import { resolveTextbookPublicTarget } from './textbookWebReader';

/** Per-read loopback gateway, not a system proxy. Chromium retains native TLS,
 * but every upstream socket is pinned to a positively checked public IP. */
export async function startTextbookBrowserProxy(signal: AbortSignal, dependencies: {
  resolve?: typeof lookup; connect?: typeof net.connect;
} = {}) {
  const sockets = new Set<Duplex>(); let bytes = 0, requests = 0, closed = false;
  const checkRequest = () => { signal.throwIfAborted(); if (closed || ++requests > 120) throw new Error('匿名浏览器请求数量超过上限'); };
  const track = (socket: Duplex) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 16_000_000) { for (const item of sockets) item.destroy(); closed = true; }
    }); return socket;
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      checkRequest();
      if (!['GET', 'HEAD'].includes(request.method || '')) throw new Error('只允许公开只读请求');
      const { url, pinned } = await resolveTextbookPublicTarget(request.url || '', signal, dependencies.resolve);
      if (url.protocol !== 'http:') throw new Error('无效代理请求');
      signal.throwIfAborted(); if (closed || request.destroyed) return;
      const port = Number(url.port || 80);
      const headers = { ...request.headers, host: url.host };
      for (const key of ['proxy-authorization', 'proxy-connection', 'authorization', 'connection']) delete headers[key];
      const upstream = http.request({ hostname: pinned.address, family: pinned.family, port,
        path: url.pathname + url.search, method: request.method, headers, signal, agent: dependencies.connect ? undefined : false,
        createConnection: dependencies.connect ? () => dependencies.connect!({ host: pinned.address, family: pinned.family, port }) : undefined }, remote => {
        response.writeHead(remote.statusCode || 502, remote.headers); remote.pipe(response);
      });
      upstream.on('socket', track); upstream.on('error', () => response.destroy()); request.pipe(upstream);
    })().catch(() => { if (!response.headersSent) response.writeHead(403); response.end(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (request, client, head) => {
    void (async () => {
      checkRequest();
      if (!/^(?:\[[\da-f:]+\]|[a-z\d.-]+):443$/iu.test(request.url || '')) throw new Error('只允许标准 HTTPS 隧道');
      const { pinned } = await resolveTextbookPublicTarget(`https://${request.url}`, signal, dependencies.resolve);
      signal.throwIfAborted(); if (closed || client.destroyed) return;
      const upstream = (dependencies.connect || net.connect)({ host: pinned.address, family: pinned.family, port: 443 });
      track(upstream); track(client);
      upstream.once('connect', () => {
        if (signal.aborted || closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.once('error', () => client.destroy()); client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const close = async () => {
    closed = true; signal.removeEventListener('abort', cancel);
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const cancel = () => { void close(); };
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
    const address = server.address() as net.AddressInfo;
    return { proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`, port: address.port, close };
  } catch (error) { await close(); throw error; }
}
