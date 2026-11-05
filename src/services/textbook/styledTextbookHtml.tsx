import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeReadingLatex } from './formulaRenderer';
import katex from 'katex';
import 'katex/contrib/mhchem';
import type { Element } from 'hast';
import { textbookQuoteKind } from '../../components/textbook/TextbookQuote';
import { parseTextbookAnswer, parseTextbookTip } from './contentSchema';
import { parseScienceDiagram } from './scienceDiagram';
import { exportVisualKey, type StyledExportAssets } from './exportAssetTypes';

const css = `
:root{color-scheme:light dark;--paper:#fffdf8;--ink:#1e2923;--muted:#58685d;--line:#d9e3d9;--panel:#f3f6f0;--accent:#315d49;--warn:#926319}
@media(prefers-color-scheme:dark){:root{--paper:#19231e;--ink:#e9f0eb;--muted:#b5c4b9;--line:#3b4f42;--panel:#233229;--accent:#a1d2ac;--warn:#edc07c}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.9 system-ui,'Microsoft YaHei',sans-serif}main{max-width:54rem;margin:auto;padding:2rem clamp(1rem,4vw,2.5rem) 5rem;overflow-wrap:anywhere}h1,h2,h3{line-height:1.45}h2{margin-top:2em;border-bottom:1px solid var(--line);padding-bottom:.3em}h3{margin-top:1.6em}p{margin:.85em 0}main>p{text-indent:2em}a{color:var(--accent)}blockquote{margin:1.2em 0;padding:.7em 1em;background:var(--panel);border-left:3px solid var(--accent)}.textbook-rich-quote{border:1px solid var(--line);border-radius:.65rem;padding:1rem;background:var(--panel)}.textbook-rich-quote>p:first-child{color:var(--accent);font-size:.85em;margin:0 0 .5em}.textbook-rich-compare>ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:.7rem;padding:0;list-style:none}.textbook-rich-compare>ul>li{padding:.7rem .9rem;background:var(--paper);border:1px solid var(--line);border-radius:.4rem}.textbook-rich-steps li{padding:.2rem}.textbook-rich-example,.textbook-rich-takeaway{border-left:4px solid var(--accent)}.textbook-rich-warning{border-left:4px solid var(--warn)}.textbook-rich-question{border-style:dashed}.textbook-rich-note{font-size:.92em}table{width:100%;border-collapse:collapse}th,td{border:1px solid var(--line);padding:.45rem .7rem;text-align:left}th{background:var(--panel)}.table-wrap{overflow-x:auto;margin:1em 0}pre{overflow:auto;padding:1em;background:var(--panel);border:1px solid var(--line);border-radius:.4rem;white-space:pre}code{font-family:ui-monospace,monospace;font-size:.9em}p code{background:var(--panel);padding:.1em .3em}.display-math{overflow-x:auto;text-align:center;margin:1em 0}.figure-source>summary,details>summary{cursor:pointer;color:var(--accent)}.export-notice{color:var(--muted);font-size:.85em}img{max-width:100%;height:auto}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media print{body{background:white;color:black}main{max-width:none}blockquote,pre,table{break-inside:avoid}}
`;
const stepsCss = `.textbook-rich-steps>ol{counter-reset:step;margin:.5rem 0;padding:0;list-style:none}.textbook-rich-steps>ol>li{counter-increment:step;position:relative;margin-left:.72rem;padding:.1rem 0 1rem 1.5rem;border-left:1px solid var(--line)}.textbook-rich-steps>ol>li:last-child{border-left-color:transparent;padding-bottom:.1rem}.textbook-rich-steps>ol>li:before{content:counter(step);position:absolute;left:-.72rem;top:.15rem;display:grid;place-items:center;width:1.38rem;height:1.38rem;border-radius:50%;background:var(--accent);color:var(--paper);font-size:.72rem;font-weight:700;line-height:1}`;
const teachingColors = `:root{--teach-green:#eef4ee;--teach-takeaway:#e8f1e9;--teach-rose:#fbf3f0;--teach-warning:#faeeeb;--teach-red:#994d42;--teach-leaf:#8eaa96}@media(prefers-color-scheme:dark){:root{--teach-green:#203027;--teach-takeaway:#293c2e;--teach-rose:#302824;--teach-warning:#382926;--teach-red:#e8b2a7;--teach-leaf:#6a9475}}.textbook-rich-quote{background:var(--teach-green)}.textbook-rich-takeaway{background:var(--teach-takeaway)}.textbook-rich-example{background:var(--teach-rose)}.textbook-rich-warning{border-left-color:var(--teach-red);background:var(--teach-warning)}.textbook-rich-warning>p:first-child{color:var(--teach-red)}.textbook-rich-question{border-color:var(--teach-leaf)}`;
const figureCss = `.export-figure{margin:1.3em 0;padding:.8em;border:1px solid var(--line);border-radius:.5rem;background:var(--panel)}.export-figure figcaption{font-weight:600}.export-figure img{display:block;margin:.6em auto;background:#fffefa;max-width:100%;height:auto}.export-figure details{font-size:.85em}.science-svg{display:block;background:#fffefa;width:100%;max-height:32rem;color:#24352b}.science-svg g{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.science-svg text{stroke:none;fill:currentColor;font:15px sans-serif}.science-svg .accent{color:#287b59}.science-svg .warm{color:#a65e25}.science-svg .cool{color:#4b78ab}.science-svg marker path{stroke:none;fill:currentColor}`;

function ScienceFigure({ code, allowed }: { code: string; allowed: string[] }) {
  try {
    const diagram = parseScienceDiagram(code, allowed);
    const label = (text: string | undefined, x: number, y: number) => text ? <text x={x} y={y} textAnchor="middle">{text}</text> : null;
    return <figure className="export-figure"><figcaption>{diagram.title} · {diagram.simulated ? '教学示意 · 非实测图' : '依据资料绘制'}</figcaption>
      <svg className="science-svg" viewBox={`0 0 ${diagram.width} ${diagram.height}`} role="img" aria-label={diagram.description}>
        <defs><marker id="export-science-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" /></marker></defs>
        {diagram.elements.map((e, index) => <g key={index} className={e.color || 'default'}>
          {e.kind === 'rect' && <><rect x={e.x} y={e.y} width={e.width} height={e.height} rx="3" />{label(e.label, e.x + e.width / 2, e.y + e.height / 2 + 5)}</>}
          {e.kind === 'circle' && <><circle cx={e.cx} cy={e.cy} r={e.r} />{label(e.label, e.cx, e.cy + 5)}</>}
          {(e.kind === 'line' || e.kind === 'arrow') && <><line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} strokeDasharray={e.dashed ? '6 5' : undefined} markerEnd={e.kind === 'arrow' ? 'url(#export-science-arrow)' : undefined} />{label(e.label, (e.x1 + e.x2) / 2 + (Math.abs(e.x2 - e.x1) < 30 ? 27 : 0), (e.y1 + e.y2) / 2 - 12)}</>}
          {e.kind === 'polyline' && <><polyline points={e.points.map(p => p.join(',')).join(' ')} strokeDasharray={e.dashed ? '6 5' : undefined} />{label(e.label, e.points[0][0], e.points[0][1] - 12)}</>}
          {e.kind === 'label' && label(e.text, e.x, e.y)}
          {e.kind === 'symbol' && <><g transform={`translate(${e.x},${e.y}) rotate(${e.angle || 0})`}>
            {e.symbol === 'resistor' ? <><path d="M-32 0 H-20 M20 0 H32" /><rect x="-20" y="-9" width="40" height="18" /></> : e.symbol === 'battery' ? <path d="M-32 0 H-5 M5 0 H32 M-5 -18 V18 M5 -10 V10" /> : e.symbol === 'lamp' ? <><path d="M-32 0 H-16 M16 0 H32 M-11 -11 L11 11 M-11 11 L11 -11" /><circle r="16" /></> : <><path d={e.symbol === 'switch-open' ? 'M-32 0 H-16 M16 0 H32 M-16 0 L12 -16' : 'M-32 0 H32'} /><circle cx="-16" r="2" /><circle cx="16" r="2" /></>}
          </g>{label(e.label, e.x, e.y + 34)}</>}
        </g>)}
      </svg><p>{diagram.description}</p></figure>;
  } catch { return null; }
}

function nodeText(node: any): string { return node?.type === 'text' ? node.value : (node?.children || []).map(nodeText).join(''); }
function formula(source: string, displayMode: boolean) {
  // KaTeX creates MathML locally. Its untrusted-input mode never permits links or HTML commands.
  if (source.length > 16_000) return <code>（公式过长，请查看 Markdown 源码）{source}</code>;
  const html = katex.renderToString(normalizeReadingLatex(source, displayMode), { output: 'mathml', displayMode, throwOnError: false, trust: false, strict: 'warn', maxExpand: 1_000, maxSize: 20 });
  return React.createElement(displayMode ? 'div' : 'span', { className: displayMode ? 'display-math' : undefined, dangerouslySetInnerHTML: { __html: html } });
}
const plugins = [remarkGfm, remarkMath];
function exportComponents(assets: StyledExportAssets): Components {
const components: Components = {
  blockquote: ({ node, children }) => { const kind = textbookQuoteKind(node); return <blockquote className={kind ? `textbook-rich-quote textbook-rich-${kind}` : undefined}>{children}</blockquote>; },
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
  img: ({ alt, src }) => src && assets.images?.[src] ? <img src={assets.images[src]} alt={alt || '教材资料原图'} loading="lazy" /> : <span>（原图未随本次分享提供：{alt || '图片'}）</span>,
  code: ({ className, children }) => className?.includes('math-inline') ? formula(String(children), false) : <code className={className}>{children}</code>,
  pre: ({ node, children }) => {
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code') as Element | undefined;
    const classes = Array.isArray(code?.properties.className) ? code.properties.className.map(String) : String(code?.properties.className || '').split(/\s+/u);
    const source = nodeText(code).replace(/\n$/u, '');
    if (classes.includes('math-display')) return formula(source, true);
    const language = classes.find(name => name.startsWith('language-'))?.slice(9) || '';
    if (language === 'textbook-tip' || language === 'textbook-answer') {
      try {
        const parsed = language === 'textbook-tip' ? parseTextbookTip(source) : parseTextbookAnswer(source);
        return language === 'textbook-answer' ? <details className="textbook-rich-quote"><summary>{parsed.title}</summary><ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>{parsed.text}</ReactMarkdown></details>
          : <blockquote className="textbook-rich-quote textbook-rich-note"><strong>{parsed.title}</strong><ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>{parsed.text}</ReactMarkdown></blockquote>;
      } catch { /* Preserve malformed blocks as text below. */ }
    }
    if (['mermaid', 'function-plot', 'chart', 'science-diagram', 'molecule'].includes(language)) {
      const image = assets.visuals?.[exportVisualKey(language, source)];
      let title = language, qualifier = language === 'function-plot' ? ' · 静态图，参数为教材初始值' : '';
      try { const value = JSON.parse(source); if (typeof value.title === 'string') title = value.title.slice(0, 120);
        if ((language === 'chart' || language === 'molecule') && typeof value.simulated === 'boolean') qualifier = value.simulated ? ' · 教学示意，非实测数据' : ' · 依据资料绘制，请核对来源';
      } catch { /* Mermaid is text. */ }
      let science: React.ReactNode = null;
      if (language === 'science-diagram') { try { parseScienceDiagram(source, assets.sourceIds || []); science = <ScienceFigure code={source} allowed={assets.sourceIds || []} />; } catch { /* Keep source fallback. */ } }
      return <>{image && <figure className="export-figure"><figcaption>{title}{qualifier}</figcaption><img src={image} alt={title} loading="lazy" /></figure>}{science}
        <details className="figure-source"><summary>{image || science ? '查看图示源码' : `${language} 图示未能导出，可查看图示源码`}</summary><pre>{children}</pre></details></>;
    }
    return <pre>{children}</pre>;
  },
};
return components;
}

/** Pure export transform. All raw HTML is skipped; executable figure pages are separate attachments. */
export function renderStyledTextbookHtml(title: string, body: string, assets: StyledExportAssets = {}): string {
  if (body.length > 5_000_000) throw Error('教材过大，无法导出 HTML');
  const components = exportComponents(assets);
  const content = renderToStaticMarkup(<main><h1>{title}</h1><ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>{body}</ReactMarkdown></main>);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>教材</title><style>${css}${stepsCss}${teachingColors}${figureCss}</style></head><body>${content}</body></html>`;
}
