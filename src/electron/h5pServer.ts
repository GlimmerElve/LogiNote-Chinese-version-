import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { H5pArchive, h5pSafePath } from './h5pPackage';
import { H5P_PLAYER_HTML, H5P_CONTENT_LAYOUT_CSS, h5pBootstrap } from './h5pPlayerPage';
import { readH5pProgress, type H5pProgress } from './h5pStore';
import type { H5pAppearance } from './h5pAppearance';

const types: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.vtt': 'text/vtt' };
export const H5P_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' about:; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

/** One random loopback origin and token per window. No generic filesystem route, CORS or host API. */
export async function startH5pServer(options: {
  archive: H5pArchive; files: Map<string, string>; assets: string; progress: H5pProgress | null;
  styles?: string; appearance?: H5pAppearance;
  readProgress?: () => Promise<H5pProgress | null>;
  save: (input: unknown) => Promise<void>;
}) {
  const token = randomBytes(24).toString('hex'), prefix = `/${token}/`;
  let origin = '', pendingSave = false, activeRequests = 0;
  let latestProgress = options.progress, pageGeneration = '', checkpointFinished: Promise<void> | undefined;
  const allowedAsset = /^[a-zA-Z0-9_./-]+$/u;
  const server = http.createServer((request, response) => {
    // A content script must not enqueue unbounded decompression work in the host.
    if (activeRequests >= 8) { response.statusCode = 429; response.end(); return; }
    activeRequests++;
    void (async () => {
      response.setHeader('Content-Security-Policy', H5P_CSP);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=()');
      const fail = (status: number) => { response.statusCode = status; response.end(); };
      if (`http://${request.headers.host}` !== origin || !request.url?.startsWith(prefix)) return fail(403);
      if (request.headers.origin && request.headers.origin !== origin) return fail(403);
      const route = decodeURIComponent(request.url.slice(prefix.length).split('?')[0]);
      if (route === 'checkpoint') {
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return fail(403);
        const generation = request.headers['x-h5p-page'];
        if (!pageGeneration || generation !== pageGeneration) return fail(409);
        if (pendingSave) return fail(429);
        pendingSave = true;
        let finished!: () => void;
        checkpointFinished = new Promise<void>(resolve => { finished = resolve; });
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) return fail(413); chunks.push(chunk); }
          if (generation !== pageGeneration) return fail(409);
          const input = readH5pProgress(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          await options.save(input);
          latestProgress = input;
          response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}');
        } finally { pendingSave = false; checkpointFinished = undefined; finished(); }
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method || '')) return fail(405);
      let bytes: Buffer, type: string;
      if (!route) { bytes = Buffer.from(H5P_PLAYER_HTML.replace('<html lang="zh-CN">', `<html lang="zh-CN" class="${options.appearance?.theme === 'dark' ? 'dark' : ''}">`)); type = 'text/html'; }
      else if (route === 'theme.css') { bytes = options.styles ? await fs.readFile(options.styles) : Buffer.from(''); type = 'text/css'; }
      else if (route === 'content-layout.css') { bytes = Buffer.from(H5P_CONTENT_LAYOUT_CSS); type = 'text/css'; }
      else if (route === 'bootstrap.js') {
        // Join accepted writes before restoring, then fence out requests from the
        // old document. A reload must never restore the opening-time snapshot.
        await checkpointFinished;
        const generation = request.method === 'HEAD' ? pageGeneration : randomBytes(16).toString('hex');
        if (request.method !== 'HEAD') pageGeneration = generation;
        const progress = options.readProgress ? await options.readProgress() : latestProgress;
        bytes = Buffer.from(h5pBootstrap(progress, options.appearance, generation)); type = 'text/javascript';
      }
      else if (route.startsWith('player/')) {
        const name = route.slice(7);
        if (!allowedAsset.test(name) || !h5pSafePath(name)) return fail(403);
        const file = path.join(options.assets, name);
        // All ancestors are installation-owned; never take an asset path from H5P JSON.
        const real = await fs.realpath(file), base = await fs.realpath(options.assets);
        if (!real.startsWith(base + path.sep)) return fail(403);
        const info = await fs.lstat(real);
        if (!info.isFile() || info.size > 4_000_000) return fail(403);
        bytes = await fs.readFile(real); type = types[path.extname(name)] || 'application/octet-stream';
      } else if (route.startsWith('package/')) {
        const name = route.slice(8), actual = options.files.get(name);
        if (!actual || !h5pSafePath(name) || /\.(?:html?|exe|dll|cjs|mjs)$/iu.test(name)
          || name.startsWith('content/') && /\.(?:js|css)$/iu.test(name)) return fail(403);
        bytes = await options.archive.read(actual); type = types[path.extname(name)] || 'application/octet-stream';
      } else return fail(404);
      response.setHeader('Content-Type', `${type}${type.startsWith('text/') || type === 'application/json' ? '; charset=utf-8' : ''}`);
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
        const start = match ? Number(match[1]) : -1, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        if (start < 0 || start > end || start >= bytes.length) { response.setHeader('Content-Range', `bytes */${bytes.length}`); return fail(416); }
        response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`); bytes = bytes.subarray(start, end + 1);
      }
      response.setHeader('Content-Length', bytes.length);
      response.setHeader('Accept-Ranges', 'bytes');
      response.end(request.method === 'HEAD' ? undefined : bytes);
    })().catch(() => { if (!response.headersSent) response.statusCode = 500; response.end(); }).finally(() => { activeRequests--; });
  });
  server.maxConnections = 20; server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('H5P 本地服务未能启动');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin + prefix, origin, setAppearance: (value: H5pAppearance) => { options.appearance = value; }, close: async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  } };
}
