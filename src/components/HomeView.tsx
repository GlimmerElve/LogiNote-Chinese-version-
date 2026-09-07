import React, { useEffect, useState } from 'react';
import { NoteItem } from '../types';
import { getUserProfile } from '../services/profile/profileStore';
import { loadMasteryTimeline } from '../services/learningAbility/timelineStore';
import { refreshLearningAbility } from '../services/learningAbility/refresh';
import { buildHomeViewModel, HomeViewModel } from '../services/homepage/homepageViewModel';

/**
 * 主页（记忆监护仪仪表盘）。
 * 只读展示：挂载时刷新学习能力 + 读取周报 + 取画像，聚合为 viewModel 渲染。
 * 配色固定绿色系，忠实复刻 monitor-v10 原型，不随全局 accentColor 变化。
 */

interface HomeViewProps {
  notes: NoteItem[];
}

/** 雷达图数据（三层能力 / 推理子项两种视图） */
type RadarKind = 'ability' | 'reasoning';

const RADAR_CX = 140;
const RADAR_CY = 140;
const RADAR_R = 82;

function radarPoint(index: number, total: number, radius: number): string {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total;
  const x = RADAR_CX + radius * Math.cos(angle);
  const y = RADAR_CY + radius * Math.sin(angle);
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function radarShape(axes: number[], radius: number): string {
  return axes.map((_, i) => radarPoint(i, axes.length, radius)).join(' ');
}

/** 三层能力雷达（含切换） */
const RadarChart: React.FC<{ vm: HomeViewModel }> = ({ vm }) => {
  const [kind, setKind] = useState<RadarKind>('ability');

  const axes: { label: string; short: string; value: number }[] =
    kind === 'ability'
      ? [
          { label: '概念清晰度', short: '概念', value: vm.layeredAbility.concept },
          { label: '判断合理性', short: '判断', value: vm.layeredAbility.judgment },
          { label: '推理有效性', short: '推理', value: vm.layeredAbility.reasoning },
        ]
      : [
          { label: '给出前提', short: '前提', value: vm.reasoningRates.premises },
          { label: '逻辑链完整', short: '链完整', value: vm.reasoningRates.completeChain },
          { label: '识别假设', short: '假设', value: vm.reasoningRates.assumption },
          { label: '演绎/归纳', short: '演绎归纳', value: vm.reasoningRates.deductiveInductive },
          { label: '反事实思考', short: '反事实', value: vm.reasoningRates.counterfactual },
        ];

  const n = axes.length;
  const maxRadius = RADAR_R;
  const dataPts = axes
    .map((a, i) =>
      radarPoint(i, n, maxRadius * Math.max(0, Math.min(100, a.value)) / 100),
    )
    .join(' ');

  const ringPolygons = [0.33, 0.66, 1]
    .map((k) => `<polygon points="${radarShape(Array(n).fill(k), maxRadius)}" fill="none" stroke="#ded5c6" />`)
    .join('');
  const axisLines = axes
    .map((_, i) => {
      const p = radarPoint(i, n, maxRadius).split(',');
      return `<line x1="${RADAR_CX}" y1="${RADAR_CY}" x2="${p[0]}" y2="${p[1]}" stroke="#ded5c6" />`;
    })
    .join('');
  const labels = axes
    .map((a, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const cos = Math.cos(angle);
      const lx = RADAR_CX + (maxRadius + 26) * cos;
      const ly = RADAR_CY + (maxRadius + 26) * Math.sin(angle);
      let anchor = 'middle';
      if (cos < -0.35) anchor = 'end';
      else if (cos > 0.35) anchor = 'start';
      return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="12" fill="#7a6f5f" font-weight="600">${a.short}</text>`;
    })
    .join('');

  return (
    <div className="home-radar-wrap">
      <div className="home-radar-toggle">
        <button className={kind === 'ability' ? 'on' : ''} onClick={() => setKind('ability')}>
          三层能力
        </button>
        <button className={kind === 'reasoning' ? 'on' : ''} onClick={() => setKind('reasoning')}>
          推理子项
        </button>
      </div>
      <svg
        className="home-radar-svg"
        viewBox="0 0 280 280"
        preserveAspectRatio="xMidYMid meet"
        dangerouslySetInnerHTML={{
          __html:
            ringPolygons +
            axisLines +
            `<polygon points="${dataPts}" fill="rgba(92,158,109,.28)" stroke="#3f7a50" stroke-width="2" stroke-linejoin="round" />` +
            labels,
        }}
      />
      <div className="home-radar-tip">
        <div className="home-radar-tip-title">{kind === 'ability' ? '三层能力' : '推理子项命中率'}</div>
        {axes.map((a) => (
          <div className="home-radar-tip-row" key={a.label}>
            <span className="k">{a.label}</span>
            <span className="v">{a.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** 错误率平滑折线（绿色主题 + 数据点 + 虚线网格） */
const ErrorLineChart: React.FC<{ series: number[] }> = ({ series }) => {
  const W = 300;
  const H = 70;
  const PL = 8;
  const PR = 8;
  const PT = 8;
  const PB = 14;
  const base = H - PB;
  const max = 2.4;
  const min = 0.4;

  const pts = series.map((v, i) => {
    const x = series.length > 1 ? PL + ((W - PL - PR) * i) / (series.length - 1) : PL;
    const y = H - PB - ((H - PT - PB) * (v - min)) / (max - min);
    return { x, y };
  });

  let line = '';
  pts.forEach((p, i) => {
    if (i === 0) {
      line += `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      return;
    }
    const prev = pts[i - 1];
    const c1x = prev.x + (p.x - prev.x) * 0.5;
    const c2x = p.x - (p.x - prev.x) * 0.5;
    line += ` C${c1x.toFixed(1)},${prev.y.toFixed(1)} ${c2x.toFixed(1)},${p.y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  });
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${base} L${pts[0].x.toFixed(1)},${base} Z`;
  const grid = [0, 0.5, 1]
    .map((k) => {
      const gy = PT + k * (base - PT);
      return `<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" stroke="#ded5c6" stroke-width="1" stroke-dasharray="3 3" />`;
    })
    .join('');
  const dots = pts
    .map(
      (p, i) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${i === series.length - 1 ? '#b8574a' : '#5c9e6d'}" stroke="#fff" stroke-width="1.5" />`,
    )
    .join('');

  const cur = series.length > 0 ? series[series.length - 1] : 0;
  const prev = series.length > 1 ? series[series.length - 2] : cur;
  const delta = cur - prev;

  return (
    <div className="home-err-wrap">
      <div className="home-err-meta">
        <span className="home-err-cur">
          {cur.toFixed(1)}
          <span className="home-err-unit"> 次/析</span>
        </span>
        <span className="home-err-delta">
          {delta <= 0 ? '▼' : '▲'} {delta.toFixed(1)}
        </span>
      </div>
      <svg
        className="home-err-chart"
        viewBox="0 0 300 70"
        preserveAspectRatio="none"
        dangerouslySetInnerHTML={{
          __html:
            `<defs><linearGradient id="home-errgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(92,158,109,.30)" /><stop offset="1" stop-color="rgba(92,158,109,.02)" /></linearGradient></defs>` +
            grid +
            `<path d="${area}" fill="url(#home-errgrad)" />` +
            `<path d="${line}" fill="none" stroke="#3f7a50" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />` +
            dots,
        }}
      />
    </div>
  );
};

/** 当月日历热力图 */
const Calendar: React.FC<{ vm: HomeViewModel }> = ({ vm }) => {
  const firstDow = new Date(vm.calYear, vm.calMonth - 1, 1).getDay();
  const offset = (firstDow + 6) % 7; // 周一=0
  const dowLabels = ['一', '二', '三', '四', '五', '六', '日'];

  const level = (minutes: number) => {
    if (minutes <= 0) return '';
    if (minutes < 20) return 'lv-1';
    if (minutes < 40) return 'lv-2';
    if (minutes < 60) return 'lv-3';
    return 'lv-4';
  };

  return (
    <div className="home-cal-table">
      {dowLabels.map((d) => (
        <span className="home-cal-dow" key={d}>
          {d}
        </span>
      ))}
      {Array.from({ length: offset }).map((_, i) => (
        <div className="home-day-cell blank" key={`blank-${i}`} />
      ))}
      {vm.calendar.map((d) => {
        let cls = 'home-day-cell';
        if (d.isToday) cls += ' today';
        else if (d.isFuture) cls += ' future';
        else if (d.active) cls += ' ' + level(d.minutes);
        return (
          <div className={cls} key={d.day}>
            {d.day}
          </div>
        );
      })}
    </div>
  );
};

/** 双极认知风格（仅两端文字） */
const Bipolar: React.FC<{ vm: HomeViewModel }> = ({ vm }) => (
  <div className="home-bipolar">
    {vm.bipolar.map((a) => {
      const pct = (a.value + 100) / 2;
      return (
        <div className="home-axis" key={a.left + a.right}>
          <div className="home-axis-cap">
            <span className="left">{a.left}</span>
            <span className="right">{a.right}</span>
          </div>
          <div className="home-axis-track">
            <div className="mid" />
            <div className="needle" style={{ left: `${pct}%` }} />
          </div>
        </div>
      );
    })}
  </div>
);

/** 表达风格（横向颜色条） */
const Expression: React.FC<{ vm: HomeViewModel }> = ({ vm }) => (
  <div className="home-express">
    {vm.expression.map((e) => (
      <div className="home-expr-row" key={e.label}>
        <span className="home-expr-label">{e.label}</span>
        <span className="home-expr-bar">
          <span className="home-expr-fill" style={{ width: `${e.value}%` }} />
        </span>
        <span className="home-expr-num">{e.value}</span>
      </div>
    ))}
  </div>
);

/** 待办事项（纵向列表） */
const Todos: React.FC<{ vm: HomeViewModel }> = ({ vm }) => {
  const today = new Date().toISOString().slice(0, 10);
  const fmt = (date: string) => {
    const [, m, d] = date.split('-');
    return `${parseInt(m)}.${d.padStart(2, '0')}`;
  };
  return (
    <div className="home-todo-list">
      {vm.todos.length === 0 ? (
        <div className="home-todo-empty">暂无待办</div>
      ) : (
        vm.todos.map((t, i) => (
          <div className="home-todo-row" key={`${t.date}-${i}`}>
            <span className={`home-todo-prio ${t.priority}`} />
            <span className={`home-todo-date ${t.date < today ? 'due' : ''}`}>{fmt(t.date)}</span>
            <span className="home-todo-text">{t.text}</span>
          </div>
        ))
      )}
    </div>
  );
};

export const HomeView: React.FC<HomeViewProps> = ({ notes }) => {
  const [vm, setVm] = useState<HomeViewModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 兜底刷新：保证 learningAbility 反映最新的学习/掌握记录
      await refreshLearningAbility(notes).catch(() => {});
      const timeline = await loadMasteryTimeline();
      if (cancelled) return;
      const profile = getUserProfile();
      setVm(buildHomeViewModel(notes, profile, timeline));
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  if (!vm) {
    return <div className="home-loading">加载中…</div>;
  }

  return (
    <div className="home-page">
      {/* 核心指标 KPI */}
      <section className="home-kpi">
        <div className="home-kpi-card">
          <span className="home-kpi-label">连续学习</span>
          <span className="home-kpi-num">
            {vm.streak}
            <span className="home-kpi-unit"> 天</span>
          </span>
          <span className="home-kpi-trend">保持中</span>
        </div>
        <div className="home-kpi-card">
          <span className="home-kpi-label">本月活跃</span>
          <span className="home-kpi-num">
            {vm.activeDaysThisMonth}
            <span className="home-kpi-unit"> 天</span>
          </span>
          <span className="home-kpi-trend">按月更新</span>
        </div>
        <div className="home-kpi-card">
          <span className="home-kpi-label">日均学习</span>
          <span className="home-kpi-num">
            {vm.avgDailyMinutes}
            <span className="home-kpi-unit"> 分</span>
          </span>
          <span className="home-kpi-trend">较上月</span>
        </div>
        <div className="home-kpi-card">
          <span className="home-kpi-label">已掌握知识点</span>
          <span className="home-kpi-num">
            {vm.masteredCount}
            <span className="home-kpi-unit"> 个</span>
          </span>
          <span className="home-kpi-trend">本周 ＋{vm.newMasteredThisWeek}</span>
        </div>
        <div className="home-kpi-card">
          <span className="home-kpi-label">已完成根项目</span>
          <span className="home-kpi-num">
            {vm.completedProjects}
            <span className="home-kpi-unit"> 个</span>
          </span>
          <span className="home-kpi-trend">持续交付</span>
        </div>
      </section>

      {/* 主区三列 */}
      <main className="home-main">
        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">能力画像</span>
            <span className="home-bay-hint">悬停查看</span>
          </div>
          <div className="home-bay-body">
            <RadarChart vm={vm} />
          </div>
        </section>

        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">
              学习足迹 · {vm.calYear} 年 {vm.calMonth} 月
            </span>
          </div>
          <div className="home-bay-body">
            <Calendar vm={vm} />
          </div>
        </section>

        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">错误率 · 近 10 周</span>
          </div>
          <div className="home-bay-body">
            <ErrorLineChart series={vm.errorWeekly.length > 0 ? vm.errorWeekly : [0]} />
          </div>
        </section>
      </main>

      {/* 第二行三列 */}
      <section className="home-lower">
        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">双极认知风格</span>
          </div>
          <div className="home-bay-body">
            <Bipolar vm={vm} />
          </div>
        </section>

        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">表达风格</span>
          </div>
          <div className="home-bay-body">
            <Expression vm={vm} />
          </div>
        </section>

        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">待办事项</span>
            <span className="home-bay-hint">{vm.todos.length} 项</span>
          </div>
          <div className="home-bay-body">
            <Todos vm={vm} />
          </div>
        </section>
      </section>
    </div>
  );
};