export const TEXTBOOK_MERMAID_CONFIG = { securityLevel: 'strict' as const, startOnLoad: false, suppressErrorRendering: true,
  maxTextSize: 8_000, maxEdges: 80, htmlLabels: false, fontSize: 16,
  fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
  flowchart: { htmlLabels: false, padding: 18, nodeSpacing: 40, rankSpacing: 52, curve: 'basis' as const },
  mindmap: { padding: 14, maxNodeWidth: 220 }, theme: 'base' as const };

export function textbookMermaidTheme(dark: boolean) {
  const text = dark ? '#eff4f0' : '#17221b';
  const surface = dark ? '#1c231e' : '#fffefa';
  const primary = dark ? '#2b4434' : '#e4ece6';
  const border = dark ? '#739b7e' : '#799981';
  const line = dark ? '#8dae96' : '#557a62';
  const branches = dark ? ['#294334', '#34483b', '#2d4543', '#404b35'] : ['#e4ece6', '#edf1e8', '#e5efeb', '#f0efe0'];
  return {
    ...TEXTBOOK_MERMAID_CONFIG,
    themeVariables: {
      darkMode: dark, background: surface, primaryColor: primary, primaryTextColor: text, primaryBorderColor: border,
      secondaryColor: branches[1], secondaryTextColor: text, secondaryBorderColor: border,
      tertiaryColor: surface, tertiaryTextColor: text, tertiaryBorderColor: border,
      lineColor: line, textColor: text, mainBkg: primary, nodeTextColor: text,
      edgeLabelBackground: surface, clusterBkg: surface, clusterBorder: border,
      actorBkg: primary, actorBorder: border, actorTextColor: text, actorLineColor: line,
      signalColor: line, signalTextColor: text, labelTextColor: text,
      labelBoxBkgColor: surface, labelBoxBorderColor: border,
      noteBkgColor: branches[1], noteTextColor: text, noteBorderColor: border,
      git0: dark ? '#365b43' : '#2f5743', gitBranchLabel0: '#ffffff',
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        [`cScale${index}`, branches[index % branches.length]],
        [`cScaleLabel${index}`, text], [`cScaleInv${index}`, border], [`lineColor${index}`, line],
      ]).flat()),
    },
    themeCSS: `.mindmap-node .node-bkg, .mindmap-node circle, .mindmap-node polygon { stroke: ${border}; stroke-width: 1px; }
      .mindmap-node .node-line- { stroke: transparent; }
      .edge { stroke: ${line}; stroke-width: 2px !important; }
      .node rect { rx: 9px; ry: 9px; }
      .edgeLabel .labelBkg { fill: ${surface}; opacity: 1; }
      .nodeLabel, .mindmap-node text { font-weight: 500; }`,
  };
}

/** Mermaid 11's SVG-only circle labels start at x=0; center against the actual shape. */
export function alignMermaidMindmapLabels(container: HTMLElement): void {
  for (const node of container.querySelectorAll<SVGGElement>('svg[aria-roledescription="mindmap"] .mindmap-node')) {
    const label = node.querySelector<SVGGElement>(':scope > g.label');
    const shape = node.querySelector<SVGGraphicsElement>(':scope > .node-bkg, :scope > .label-container');
    if (!label || !shape) continue;
    const labelBox = label.getBBox(), shapeBox = shape.getBBox();
    if (![labelBox.x, labelBox.y, labelBox.width, labelBox.height, shapeBox.x, shapeBox.y, shapeBox.width, shapeBox.height].every(Number.isFinite)
      || labelBox.width <= 0 || shapeBox.width <= 0) continue;
    label.setAttribute('transform', `translate(${shapeBox.x + shapeBox.width / 2 - labelBox.x - labelBox.width / 2}, ${shapeBox.y + shapeBox.height / 2 - labelBox.y - labelBox.height / 2})`);
  }
}
export function sanitizeMermaidSvg(svg: string): string {
  if (svg.length > 1_000_000) throw new Error('图示渲染结果过大');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('图示 SVG 格式无效');
  const elements = [...document.querySelectorAll('*')];
  if (elements.length > 5_000) throw new Error('图示渲染节点过多');
  for (const element of elements) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'a', 'audio', 'video', 'animate', 'set'].includes(element.localName.toLowerCase())) throw new Error('图示包含未授权内容');
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(), value = attribute.value;
      if (name.startsWith('on') || (/(?:^|:)href$/u.test(name) && !/^#[\w:.-]+$/u.test(value))
        || /(?:javascript|data|https?|file):/iu.test(value) && name !== 'xmlns' && !name.startsWith('xmlns:')
        || [...value.matchAll(/url\s*\(\s*['"]?([^)'"\s]+)['"]?\s*\)/giu)].some((hit) => !/^#[\w:.-]+$/u.test(hit[1]))) throw new Error('图示包含脚本或外部资源');
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}
/** Reading layout only: never trust SVG dimensions as an unbounded allocation or CSS value. */
export function boundedMermaidReadingWidth(viewBox: string | null): number {
  const parts = (viewBox || '').trim().split(/[\s,]+/u);
  if (parts.length !== 4 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(part))) return 960;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value)) || values[2] < 1 || values[3] < 1) return 960;
  return Math.min(4096, Math.ceil(values[2]));
}
/**
 * Mermaid's SVG-label renderer treats a literal `\\n` as two visible
 * characters. Convert it only after the untrusted source has passed the
 * Mermaid safety gate; the inserted tag is fixed by us and becomes SVG
 * tspans because htmlLabels is disabled.
 */
export function normalizeMermaidLineBreaks(code: string): string {
  // Timeline's SVG text wrapper recognizes <br>, unlike the flowchart wrapper.
  return code.replace(/\\r\\n|\\n|\\r/gu, /^\s*(?:%%[^\n]*\n\s*)*timeline\s*(?:\n|$)/u.test(code) ? '<br>' : '<br/>');
}
