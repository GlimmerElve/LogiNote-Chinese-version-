/**
 * S4 结果曲线面板（阶段八新增，取代原先「直接画标准答案」的实现）。
 *
 * 背景与动机：
 * 旧实现把 `spec.compute.expected_formula`（标准答案）直接画成曲线，
 * 运行中等于把答案摆在用户面前。而该组件的设计初衷是「让用户看见自己算出来的东西」
 * （原则 2「表现性」）。
 *
 * 现在改为：**用户自选要画哪些公式**。
 * - 候选来自画布上的公式 / 结论节点（用户自己写的）
 * - 结束后额外解锁「标准答案」选项，供对照复盘（与 StandardSolutionView 的解锁时机一致）
 * - 支持**多选叠加**：观察两个函数的关系（如交点位置）是该功能的真实诉求
 *
 * 硬约束（必须让用户看见，而不是默默失败）：
 * 多条曲线要画在同一张图上，**必须共用同一个自变量**。
 * 若某个公式含多个未定变量、或完全不含选定自变量，它会被**标注原因并允许取消勾选**，
 * 而不是让用户选中后得到一片空白。
 *
 * 数据流：
 *   节点 LaTeX --resolveNodeExpression--> SymPy 表达式（本地快速通道 / LLM 转译）
 *   --> plot_data 采样 --> ChartView 渲染
 *   选中 ≥2 条时 --solveIntersections--> 交点标注
 *
 * 对应《场景设计原则》：
 * - 原则 2「表现性」：画用户自己的推导结果，不画标准答案
 * - 原则 10「LLM 生成、系统执行」：曲线与交点全部由 SymPy 引擎计算
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Loader2, CircleAlert, Calculator } from 'lucide-react';
import type { SceneRunState, SceneSpec } from '../../types';
import type { DerivationNode } from '../../types/sceneS4';
import { ChartView, type ChartSeries, type ChartIntersection } from './ChartView';
import { parseExpression, solveIntersections } from '../../services/scene/computeClient';
import { resolveNodeExpression } from '../../services/scene/computeAnalyze';
import { isS4ReferenceUnlocked } from '../../services/scene/sceneS4Policy';

/** 曲线配色（与画布节点色系区分，保证图例可辨） */
const SERIES_COLORS = ['#3F7A50', '#5B7FA8', '#B8574A', '#8A6BB8', '#C08A3E', '#4A9A9A'];

/** 候选曲线来源 */
interface Candidate {
  id: string;
  label: string;
  /** 原始 LaTeX（节点用）或表达式（标准答案用） */
  source: string;
  /** 是否为「标准答案」候选（仅结束后可选） */
  isAnswer?: boolean;
}

interface Resolution { key: string; expr: string; error?: string }

export interface CurvePanelProps {
  spec: SceneSpec;
  run: SceneRunState;
  /** 是否已结束；标准答案还需用户主动解锁，与参考解共用许可。 */
  isEnded: boolean;
  /** 面板整体高度（px） */
  height?: number;
}

export const CurvePanel: React.FC<CurvePanelProps> = ({ spec, run, isEnded, height = 200 }) => {
  const compute = spec.compute;

  /** 可选自变量（来自符号表声明为 variable 的符号） */
  const variables = useMemo(
    () => (compute?.symbols ?? []).filter((s) => s.kind === 'variable').map((s) => s.name),
    [compute?.symbols],
  );
  const [preferredVar, setSelectedVar] = useState<string>(variables[0] ?? '');
  const selectedVar = variables.includes(preferredVar) ? preferredVar : variables[0] ?? '';

  /** 常量表：符号表常量值 + given 的值兜底（供采样时代入） */
  const constants = useMemo(() => {
    const map: Record<string, string> = {};
    (compute?.symbols ?? []).forEach((s) => {
      if (s.kind === 'constant' && s.value) map[s.name] = s.value;
    });
    (compute?.given ?? []).forEach((g) => {
      if (g.symbol_value && !(g.name in map)) map[g.name] = g.symbol_value;
    });
    return map;
  }, [compute?.symbols, compute?.given]);

  /** 自变量范围：取声明里的 range，缺省 [0,1] */
  const range = useMemo<[string, string]>(() => {
    const decl = (compute?.symbols ?? []).find((s) => s.name === selectedVar);
    return (decl?.range ?? ['0', '1']) as [string, string];
  }, [compute?.symbols, selectedVar]);

  /** 候选列表：画布上的公式/结论节点（+ 结束后的标准答案） */
  const candidates = useMemo<Candidate[]>(() => {
    const nodes = run.canvas?.nodes ?? [];
    const list: Candidate[] = nodes
      .filter((n) => (n.type === 'formula' || n.type === 'conclusion') && n.data.latex?.trim())
      .map((n: DerivationNode) => ({
        id: n.id,
        label: n.data.label || n.id,
        source: n.data.latex ?? '',
      }));

    if (isEnded && isS4ReferenceUnlocked(run) && compute?.expected_formula) {
      const raw = compute.expected_formula.trim();
      const eqIdx = raw.indexOf('=');
      // 等式形式取右侧：绘图只接受「可求值表达式」
      const expr = eqIdx > 0 ? raw.slice(eqIdx + 1).trim() : raw;
      list.push({ id: '__answer__', label: '标准答案', source: expr, isAnswer: true });
    }
    return list;
  }, [run.canvas?.nodes, run.status, run.endedByUser, run.s4ReferenceUnlocked, isEnded, compute?.expected_formula]);

  /** 已勾选的候选 id */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [checkedScope, setCheckedScope] = useState(() => JSON.stringify([spec.sceneId, run.runId]));
  /** 每个候选解析后的结果（缓存，避免重复 LLM 调用） */
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  /** 正在解析 / 绘图中 */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intersectionData, setIntersectionData] = useState<{key: string; points: ChartIntersection[]}>({key: '', points: []});
  /** 展开放置 */
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [intersectionRetry, setIntersectionRetry] = useState(0);
  const [intersectionError, setIntersectionError] = useState<string | null>(null);
  const [findingIntersections, setFindingIntersections] = useState(false);
  const scope = JSON.stringify([spec.sceneId, run.runId]);
  const computeKey = JSON.stringify(compute);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const pendingRef = useRef(new Map<string, Promise<Resolution>>());
  const resolutionKey = (c: Candidate) => JSON.stringify([scope, computeKey, c.source, c.isAnswer, selectedVar]);
  const currentResolution = (c: Candidate) => resolved[c.id]?.key === resolutionKey(c) ? resolved[c.id] : undefined;

  /** 防止「已卸载后 setState」 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    setChecked(new Set()); setCheckedScope(scope); setResolved({}); setIntersectionData({key: '', points: []});
    setBusy(false); setError(null); setIntersectionError(null);
    pendingRef.current.clear();
  }, [scope]);

  /**
   * 解析一个候选为 SymPy 表达式，并校验它能否以 selectedVar 为自变量绘图。
   *
   * 校验口径：解析后的自由变量必须全部落在 {selectedVar} ∪ constants 内。
   * 否则说明它含多个未定变量，无法二维呈现。
   */
  const resolveCandidate = useCallback(
    async (c: Candidate, varName: string): Promise<{ expr: string } | { error: string }> => {
      let expr = '';
      if (c.isAnswer) {
        expr = c.source;
      } else {
        const node = run.canvas?.nodes.find((n) => n.id === c.id);
        if (!node) return { error: '节点已不存在' };
        const res = await resolveNodeExpression(node, spec);
        if (!aliveRef.current || scopeRef.current !== scope) return { error: '场景已切换' };
        if (!res.ok) return { error: (res as { ok: false; error: string }).error || '公式转译失败' };
        expr = res.expr;
      }

      // 用引擎解析一次，拿到真实自由变量表
      const parsed = await parseExpression(expr, Object.keys(constants));
      if (!parsed.ok) {
        return { error: (parsed as { ok: false; error: string }).error || '表达式无法解析' };
      }

      const allowed = new Set([varName, ...Object.keys(constants)]);
      const extra = parsed.result.variables.filter((v) => !allowed.has(v));
      if (extra.length > 0) {
        return { error: `含其他未定变量（${extra.join(', ')}），无法以 ${varName} 为自变量绘图` };
      }
      if (!parsed.result.variables.includes(varName)) {
        return { error: `不含自变量 ${varName}，无法绘制` };
      }
      return { expr };
    },
    [run.canvas?.nodes, spec, constants, scope],
  );

  /** 勾选变化 → 按需解析新候选（已缓存的直接复用） */
  useEffect(() => {
    if (!open || !selectedVar || checkedScope !== scope) { setBusy(false); return; }
    const need = candidates.filter((c) => checked.has(c.id) && !currentResolution(c));
    if (need.length === 0) { setBusy(false); return; }
    let cancelled = false;

    setBusy(true);
    setError(null);
    void (async () => {
      const updates: Record<string, Resolution> = {};
      for (const c of need) {
        if (cancelled) return;
        const key = resolutionKey(c);
        let promise = pendingRef.current.get(key);
        if (!promise) {
          promise = resolveCandidate(c, selectedVar)
            .then((r) => 'expr' in r ? { key, expr: r.expr } : { key, expr: '', error: r.error })
            .catch((failure) => ({ key, expr: '', error: (failure as Error)?.message || '公式转译失败，请重试' }));
          pendingRef.current.set(key, promise);
          const pending = promise;
          void promise.then(() => { if (pendingRef.current.get(key) === pending) pendingRef.current.delete(key); });
        }
        updates[c.id] = await promise;
      }
      if (cancelled || !aliveRef.current) return;
      setResolved((prev) => ({ ...prev, ...updates }));
      setBusy(false);
    })();
    return () => { cancelled = true; };
    // resolved 故意不入依赖：仅按「缺哪些」触发，避免自激
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, checkedScope, open, selectedVar, candidates, resolveCandidate, computeKey, retry]);

  /** 选中的有效曲线 */
  const series = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    if (checkedScope !== scope) return out;
    let i = 0;
    candidates.forEach((c) => {
      if (!checked.has(c.id)) return;
      const r = currentResolution(c);
      if (!r?.expr) return;
      out.push({
        id: c.id,
        label: c.label,
        expr: r.expr,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      });
      i += 1;
    });
    return out;
  }, [candidates, checked, checkedScope, resolved, selectedVar, scope, computeKey]);
  const intersectionKey = JSON.stringify([scope, series.map((s) => [s.id, s.expr]), selectedVar, range, constants]);
  const intersections = intersectionData.key === intersectionKey ? intersectionData.points : [];

  /** 选中 ≥2 条时计算交点（以第一条为基准，与其余各条求交） */
  useEffect(() => {
    setIntersectionData({key: '', points: []}); setIntersectionError(null);
    if (!open || series.length < 2 || !selectedVar) {
      setFindingIntersections(false);
      return;
    }
    let cancelled = false;
    setFindingIntersections(true);
    void (async () => {
      try {
        const base = series[0];
        const found: ChartIntersection[] = [];
        for (let i = 1; i < series.length; i += 1) {
          const res = await solveIntersections(base.expr, series[i].expr, selectedVar, range, constants);
          if (cancelled) return;
          if (!res.ok) throw new Error((res as {error: string}).error || '交点计算失败');
          res.result.points.forEach((p) =>
            found.push({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) }),
          );
        }
        if (!cancelled) setIntersectionData({key: intersectionKey, points: found});
      } catch (failure) {
        if (!cancelled) setIntersectionError((failure as Error)?.message || '交点计算失败，请重试');
      } finally {
        if (!cancelled) setFindingIntersections(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // series 每次渲染都是新数组，用 key 串做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(series.map((s) => [s.id, s.expr])), selectedVar, range[0], range[1], JSON.stringify(constants), scope, intersectionRetry]);

  if (!compute || candidates.length === 0 || variables.length === 0) {
    return (
      <div className="scene-s4-curve-empty">
        <Calculator className="w-3.5 h-3.5" />
        暂无可用于绘图的公式（需要写出公式，且场景声明了自变量）
      </div>
    );
  }

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="scene-s4-curve">
      <button
        type="button"
        className="scene-s4-solution-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <LineChart className="w-3.5 h-3.5" />
        <span className="scene-s4-solution-title">结果曲线</span>
        <span className="scene-s4-solution-progress">
          {open ? '收起' : checked.size > 0 ? `已选 ${checked.size} 条` : '展开'}
        </span>
      </button>

      {open && (
        <div className="scene-s4-curve-body">
          {/* 自变量选择：多曲线必须共用同一自变量，故显式让用户确认 */}
          {variables.length > 1 && (
            <div className="scene-s4-curve-var">
              <span className="scene-s4-curve-var-label">自变量</span>
              <select
                aria-label="曲线自变量"
                className="scene-s4-curve-var-select"
                value={selectedVar}
                onChange={(e) => {
                  setSelectedVar(e.target.value);
                  // 自变量变了，之前的解析结论失效，清空重算
                  setResolved({});
                }}
              >
                {variables.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 候选清单：多选 */}
          <div className="scene-s4-curve-list">
            {candidates.map((c, idx) => {
              const r = currentResolution(c);
              const color = SERIES_COLORS[
                series.findIndex((s) => s.id === c.id) >= 0
                  ? series.findIndex((s) => s.id === c.id)
                  : idx % SERIES_COLORS.length
              ];
              return (
                <label
                  key={c.id}
                  className={`scene-s4-curve-item${r?.error ? ' is-error' : ''}`}
                  title={r?.error || c.source}
                >
                  <input
                    type="checkbox"
                    aria-label={c.label}
                    checked={checked.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span
                    className="scene-s4-curve-dot"
                    style={{ background: checked.has(c.id) ? color : 'transparent' }}
                  />
                  <span className="scene-s4-curve-label">
                    {c.label}
                    {c.isAnswer && <span className="scene-s4-curve-tag">参考答案</span>}
                  </span>
                  {r?.error && <span className="scene-s4-curve-reason">{r.error}</span>}
                </label>
              );
            })}
          </div>

          {busy && (
            <div className="scene-s4-curve-busy" role="status">
              <Loader2 className="w-3 h-3 animate-spin" />
              正在转译公式…
            </div>
          )}
          {candidates.some((c) => checked.has(c.id) && currentResolution(c)?.error) && (
            <button type="button" className="scene-s4-btn-ghost" disabled={busy} onClick={() => {
              setResolved((prev) => Object.fromEntries(Object.entries(prev).filter(([, value]) => !value.error)));
              setRetry((value) => value + 1);
            }}>重试所选公式</button>
          )}
          {findingIntersections && <div className="scene-s4-curve-busy" role="status">正在计算交点…</div>}
          {intersectionError && <div className="scene-s4-curve-error" role="alert">
            <CircleAlert className="w-3 h-3" /><span>{intersectionError}</span>
            <button type="button" className="scene-s4-btn-ghost" onClick={() => setIntersectionRetry((value) => value + 1)}>重试交点</button>
          </div>}
          {error && (
            <div className="scene-s4-curve-error" role="alert">
              <CircleAlert className="w-3 h-3" />
              {error}
            </div>
          )}

          {/* 图表 */}
          {series.length > 0 ? (
            <ChartView
              series={series}
              variable={selectedVar}
              range={range}
              constants={constants}
              height={height}
              intersections={intersections}
            />
          ) : (
            <p className="scene-s4-curve-hint">勾选上方公式即可绘制曲线；勾选两条可自动标注交点。</p>
          )}
        </div>
      )}
    </div>
  );
};

export default CurvePanel;
