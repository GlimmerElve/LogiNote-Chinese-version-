import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BookOpenText,
  CalendarClock,
  CheckCircle2,
  CircleGauge,
  Network,
} from 'lucide-react';
import type { NoteItem } from '../types';
import { getUserProfile } from '../services/profile/profileStore';
import { loadMasteryTimeline } from '../services/learningAbility/timelineStore';
import { refreshLearningAbility } from '../services/learningAbility/refresh';
import { buildHomeViewModel, homeAbilitySummary, type HomeFocusProject, type HomeViewModel } from '../services/homepage/homepageViewModel';
import { buildLearningCapacity, cachedCapacitySettings, weekStartDate } from '../services/learningCapacity';
import { HomeReviewEchoCard } from './HomeReviewEchoCard';

interface HomeViewProps {
  capacitySettings?: Partial<import('../types').VaultSettings>;
  notes: NoteItem[];
  onContinueProject: (project: HomeFocusProject) => void;
  onOpenPlan: () => void;
  onOpenReview: () => void;
  onOpenProfile: () => void;
}

function formatDueDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const dayDelta = Math.round((date.setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86_400_000);
  if (dayDelta === 0) return '今天到期';
  if (dayDelta === 1) return '明天到期';
  if (dayDelta < 0) return `已逾期 ${Math.abs(dayDelta)} 天`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日到期`;
}

const LogicFigure: React.FC = () => (
  <div className="quiet-home-logic" aria-label="前提、推理与结论的逻辑链示意图">
    <svg viewBox="0 0 430 280" role="img" aria-hidden="true">
      <path className="quiet-home-orbit orbit-a" d="M48 196C72 72 226 24 338 98" />
      <path className="quiet-home-orbit orbit-b" d="M96 242C216 228 184 54 350 44" />
      <path className="quiet-home-orbit orbit-c" d="M62 116C152 96 242 178 384 142" />
      <path className="quiet-home-link" d="M117 148L205 132L300 142" />
      <path className="quiet-home-arrow" d="M186 128L205 132L190 142" />
      <path className="quiet-home-arrow" d="M281 136L300 142L283 151" />
      <circle className="quiet-home-node node-p" cx="94" cy="152" r="35" />
      <circle className="quiet-home-node node-r" cx="230" cy="132" r="42" />
      <circle className="quiet-home-node node-c" cx="330" cy="144" r="36" />
      <circle className="quiet-home-satellite" cx="365" cy="51" r="13" />
      <circle className="quiet-home-satellite" cx="76" cy="225" r="13" />
      <circle className="quiet-home-satellite is-accent" cx="264" cy="64" r="5" />
      <text x="94" y="160" textAnchor="middle">P</text>
      <text x="230" y="140" textAnchor="middle">R</text>
      <text x="330" y="152" textAnchor="middle">C</text>
    </svg>
    <div className="quiet-home-logic-label label-p"><strong>前提</strong><span>已知与观察</span></div>
    <div className="quiet-home-logic-label label-r"><strong>推理</strong><span>建立关联</span></div>
    <div className="quiet-home-logic-label label-c"><strong>结论</strong><span>形成理解</span></div>
    <span className="quiet-home-satellite-label label-context">补充信息</span>
    <span className="quiet-home-satellite-label label-experience">相关经验</span>
  </div>
);

const ProjectFocusCard: React.FC<{
  vm: HomeViewModel;
  onContinueProject: (project: HomeFocusProject) => void;
  onOpenPlan: () => void;
}> = ({ vm, onContinueProject, onOpenPlan }) => {
  const project = vm.focusProject;
  const progress = project?.progress ?? 0;
  const ringStyle = { '--quiet-home-progress': `${progress * 3.6}deg` } as React.CSSProperties;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const launch = project?.nextLaunch;
  const actionLabel = !project ? '制定计划' : !launch || launch.actionDate > today ? '查看计划'
    : launch.mode === 'scene' ? '开始练习' : launch.mode === 'review' ? '去复习'
      : launch.mode === 'none' ? '查看待办' : '继续学习';

  return (
    <section className="quiet-home-project-card" aria-labelledby="quiet-home-project-title">
      <div className="quiet-home-progress" style={ringStyle} aria-label={`项目完成度 ${progress}%`}>
        <div>
          <strong>{progress}%</strong>
          <span>项目完成度</span>
        </div>
      </div>

      <div className="quiet-home-project-copy">
        <span className="quiet-home-card-eyebrow"><BookOpenText aria-hidden="true" />当前项目</span>
        <h2 id="quiet-home-project-title">{project?.title || '还没有学习项目'}</h2>
        <p>
          {project?.nextTask
            ? `下一步：${project.nextTask}`
            : project?.totalTasks && project.completedTasks === project.totalTasks
              ? '计划任务已经完成，可以回看笔记或开始新的项目。'
              : project
                ? '当前没有可开始的学习任务，可在计划中查看和安排。'
                : '创建一个项目，让目标、资料和复盘围绕同一条主线生长。'}
        </p>
        <div className="quiet-home-project-meta">
          <span><CircleGauge aria-hidden="true" />{project?.totalTasks ? `${project.completedTasks} / ${project.totalTasks} 项完成` : '尚无任务进度'}</span>
          {project?.nearestDueDate && <span><CalendarClock aria-hidden="true" />{formatDueDate(project.nearestDueDate)}</span>}
        </div>
      </div>

      <button
        type="button"
        className="quiet-home-primary-action"
        onClick={() => project ? onContinueProject(project) : onOpenPlan()}
      >
        {actionLabel}<ArrowRight aria-hidden="true" />
      </button>
    </section>
  );
};

export const HomeView: React.FC<HomeViewProps> = ({
  capacitySettings = cachedCapacitySettings(),
  notes,
  onContinueProject,
  onOpenPlan,
  onOpenReview,
  onOpenProfile,
}) => {
  const [vm, setVm] = useState<HomeViewModel | null>(null);
  const capacity = buildLearningCapacity(notes, weekStartDate(), capacitySettings);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        await refreshLearningAbility(notes).catch(() => {});
        const timeline = await loadMasteryTimeline();
        if (cancelled) return;
        setVm(buildHomeViewModel(notes, getUserProfile(), timeline));
      } catch {
        if (!cancelled) setLoadError('学习线索读取失败，请重试。');
      }
    })();
    return () => { cancelled = true; };
  }, [notes, readAttempt]);

  if (!vm) return <div className="quiet-home-loading" role={loadError ? 'alert' : 'status'}>
    {loadError || '正在整理今天的学习线索…'}
    {loadError && <button type="button" className="quiet-home-primary-action" onClick={() => setReadAttempt((attempt) => attempt + 1)}>重试读取</button>}
  </div>;

  return (
    <main className="quiet-home-page">
      {loadError && <div role="alert" className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-3 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-3 text-sm text-[var(--ln-danger)]">
        {loadError}<button type="button" className="quiet-home-review-action" onClick={() => setReadAttempt((attempt) => attempt + 1)}>重试读取</button>
      </div>}
      <div className="quiet-home-decoration quiet-home-decoration-left" aria-hidden="true" />
      <div className="quiet-home-decoration quiet-home-decoration-right" aria-hidden="true" />

      <header className="quiet-home-hero">
        <span className="quiet-home-kicker">QUIET PROGRESS</span>
        <h1>今天，只推进一个理解。</h1>
        <p>把注意力放在真正重要的地方，<br />让知识在时间里，慢慢长成自己的样子。</p>
      </header>

      <div className="quiet-home-focus-row">
        <ProjectFocusCard vm={vm} onContinueProject={onContinueProject} onOpenPlan={onOpenPlan} />
        <LogicFigure />
      </div>

      <section className="quiet-home-capacity" aria-label="个人本周学习容量">
        <button
          type="button"
          onClick={onOpenPlan}
          aria-label={`查看本周学习安排，已安排 ${capacity.scheduledMinutes} 分钟，个人周预算 ${capacity.budgetMinutes ?? '待确认'} 分钟${capacity.percent === null ? '' : `，已使用 ${capacity.percent}%`}`}
        >
          <span className="quiet-home-capacity-icon"><CalendarClock aria-hidden="true" /></span>
          <span className="quiet-home-capacity-copy">
            <strong>本周学习安排</strong>
            <small>全部计划共享个人周预算</small>
          </span>
          <span className="quiet-home-capacity-metric">
            <strong>{capacity.scheduledMinutes} / {capacity.budgetMinutes ?? '待确认'} 分钟</strong>
            <span>
              <i aria-hidden="true"><b className={capacity.percent !== null && capacity.percent > 100 ? 'is-overload' : ''} style={{ width: `${Math.min(100, capacity.percent ?? 0)}%` }} /></i>
              <em>{capacity.percent === null ? '待确认' : `${capacity.percent}%`}</em>
            </span>
          </span>
          <ArrowRight aria-hidden="true" />
        </button>
      </section>

      <HomeReviewEchoCard vm={vm} onOpenReview={onOpenReview} />

      <button type="button" className="quiet-home-profile-link" onClick={onOpenProfile}>
        <span className="quiet-home-profile-icon"><Network aria-hidden="true" /></span>
        <span>
          <strong>学习画像</strong>
          <small>{homeAbilitySummary(vm)}</small>
        </span>
        <span className="quiet-home-profile-status"><CheckCircle2 aria-hidden="true" />展开画像</span>
        <ArrowRight aria-hidden="true" />
      </button>
    </main>
  );
};
