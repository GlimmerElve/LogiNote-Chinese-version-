import React, { useCallback, useId, useMemo, useState } from 'react';
import { parseFunctionPlot, riemannRectangles, type TextbookFunctionPlot } from '../../services/textbook/functionPlot';
import { BackgroundTextbookVisual } from './BackgroundTextbookVisual';
export { sampleTextbookCurve } from '../../services/textbook/curveSampling';
const COLORS = ['#287b59', '#685bb0', '#a65e25', '#b34866'];
const METHODS = { left: '左端点', midpoint: '中点', right: '右端点' } as const;
function FunctionFigure({ plot }: { plot: TextbookFunctionPlot }) {
  const id = useId(), [count, setCount] = useState(plot.riemann?.count || 8), [method, setMethod] = useState(plot.riemann?.method || 'midpoint');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const onStatus = useCallback((value: typeof status) => setStatus(value), []);
  const sums = useMemo(() => plot.riemann ? riemannRectangles(plot, count, method) : null, [plot, count, method]);
  const code = useMemo(() => JSON.stringify({ ...plot, ...(plot.riemann ? { riemann: { ...plot.riemann, count, method } } : {}) }), [plot, count, method]);
  return <figure className="textbook-function" data-function-plot="true" data-plot-status={status}>
    <figcaption><strong>{plot.title}</strong><span>由明确表达式绘制 · {plot.variable} 为自变量 · 当前绘图区间</span></figcaption>
    <div className="textbook-function-legend">{plot.curves.map((curve, i) => <span key={curve.id}><i style={{ background: COLORS[i] }} />{curve.label}：{curve.expression}</span>)}</div>
    <div className="textbook-function-canvas"><BackgroundTextbookVisual kind="function-plot" code={code} onStatus={onStatus}
      label={`${plot.title}。横轴${plot.xLabel}；纵轴${plot.yLabel}。${plot.area ? `阴影为函数与横轴在 ${plot.area.from} 至 ${plot.area.to} 之间的区域。` : ''}`} /></div>
    {plot.riemann && sums && <>
      <div className="textbook-riemann-controls">
        <label htmlFor={`${id}-count`}>分割数 n = {count}<input id={`${id}-count`} type="range" min="2" max="80" step="1" value={count} onChange={event => setCount(Number(event.target.value))} /></label>
        <label htmlFor={`${id}-method`}>取样方式<select id={`${id}-method`} value={method} onChange={event => setMethod(event.target.value as typeof method)}>{Object.entries(METHODS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </div>
      <output className="textbook-riemann-result" aria-live="polite">Δ{plot.variable} = {sums.dx.toFixed(4)} · 有向黎曼和 ≈ {sums.signedSum.toFixed(6)} · 小矩形几何面积之和 ≈ {sums.geometricSum.toFixed(6)}</output>
      <p className="textbook-function-note">黄色小矩形的宽度为 Δ{plot.variable}，高度取自{METHODS[method]}。下方数值是有限分割的近似，不是精确积分或公式证明；横轴下方的矩形计入有向和时为负。</p>
    </>}
    {plot.area && <p className="textbook-function-note">淡色阴影：函数与横轴在 [{plot.area.from}, {plot.area.to}] 内的区域；不要把几何面积与有正负号的定积分混淆。</p>}
  </figure>;
}
export function FunctionPlotBlock({ code }: { code: string }) {
  const { plot, error } = useMemo(() => {
    try { return { plot: parseFunctionPlot(code), error: '' }; }
    catch (error) { return { plot: null, error: error instanceof SyntaxError ? '图块不是有效的 JSON' : error instanceof Error ? error.message : '函数图参数不明确或不支持' }; }
  }, [code]);
  return plot ? <FunctionFigure key={code} plot={plot} /> : <small className="textbook-function-skipped" role="status">函数图暂未绘制：{error}。正文与公式仍可继续阅读，也可使用“编辑源码”修正。</small>;
}
