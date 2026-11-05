import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Clock3, FileSearch, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ProfileEvidenceDetail, ProfileEvidenceSampleDetail } from '../services/profile/evidenceModel';
import { loadProfileEvidenceData } from '../services/profile/evidenceRead';
import type { NoteItem } from '../types';
import { useLocalCalendarDate } from './useLocalCalendarDate';
import type { LearningEpisodeType } from '../services/memory/types';
import {
  listLatestMemoryContextTraces,
  type MemoryContextTrace,
} from '../services/memory/memoryContextBuilder';
import {
  type HabitConfidenceStatus,
  type LearningHabitProfile,
} from '../services/memory/learningHabitAggregator';
import { PersonalCognitionLauncher } from './PersonalCognitionLauncher';

interface Props {
  onBack: () => void;
  notes: NoteItem[];
  onOpenNote?: (noteId: string) => void;
}

const DIMENSION_LABELS: Record<ProfileEvidenceDetail['dimension'], string> = {
  ability: '三层能力',
  cognitive_style: '认知风格',
  expression_style: '表达风格',
};

const INDICATOR_LABELS: Record<string, string> = {
  conceptClarity: '概念清晰度',
  judgmentReasonableness: '判断合理性',
  reasoningValidity: '推理有效性',
  abstractVsConcrete: '抽象—具体',
  systematicVsScattered: '系统—零散',
  divergentVsConvergent: '发散—收敛',
  cautiousVsDogmatic: '审慎—武断',
  deepVsSurface: '深入—表层',
  clarityScore: '表达清晰度',
  academic: '学术建构型',
  critical: '逻辑批判型',
  practical: '实用行动型',
  divergent: '发散探索型',
  objective: '客观陈述型',
};

const EPISODE_LABELS: Record<LearningEpisodeType, string> = {
  flow: '心流复盘',
  review: '苏格拉底复习',
  scene: '场景模拟',
  qa: '问题答疑',
  plan: '学习计划',
};

const WORKFLOW_LABELS: Record<string, string> = {
  'agent-chat': 'Agent 学习助手',
  'plan-generation': '学习计划生成',
  'question-answer': '问题答疑',
  'review-tutor': '苏格拉底复习',
  'scene-generate': '场景生成',
  'scene-adapt': '场景改编',
  'scene-compute-generate': '数理场景生成',
  'scene-compute-config': '数理计算配置',
  'scene-compute-adapt': '数理场景改编',
  'scene-role-reply': '场景角色回复',
  'scene-general-turn': '通用场景回合',
};

const MEMORY_SECTION_LABELS: Record<MemoryContextTrace['sections'][number]['kind'], string> = {
  decision: '个性化计划决策',
  plan_state: '当前计划组合',
  profile: '画像与学习状态',
  habits: '长期学习习惯',
  rag: '相关笔记',
  knowledge_state: '知识点掌握状态',
  episodes: '相关学习事件',
};

const HABIT_STATUS_LABELS: Record<HabitConfidenceStatus, string> = {
  insufficient: '样本不足',
  provisional: '暂定观察',
  trusted: '已采信',
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日期未记录' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Explicit columns keep each card in place when the other column expands. */
export function renderEvidenceColumns(cards: React.ReactNode[], className = 'profile-evidence-grid') {
  return <div className={className}>
    {[0, 1].map(column => <div className="profile-evidence-column" key={column}>
      {cards.filter((_, index) => index % 2 === column)}
    </div>)}
  </div>;
}

export function countEvidenceRecords(details: ProfileEvidenceDetail[]): number {
  return new Set(details.flatMap(item => item.samples.map(sample => sample.episodeId))).size;
}

function renderExcerpt(text: string, key: string) {
  if (text.length <= 160) return <p className="profile-evidence-quote" key={key}>{text}</p>;
  return <details className="profile-evidence-excerpt" key={key}>
    <summary><span className="profile-evidence-quote-preview">{text.slice(0, 160)}…</span><span className="profile-evidence-excerpt-action"><span>展开摘录</span><span>收起摘录</span><ChevronDown aria-hidden="true" /></span></summary>
    <p className="profile-evidence-quote">{text}</p>
  </details>;
}

function renderMemoryUsage(traces: MemoryContextTrace[]) {
  return <details className="profile-evidence-usage">
    <summary><div><strong>个性化使用记录</strong><span>查看助手最近参考了什么、采用了哪些调整</span></div><span>本次运行 · {traces.length} 项</span><ChevronDown className="profile-evidence-expand" aria-hidden="true" /></summary>
    {traces.length === 0 ? <p className="memory-trace-empty">使用计划、答疑、复习或场景功能后，这里会显示助手参考过的信息。</p> : renderEvidenceColumns(traces.map(trace => (
      <details className="memory-trace-card" key={trace.workflow}>
        <summary><div><strong>{WORKFLOW_LABELS[trace.workflow] || '学习助手'}</strong><span>{formatTime(trace.createdAt)}</span></div><span>{trace.sections.filter(section => section.included).length} 类参考信息</span><ChevronDown className="profile-evidence-expand" aria-hidden="true" /></summary>
        <div className="memory-trace-sections">
          {trace.personalization && <div className="memory-trace-decisions">
            <strong>采用的个性化调整</strong>
            {trace.personalization.decisions.length ? <ul>{trace.personalization.decisions.map(decision => <li key={decision.id}><span>{decision.instruction}</span><small>{decision.reason}</small></li>)}</ul> : <span>本次未采用个性化调整，以你的当前输入为准。</span>}
            {trace.personalization.deferred.length > 0 && <details><summary>{trace.personalization.deferred.length} 项观察暂未采用</summary><ul>{trace.personalization.deferred.map(item => <li key={item.label}><span>{item.label}</span><small>{item.reason}</small></li>)}</ul></details>}
          </div>}
          {trace.sections.filter(section => section.included).map(section => <div className="memory-trace-section is-included" key={section.kind}><strong>{MEMORY_SECTION_LABELS[section.kind]}</strong><span>已参考</span></div>)}
          {!trace.sections.some(section => section.included) && <p>本次没有使用额外的个人参考信息。</p>}
        </div>
      </details>
    )), 'memory-trace-list')}
  </details>;
}

export const ProfileEvidenceView: React.FC<Props> = ({ onBack, notes, onOpenNote }) => {
  const [details, setDetails] = useState<ProfileEvidenceDetail[]>([]);
  const [habits, setHabits] = useState<LearningHabitProfile | null>(null);
  const [memoryTraces, setMemoryTraces] = useState(() => listLatestMemoryContextTraces());
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({ evidence: false, habits: false });
  const [attempt, setAttempt] = useState(0);
  const [visibleSamples, setVisibleSamples] = useState<Record<string, number>>({});
  const pending = useRef(true);
  const retryOrigin = useRef<HTMLButtonElement | null>(null);
  const today = useLocalCalendarDate();

  useEffect(() => {
    let cancelled = false;
    pending.current = true;
    setLoading(true);
    setMemoryTraces(listLatestMemoryContextTraces());
    loadProfileEvidenceData(notes)
      .then(result => {
        if (cancelled) return;
        if (result.evidence.ok) setDetails(result.evidence.value || []);
        if (result.habits.ok) setHabits(result.habits.value);
        setErrors({ evidence: !result.evidence.ok, habits: !result.habits.ok });
      })
      .catch(() => { if (!cancelled) setErrors({ evidence: true, habits: true }); })
      .finally(() => {
        if (cancelled) return;
        pending.current = false;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [attempt, notes, today]);

  // Restore after React has committed the enabled button, not while it is still disabled.
  useEffect(() => {
    if (loading) return;
    const origin = retryOrigin.current;
    retryOrigin.current = null;
    if (origin?.isConnected && document.activeElement === document.body) origin.focus();
  }, [loading]);

  const retry = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (pending.current) return;
    pending.current = true;
    retryOrigin.current = event.currentTarget;
    setLoading(true);
    setAttempt(value => value + 1);
  };

  const grouped = useMemo(() => Object.entries(
    details.reduce<Partial<Record<ProfileEvidenceDetail['dimension'], ProfileEvidenceDetail[]>>>((result, item) => {
      (result[item.dimension] ||= []).push(item);
      return result;
    }, {}),
  ) as Array<[ProfileEvidenceDetail['dimension'], ProfileEvidenceDetail[]]>, [details]);
  const trustedCount = details.filter((item) => item.status === 'trusted').length;
  const sampleCount = countEvidenceRecords(details);
  const habitGroups = habits ? [
    {
      key: 'study', label: '学习节奏', group: habits.studyRhythm,
      preview: `近 ${habits.windowDays} 天活跃 ${habits.studyRhythm.activeDays} 天`,
      rows: [['活跃天数', `${habits.studyRhythm.activeDays} 天`], ['每周平均活跃', `${habits.studyRhythm.averageActiveDaysPerWeek} 天`], ['单次学习时长（中位数）', habits.studyRhythm.medianSessionMinutes > 0 ? `${habits.studyRhythm.medianSessionMinutes} 分钟` : '暂无时长记录'], ['累计专注时长', `${habits.studyRhythm.totalMinutes} 分钟`]],
    },
    {
      key: 'review', label: '复习互动', group: habits.reviewPattern,
      preview: habits.reviewPattern.sampleCount ? `每次回答 ${habits.reviewPattern.medianAnswerTurns} 轮（中位数）` : '尚无复习记录',
      rows: [['每次回答轮数（中位数）', `${habits.reviewPattern.medianAnswerTurns} 轮`], ['每次回答字数（中位数）', `${habits.reviewPattern.medianAnswerChars} 字`], ['达到参与门槛的复习', habits.reviewPattern.sampleCount ? `${habits.reviewPattern.qualifiedReviewRate}%` : '暂无记录']],
    },
    {
      key: 'correction', label: '数理求助与纠错', group: habits.correctionPattern,
      preview: habits.correctionPattern.sampleCount ? `累计提交 ${habits.correctionPattern.submitCount} 次 · 验证未通过 ${habits.correctionPattern.failureCount} 次` : '尚无数理推导记录',
      rows: [['累计提交', `${habits.correctionPattern.submitCount} 次`], ['验证未通过', `${habits.correctionPattern.failureCount} 次`], ['求助使用率', habits.correctionPattern.submitCount ? `${habits.correctionPattern.helpUsageRate}%` : '暂无提交'], ['错误修正成功率', habits.correctionPattern.failureCount > 0 ? `${habits.correctionPattern.correctionRecoveryRate}%` : '暂无待纠错样本']],
    },
    {
      key: 'execution', label: '任务履约', group: habits.executionPattern,
      preview: habits.executionPattern.sampleCount ? `按时完成 ${habits.executionPattern.onTimeRate}% · 当前逾期 ${habits.executionPattern.overdueOpen} 项` : `当前逾期 ${habits.executionPattern.overdueOpen} 项`,
      rows: [['按时完成率', habits.executionPattern.sampleCount ? `${habits.executionPattern.onTimeRate}%` : '暂无已完成任务'], ['延期任务平均延迟', `${habits.executionPattern.averageLateDays} 天`], ['当前逾期', `${habits.executionPattern.overdueOpen} 项`]],
    },
    {
      key: 'planning', label: '计划结构', group: habits.planningPattern,
      preview: habits.planningPattern.sampleCount ? `每个计划 ${habits.planningPattern.medianNodeCount} 个项目（中位数）` : '尚无计划记录',
      rows: [['计划项目数（中位数）', `${habits.planningPattern.medianNodeCount} 个`], ['已安排日期的项目', habits.planningPattern.sampleCount ? `${habits.planningPattern.scheduledNodeRate}%` : '暂无计划']],
    },
  ] : [];

  const renderSample = (sample: ProfileEvidenceSampleDetail) => {
    const excerpts = [...new Set(sample.evidenceSnippets.map(snippet => snippet.text.trim()).filter(Boolean))];
    const canOpen = sample.episodeType === 'flow' && sample.noteId && onOpenNote && notes.some(note => note.id === sample.noteId);
    return <article className="profile-evidence-sample" key={`${sample.episodeId}:${sample.observedAt}`}>
      <div className="profile-evidence-sample-head"><strong>{sample.episodeTitle || '历史学习记录'}</strong><span>{formatTime(sample.observedAt)}</span></div>
      <p className="profile-evidence-sample-meta">{sample.episodeType ? EPISODE_LABELS[sample.episodeType] : '历史记录'}</p>
      {excerpts.length ? <>
        {excerpts.slice(0, 2).map((text, index) => renderExcerpt(text, `excerpt-${index}`))}
        {excerpts.length > 2 && <details className="profile-evidence-more-excerpts"><summary>另有 {excerpts.length - 2} 段摘录</summary>{excerpts.slice(2).map((text, index) => renderExcerpt(text, `extra-${index}`))}</details>}
      </> : <p className="profile-evidence-legacy">这条历史记录未保存证据摘录。</p>}
      {canOpen && <button type="button" className="profile-evidence-record-link" onClick={() => onOpenNote!(sample.noteId!)}>查看相关笔记</button>}
    </article>;
  };

  return (
    <div className="home-page profile-evidence-page">
      <header className="profile-evidence-hero">
        <button type="button" className="profile-evidence-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />返回画像
        </button>
        <div>
          <span className="home-focus-eyebrow">PROFILE EVIDENCE</span>
          <h2>画像证据</h2>
          <p>查看画像背后的学习记录与关键摘录，了解每项观察的依据。</p>
        </div>
        <div className="profile-evidence-summary" aria-label={loading || errors.evidence ? '证据统计尚未更新' : `已采信 ${trustedCount} 项，来自 ${sampleCount} 次学习记录`}>
          <strong>{loading || errors.evidence ? '—' : trustedCount}</strong><span>已采信指标</span>
          <strong>{loading || errors.evidence ? '—' : sampleCount}</strong><span>学习记录（去重）</span>
        </div>
      </header>

      <div className={`profile-evidence-read-status${!loading && !errors.evidence && !errors.habits ? ' is-ready' : ''}`}>
        <p role={loading || (!errors.evidence && !errors.habits) ? 'status' : 'alert'}>
          {loading ? '正在读取画像证据与学习习惯，已显示的内容保留。'
            : errors.evidence || errors.habits
              ? `${[errors.evidence && '画像证据', errors.habits && '学习习惯'].filter(Boolean).join('、')}读取失败，已显示的内容可能不是最新，请重新读取。`
              : '已读取画像证据与学习习惯'}
        </p>
        <button type="button" disabled={loading} onClick={retry}>
          <RefreshCw aria-hidden="true" />{loading ? '读取中…' : '重新读取'}
        </button>
      </div>

      <PersonalCognitionLauncher />

      <p className="profile-evidence-guide">已采信的观察可用于长期画像；观察中表示仍在积累证据。展开卡片查看依据。</p>

      {!habits && (loading || errors.habits) && <div className={`profile-evidence-read-message ${errors.habits && !loading ? 'is-error' : ''}`}>
        <strong>长期学习习惯</strong>
        <span>{loading ? '正在读取学习习惯…' : '学习习惯读取失败，请使用上方的重新读取。'}</span>
      </div>}
      {habits && (
        <section className="profile-evidence-group">
          <div className="profile-evidence-group-head">
            <span className="home-tick" />
            <h3>长期学习习惯</h3>
            <span>最近 {habits.windowDays} 天 · {habitGroups.filter((item) => item.group.status === 'trusted').length} 项已采信</span>
          </div>
          {renderEvidenceColumns(habitGroups.map((item) => (
              <details className="profile-evidence-card" key={item.key}>
                <summary>
                  <div>
                    <span className="profile-evidence-indicator">{item.label}</span>
                    <span className="profile-evidence-preview">{item.preview}</span>
                    <span className={`profile-evidence-status is-${item.group.status === 'trusted' ? 'trusted' : 'holding'}`}>
                      {item.group.status === 'trusted' ? <ShieldCheck aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
                      {HABIT_STATUS_LABELS[item.group.status]}
                    </span>
                  </div>
                  <div className="profile-evidence-score is-count">
                    <strong>{item.group.sampleCount} <small>个样本</small></strong>
                    <span>采样覆盖 {item.group.daysObserved} 天</span>
                  </div>
                  <ChevronDown className="profile-evidence-expand" aria-hidden="true" />
                </summary>
                <div className="profile-evidence-samples">
                  <dl className="profile-evidence-metrics">{item.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                </div>
              </details>
            )))}
        </section>
      )}

      {!loading && errors.evidence && details.length === 0 && <div className="profile-evidence-read-message is-error"><strong>画像判定证据</strong><span>证据读取失败，请使用上方的重新读取。</span></div>}
      {!loading && !errors.evidence && details.length === 0 && (
        <div className="profile-evidence-state">
          <FileSearch aria-hidden="true" />
          <strong>还没有可展示的画像证据</strong>
          <span>完成心流复盘、苏格拉底式复习或数理推导场景后，系统会先积累证据，再决定是否更新长期画像。</span>
        </div>
      )}

      {grouped.map(([dimension, items]) => (
        <section className="profile-evidence-group" key={dimension}>
          <div className="profile-evidence-group-head">
            <span className="home-tick" />
            <h3>{DIMENSION_LABELS[dimension]}</h3>
            <span>{items.length} 个指标</span>
          </div>
          {renderEvidenceColumns(items.map((item) => {
            const key = `${item.dimension}:${item.indicator}:${item.rubricVersion || 'legacy'}`;
            const limit = visibleSamples[key] || 3;
            const sources = [...new Set(item.samples.flatMap(sample => sample.episodeType ? [EPISODE_LABELS[sample.episodeType]] : []))];
            return <details className="profile-evidence-card" key={key}>
                <summary>
                  <div>
                    <span className="profile-evidence-indicator">{INDICATOR_LABELS[item.indicator] || '其他画像观察'}</span>
                    <span className="profile-evidence-preview">{sources.length > 1 ? `${sources[0]}等 ${sources.length} 类学习记录` : sources[0] || '历史观察'}</span>
                    <span className={`profile-evidence-status is-${item.status}`}>
                      {item.status === 'trusted' ? <ShieldCheck aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
                      {item.status === 'trusted' ? '已采信' : '观察中'}
                    </span>
                  </div>
                  <div className="profile-evidence-score">
                    <strong>{item.mean.toFixed(1)}</strong>
                    <span>综合值 · {item.samples.length} 条观察</span>
                  </div>
                  <ChevronDown className="profile-evidence-expand" aria-hidden="true" />
                </summary>
                <div className="profile-evidence-samples">
                  {item.samples.slice(0, limit).map(renderSample)}
                  {item.samples.length === 0 && <p className="profile-evidence-legacy">尚无可展示的学习记录。</p>}
                  {item.samples.length > limit && <button type="button" className="profile-evidence-load-more" onClick={() => setVisibleSamples(previous => ({ ...previous, [key]: limit + 3 }))}>查看更早记录 · 还有 {item.samples.length - limit} 条</button>}
                  <details className="profile-evidence-method"><summary>统计说明</summary><p>综合值由该指标的多次观察汇总。证据置信度 {Math.round(item.confidence * 100)}%，表示系统对这项观察的把握程度，不是答题正确率。</p></details>
                </div>
              </details>;
            }))}
        </section>
      ))}
      {renderMemoryUsage(memoryTraces)}
    </div>
  );
};
