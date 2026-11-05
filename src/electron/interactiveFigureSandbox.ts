import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, session, type IpcMain, type IpcMainInvokeEvent, type Rectangle, type Session } from 'electron';
import anatomyIsoSource from './vendor/teachable/anatomyIsoSource';
import anatomy3dSource from './vendor/teachable/anatomy3dSource';
import anatomyLicense from './vendor/teachable/anatomyLicense';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { upgradeLegacyFunctionReadout } from '../services/textbook/interactiveFunctionFigureUpgrade';
import { INTERACTIVE_FIGURE_CONTRAST } from './interactiveFigureContrast';

/** Model-authored documents are untrusted. They have no preload, network,
 * filesystem, application origin or bridge. Do not reuse website partitions. */
const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";
const MAX_HTML = 100_000;
const loadTimeout = 10_000;
const heartbeatInterval = 3_000;
const heartbeatTimeout = 6_000;
export interface FigureSandboxBounds extends Rectangle { viewportWidth?: number; viewportHeight?: number }
export interface FigureSandboxState { processId: number }

type FigureTheme = 'light' | 'dark';
let figureTheme: FigureTheme = 'light';
const figureSandboxes = new Set<InteractiveFigureSandbox>();
/** Only trusted main-process appearance changes reach the isolated guest. */
export function setInteractiveFigureTheme(theme: FigureTheme): void {
  figureTheme = theme;
  for (const sandbox of figureSandboxes) sandbox.setTheme(theme);
}

let mathAssets: { css: string; scripts: string } | undefined;
function figureMathAssets() {
  if (mathAssets) return mathAssets;
  const katexFile = require.resolve('katex/dist/katex.min.js');
  const base = path.dirname(katexFile);
  const css = readFileSync(path.join(base, 'katex.min.css'), 'utf8')
    .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("[^"]+"\)/gu, '')
    .replace(/url\(fonts\/([^/()]+\.woff2)\)/gu, (_all, name: string) => `url(data:font/woff2;base64,${readFileSync(path.join(base, 'fonts', name)).toString('base64')})`);
  const scripts = [katexFile, path.join(base, 'contrib', 'auto-render.min.js')]
    .map(file => readFileSync(file, 'utf8').replace(/<\/script/giu, '<\\/script')).join('\n');
  return mathAssets = { css, scripts };
}

export function figureSandboxDocument(html: string, theme: FigureTheme = 'light'): string {
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_HTML || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(html)) throw new Error('交互图内容为空或超过限制');
  html = upgradeLegacyFunctionReadout(html);
  // The CSP is parsed before any authored bytes and cannot be relaxed by a
  // later meta tag. Never interpolate it into a script or execute it in the host.
  const disablePeerConnections = `<script>window.__teachingRuntimeErrors=0;window.addEventListener('error',()=>window.__teachingRuntimeErrors++);window.addEventListener('unhandledrejection',()=>window.__teachingRuntimeErrors++);for(const k of ['RTCPeerConnection','webkitRTCPeerConnection']){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}}</script>`;
  const usesIso = /\bdata-figure-renderer\s*=\s*["']anatomy-iso["']/iu.test(html);
  // The MIT-licensed renderer is trusted application code, injected only into
  // the isolated guest. Generated content still has no application bridge.
  const isoKit = usesIso ? `<script>(function(){${anatomyIsoSource.replace(/^export /gmu, '').replace(/<\/script/giu, '<\\/script')}\nconst style=document.createElement('style');style.textContent=ISO_CSS;document.head.append(style);document.documentElement.classList.add('iso');const solid=(paths,options)=>Array.isArray(paths)?paths.map(path=>solidSvg(path,options)).join(''):solidSvg(paths,options);Object.defineProperty(window,'TeachingIso',{value:Object.freeze({iso,fitProjection,boxCorners,slabOf,cylinder,solidSvg:solid,lineSvg}),writable:false,configurable:false});})();</script>` : '';
  const uses3d = /\bdata-figure-renderer\s*=\s*["']anatomy-3d["']/iu.test(html);
  const turnKit = uses3d ? `<script>${anatomy3dSource.replace(/<\/script/giu, '<\\/script')}\n(function(){const style=document.createElement('style');style.textContent=window.Teaching3D.ISO_CSS;document.head.append(style);document.documentElement.classList.add('iso');Object.freeze(window.Teaching3D)})();</script>` : '';
  const responsive = usesIso || uses3d ? '<style>[data-figure-renderer],[data-figure-renderer] *{box-sizing:border-box;max-width:100%}</style>' : '';
  // Isolated pages have no access to the reader's renderer or local fonts.
  // Embed the existing KaTeX assets only for figures containing math syntax.
  const hasMath = /\$[^$\n]+\$|\\[([]/u.test(html);
  const math = hasMath ? figureMathAssets() : undefined;
  const baseline = `<style>html{color-scheme:light}body{box-sizing:border-box;margin:0;padding:24px;color:#243d32;background:#fafbf8;font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}*,*:before,*:after{box-sizing:border-box}h1,h2,h3{line-height:1.35;color:#244a38}button,input,select,textarea{font:inherit}button,select,input:not([type=range]):not([type=checkbox]):not([type=radio]){border:1px solid #bed0c2;border-radius:8px;background:#fff;color:#244a38;padding:6px 10px}button{cursor:pointer}button:hover{background:#edf5ef}input[type=range]{accent-color:#386c50}svg,canvas{max-width:100%;height:auto}p{margin:.65em 0}</style>`;
  // Existing stored figures contain their own light CSS. Override only our
  // known component vocabulary: arbitrary model-authored illustrations retain
  // their original palette rather than inverting scientific colours or photos.
  const themed = usesIso || uses3d || /\bdata-local-(?:function|gear|lru|threshold|probability)\s*=\s*["']true["']/iu.test(html)
    || /\bdata-figure-theme-aware\s*=\s*["']true["']/iu.test(html);
  const themeStyles = `<style>
html[data-theme="dark"][data-theme-adapted="true"]{color-scheme:dark}
html[data-theme="dark"][data-theme-adapted="true"] body{background:#171f1a!important;color:#e2eee5!important}
html[data-theme="dark"][data-theme-adapted="true"] h1,html[data-theme="dark"][data-theme-adapted="true"] h2,html[data-theme="dark"][data-theme-adapted="true"] h3{color:#d6eadb!important}
html[data-theme="dark"][data-theme-adapted="true"] button,html[data-theme="dark"][data-theme-adapted="true"] select,html[data-theme="dark"][data-theme-adapted="true"] input:not([type=range]):not([type=checkbox]):not([type=radio]){background:#26382e!important;color:#e2eee5!important;border-color:#526e5b!important}
html[data-theme="dark"][data-theme-adapted="true"] input[type=range]{accent-color:#8bc9a2!important}
html[data-theme="dark"] :is(.local-function-figure,.local-gear,.local-lru,.local-threshold,.local-probability){color:#e2eee5!important}
html[data-theme="dark"] :is(.local-function-figure,.local-gear,.local-lru,.local-threshold,.local-probability) .panel{background:#202e25!important;border-color:#496052!important}
html[data-theme="dark"] :is(.local-function-figure,.local-gear,.local-lru,.local-threshold,.local-probability) .prompt{background:#294234!important}
html[data-theme="dark"] :is(.local-function-figure,.local-gear,.local-lru,.local-threshold,.local-probability) .note{color:#b4cbb9!important}
html[data-theme="dark"] .local-lru .slot{background:#2b4133!important;border-color:#628670!important}
html[data-theme="dark"] .local-lru .slot:first-child{background:#375640!important;border-color:#8bc9a2!important}
html[data-theme="dark"] .local-function-figure .grid line{stroke:#405347!important}
html[data-theme="dark"] .local-function-figure .grid text,html[data-theme="dark"] .local-function-figure svg>text{fill:#b4cbb9!important}
html[data-theme="dark"] .local-function-figure .axis{stroke:#9bbdab!important}
html[data-theme="dark"] .local-function-figure [stroke="#287b59"]{stroke:#7bd6a5!important}html[data-theme="dark"] .local-function-figure [fill="#287b59"]{fill:#7bd6a5!important}
html[data-theme="dark"] .local-function-figure [stroke="#685bb0"]{stroke:#c0aaff!important}html[data-theme="dark"] .local-function-figure [fill="#685bb0"]{fill:#c0aaff!important}
html[data-theme="dark"] .local-function-figure [stroke="#a65e25"]{stroke:#f1b57f!important}html[data-theme="dark"] .local-function-figure [fill="#a65e25"]{fill:#f1b57f!important}
html[data-theme="dark"] .local-function-figure [stroke="#b34866"]{stroke:#f69bb2!important}html[data-theme="dark"] .local-function-figure [fill="#b34866"]{fill:#f69bb2!important}
html[data-theme="dark"] .local-function-figure .legend span:nth-child(1) i{background:#7bd6a5!important}html[data-theme="dark"] .local-function-figure .legend span:nth-child(2) i{background:#c0aaff!important}html[data-theme="dark"] .local-function-figure .legend span:nth-child(3) i{background:#f1b57f!important}html[data-theme="dark"] .local-function-figure .legend span:nth-child(4) i{background:#f69bb2!important}
html[data-theme="dark"] .local-gear svg text{fill:#d6eadb!important}html[data-theme="dark"] .local-gear [data-gear="driver"]{fill:#355e46!important;stroke:#8bc9a2!important}html[data-theme="dark"] .local-gear [data-gear="driven"]{fill:#42654e!important;stroke:#b0d6ba!important}html[data-theme="dark"] .local-gear [data-spoke]{stroke:#d6eadb!important}
</style>`;
  const mathRuntime = math ? `<style>${math.css}.katex span:not(.fbox):not(.colorbox){padding:0!important;background:transparent!important;border-radius:0!important}</style><script>${math.scripts}</script><script>(function(){let queued=false;const options={delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false},{left:'$',right:'$',display:false}],throwOnError:false,trust:false,maxExpand:1000,maxSize:20,ignoredTags:['script','noscript','style','textarea','pre','code','option','select','svg','canvas'],ignoredClasses:['katex']};const observer=new MutationObserver(schedule);function run(){queued=false;observer.disconnect();try{renderMathInElement(document.body,options)}catch{}observer.observe(document.body,{childList:true,characterData:true,subtree:true})}function schedule(){if(!queued){queued=true;setTimeout(run,80)}}run()})()</script>` : '';
  return `<!doctype html><html data-theme="${theme}" data-theme-adapted="${themed}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${POLICY}">${baseline}${responsive}${disablePeerConnections}${isoKit}${turnKit}</head><body>${html}${mathRuntime}${themeStyles}<script>${INTERACTIVE_FIGURE_CONTRAST}</script></body></html>`;
}

export function fitFigureBounds(value: FigureSandboxBounds, window: BrowserWindow): Rectangle | null {
  if (!value || ![value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight].every(Number.isFinite)
    || !value.viewportWidth || !value.viewportHeight || value.viewportWidth <= 0 || value.viewportHeight <= 0 || value.width <= 0 || value.height <= 0) return null;
  const size = window.getContentBounds();
  const left = Math.max(0, Math.min(size.width, Math.round(value.x / value.viewportWidth * size.width)));
  const top = Math.max(0, Math.min(size.height, Math.round(value.y / value.viewportHeight * size.height)));
  const right = Math.max(left, Math.min(size.width, Math.round((value.x + value.width) / value.viewportWidth * size.width)));
  const bottom = Math.max(top, Math.min(size.height, Math.round((value.y + value.height) / value.viewportHeight * size.height)));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** Portable file stays sandboxed when opened outside LogiNote, including the MIT notice. */
export function portableFigureDocument(html: string): { html: string; license: string } {
  const inner = figureSandboxDocument(html);
  const escaped = inner.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return { html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'self' data:; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>交互探索</title><style>html,body{margin:0;height:100%;font-family:system-ui}iframe{border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts" title="交互探索" srcdoc="${escaped}"></iframe></body></html>`, license: anatomyLicense };
}

export function validFigureBounds(value: unknown, window: BrowserWindow): value is FigureSandboxBounds {
  if (!value || typeof value !== 'object') return false;
  const rect = value as FigureSandboxBounds, size = window.getContentBounds();
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    && rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1
    && rect.x + rect.width <= size.width && rect.y + rect.height <= size.height;
}

export class InteractiveFigureSandbox {
  private view?: WebContentsView;
  private isolatedSession?: Session;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private disposed = false;
  private theme: FigureTheme = figureTheme;
  constructor(private readonly owner: BrowserWindow, private readonly onFailure: (reason: string) => void = () => {}) {
    figureSandboxes.add(this);
    owner.once('closed', () => this.dispose());
  }
  async open(html: string, bounds: FigureSandboxBounds): Promise<FigureSandboxState> {
    const document = figureSandboxDocument(html, this.theme);
    const fitted = bounds?.viewportWidth ? fitFigureBounds(bounds, this.owner) : validFigureBounds(bounds, this.owner) ? bounds : null;
    if (this.disposed || this.owner.isDestroyed() || !fitted) throw Error('交互图显示范围无效');
    this.close(); const revision = ++this.generation;
    const isolated = session.fromPartition(`teachable-figure-${randomUUID()}`, { cache: false });
    this.isolatedSession = isolated;
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith('data:') }));
    isolated.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
      devTools: false, disableDialogs: true, backgroundThrottling: true, spellcheck: false } });
    this.view = view;
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-redirect', event => event.preventDefault());
    view.webContents.on('render-process-gone', () => {
      if (this.view === view) { this.close(); this.onFailure('交互图进程已停止，教材正文不受影响。'); }
    });
    view.setBounds(fitted); this.owner.contentView.addChildView(view);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('交互图加载超时')), loadTimeout); })]);
      if (this.disposed || this.view !== view || this.generation !== revision || view.webContents.isDestroyed()) throw Error('交互图已关闭');
      this.setTheme(this.theme);
      const processId = view.webContents.getOSProcessId();
      if (!processId || processId === this.owner.webContents.getOSProcessId()) throw Error('交互图未获得独立渲染进程');
      this.startHeartbeat(view, revision);
      return { processId };
    } catch (error) { if (this.view === view) this.close(); throw error; }
    finally { if (timeout) clearTimeout(timeout); }
  }
  setBounds(bounds: FigureSandboxBounds) {
    const fitted = bounds?.viewportWidth ? fitFigureBounds(bounds, this.owner) : validFigureBounds(bounds, this.owner) ? bounds : null;
    if (!this.view || this.owner.isDestroyed() || !fitted) throw Error('交互图显示范围无效');
    this.view.setBounds(fitted);
  }
  setVisible(visible: boolean) { this.view?.setVisible(visible); }
  setTheme(theme: FigureTheme) {
    this.theme = theme;
    const view = this.view;
    if (view && !view.webContents.isDestroyed()) void view.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`).catch(() => {});
  }
  private startHeartbeat(view: WebContentsView, revision: number) {
    let pending = false;
    this.timer = setInterval(() => {
      if (pending || this.view !== view || view.webContents.isDestroyed()) return;
      pending = true; let deadline: ReturnType<typeof setTimeout>;
      void Promise.race([view.webContents.executeJavaScript('1'), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(Error('timeout')), heartbeatTimeout);
      })]).catch(() => {
        if (this.view === view && this.generation === revision) { this.close(); this.onFailure('交互图运行超时，已停止；教材正文不受影响。'); }
      }).finally(() => { clearTimeout(deadline); pending = false; });
    }, heartbeatInterval);
  }
  close() {
    this.generation++;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const view = this.view, isolated = this.isolatedSession; this.view = undefined; this.isolatedSession = undefined;
    if (view && !this.owner.isDestroyed()) this.owner.contentView.removeChildView(view);
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    if (isolated) void isolated.clearStorageData().catch(() => {});
  }
  dispose() { if (!this.disposed) { this.disposed = true; figureSandboxes.delete(this); this.close(); } }
}

let preflightTail: Promise<void> = Promise.resolve();
let preflightQueued = 0;
export interface FigureDiagnosticResult {
  interaction: 'observed' | 'inconclusive';
  reset: 'restored' | 'different' | 'inconclusive';
  warnings?: Array<'gear-contact' | 'prediction-consistency' | 'budget-readout' | 'axis-scale' | 'chart-overflow'>;
  checks?: { gearContact?: true; predictionConsistency?: true; budgetReadout?: true; axisScale?: true; chartBounds?: true };
  evidence?: { prediction?: { question: string; answer: string; beforeCondition: string; afterCondition: string; beforeFeedback: string; afterFeedback: string }; budget?: { category: string; baseline: number; spend: number; remaining: number }; axis?: { ticks: Array<{ value: number; x: number }>; expectedX: number; observedX: number }; chart?: { label:string; value:number; bar:string; top:number; bottom:number; viewTop:number; viewBottom:number } };
}
/** Serialize isolated probes: simultaneous figures must not fail just because
 * another probe is running. A bounded queue limits hidden renderer resources. */
function enqueueFigureCheck<T>(task: () => Promise<T>): Promise<T> {
    if (preflightQueued >= 32) return Promise.reject(Error('交互图检查任务过多，请稍后重试'));
    preflightQueued++;
    const result = preflightTail.then(task);
    preflightTail = result.then(() => {}, () => {});
    return result.finally(() => { preflightQueued--; });
}
export function preflightInteractiveFigure(input: string): Promise<void> {
    return enqueueFigureCheck(() => runFigurePreflight(input));
}
/** Advisory only: generated pages can use asynchronous or custom controls, so
 * a missing observed change is never treated as a failed figure. */
export function diagnoseInteractiveFigure(input: string): Promise<FigureDiagnosticResult> {
    return enqueueFigureCheck(() => runFigureDiagnostics(input));
}

async function runFigureDiagnostics(input: string): Promise<FigureDiagnosticResult> {
    let hidden: BrowserWindow | undefined, probe: InteractiveFigureSandbox | undefined;
    try {
      hidden = new BrowserWindow({ show: false, width: 800, height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true } });
      probe = new InteractiveFigureSandbox(hidden);
      await hidden.loadURL('data:text/html,<meta charset="utf-8"><p>figure diagnostics</p>');
      await probe.open(input, { x: 0, y: 0, width: 640, height: 480 });
      const child = hidden.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView | undefined;
      if (!child) throw Error('交互图检查未能启动');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([child.webContents.executeJavaScript(`(() => {
          const disclosure = document.querySelector('[data-local-prediction-disclosure]');
          if (disclosure instanceof HTMLDetailsElement) { disclosure.open = true; window.dispatchEvent(new Event('resize')); }
          const reset = document.querySelector('[data-figure="reset"]');
          // A narrow advisory heuristic for simple two-circle gear diagrams.
          // It cannot validate teeth, mechanics, animation, or general drawings.
          const gearAssessment = (() => {
            const text = document.body.innerText || '';
            if (!/(齿轮|啮合)/u.test(text) || !/(主动轮|从动轮)/u.test(text)) return 'inconclusive';
            for (const svg of document.querySelectorAll('svg')) {
              const circles = [...svg.querySelectorAll('circle')].map(node => node.getBoundingClientRect())
                .filter(r => r.width >= 20 && r.height >= 20 && Math.abs(r.width-r.height) <= r.width*.1)
                .sort((a,b) => b.width-a.width);
              if (circles.length !== 2) continue;
              const [a,b] = circles, distance = Math.hypot(a.left+a.width/2-b.left-b.width/2, a.top+a.height/2-b.top-b.height/2);
              return Math.abs(distance-(a.width+b.width)/2) > Math.min(a.width,b.width)*.06 ? 'misaligned' : 'aligned';
            }
            return 'inconclusive';
          })();
          const warnings = gearAssessment === 'misaligned' ? ['gear-contact'] : [], evidence = {}, checks = {};
          if (gearAssessment !== 'inconclusive') checks.gearContact = true;
          // Probe only explicitly labelled bar-chart SVGs with identifiable,
          // untransformed bars and a single range control. Other plots remain unknown.
          (() => {
            if (!reset) return;
            const sliders = [...document.querySelectorAll('input[type="range"]')].filter(node => !node.disabled);
            const charts = [...document.querySelectorAll('svg[viewBox]')].filter(svg => /(柱状图|条形图|直方图)/u.test(svg.getAttribute('aria-label') || ''));
            if (sliders.length !== 1 || charts.length !== 1) return;
            const svg = charts[0], box = svg.viewBox.baseVal, slider = sliders[0], max = Number(slider.max), min = Number(slider.min || 0);
            const bars = [...svg.querySelectorAll('rect')].filter(node => /bar|柱/iu.test((node.id || '') + ' ' + (node.getAttribute('class') || '')) && !node.closest('defs,clipPath,[transform]'));
            if (!bars.length || ![box.y,box.height,min,max].every(Number.isFinite) || box.height <= 0 || min >= max) return;
            let tested = false;
            for (const value of [min,max]) {
              slider.value = String(value); slider.dispatchEvent(new Event('input',{bubbles:true})); slider.dispatchEvent(new Event('change',{bubbles:true}));
              for (const bar of bars) {
                const y = Number(bar.getAttribute('y')), height = Number(bar.getAttribute('height'));
                if (!bar.hasAttribute('y') || !bar.hasAttribute('height') || !Number.isFinite(y) || !Number.isFinite(height) || height < 0) continue;
                tested = true;
                if (y < box.y-1 || y+height > box.y+box.height+1) {
                  warnings.push('chart-overflow'); evidence.chart = {label:(svg.getAttribute('aria-label') || '').slice(0,120), value:Number(slider.value), bar:(bar.id || bar.getAttribute('class') || '').slice(0,80), top:y, bottom:y+height, viewTop:box.y, viewBottom:box.y+box.height}; break;
                }
              }
              if (evidence.chart) break;
            }
            if (tested) checks.chartBounds = true;
            reset.click();
          })();
          // Only inspect an explicitly labelled, simple linear money axis.
          // General charts, nonlinear axes and transformed text are unknown.
          for (const svg of document.querySelectorAll('svg')) {
            const description = svg.textContent || '';
            if (!/横轴为金额/u.test(description) || /(对数|非线性)/u.test(description)) continue;
            const ticks = [...svg.querySelectorAll('text')].flatMap(node => {
              const match = (node.textContent || '').match(/^\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:元)?\\s*$/u);
              if (!match || !node.hasAttribute('x') || !node.hasAttribute('y') || node.closest('[transform]')) return [];
              const x = Number(node.getAttribute('x')), y = Number(node.getAttribute('y')), value = Number(match[1]);
              return [x,y,value].every(Number.isFinite) ? [{x,y,value}] : [];
            });
            if (ticks.length !== 3 || !ticks.some(t => t.value === 0) || ticks.some(t => Math.abs(t.y - ticks[0].y) > 2)) continue;
            ticks.sort((a,b) => a.value-b.value);
            const [a,b,c] = ticks;
            if (a.value === b.value || b.value === c.value || c.x <= a.x || b.x <= a.x || b.x >= c.x) continue;
            const expectedX = a.x + (c.x-a.x)*(b.value-a.value)/(c.value-a.value);
            checks.axisScale = true;
            if (Math.abs(expectedX-b.x) > Math.max(3, (c.x-a.x)*0.02)) {
              warnings.push('axis-scale'); evidence.axis = {ticks:ticks.map(({value,x}) => ({value,x})), expectedX, observedX:b.x};
            }
            break;
          }
          // A deliberately narrow probe for one-off categorized budgets with
          // explicit current-spend and total-balance readouts. It cannot infer
          // accounting rules from arbitrary figures; unknown layouts are skipped.
          (() => {
            const text = document.body.innerText || '';
            if (!reset || !/预算/u.test(text) || !/总余额/u.test(text) || !/支出类别/u.test(text)) return;
            const label = [...document.querySelectorAll('label[for]')].find(node => /支出类别/u.test(node.textContent || ''));
            const category = label && document.getElementById(label.htmlFor);
            const sliders = [...document.querySelectorAll('input[type="range"]')].filter(node => !node.disabled);
            if (!(category instanceof HTMLSelectElement) || sliders.length !== 1 || category.options.length < 2) return;
            const slider = sliders[0], options = [...category.options].filter(option => !option.disabled && option.value);
            const balanceNodes = [...document.querySelectorAll('b,strong,output')].filter(node => /总余额/u.test(node.parentElement?.textContent || '') && /^\\s*\\d+(?:\\.\\d+)?\\s*$/u.test(node.textContent || ''));
            const spendNodes = [...document.querySelectorAll('div,p,output')].filter(node => node.children.length === 0 && /当前支出\\s*[:：]\\s*\\d+(?:\\.\\d+)?\\s*元/u.test(node.textContent || ''));
            if (balanceNodes.length !== 1 || spendNodes.length !== 1 || options.length < 2 || Number(slider.min || 0) !== 0 || Number(slider.max) <= 0) return;
            const read = () => { const spend = (spendNodes[0].textContent || '').match(/当前支出\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)\\s*元/u); return {spend: spend ? Number(spend[1]) : NaN, remaining: Number(balanceNodes[0].textContent)}; };
            const change = node => { node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true})); };
            slider.value = '0'; change(slider); const zero = read();
            if (zero.spend !== 0 || !Number.isFinite(zero.remaining)) { reset.click(); return; }
            const wanted = Number(slider.max); slider.value = String(wanted); change(slider);
            let tested = false;
            for (const option of options.slice(0, 4)) {
              category.value = option.value; change(category); const result = read();
              if (!Number.isFinite(result.spend) || !Number.isFinite(result.remaining)) continue;
              tested = true;
              if (Math.abs(zero.remaining - result.spend - result.remaining) > 0.01) {
                warnings.push('budget-readout'); evidence.budget = {category:(option.textContent || '').trim().slice(0,80), baseline:zero.remaining, spend:result.spend, remaining:result.remaining}; break;
              }
            }
            if (tested) checks.budgetReadout = true;
            reset.click();
          })();
          // Only flag a possible inconsistency: a fixed visible question, the
          // same selected answer, and a changed condition flip the feedback.
          // Some lessons intentionally depend on context, so this never blocks.
          const prediction = document.querySelector('input[type="radio"][data-figure="prediction"], [data-figure="prediction"] input[type="radio"]');
          const check = document.querySelector('[data-figure="check"]');
          const condition = [...document.querySelectorAll('select')].find(node => node.getAttribute('data-figure') !== 'prediction' && !node.disabled && [...node.options].some(option => !option.disabled && option.value !== node.value));
          const feedback = document.querySelector('#feedback,#predictionFeedback,#fb,[data-feedback],[aria-live="polite"],[role="status"]');
          const question = prediction?.closest('fieldset') || prediction?.parentElement?.parentElement;
          const classify = text => /(不正确|不一致|错误|再想想)/u.test(text) ? 'wrong' : /(预测正确|回答正确|回答对了|正确|预测.{0,12}一致)/u.test(text) ? 'right' : '';
          if (prediction && check && reset && condition && feedback && question) {
            prediction.checked = true; prediction.dispatchEvent(new Event('change', {bubbles:true}));
            const beforeQuestion = question.textContent, answer = (prediction.closest('label')?.textContent || prediction.value || '').trim().slice(0, 160), beforeCondition = (condition.selectedOptions[0]?.textContent || condition.value || '').trim().slice(0, 160);
            check.click(); const beforeFeedback = (feedback.textContent || '').trim().slice(0, 500), before = classify(beforeFeedback);
            const option = [...condition.options].find(item => !item.disabled && item.value !== condition.value);
            if (option) { condition.value = option.value; condition.dispatchEvent(new Event('change', {bubbles:true})); condition.dispatchEvent(new Event('input', {bubbles:true})); check.click();
              const afterFeedback = (feedback.textContent || '').trim().slice(0, 500), after = classify(afterFeedback);
              if (before && after && beforeQuestion === question.textContent && prediction.checked) {
                checks.predictionConsistency = true;
                if (before !== after) { warnings.push('prediction-consistency'); evidence.prediction = { question:(beforeQuestion || '').trim().slice(0, 500), answer, beforeCondition, afterCondition:(condition.selectedOptions[0]?.textContent || condition.value || '').trim().slice(0, 160), beforeFeedback, afterFeedback }; }
              } }
            reset.click();
          }
          // A fixed question can also use a select for the learner's answer.
          // Probe one alternate condition at a time and only warn when clear
          // correct/incorrect feedback flips while the question is unchanged.
          const selectedPrediction = document.querySelector('select[data-figure="prediction"], [data-figure="prediction"] select');
          if (selectedPrediction && check && reset && feedback) {
            const label = document.querySelector('label[for="'+CSS.escape(selectedPrediction.id)+'"]') || selectedPrediction.closest('label');
            const choice = [...selectedPrediction.options].find(option => !option.disabled && option.value);
            const variants = [...document.querySelectorAll('input[type="range"],select')].filter(node => node !== selectedPrediction && !node.closest('[data-figure="prediction"]') && !node.disabled).slice(0,4);
            if (label && choice) for (const control of variants) {
              reset.click(); selectedPrediction.value=choice.value;selectedPrediction.dispatchEvent(new Event('change',{bubbles:true}));
              const beforeQuestion=label.textContent,answer=(choice.textContent||choice.value).trim().slice(0,160);
              check.click(); const beforeFeedback=(feedback.textContent||'').trim().slice(0,500), before=classify(beforeFeedback);
              if (control.tagName==='SELECT') {const option=[...control.options].find(item=>!item.disabled&&item.value!==control.value);if(!option)continue;control.value=option.value;}
              else {const min=Number(control.min||0),max=Number(control.max||100);if(!Number.isFinite(min)||!Number.isFinite(max)||min>=max)continue;control.value=String(Number(control.value)===max?min:max);}
              control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));check.click();
              const afterFeedback=(feedback.textContent||'').trim().slice(0,500),after=classify(afterFeedback);
              if(before&&after&&beforeQuestion===label.textContent&&selectedPrediction.value===choice.value){
                checks.predictionConsistency=true;
                if(before!==after){warnings.push('prediction-consistency');evidence.prediction={question:(beforeQuestion||'').trim().slice(0,500),answer,beforeFeedback,afterFeedback};break;}
              }
            }
            reset.click();
          }
          const report = (interaction, reset) => ({interaction, reset, ...(warnings.length ? {warnings} : {}), ...(Object.keys(evidence).length ? {evidence} : {}), ...(Object.keys(checks).length ? {checks} : {})});
          const controls = [...document.querySelectorAll('input[type="range"],input[type="checkbox"],select,button')]
            .filter(node => !['prediction','check','reset'].includes(node.getAttribute('data-figure')) && !node.disabled && node.getClientRects().length
              && !(node.hasAttribute('data-parameter-choice') && node.closest('.local-parameter-figure[data-local-function="true"]'))).slice(0, 4);
          const snapshot = () => JSON.stringify({
            visual: [...document.querySelectorAll('svg,[data-figure="visual"]')].map(node => node.outerHTML.slice(0, 25000)).join('').slice(0, 40000),
            readout: [...document.querySelectorAll('output,[aria-live]')].map(node => (node.textContent || '').slice(0, 500)).join('|').slice(0, 4000),
          });
          const state = () => controls.map(node => node.type === 'checkbox' ? String(node.checked) : node.value).join('\\u0000');
          if (!reset || !controls.length) return report('inconclusive', 'inconclusive');
          const initial = snapshot(), initialState = state();
          for (const node of controls) {
            if (node.tagName === 'BUTTON') node.click();
            else if (node.type === 'checkbox') node.checked = !node.checked;
            else if (node.tagName === 'SELECT') { const option = [...node.options].find(o => !o.disabled && o.value !== node.value); if (!option) continue; node.value = option.value; }
            else { const min = Number(node.min || 0), max = Number(node.max || 100); if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue; node.value = String(Number(node.value) === min ? max : min); }
            if (node.tagName !== 'BUTTON') { node.dispatchEvent(new Event('input', { bubbles:true })); node.dispatchEvent(new Event('change', { bubbles:true })); }
            if (snapshot() !== initial) {
              reset.click();
              return report('observed', snapshot() === initial && state() === initialState ? 'restored' : 'different');
            }
            reset.click();
          }
          return report('inconclusive', 'inconclusive');
        })()`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('交互图本地检查超时')), 4000); })]);
      } finally { if (timer) clearTimeout(timer); }
    } finally { probe?.dispose(); if (hidden && !hidden.isDestroyed()) hidden.destroy(); }
}

/** Run once in a disposable hidden renderer; the book and its reader never wait. */
async function runFigurePreflight(input: string): Promise<void> {
    let hidden: BrowserWindow | undefined, probe: InteractiveFigureSandbox | undefined;
    try {
      hidden = new BrowserWindow({ show: false, width: 800, height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true } });
      probe = new InteractiveFigureSandbox(hidden);
      await hidden.loadURL('data:text/html,<meta charset="utf-8"><p>figure preflight</p>');
      await probe.open(input, { x: 0, y: 0, width: 640, height: 480 });
      const child = hidden.contentView.children.find(view => view instanceof WebContentsView) as WebContentsView | undefined;
      if (!child) throw Error('交互图检查未能启动');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([child.webContents.executeJavaScript(`(() => {
          const visible = node => !!node && !node.disabled && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
          const disclosure = document.querySelector('[data-local-prediction-disclosure]');
          const gate = document.querySelector('[data-local-prediction-gate]');
          const gateValid = !gate || (!!disclosure && !disclosure.open && [...disclosure.children].filter(node => node.tagName !== 'SUMMARY').every(node => !visible(node)) && [...document.body.children].filter(node => node !== gate && !['SCRIPT','STYLE'].includes(node.tagName)).every(node => !visible(node)));
          if (disclosure instanceof HTMLDetailsElement) { disclosure.open = true; window.dispatchEvent(new Event('resize')); }
          const nodes = ['prediction','check','reset','transfer'].map(key => document.querySelector('[data-figure="'+key+'"]'));
          const actions = [...document.querySelectorAll('input,select,textarea,button')].filter(node => !node.closest('[data-figure="prediction"],[data-figure="check"],[data-figure="reset"]'));
          const visual = [...document.querySelectorAll('svg,canvas')].some(node => visible(node) && (node.tagName.toLowerCase() === 'canvas' || !!node.querySelector('path,circle,rect,line,polyline,polygon,ellipse,text'))) ||
            [...document.querySelectorAll('[data-figure="visual"]')].some(node => visible(node) && [...node.children].filter(visible).length >= 2);
          const predictionUsable = nodes[0] && (nodes[0].matches('input,select,textarea') ? visible(nodes[0]) : [...nodes[0].querySelectorAll('input,select,textarea')].some(visible));
          return { controls: nodes.slice(0, 3).every(visible) && predictionUsable && actions.some(visible), transfer: !!nodes[3]?.textContent?.trim(), errors: Number(window.__teachingRuntimeErrors)||0,
            visual, gateValid };
        })()`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('交互图运行检查超时')), 4000); })]);
        if (!result.controls || !result.transfer || result.errors || !result.visual || !result.gateValid) throw Error('交互图运行检查未通过');
      } finally { if (timer) clearTimeout(timer); }
    } finally { probe?.dispose(); if (hidden && !hidden.isDestroyed()) hidden.destroy(); }
}

/** One bounded guest for the trusted main window; generated documents never get IPC. */
export function registerInteractiveFigureSandbox(ipc: Pick<IpcMain, 'handle'>, trusted: (event: IpcMainInvokeEvent) => boolean) {
  let sandbox: InteractiveFigureSandbox | undefined, currentOwner: BrowserWindow | undefined, stopped = false;
  const owned = (event: IpcMainInvokeEvent) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (stopped || !trusted(event) || !owner || owner.isDestroyed()) throw Error('当前窗口不可使用交互图');
    if (currentOwner !== owner) { sandbox?.dispose(); currentOwner = owner;
      sandbox = new InteractiveFigureSandbox(owner, reason => { if (!owner.isDestroyed()) owner.webContents.send('interactive-figure:failure', reason); }); }
    return sandbox!;
  };
  ipc.handle('interactive-figure:open', (event, input: unknown) => {
    const request = input as { html?: unknown; bounds?: unknown } | null;
    if (!request || typeof request.html !== 'string') throw Error('交互图请求无效');
    return owned(event).open(request.html, request.bounds as FigureSandboxBounds);
  });
  ipc.handle('interactive-figure:preflight', async (event, input: unknown) => {
    if (stopped || !trusted(event) || typeof input !== 'string') throw Error('交互图检查不可用');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw Error('交互图检查不可用');
    return preflightInteractiveFigure(input);
  });
  ipc.handle('interactive-figure:diagnose', async (event, input: unknown) => {
    if (stopped || !trusted(event) || typeof input !== 'string') throw Error('交互图本地检查不可用');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw Error('交互图本地检查不可用');
    return diagnoseInteractiveFigure(input);
  });
  ipc.handle('interactive-figure:portable', async (event, input: unknown) => {
    if (stopped || !trusted(event) || typeof input !== 'string') throw Error('交互图导出不可用');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw Error('交互图导出不可用');
    return portableFigureDocument(input);
  });
  ipc.handle('interactive-figure:bounds', (event, input: unknown) => owned(event).setBounds(input as FigureSandboxBounds));
  ipc.handle('interactive-figure:visible', (event, value: unknown) => {
    if (typeof value !== 'boolean') throw Error('交互图可见状态无效'); owned(event).setVisible(value);
  });
  ipc.handle('interactive-figure:close', event => owned(event).close());
  return () => { stopped = true; sandbox?.dispose(); sandbox = undefined; currentOwner = undefined; };
}
