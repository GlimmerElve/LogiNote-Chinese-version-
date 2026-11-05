/**
 * S4 结果图表（对应实施计划 F19，阶段八扩展为多曲线）。
 *
 * 职责：
 * - 把 SymPy `plot_data` 命令返回的点列渲染为函数曲线（渲染引擎：function-plot）
 * - 支持**同时渲染多条曲线**，用于观察两个函数的关系（如交点位置）
 * - 支持在图上标注交点（由 `solve_intersections` 命令给出）
 *
 * 为什么画「采样点列」而不是「函数表达式」：
 * - SymPy 采样能覆盖解析绘图处理不了的形态（分段、边界截断、无初等原函数）
 * - 采样数据完全由引擎产出，LLM 不参与，符合原则 10「LLM 生成、系统执行」
 *
 * 多曲线为什么可行（阶段八）：
 * function-plot 的 `data` 本就是数组，每条曲线一项；`plot_data` 协议无需改动，
 * 对每个选中表达式各调一次再合并即可。坐标轴 x 范围取所有曲线的**并集**，
 * 保证叠加后不错位。
 *
 * 对应《场景设计原则》：
 * - 原则 2「表现性」：用户推出来的公式由真实引擎求值并画出来（而非展示标准答案）
 * - 原则 7「状态可感知」：把抽象结果变成可视曲线，用户看得见自己算出了什么
 * - 原则 10「LLM 生成、系统执行」：曲线与交点均由引擎算，LLM 不参与
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LineChart, Loader2, CircleAlert } from 'lucide-react';
import { fetchPlotData } from '../../services/scene/computeClient';

/** function-plot 的调用签名（该库无官方 TS 类型，此处按实际用法最小化声明） */
type PlotFn = (opts: Record<string, unknown>) => unknown;

/** 一条待绘制曲线 */
export interface ChartSeries {
  /** 唯一标识（用于配色与图例对应） */
  id: string;
  /** 图例显示名，如节点的 Step 1 */
  label: string;
  /** 待绘图表达式（SymPy 可解析） */
  expr: string;
  /** 该曲线颜色（由调用方分配，保证图例与曲线一致） */
  color: string;
}

/** 图表交点标注 */
export interface ChartIntersection {
  x: number;
  y: number;
}

/** 图表绘制参数 */
export interface ChartViewProps {
  /** 待绘制曲线集合（至少一条） */
  series: ChartSeries[];
  /** 自变量名，如 "v" */
  variable: string;
  /** 自变量取值范围（SymPy 可解析的字符串） */
  range: [string, string];
  /** 常量表（符号名 → 值），用于含其他符号的公式 */
  constants?: Record<string, string>;
  /** 采样点数（默认 400） */
  points?: number;
  /** 图表高度（px，默认 220） */
  height?: number;
  /** 交点标注（由 solveIntersections 计算后传入；可选） */
  intersections?: ChartIntersection[];
}

/**
 * 把可能含 null / NaN / Infinity 的采样序列过滤为可绘制点列。
 * SymPy 在超出定义域处会产出 NaN，function-plot 遇到非有限值会画断线或报错，
 * 因此先剔除，再由 polyline 连接剩余点。
 */
function toDrawablePoints(xs: number[], ys: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

export const ChartView: React.FC<ChartViewProps> = ({
  series,
  variable,
  range,
  constants,
  points = 400,
  height = 220,
  intersections = [],
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 采样点为空时给用户明确原因，而不是留下一块空白 */
  const [empty, setEmpty] = useState(false);
  const [hostWidth, setHostWidth] = useState(0);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const samplesRef = useRef<{key: string; promise: Promise<Awaited<ReturnType<typeof fetchPlotData>>[]>} | null>(null);

  // 这些依赖每次渲染都是新引用，用「序列化标量」保证 effect 稳定
  const constantsKey = JSON.stringify(constants ?? {});
  const seriesKey = JSON.stringify(series.map((s) => [s.id, s.expr, s.color]));
  const [rangeLo, rangeHi] = range;
  const intersectionsKey = JSON.stringify(intersections);
  const sampleKey = JSON.stringify([series.map((s) => [s.id, s.expr]), variable, rangeLo, rangeHi, constantsKey, points]);
  const viewKey = JSON.stringify([sampleKey, seriesKey, intersectionsKey, height, hostWidth]);
  const viewKeyRef = useRef(viewKey); viewKeyRef.current = viewKey;

  useEffect(() => {
    aliveRef.current = true;
    const host = hostRef.current;
    const measure = () => { if (host) setHostWidth(host.clientWidth); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (host) observer?.observe(host);
    return () => { aliveRef.current = false; requestRef.current++; observer?.disconnect(); };
  }, []);

  const render = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    const token = ++requestRef.current;
    const isCurrent = () => aliveRef.current && requestRef.current === token && viewKeyRef.current === viewKey;
    host.innerHTML = '';
    if (!series.length) {
      loadingRef.current = false; setLoading(false); setError(null);
      setEmpty(true);
      return;
    }

    setError(null);
    setEmpty(false);
    setLoading(true);
    loadingRef.current = true;

    try {
      const safeRange: [string, string] = [rangeLo, rangeHi];

      // 并行取所有曲线的采样点（互不依赖，串行会明显拖慢）
      if (samplesRef.current?.key !== sampleKey) samplesRef.current = {key: sampleKey, promise: Promise.all(
        series.map((s) => fetchPlotData(s.expr, variable, safeRange, constants, points)),
      )};
      const results = await samplesRef.current.promise;
      if (!isCurrent()) return;

      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) {
        setError((failed as { ok: false; error: string }).error || '绘图失败');
        return;
      }

      // 组装 function-plot 的 data 数组 + x 范围并集
      const data: Array<Record<string, unknown>> = [];
      let xMin = Number.POSITIVE_INFINITY;
      let xMax = Number.NEGATIVE_INFINITY;
      let totalPoints = 0;

      results.forEach((r, i) => {
        if (!r.ok) return;
        const pts = toDrawablePoints(r.result.x, r.result.y);
        if (!pts.length) return;
        totalPoints += pts.length;
        xMin = Math.min(xMin, pts[0][0]);
        xMax = Math.max(xMax, pts[pts.length - 1][0]);
        data.push({
          points: pts,
          fnType: 'points',
          graphType: 'polyline',
          color: series[i].color,
          attr: { 'stroke-width': 2 },
        });
      });

      if (totalPoints === 0) {
        setEmpty(true);
        return;
      }

      // 交点标注：散点 + 数值标签，让「相交位置」一眼可读
      if (intersections.length) {
        data.push({
          points: intersections.map((p) => [p.x, p.y]),
          fnType: 'points',
          graphType: 'scatter',
          color: '#B8574A',
          attr: { r: 4, 'stroke-width': 1, fill: '#B8574A' },
        });
      }

      // 动态加载 function-plot：既不拖累首屏，也规避该库缺失类型声明的问题
      const mod = await import('function-plot');
      if (!isCurrent()) return;
      const plotFn: PlotFn =
        (mod as unknown as { default?: PlotFn }).default ?? (mod as unknown as PlotFn);

      host.innerHTML = '';
      plotFn({
        target: host,
        width: hostWidth || host.clientWidth || 320,
        height,
        disableZoom: false,
        grid: true,
        xAxis: {
          label: variable,
          domain: Number.isFinite(xMin) && Number.isFinite(xMax) ? [xMin, xMax] : undefined,
        },
        yAxis: { label: 'f' },
        data,
        // 交点用文字标出坐标，避免用户还要自己估读
        annotations: intersections.slice(0, 6).map((p) => ({
          x: p.x,
          text: `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`,
        })),
      });
    } catch (e) {
      if (isCurrent()) setError((e as Error)?.message || '绘图失败');
    } finally {
      if (isCurrent()) { loadingRef.current = false; setLoading(false); }
    }
  }, [seriesKey, variable, rangeLo, rangeHi, constantsKey, points, height, intersectionsKey, hostWidth]);

  useEffect(() => {
    void render();
    return () => { requestRef.current++; };
  }, [render]);

  // 卸载时清空宿主节点，避免 function-plot 残留 SVG（React 不接管其内部 DOM）
  useEffect(
    () => () => {
      if (hostRef.current) hostRef.current.innerHTML = '';
    },
    [],
  );

  return (
    <div className="scene-s4-chart">
      <div className="scene-s4-chart-head">
        <LineChart className="w-3.5 h-3.5" />
        <span className="scene-s4-chart-title">结果曲线</span>
        <span className="scene-s4-chart-sub" title={`x: ${variable}`}>
          x: {variable}
        </span>
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>

      {/* 图例：曲线颜色 ↔ 节点标签，多条曲线时必需 */}
      {series.length > 1 && (
        <div className="scene-s4-chart-legend">
          {series.map((s) => (
            <span key={s.id} className="scene-s4-chart-legend-item">
              <span className="scene-s4-chart-legend-dot" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {intersections.length > 0 && (
            <span className="scene-s4-chart-legend-item">
              <span className="scene-s4-chart-legend-dot is-cross" />
              交点 {intersections.length} 个
            </span>
          )}
        </div>
      )}

      <div className="scene-s4-chart-body" style={{ height }}>
        <div ref={hostRef} className="scene-s4-chart-host" />
        {loading && <div className="scene-s4-chart-empty" role="status"><Loader2 className="w-3.5 h-3.5 animate-spin" />正在绘制曲线…</div>}

        {!loading && (error || empty) && (
          <div className="scene-s4-chart-empty" role={error ? 'alert' : 'status'}>
            <CircleAlert className="w-3.5 h-3.5" />
            <span>{error || '所选表达式在给定范围内无有效采样点'}</span>
            {error && <button type="button" className="scene-s4-btn-ghost" onClick={() => {
              if (loadingRef.current) return;
              samplesRef.current = null;
              void render();
            }}>重试绘图</button>}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChartView;
