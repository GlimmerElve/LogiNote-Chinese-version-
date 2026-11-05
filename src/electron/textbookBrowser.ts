import { BrowserWindow, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { extractTextbookHtml } from './textbookWebContent';
import { resolveTextbookPublicTarget, type PublicBody } from './textbookWebReader';
import { startTextbookBrowserProxy } from './textbookBrowserProxy';

/** Trusted extraction code only. No meta descriptions/search snippets are returned.
 * Computed CSS visibility is frozen into the clone before the inert parser runs. */
const READ_RENDERED_BODY = `(() => {
  if (!document.body) return { url: location.href, html: '' };
  const original = [document.body, ...document.body.querySelectorAll('*')];
  if (original.length > 50000) return { error: 'structure' };
  if (original.some(node => node.tagName === 'INPUT' && node.getClientRects().length
    && (node.type === 'password' || /验证码/.test(node.placeholder || '')))) return { error: 'challenge' };
  const clone = document.body.cloneNode(true), copies = [clone, ...clone.querySelectorAll('*')];
  for (let i = original.length - 1; i >= 0; i--) {
    const node = original[i], copy = copies[i], style = getComputedStyle(node);
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','IFRAME','OBJECT','EMBED','SVG','CANVAS','FORM','INPUT','BUTTON','TEXTAREA','SELECT'].includes(node.tagName)
      || node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') copy.remove();
  }
  const html = clone.outerHTML;
  if (html.length > 2000000) return { error: 'size' };
  const title = document.title || '';
  if (/安全验证|访问验证|验证码|请先登录|access denied|just a moment|checking your browser/i.test(title)) return { error: 'challenge' };
  return { url: location.href, html };
})()`;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancelled!: () => void;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    cancelled = () => reject(signal.reason); signal.addEventListener('abort', cancelled, { once: true });
  })]); } finally { signal.removeEventListener('abort', cancelled); }
}

/** One hidden window + unique in-memory session per approved URL. Never uses
 * defaultSession, resource-search partitions, preload scripts or login containers.
 * Optional setup is for offline native acceptance tests; never exposed over IPC. */
export async function renderTextbookPublicPage(raw: string, caller?: AbortSignal, testSetup?: (session: Session) => Promise<void>,
  testNetwork?: Parameters<typeof startTextbookBrowserProxy>[1]): Promise<PublicBody> {
  const signal = caller ? AbortSignal.any([caller, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const initial = textbookPublicUrl(raw);
  await resolveTextbookPublicTarget(initial, signal, testNetwork?.resolve);
  const isolated = session.fromPartition(`textbook-render-${randomUUID()}`, { cache: false });
  const gateway = await startTextbookBrowserProxy(signal, testNetwork);
  let window: BrowserWindow | undefined, redirects = 0, requests = 0;
  const allowedTop = new Set([initial]); let loadedUrl = initial, pendingUrl = initial, committed = false, domReady = false;
  const fatal = new AbortController(), abort = AbortSignal.any([signal, fatal.signal]);
  const stop = (message: string) => { if (!fatal.signal.aborted) fatal.abort(new Error(message)); };
  const destroy = () => { if (window && !window.isDestroyed()) window.destroy(); };
  abort.addEventListener('abort', destroy, { once: true });
  try {
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: gateway.proxyRules, proxyBypassRules: '<-loopback>' });
    isolated.setPermissionCheckHandler(() => false); isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', event => { event.preventDefault(); stop('匿名 URL 返回下载附件，未取得网页正文；请绑定本地资料'); });
    isolated.webRequest.onBeforeRedirect(details => {
      if (details.resourceType !== 'mainFrame') return;
      try { if (++redirects > 5) throw new Error('匿名网页跳转次数过多'); allowedTop.add(textbookPublicUrl(details.redirectURL)); }
      catch { stop('匿名网页跳转目标无效或越过安全限制'); }
    });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (abort.aborted || ++requests > 120 || !['GET', 'HEAD'].includes(details.method)
        || ['image', 'font', 'media', 'subFrame', 'webSocket'].includes(details.resourceType)) { callback({ cancel: true }); return; }
      void (async () => {
        const url = textbookPublicUrl(details.url);
        if (details.resourceType === 'mainFrame' && !allowedTop.has(url)) throw new Error('不跟随页面脚本打开其它正文');
        await resolveTextbookPublicTarget(url, abort, testNetwork?.resolve); callback({ cancel: abort.aborted });
      })().catch(() => { if (details.resourceType === 'mainFrame') stop('匿名网页目标不可公开访问或指向内网'); callback({ cancel: true }); });
    });
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (/^(?:authorization|proxy-authorization)$/iu.test(key)) delete headers[key];
      callback({ requestHeaders: headers });
    });
    isolated.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame' && details.statusCode >= 400) {
        stop(`匿名浏览器返回 HTTP ${details.statusCode}，未取得公开正文`); callback({ cancel: true });
      } else if (details.resourceType === 'mainFrame' && details.statusCode >= 200 && details.statusCode < 300) {
        const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).map(([key, value]) => [key.toLowerCase(), value?.join(';') || '']));
        const type = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (/\battachment\b/iu.test(headers['content-disposition'] || '')
          || (type && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(type))) {
          stop('匿名 URL 返回附件或非网页内容，未取得网页正文；请绑定本地资料'); callback({ cancel: true });
        } else callback({});
      } else callback({});
    });
    await testSetup?.(isolated); abort.throwIfAborted();
    window = new BrowserWindow({ show: false, width: 1280, height: 900, skipTaskbar: true, focusable: false,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false, disableDialogs: true, navigateOnDragDrop: false } });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('will-navigate', event => { event.preventDefault(); stop('匿名页面尝试切换正文，未收录其它页面'); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) { pendingUrl = details.url; committed = false; domReady = false; }
    });
    contents.on('did-navigate', (_event, url) => {
      try { loadedUrl = textbookPublicUrl(url); committed = true; }
      catch { stop('匿名网页导航越过公开地址限制'); }
    });
    contents.on('dom-ready', () => { domReady = true; });
    contents.on('render-process-gone', () => stop('匿名网页渲染进程中断'));
    contents.on('destroyed', () => stop('匿名网页读取已停止'));
    contents.on('login', (event, _info, _auth, callback) => { event.preventDefault(); callback(); stop('匿名页面要求登录，未使用用户登录态'); });
    try { await abortable(contents.loadURL(initial), abort); }
    catch (error) {
      // Destroying a denied window can reject loadURL before the abort race.
      // Preserve the original public denial, not Electron's generic ERR_FAILED.
      abort.throwIfAborted();
      if (!allowedTop.has(pendingUrl)) throw new Error('匿名页面发起额外验证或导航，未读取未批准的页面');
      const message = error instanceof Error ? error.message : '';
      const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
      const abortedLoad = error && typeof error === 'object' && 'errno' in error && error.errno === -3;
      const code = rawCode || /\bERR_[A-Z_]+\b/u.exec(message)?.[0] || (abortedLoad ? 'ERR_ABORTED' : '');
      // Some pages commit a usable DOM then stop their remaining load. Never
      // accept the error alone: only the already-admitted, unchanged document
      // may continue to the same strict body/challenge/stability checks below.
      if (!(code === 'ERR_ABORTED' && committed && domReady && allowedTop.has(loadedUrl)
        && textbookPublicUrl(contents.getURL()) === loadedUrl)) {
        throw new Error(`匿名浏览器加载失败${/^ERR_[A-Z_]+$/u.test(code) ? `（${code}）` : ''}，未取得公开正文`, { cause: error });
      }
    }
    const started = Date.now(); let previous = '', stable = 0, lastError: unknown;
    while (Date.now() - started < 6500) {
      abort.throwIfAborted();
      try {
        // Electron replaces renderer-thrown errors with a generic message. Return
        // fixed extraction codes instead, so a challenge fails immediately.
        const captured = await abortable(contents.executeJavaScript(READ_RENDERED_BODY), abort) as { url?: string; html?: string; error?: string };
        const captureErrors: Record<string, string> = { challenge: '匿名页面要求登录或安全验证', structure: '网页结构超出解析上限', size: '渲染正文超过安全上限' };
        if (captured?.error && captureErrors[captured.error]) throw new Error(captureErrors[captured.error]);
        if (typeof captured?.url !== 'string' || typeof captured.html !== 'string') throw new Error('匿名网页未返回可读正文');
        const finalUrl = textbookPublicUrl(captured.url);
        if (finalUrl !== loadedUrl || !allowedTop.has(finalUrl)) throw new Error('页面在读取过程中切换，未收录其它页面');
        const parsed = extractTextbookHtml(captured.html);
        stable = parsed.text === previous ? stable + 1 : 0; previous = parsed.text;
        if (stable >= 2 && Date.now() - started >= 1200) {
          await resolveTextbookPublicTarget(finalUrl, abort, testNetwork?.resolve); abort.throwIfAborted();
          return { url: finalUrl, bytes: Buffer.from(captured.html), contentType: 'text/html; charset=utf-8' };
        }
      } catch (error) {
        abort.throwIfAborted();
        if (error instanceof Error && /要求登录或安全验证|页面在读取过程中切换|超过安全上限|结构超出解析上限/u.test(error.message)) throw error;
        lastError = error;
      }
      await delay(350, undefined, { signal: abort });
    }
    throw lastError || new Error('匿名网页正文未稳定或内容不足，未作为教材证据');
  } finally {
    abort.removeEventListener('abort', destroy); destroy();
    await gateway.close();
    await Promise.allSettled([isolated.closeAllConnections(), isolated.clearStorageData(), isolated.clearCache(), isolated.clearAuthCache()]);
  }
}
