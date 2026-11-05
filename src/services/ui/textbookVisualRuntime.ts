/** Imported only by the isolated drawing document. Library evaluation, plotting,
 * measurement and SVG construction must never run in the reader's JS realm. */
import { parseFunctionPlot, compileTextbookFunction, riemannRectangles } from '../textbook/functionPlot';
import { sampleTextbookCurve } from '../textbook/curveSampling';
import { parseChartBlock } from '../textbook/contentSchema';
import { parseMoleculeDiagram } from '../textbook/scienceDiagram';
import { withMermaidMeasurementHost } from './mermaidMeasureHost';
import { sanitizeMermaidSvg } from './mermaidPresentation';
import type { TextbookVisualInput } from './textbookVisualTypes';

const COLORS = ['#287b59', '#685bb0', '#a65e25', '#b34866'];
const svg = (name: string, attrs: Record<string, string | number> = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value))); return element;
};
function finish(element: SVGSVGElement, width: number, height: number) {
  element.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  element.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // Main-reader accessibility text is supplied by the owned component.
  element.removeAttribute('aria-label');
  return { svg: sanitizeMermaidSvg(new XMLSerializer().serializeToString(element)), readingWidth: width };
}
export async function renderTextbookVisual(value: TextbookVisualInput): Promise<{ svg: string; readingWidth: number }> {
  const width = Math.max(260, Math.min(1000, Math.round(value.width || 800))), height = 340;
  if (value.visualKind === 'function-plot') {
    const plot = parseFunctionPlot(value.code);
    const { default: functionPlot, Chart } = await import('function-plot');
    return withMermaidMeasurementHost(async host => {
      const options: Parameters<typeof functionPlot>[0] = { target: host, width, height, disableZoom: true, grid: true,
        xAxis: { domain: [...plot.xDomain], label: plot.xLabel }, yAxis: { domain: [...plot.yDomain], label: plot.yLabel },
        data: plot.curves.flatMap((_, index) => sampleTextbookCurve(plot, index).map(points => ({ points, fnType: 'points',
          graphType: 'polyline', color: COLORS[index], skipTip: true, attr: { 'stroke-width': 2 } }))) };
      try {
        const instance = functionPlot(options); instance.meta.zoomBehavior?.filter(() => false);
        const content = host.querySelector<SVGGElement>('g.content'), x = instance.meta.xScale!, y = instance.meta.yScale!;
        if (!content) throw Error('函数图坐标层未建立');
        const overlay = svg('g', { class: 'textbook-function-overlay', 'pointer-events': 'none' }); content.insertBefore(overlay, content.firstChild);
        if (plot.area) {
          const { from, to, curveId } = plot.area, index = plot.curves.findIndex(curve => curve.id === curveId);
          const curve = compileTextbookFunction(plot.curves[index].expression, plot.variable, plot.parameters);
          const points = Array.from({ length: 401 }, (_, i) => { const input = from + (to - from) * i / 400; return `${x(input)},${y(curve.evaluate(input))}`; });
          overlay.append(svg('path', { class: 'textbook-function-area', d: `M${x(from)},${y(0)} L${points.join(' L')} L${x(to)},${y(0)} Z`, fill: COLORS[index], 'fill-opacity': .12 }));
        }
        const sums = plot.riemann ? riemannRectangles(plot, plot.riemann.count, plot.riemann.method) : null;
        for (const rect of sums?.rectangles || []) overlay.append(svg('rect', { class: 'textbook-riemann-rectangle', x: x(rect.left),
          y: Math.min(y(0), y(rect.height)), width: Math.max(0, x(rect.right) - x(rect.left)), height: Math.abs(y(rect.height) - y(0)),
          fill: '#b47b25', 'fill-opacity': .22, stroke: '#996316', 'stroke-width': .7 }));
        const foreground = value.dark ? '#eff4f0' : '#17221b', line = value.dark ? '#87958c' : '#64756a';
        host.querySelectorAll('text').forEach(node => node.setAttribute('fill', foreground));
        host.querySelectorAll('.axis path,.axis line').forEach(node => node.setAttribute('stroke', line));
        const root = host.querySelector<SVGSVGElement>('svg'); if (!root) throw Error('函数图为空');
        return finish(root, width, height);
      } finally {
        if (options.id) { Chart.cache?.[options.id]?.removeAllListeners(); if (Chart.cache) delete Chart.cache[options.id]; }
      }
    });
  }
  if (value.visualKind === 'chart') {
    const chart = parseChartBlock(value.code, { sourceIds: JSON.parse(value.code).sourceIds });
    const [echarts, charts, components, renderers] = await Promise.all([import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers')]);
    echarts.use([charts.BarChart, charts.LineChart, charts.PieChart, components.GridComponent, components.LegendComponent, components.AriaComponent, renderers.SVGRenderer]);
    const instance = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width, height });
    try {
      const foreground = value.dark ? '#eff4f0' : '#364152';
      instance.setOption({ animation: false, textStyle: { color: foreground }, color: [COLORS[0], '#6575b6', '#b98235', '#9b6377', '#538ba0', '#7c8960'],
        aria: { enabled: true, decal: { show: true } }, legend: { bottom: 0, textStyle: { color: foreground } },
        grid: { left: 55, right: 25, top: 25, bottom: 60, containLabel: true },
        ...(chart.type !== 'pie' ? { xAxis: { type: 'category', data: chart.labels, axisLabel: { color: foreground } }, yAxis: { type: 'value', axisLabel: { color: foreground } } } : {}),
        series: chart.series.map(series => chart.type === 'pie' ? { name: series.name, type: 'pie', radius: ['25%', '65%'], label: { color: foreground }, data: chart.labels.map((label, index) => ({ name: label, value: series.data[index] })) }
          : { name: series.name, type: chart.type, data: series.data, smooth: false }) });
      const root = new DOMParser().parseFromString(instance.renderToSVGString(), 'image/svg+xml').documentElement as unknown as SVGSVGElement;
      return finish(root, width, height);
    } finally { instance.dispose(); }
  }
  if (value.visualKind === 'molecule') {
    const molecule = parseMoleculeDiagram(value.code, JSON.parse(value.code).sourceIds);
    const { default: drawer } = await import('smiles-drawer');
    return withMermaidMeasurementHost(host => new Promise<{ svg: string; readingWidth: number }>((resolve, reject) => {
      drawer.parse(molecule.smiles, tree => {
        try {
          const root = svg('svg') as SVGSVGElement; host.append(root);
          new drawer.SvgDrawer({ width: 420, height: 240, padding: 24 }).draw(tree, root, value.dark ? 'dark' : 'light');
          if (!root.querySelector('path,line,text,polygon')) throw Error('分子图为空');
          resolve(finish(root, 420, 240));
        } catch (error) { reject(error); }
      }, () => reject(Error('SMILES 语法无法解析')));
    }));
  }
  throw Error('不支持的后台图形');
}
