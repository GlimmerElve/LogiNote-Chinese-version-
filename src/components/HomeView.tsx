import React, { useEffect, useState } from 'react';
import { ArrowRight, Circle, Target } from 'lucide-react';
import { NoteItem, StyleSnapshotFile, StyleTrendFile, ExpressionStyleKind } from '../types';
import { getUserProfile } from '../services/profile/profileStore';
import { loadMasteryTimeline } from '../services/learningAbility/timelineStore';
import { refreshLearningAbility } from '../services/learningAbility/refresh';
import { buildHomeViewModel, HomeViewModel } from '../services/homepage/homepageViewModel';
import { readSnapshot, readTrend, readWordCloud } from '../services/profile/styleStore';
import { EXPRESSION_KINDS, EXPRESSION_STYLE_LABELS } from '../services/profile/styleScoring';

/**
 * 主页（记忆监护仪仪表盘）。
 * 只读展示：挂载时刷新学习能力 + 读取周报 + 取画像，聚合为 viewModel 渲染。
 * 配色固定绿色系，忠实复刻 monitor-v10 原型，不随全局 accentColor 变化。
 */

interface HomeViewProps {
  notes: NoteItem[];
  onOpenTodo: (noteId: string) => void;
  onToggleTodo: (noteId: string, taskId: string) => void;
}

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

/** 三层能力雷达 */
const RadarChart: React.FC<{ vm: HomeViewModel }> = ({ vm }) => {
  const axes: { label: string; short: string; value: number }[] = [
    { label: '概念清晰度', short: '概念', value: vm.layeredAbility.concept },
    { label: '判断合理性', short: '判断', value: vm.layeredAbility.judgment },
    { label: '推理有效性', short: '推理', value: vm.layeredAbility.reasoning },
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
      return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="15" fill="#4a4133" font-weight="700">${a.short}</text>`;
    })
    .join('');

  return (
    <div className="home-radar-wrap">
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
        <div className="home-radar-tip-title">三层能力</div>
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
const ErrorLineChart: React.FC<{
  series: number[];
  collectedWeeks: number;
}> = ({ series, collectedWeeks }) => {
  if (series.length < 4) {
    return (
      <div className="home-chart-empty" role="status">
        <strong>趋势数据准备中</strong>
        <span>已积累 {collectedWeeks} / 4 个有效周数据</span>
        <span>趋势会在积累 4 周复盘数据后显示。</span>
      </div>
    );
  }

  const W = 300;
  const H = 70;
  const PL = 8;
  const PR = 8;
  const PT = 8;
  const PB = 14;
  const base = H - PB;
  // 动态刻度：按 series 实际 min/max，上下各留 10% padding；范围过小或全相等时兜底
  const dataMin = Math.min(...series);
  const dataMax = Math.max(...series);
  const rawRange = dataMax - dataMin;
  const pad = rawRange > 0 ? rawRange * 0.1 : Math.max(Math.abs(dataMax) * 0.1, 0.1);
  let min = dataMin - pad;
  let max = dataMax + pad;
  if (max - min < 0.2) {
    const mid = (min + max) / 2;
    min = mid - 0.1;
    max = mid + 0.1;
  }

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
          <span className="home-err-unit"> 次/结论</span>
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

/** 表达风格（五轴雷达 + 历史对比切换） */
const StyleRadar: React.FC<{ view: 'current' | 'd30' | 'd90' }> = ({ view }) => {
  const [snapshot, setSnapshot] = useState<StyleSnapshotFile | null>(null);
  const [trend, setTrend] = useState<StyleTrendFile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snap = await readSnapshot();
      const tr = await readTrend();
      if (cancelled) return;
      setSnapshot(snap);
      setTrend(tr);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!snapshot) {
    return (
      <div className="home-chart-empty" role="status">
        <strong>表达风格数据准备中</strong>
        <span>完成一次复盘分析后生成五轴风格画像。</span>
      </div>
    );
  }

  /** 选择展示数据：当前用 display；历史从 trend 找最接近目标日期的快照 */
  const pickDisplay = (): Record<ExpressionStyleKind, number> => {
    if (view === 'current') return snapshot.display;
    const days = view === 'd30' ? 30 : 90;
    const target = new Date();
    target.setDate(target.getDate() - days);
    const ts = target.getTime();
    const snaps = (trend?.snapshots || []).slice();
    if (snaps.length === 0) return snapshot.display;
    snaps.sort((a, b) => Math.abs(new Date(a.date).getTime() - ts) - Math.abs(new Date(b.date).getTime() - ts));
    return snaps[0].display;
  };

  const display = pickDisplay();
  const axes = EXPRESSION_KINDS.map((k) => ({
    key: k,
    label: EXPRESSION_STYLE_LABELS[k],
    value: display[k] || 0,
  }));
  const n = axes.length;
  const maxRadius = RADAR_R;
  const dataPts = axes
    .map((a, i) => radarPoint(i, n, maxRadius * Math.max(0, Math.min(100, a.value)) / 100))
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
      const lx = RADAR_CX + (maxRadius + 32) * cos;
      const ly = RADAR_CY + (maxRadius + 32) * Math.sin(angle);
      let anchor = 'middle';
      if (cos < -0.35) anchor = 'end';
      else if (cos > 0.35) anchor = 'start';
      return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="13" fill="#4a4133" font-weight="700">${a.label}</text>`;
    })
    .join('');

  return (
    <div className="home-radar-wrap">
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
        <div className="home-radar-tip-title">{view === 'current' ? '当前画像' : `${view === 'd30' ? '30' : '90'} 天前镜像`}</div>
        {axes.map((a) => (
          <div className="home-radar-tip-row" key={a.key}>
            <span className="k">{a.label}</span>
            <span className="v">{Math.round(a.value)}</span>
          </div>
        ))}
      </div>
      {snapshot.conclusion && (
        <div className="home-radar-tip" style={{ marginTop: 8 }}>
          <div className="home-radar-tip-title">判定</div>
          <div className="home-radar-tip-row"><span className="k">{snapshot.conclusion}</span></div>
        </div>
      )}
    </div>
  );
};

/** 常用表达词（词云，独立卡片） */
const WordCloudCard: React.FC = () => {
  const [words, setWords] = useState<Array<{ word: string; count: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wc = await readWordCloud();
      if (cancelled) return;
      const currentWeek = wc.weeks.length > 0 ? wc.weeks[wc.weeks.length - 1].words : [];
      setWords(currentWeek.slice(0, 16));
    })();
    return () => { cancelled = true; };
  }, []);

  if (words.length === 0) {
    return (
      <div className="home-chart-empty" role="status">
        <strong>词云数据准备中</strong>
        <span>完成一次复盘分析后生成高频表达词。</span>
      </div>
    );
  }

  return (
    <div className="home-wordcloud-standalone">
      {words.map((w) => (
        <span
          key={w.word}
          className="home-wordcloud-tag"
          style={{ fontSize: `${12 + Math.min(w.count, 8) * 2.4}px`, opacity: 0.55 + Math.min(w.count, 6) * 0.075 }}
        >
          {w.word}
        </span>
      ))}
    </div>
  );
};

/** 待办事项（纵向列表） */
const Todos: React.FC<{
  vm: HomeViewModel;
  onOpenTodo: (noteId: string) => void;
  onToggleTodo: (noteId: string, taskId: string) => void;
}> = ({ vm, onOpenTodo, onToggleTodo }) => {
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
          <div className="home-todo-row" key={t.taskId}>
            <button
              className="home-todo-check"
              type="button"
              onClick={() => onToggleTodo(t.noteId, t.taskId)}
              aria-label={`完成待办：${t.text}`}
              title="标记为完成"
            >
              <Circle aria-hidden="true" />
            </button>
            <span className={`home-todo-prio ${t.priority}`} />
            <span className={`home-todo-date ${t.date < today ? 'due' : ''}`}>{fmt(t.date)}</span>
            <button
              className="home-todo-text"
              type="button"
              onClick={() => onOpenTodo(t.noteId)}
              title={`打开笔记：${t.noteTitle}`}
            >
              {t.text}
            </button>
          </div>
        ))
      )}
    </div>
  );
};

const TodayFocus: React.FC<{ vm: HomeViewModel; onOpenTodo: (noteId: string) => void }> = ({ vm, onOpenTodo }) => {
  const nextTodo = vm.todos[0];
  const goalProgress = Math.min(100, Math.round((vm.todayMinutes / vm.dailyGoalMinutes) * 100));

  return (
    <section className="home-focus" aria-labelledby="home-focus-title">
      <div className="home-focus-copy">
        <span className="home-focus-eyebrow">今日学习</span>
        <h2 id="home-focus-title">
          {nextTodo ? nextTodo.text : '今天还没有安排学习任务'}
        </h2>
        <p>{nextTodo ? `来自「${nextTodo.noteTitle}」` : '新建一条学习计划，让今天的行动从这里开始。'}</p>
      </div>
      <div className="home-focus-goal" aria-label={`今日学习 ${vm.todayMinutes} 分钟，目标 ${vm.dailyGoalMinutes} 分钟`}>
        <span><Target aria-hidden="true" /> 今日进度</span>
        <strong>{vm.todayMinutes} <small>/ {vm.dailyGoalMinutes} 分钟</small></strong>
        <div className="home-focus-track" aria-hidden="true"><span style={{ width: `${goalProgress}%` }} /></div>
      </div>
      <button
        className="home-focus-action"
        type="button"
        disabled={!nextTodo}
        onClick={() => nextTodo && onOpenTodo(nextTodo.noteId)}
      >
        {nextTodo ? <>开始处理 <ArrowRight aria-hidden="true" /></> : <>创建计划 <ArrowRight aria-hidden="true" /></>}
      </button>
    </section>
  );
};

export const HomeView: React.FC<HomeViewProps> = ({ notes, onOpenTodo, onToggleTodo }) => {
  const [vm, setVm] = useState<HomeViewModel | null>(null);
  const [styleView, setStyleView] = useState<'current' | 'd30' | 'd90'>('current');

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
      <TodayFocus vm={vm} onOpenTodo={onOpenTodo} />
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
            <ErrorLineChart
              series={vm.errorWeekly}
              collectedWeeks={vm.errorTrendWeeks}
            />
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
            <div className="home-radar-toggle">
              <button className={styleView === 'current' ? 'on' : ''} onClick={() => setStyleView('current')} aria-pressed={styleView === 'current'}>当前</button>
              <button className={styleView === 'd30' ? 'on' : ''} onClick={() => setStyleView('d30')} aria-pressed={styleView === 'd30'}>30天前</button>
              <button className={styleView === 'd90' ? 'on' : ''} onClick={() => setStyleView('d90')} aria-pressed={styleView === 'd90'}>90天前</button>
            </div>
          </div>
          <div className="home-bay-body">
            <StyleRadar view={styleView} />
          </div>
        </section>


        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">常用表达词</span>
            <span className="home-bay-hint">本周</span>
          </div>
          <div className="home-bay-body">
            <WordCloudCard />
          </div>
        </section>

        <section className="home-bay">
          <div className="home-bay-head">
            <span className="home-tick" />
            <span className="home-bay-title">待办事项</span>
            <span className="home-bay-hint">{vm.todos.length} 项</span>
          </div>
          <div className="home-bay-body">
            <Todos vm={vm} onOpenTodo={onOpenTodo} onToggleTodo={onToggleTodo} />
          </div>
        </section>
      </section>
    </div>
  );
};
