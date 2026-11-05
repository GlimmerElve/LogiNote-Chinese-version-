import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CalendarDays,
  Flame,
  Gauge,
  Quote,
  Sparkles,
  Target,
  TrendingDown,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import type { NoteItem } from '../types';
import { buildHomeViewModel, type HomeViewModel } from '../services/homepage/homepageViewModel';
import { masteryReadMode } from '../services/masteryReadModel';
import { aggregateLearningAbility } from '../services/learningAbility/aggregator';
import { getUserProfile } from '../services/profile/profileStore';
import { loadProfileOverviewData, type ProfileOverviewData } from '../services/profile/overviewRead';
import { selectProfileStyle, selectProfileWeekWords, profileErrorDelta, profileRecordDate, type ProfileStyleView } from '../services/profile/overviewModel';
import { useLocalCalendarDate } from './useLocalCalendarDate';
import { EXPRESSION_KINDS, EXPRESSION_STYLE_LABELS } from '../services/profile/styleScoring';
import { latestFlowProfileObservation } from '../services/profile/evidenceModel';

interface ProfileOverviewViewProps {
  notes: NoteItem[];
  onBack: () => void;
  onOpenEvidence: () => void;
}

const RADAR_CENTER = 128;
const RADAR_RADIUS = 78;

function radarPoint(index: number, total: number, radius: number): [number, number] {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / total;
  return [RADAR_CENTER + radius * Math.cos(angle), RADAR_CENTER + radius * Math.sin(angle)];
}

function polygonPoints(values: number[], maxValue = 100): string {
  return values
    .map((value, index) => radarPoint(index, values.length, RADAR_RADIUS * Math.max(0, Math.min(maxValue, value)) / maxValue).join(','))
    .join(' ');
}

const Radar: React.FC<{ labels: string[]; values: number[]; maxValue?: number }> = ({ labels, values, maxValue = 100 }) => (
  <div className="profile-overview-radar">
    <svg viewBox="-32 -18 320 292" role="img" aria-label={labels.map((label, index) => `${label} ${Math.round(values[index] || 0)}`).join('，')}>
      {[0.33, 0.66, 1].map((scale) => (
        <polygon key={scale} points={polygonPoints(labels.map(() => maxValue * scale), maxValue)} className="profile-overview-radar-ring" />
      ))}
      {labels.map((label, index) => {
        const [x, y] = radarPoint(index, labels.length, RADAR_RADIUS);
        const [labelX, labelY] = radarPoint(index, labels.length, RADAR_RADIUS + 29);
        return (
          <g key={label}>
            <line x1={RADAR_CENTER} y1={RADAR_CENTER} x2={x} y2={y} className="profile-overview-radar-axis" />
            <text x={labelX} y={labelY} textAnchor={labelX < 104 ? 'end' : labelX > 152 ? 'start' : 'middle'} dominantBaseline="middle">
              {label}
            </text>
          </g>
        );
      })}
      <polygon points={polygonPoints(values, maxValue)} className="profile-overview-radar-data" />
      {values.map((value, index) => {
        const [x, y] = radarPoint(index, values.length, RADAR_RADIUS * Math.max(0, Math.min(maxValue, value)) / maxValue);
        return <circle key={`${index}-${value}`} cx={x} cy={y} r="3.5" className="profile-overview-radar-dot" />;
      })}
    </svg>
  </div>
);

const LearningCalendar: React.FC<{ vm: HomeViewModel }> = ({ vm }) => {
  const start = (new Date(vm.calYear, vm.calMonth - 1, 1).getDay() + 6) % 7;
  const level = (minutes: number) => minutes >= 60 ? 4 : minutes >= 40 ? 3 : minutes >= 20 ? 2 : minutes > 0 ? 1 : 0;
  return (
    <div className="profile-overview-calendar">
      {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span className="profile-overview-weekday" key={day}>{day}</span>)}
      {Array.from({ length: start }).map((_, index) => <span key={`empty-${index}`} />)}
      {vm.calendar.map((day) => (
        <span
          key={day.day}
          className={`profile-overview-day level-${level(day.minutes)}${day.isToday ? ' is-today' : ''}${day.isFuture ? ' is-future' : ''}`}
          title={`${day.day} 日 · ${day.minutes} 分钟`}
        >
          {day.day}
        </span>
      ))}
    </div>
  );
};

const ErrorTrend: React.FC<{ values: number[]; weeks: number }> = ({ values, weeks }) => {
  if (values.length < 4) {
    return <div className="profile-overview-empty"><TrendingDown /><strong>趋势正在生长</strong><span>已积累 {weeks} / 4 个有效周，完成更多复盘后显示。</span></div>;
  }
  const width = 420;
  const height = 136;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.2);
  const points = values.map((value, index) => {
    const x = 18 + index * (width - 36) / Math.max(1, values.length - 1);
    const y = 18 + (max - value) * (height - 42) / range;
    return { x, y, value };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const current = values.at(-1) ?? 0;
  const delta = profileErrorDelta(values);
  return (
    <div className="profile-overview-trend">
      <div><strong>{current.toFixed(1)}</strong><span>次 / 结论</span><em className={delta < 0 ? 'is-good' : delta > 0 ? 'is-alert' : ''}>{delta < 0 ? '↓' : delta > 0 ? '↑' : '→'} {Math.abs(delta).toFixed(1)}</em></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="近期错误率趋势">
        {[28, 68, 108].map((y) => <line key={y} x1="18" y1={y} x2={width - 18} y2={y} className="profile-overview-trend-grid" />)}
        <polyline points={`${points[0].x},${height - 18} ${line} ${points.at(-1)?.x},${height - 18}`} className="profile-overview-trend-area" />
        <polyline points={line} className="profile-overview-trend-line" />
        {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="4" className={index === points.length - 1 ? 'is-last' : ''} />)}
      </svg>
    </div>
  );
};

const CognitiveStyle: React.FC<{ vm: HomeViewModel }> = ({ vm }) => (
  <div className="profile-overview-bipolar">
    {vm.bipolar.map((axis) => (
      <div className="profile-overview-axis" key={`${axis.left}-${axis.right}`}>
        <div><span>{axis.left}</span><span>{axis.right}</span></div>
        <div className="profile-overview-axis-track"><i /><b style={{ left: `${(axis.value + 100) / 2}%` }} /></div>
      </div>
    ))}
  </div>
);

const ExpressionStyleBars: React.FC<{ values: number[]; source: 'trusted' | 'observation' }> = ({ values, source }) => {
  const rows = EXPRESSION_KINDS.map((kind, index) => ({
    kind,
    label: EXPRESSION_STYLE_LABELS[kind],
    value: Math.max(0, Math.min(100, values[index] || 0)),
  }));
  const dominant = rows.reduce((best, row) => row.value > best.value ? row : best, rows[0]);
  return (
    <div className="profile-overview-expression-chart" role="group" aria-label={`${source === 'trusted' ? '长期表达风格' : '本次表达观察'}五维占比`}>
      <div className="profile-overview-expression-lead">
        <span>{source === 'trusted' ? '长期主导风格' : '本次最明显倾向'}</span>
        <strong>{dominant.label}</strong>
        <small>{dominant.value.toFixed(1)}%</small>
      </div>
      <div className="profile-overview-expression-bars">
        {rows.map((row) => (
          <div className={`profile-overview-expression-row${row.kind === dominant.kind ? ' is-dominant' : ''}`} key={row.kind}>
            <div><span>{row.label}</span><strong>{row.value.toFixed(1)}%</strong></div>
            <i
              role="progressbar"
              aria-label={row.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Number(row.value.toFixed(1))}
            >
              <b style={{ width: `${row.value}%` }} />
            </i>
          </div>
        ))}
      </div>
    </div>
  );
};

const ReadFailure: React.FC<{ label: string }> = ({ label }) => (
  <div className="profile-overview-empty is-error"><AlertCircle aria-hidden="true" /><strong>{label}读取失败</strong><span>可使用上方的重新读取按钮重试，原记录未改动。</span></div>
);

export const ProfileOverviewView: React.FC<ProfileOverviewViewProps> = ({ notes, onBack, onOpenEvidence }) => {
  const [data, setData] = useState<ProfileOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [styleView, setStyleView] = useState<ProfileStyleView>('current');
  const pending = useRef(true);
  const retryOrigin = useRef<HTMLButtonElement | null>(null);
  const today = useLocalCalendarDate();

  useEffect(() => {
    let cancelled = false;
    pending.current = true;
    setLoading(true);
    (async () => {
      let next: ProfileOverviewData;
      try { next = await loadProfileOverviewData(); }
      catch { next = { timeline: { ok: false, value: null }, snapshot: { ok: false, value: null },
        trend: { ok: false, value: null }, cloud: { ok: false, value: null } }; }
      if (cancelled) return;
      setData(next);
      pending.current = false;
      setLoading(false);
      const origin = retryOrigin.current;
      retryOrigin.current = null;
      if (origin?.isConnected) window.requestAnimationFrame(() => {
        if (!cancelled && origin.isConnected && document.activeElement === document.body) origin.focus({ preventScroll: true });
      });
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  const vm = useMemo(() => {
    if (!data) return null;
    try {
      const timeline = data.timeline.value || { version: 1 as const, weeks: [] };
      if (data.profile?.ok === false) return null;
      const profile = data.profile?.value || getUserProfile();
      // Derive fresh counters without settling weeks, mutating the profile cache or saving files.
      return buildHomeViewModel(notes, { ...profile, learningAbility: aggregateLearningAbility(notes, timeline) }, timeline, today);
    } catch { return null; }
  }, [notes, data, today]);
  const profile = data?.profile?.ok ? data.profile.value : undefined;
  const latestObservation = profile ? latestFlowProfileObservation(profile) : null;
  const expression = data ? selectProfileStyle(data.snapshot.value, data.trend.value, styleView, today, profile || undefined) : null;
  const usesFlowStyle = Object.values(profile?.evidenceGate?.aggregates || {}).some(a =>
    a.dimension === 'expression_style' && a.rubricVersion?.startsWith('flow-evidence-rubric-'));
  const words = selectProfileWeekWords(data?.cloud.value || null, today);
  const failures = data ? [!data.timeline.ok && '学习周报', data.statistics?.ok === false && '新版复盘统计', !data.snapshot.ok && !usesFlowStyle && '当前表达',
    !data.trend.ok && '历史表达', !data.cloud.ok && '本周词云', !vm && '学习统计'].filter(Boolean) : [];
  const expressionFailed = data && (styleView === 'current' ? !usesFlowStyle && !data.snapshot.ok : !data.trend.ok);

  const abilityValues = vm ? [vm.layeredAbility.concept, vm.layeredAbility.judgment, vm.layeredAbility.reasoning] : [];
  const hasCompleteAbility = abilityValues.length === 3 && abilityValues.every(value => value !== null);
  const expressionValues = EXPRESSION_KINDS.map((kind) => expression?.display[kind] ?? 0);
  const observedExpressionRows = latestObservation?.rows.filter(row => row.dimension === 'expression_style') || [];
  const observedExpressionValues = EXPRESSION_KINDS.map((kind) =>
    observedExpressionRows.find(row => row.indicator === kind)?.value ?? 0);
  const hasObservedExpression = observedExpressionRows.length > 0;

  return (
    <main className="home-page profile-overview-page">
      <header className="profile-overview-hero">
        <button type="button" className="profile-evidence-back" onClick={onBack}><ArrowLeft />返回首页</button>
        <div>
          <span>LEARNING PROFILE</span>
          <h1>学习画像</h1>
          <p>从心流复盘、苏格拉底式复习与场景训练中，长期观察你如何理解、判断与推理。</p>
        </div>
        <button type="button" className="profile-overview-evidence-action" onClick={onOpenEvidence}>查看画像证据<ArrowRight />
        </button>
      </header>

      <div className="profile-overview-read-status">
        <span role={failures.length && !loading ? 'alert' : 'status'} aria-live={failures.length && !loading ? 'assertive' : 'polite'}>
          {loading ? '正在读取学习画像…' : failures.length ? `${failures.join('、')}读取失败；已读取的内容仍可查看。` : '已读取学习画像'}
        </span>
        <button type="button" disabled={loading} onClick={(event) => {
          if (pending.current) return;
          pending.current = true;
          retryOrigin.current = event.currentTarget;
          setLoading(true);
          setAttempt(value => value + 1);
        }}><RefreshCw aria-hidden="true" />{loading ? '读取中…' : '重新读取'}</button>
      </div>
      {!data && <div className="profile-overview-empty"><RefreshCw aria-hidden="true" /><strong>正在整理长期学习轨迹…</strong></div>}
      {latestObservation && <div className="profile-overview-read-status" role="status" aria-live="polite">
        <span>最近复盘已记录 {latestObservation.rows.length} 项观察，其中 {latestObservation.holding} 项仍在积累证据；长期画像不等于本次得分。</span>
      </div>}
      {data && !vm && <ReadFailure label="学习统计" />}
      {vm && <>
      <section className="profile-overview-kpis" aria-label="学习画像摘要">
        <article><Flame /><span>连续学习</span><strong>{data?.timeline.ok ? vm.streak : '—'}<small>天</small></strong></article>
        <article><CalendarDays /><span>本月活跃</span><strong>{data?.timeline.ok ? vm.activeDaysThisMonth : '—'}<small>天</small></strong></article>
        <article><Gauge /><span>日均学习</span><strong>{data?.timeline.ok ? vm.avgDailyMinutes : '—'}<small>分钟</small></strong></article>
        <article><Target /><span>{masteryReadMode() === 'current' ? '已确认知识点' : '历史已掌握知识点'}</span><strong>{vm.masteredCount}<small>个</small></strong></article>
      </section>

      <section className="profile-overview-grid">
        <article className="profile-overview-card profile-overview-card-ability">
          <div className="profile-overview-card-head"><span><BrainCircuit />三层能力</span><small>{vm.abilityEvidenceStatus === 'empty' ? '暂无分析' : vm.abilityEvidenceStatus === 'collecting' ? '证据积累中' : '当前聚合值'}</small></div>
          <div className="profile-overview-ability">
            {hasCompleteAbility ? <Radar labels={['概念', '判断', '推理']} values={abilityValues as number[]} />
              : <p className="profile-overview-empty" role="status">{vm.abilityEvidenceStatus === 'empty' ? '暂无能力分析记录。完成学习复盘后，这里会逐步积累观察。' : '部分能力维度仍在积累证据，暂不绘制完整雷达图。'}</p>}
            <div className="profile-overview-ability-list">
              {['概念清晰度', '判断合理性', '推理有效性'].map((label, index) => (
                <div key={label}><span>{label}</span><strong>{abilityValues[index] === null ? '—' : Math.round(abilityValues[index])}</strong><i aria-hidden="true"><b style={{ width: `${abilityValues[index] === null ? 0 : Math.max(0, Math.min(100, abilityValues[index]))}%` }} /></i></div>
              ))}
            </div>
          </div>
        </article>

        <article className="profile-overview-card profile-overview-card-calendar">
          <div className="profile-overview-card-head"><span><CalendarDays />学习足迹</span><small>{vm.calYear} 年 {vm.calMonth} 月</small></div>
          {data?.timeline.ok ? <LearningCalendar vm={vm} /> : <ReadFailure label="学习足迹" />}
        </article>

        <article className="profile-overview-card profile-overview-card-trend">
          <div className="profile-overview-card-head"><span><TrendingDown />错误趋势</span><small>{data?.timeline.value?.flowAnalysis ? '新版量规 · 近 10 周' : '近 10 周'}</small></div>
          {data?.timeline.ok && data.statistics?.ok !== false ? <ErrorTrend values={vm.errorWeekly} weeks={vm.errorTrendWeeks} /> : <ReadFailure label="错误趋势" />}
        </article>

        <article className="profile-overview-card profile-overview-card-cognitive">
          <div className="profile-overview-card-head"><span><Sparkles />认知风格</span><small>长期倾向</small></div>
          <CognitiveStyle vm={vm} />
        </article>

        <article className="profile-overview-card profile-overview-card-expression">
          <div className="profile-overview-card-head">
            <span><BrainCircuit />表达风格</span>
            <div className="profile-overview-toggle" role="group" aria-label="表达风格记录时段">
              {([['current', '当前'], ['d30', '30 天前'], ['d90', '90 天前']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={styleView === value} className={styleView === value ? 'is-active' : ''} onClick={() => setStyleView(value)}>{label}</button>
              ))}
            </div>
          </div>
          {expressionFailed ? <ReadFailure label={styleView === 'current' ? '当前表达' : '历史表达'} /> : expression ? (
            <div className="profile-overview-expression">
              <ExpressionStyleBars values={expressionValues} source="trusted" />
              <div className="profile-overview-expression-note"><span>长期画像</span><strong>{expression.conclusion || '表达风格正在形成'}</strong><small className="profile-overview-record-date">记录日期 · {profileRecordDate(expression.date)}</small><p>这是从你的口语复盘中统计出的表达倾向，不是人格标签。</p></div>
            </div>
          ) : styleView === 'current' && hasObservedExpression ? <div className="profile-overview-expression is-observation">
            <ExpressionStyleBars values={observedExpressionValues} source="observation" />
            <div className="profile-overview-expression-note"><span>本次观察 · 尚未采信</span><strong>长期表达风格仍在积累</strong><p>这些数值只代表最近一次复盘。同量规的多次证据达标后，才会更新长期画像。</p></div>
          </div> : <div className="profile-overview-empty"><BrainCircuit /><strong>{styleView === 'current' ? '长期表达风格仍在积累' : '该时段暂无历史记录'}</strong><span>{styleView === 'current' ? '完成更多口语复盘后，这里会生成五维表达风格图。' : '仅显示该时点或更早的最近记录，不使用当前数据替代。'}</span></div>}
        </article>

        <article className="profile-overview-card profile-overview-card-words">
          <div className="profile-overview-card-head"><span><Quote />高频表达</span><small>本周</small></div>
          {!data?.cloud.ok ? <ReadFailure label="本周词云" /> : words.length > 0 ? (
            <div className="profile-overview-wordcloud">{words.map((word) => <span key={word.word} style={{ fontSize: `${12 + Math.min(word.count, 8) * 1.7}px` }}>{word.word}</span>)}</div>
          ) : <div className="profile-overview-empty"><Quote /><strong>词汇样本不足</strong><span>复盘后会在这里呈现本周常用表达。</span></div>}
        </article>
      </section>
      </>}
    </main>
  );
};
