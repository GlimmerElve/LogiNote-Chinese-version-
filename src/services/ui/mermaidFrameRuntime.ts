import { validateMermaid } from '../textbook/contentSchema';
import { withMermaidMeasurementHost } from './mermaidMeasureHost';
import { loadMermaidRuntime } from './mermaidRenderQueue';
import { alignMermaidMindmapLabels, boundedMermaidReadingWidth, normalizeMermaidLineBreaks, sanitizeMermaidSvg, textbookMermaidTheme } from './mermaidPresentation';
import { validTextbookVisualKind, type TextbookVisualInput } from './textbookVisualTypes';

// Desktop: an independent renderer process with a narrow preload. Browser-only
// previews retain the document-isolated frame protocol below.
const session = new URL(location.href).searchParams.get('session') || '';
const sessionValid = /^[\w-]{16,160}$/u.test(session);
let busy = false;
function send(message: Record<string, unknown>): void { parent.postMessage({ ...message, session }, '*'); }
async function render(value: TextbookVisualInput) {
  if (value.visualKind && value.visualKind !== 'mermaid') {
    const { renderTextbookVisual } = await import('./textbookVisualRuntime');
    return renderTextbookVisual(value);
  }
  const code = normalizeMermaidLineBreaks(validateMermaid(value.code));
  const { default: mermaid } = await loadMermaidRuntime(() => import('mermaid'), new AbortController().signal);
  mermaid.initialize(textbookMermaidTheme(value.dark));
  return withMermaidMeasurementHost(async host => {
    const rendered = await mermaid.render(value.id, code, host);
    host.innerHTML = sanitizeMermaidSvg(rendered.svg);
    alignMermaidMindmapLabels(host);
    const element = host.querySelector('svg');
    if (!element) throw new Error('图示渲染结果无效');
    const svg = new XMLSerializer().serializeToString(element);
    return { svg, readingWidth: boundedMermaidReadingWidth(element.getAttribute('viewBox')) };
  });
}
const worker = (window as any).logiMermaidWorker;
if (worker && parent === window) {
  worker.onTask(async (value: TextbookVisualInput & { requestId: string }) => {
    if (busy) { worker.reply({ requestId: value.requestId, error: '图示渲染任务仍在运行' }); return; }
    busy = true;
    try { worker.reply({ requestId: value.requestId, ...await render(value) }); }
    catch (error) { worker.reply({ requestId: value.requestId, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }); }
    finally { busy = false; }
  });
  worker.ready();
}

if (sessionValid && parent !== window) {
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.source !== parent || !value || typeof value !== 'object' || value.kind !== 'loginote-mermaid-render'
      || value.session !== session || typeof value.requestId !== 'string' || !/^[\w-]{1,160}$/u.test(value.requestId)
      || typeof value.id !== 'string' || !/^[\w-]{1,160}$/u.test(value.id)
      || typeof value.code !== 'string' || !validTextbookVisualKind(value.visualKind)
      || value.code.length > (value.visualKind && value.visualKind !== 'mermaid' ? 32_000 : 8_000)
      || value.width !== undefined && (!Number.isFinite(value.width) || value.width < 260 || value.width > 1000)
      || typeof value.dark !== 'boolean') return;
    const requestId = value.requestId as string;
    if (busy) { send({ kind: 'loginote-mermaid-error', requestId, error: '图示渲染任务仍在运行' }); return; }
    busy = true;
    void (async () => {
      try {
        send({ kind: 'loginote-mermaid-result', requestId, ...await render(value) });
      } catch (error) {
        send({ kind: 'loginote-mermaid-error', requestId, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      } finally { busy = false; }
    })();
  });
  send({ kind: 'loginote-mermaid-ready' });
}
