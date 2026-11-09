import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, ChevronRight, Circle, Clock3, FileText, MessageCircle, Mic, Monitor } from 'lucide-react';
import { mobileDate, mobileWeek, type MobileTask } from './mobile-task-data';
import './mobile-tasks.css';

export type MobileTasksProps = {
  tasks: MobileTask[];
  onChange: (tasks: MobileTask[]) => boolean | void;
  onOpenMaterial: (materialId: string) => void;
  onRecap: (materialId?: string) => void;
  onAsk: (sourceId: string, title: string) => void;
  onClose: () => void;
};
type DatePreview = { id: string; title: string; before: string; after: string; done: boolean };

function dateLabel(value: string, today: string) {
  if (value === today) return '今天';
  const tomorrow = new Date(`${today}T12:00:00`); tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === mobileDate(tomorrow)) return '明天';
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }) : value;
}

export function MobileTasks({ tasks, onChange, onOpenMaterial, onRecap, onAsk, onClose }: MobileTasksProps) {
  const [range, setRange] = useState<'today' | 'week' | 'all'>('today');
  const [plan, setPlan] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newDay, setNewDay] = useState('');
  const [preview, setPreview] = useState<DatePreview | null>(null);
  const [error, setError] = useState('');
  const today = mobileDate(), week = mobileWeek();
  const todayTasks = tasks.filter(task => task.day === today);
  const overdue = tasks.filter(task => task.day < today && !task.done);
  const todayRemaining = todayTasks.filter(task => !task.done).reduce((sum, task) => sum + task.minutes, 0);
  const weekMinutes = tasks.filter(task => task.day >= week.start && task.day <= week.end).reduce((sum, task) => sum + task.minutes, 0);
  const plans = [...new Set(tasks.map(task => task.plan))];
  const visible = useMemo(() => tasks.filter(task => (!plan || task.plan === plan) && (range === 'all' || range === 'week' && task.day >= week.start && task.day <= week.end || range === 'today' && (task.day === today || task.day < today && !task.done)))
    .slice().sort((a, b) => a.day.localeCompare(b.day) || Number(a.done) - Number(b.done)), [tasks, plan, range, today, week.start, week.end]);
  const selected = tasks.find(task => task.id === selectedId) || visible[0];
  const groups = [...new Set(visible.map(task => task.day))];

  function choose(task: MobileTask) {
    setSelectedId(task.id); setNewDay(task.day); setPreview(null); setError('');
  }
  function updateDone(task: MobileTask) {
    if (task.kind === '简测' || task.kind === '桌面任务') return;
    const result = onChange(tasks.map(item => item.id === task.id ? { ...item, done: !item.done } : item));
    if (result === false) setError('本机保存失败，任务状态未改变。');
    else { setError(''); setPreview(null); }
  }
  function previewDate(task: MobileTask) {
    const nextDay = newDay || task.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDay) || !Number.isFinite(new Date(`${nextDay}T12:00:00`).getTime()) || mobileDate(new Date(`${nextDay}T12:00:00`)) !== nextDay) { setError('请选择有效日期。'); return; }
    if (nextDay === task.day) { setError('请选择新的安排日期。'); return; }
    setPreview({ id: task.id, title: task.title, before: task.day, after: nextDay, done: task.done }); setError('');
  }
  function confirmDate() {
    if (!preview) return;
    const current = tasks.find(task => task.id === preview.id);
    if (!current || current.day !== preview.before || current.done !== preview.done) { setError('任务已更新，请重新预览。'); setPreview(null); return; }
    const result = onChange(tasks.map(task => task.id === preview.id ? { ...task, day: preview.after } : task));
    if (result === false) { setError('改期尚未保存，请重试。'); return; }
    setPreview(null); setError('');
  }
  function backToList() { setSelectedId(null); setNewDay(''); setPreview(null); setError(''); }
  const detail = selected && <section className="mt-detail" aria-label="任务详情">
    <header className="mt-detail-head"><span>{selected.kind}</span><strong className={selected.done ? 'mt-done-label' : ''}>{selected.done ? '已完成' : selected.day < today ? '待补完' : '待完成'}</strong></header>
    <div className="mt-detail-scroll">
      <p className="mt-plan-label">{selected.plan}</p><h2>{selected.title}</h2>
      <div className="mt-metadata"><span><CalendarDays />{dateLabel(selected.day, today)}</span><span><Clock3 />约 {selected.minutes} 分钟</span></div>
      {(selected.kind === '简测' || selected.kind === '桌面任务') && <div className="mt-desktop-note"><Monitor /><p>{selected.kind === '简测' ? '简测按桌面端的评价流程完成。' : '这项任务需要在桌面端继续。'}<small>本页仅查看与调整安排。</small></p></div>}
      <div className="mt-primary-actions">
        {selected.kind === '阅读' && selected.materialId && <button type="button" className="ix-primary" onClick={() => onOpenMaterial(selected.materialId!)}><BookOpen />开始阅读<ArrowRight /></button>}
        {selected.kind === '复述' && <button type="button" className="ix-primary" onClick={() => onRecap(selected.materialId)}><Mic />开始复述<ArrowRight /></button>}
        {selected.materialId && selected.kind !== '阅读' && <button type="button" className="ix-secondary" onClick={() => onOpenMaterial(selected.materialId!)}><FileText />查看关联资料</button>}
        <button type="button" className="ix-secondary" onClick={() => onAsk(selected.materialId || selected.id, selected.title)}><MessageCircle />问助手</button>
      </div>
      {selected.kind !== '简测' && selected.kind !== '桌面任务' && <div className="mt-completion"><button type="button" className={selected.done || selected.kind !== '待办' ? 'ix-secondary' : 'ix-primary'} aria-pressed={selected.done} aria-label={`${selected.done ? '取消完成' : '标记完成'}任务：${selected.title}`} onClick={() => updateDone(selected)}>{selected.done ? <Circle /> : <Check />}{selected.done ? '取消完成' : '标记本次完成'}</button>{selected.kind !== '待办' && <small>仅记录任务进度，不代表已掌握。</small>}</div>}
      {!selected.done && <section className="mt-reschedule" aria-label="调整任务日期"><h3>调整日期</h3><div className="mt-date-row"><input type="date" aria-label="新的任务日期" value={newDay || selected.day} onChange={event => { setNewDay(event.target.value); setPreview(null); setError(''); }} /><button type="button" className="ix-secondary" onClick={() => previewDate(selected)}>预览改期</button></div>
        {preview?.id === selected.id && <div className="mt-date-preview"><strong>{preview.title}</strong><span>{dateLabel(preview.before, today)}<ArrowRight />{dateLabel(preview.after, today)}</span><div><button type="button" className="ix-text" onClick={() => setPreview(null)}>取消</button><button type="button" className="ix-primary" onClick={confirmDate}>确认改期</button></div></div>}
      </section>}
      {error && <p className="mt-error" role="alert">{error}</p>}
    </div>
  </section>;

  return <section className={`mt-page ${selectedId ? 'mt-has-selection' : ''}`} aria-label="我的任务">
    <header className="mt-page-head"><button type="button" className="ix-icon mt-home-back" aria-label="返回首页" onClick={onClose}><ArrowLeft /></button><button type="button" className="ix-icon mt-mobile-back" aria-label="返回任务列表" onClick={backToList}><ArrowLeft /></button><h1><span className="mt-list-title">我的任务</span><span className="mt-selected-title">任务详情</span></h1><small className="mt-list-caption">本机任务样例</small><small className="mt-selected-caption">{selected?.kind} · {selected?.done ? '已完成' : selected && selected.day < today ? '待补完' : '待完成'}</small></header>
    <div className="mt-workspace"><section className="mt-list-pane" aria-label="任务清单">
      <div className="mt-today-summary"><span>今天<strong>{todayTasks.filter(task => task.done).length} / {todayTasks.length}</strong></span><span>{todayRemaining ? `${todayRemaining} 分钟待完成` : '今日安排已完成'}{overdue.length ? <small>{overdue.length} 项待补完</small> : null}</span></div>
      <div className="mt-toolbar"><div className="mt-range" role="group" aria-label="任务日期范围">{([{ key: 'today', label: '今天' }, { key: 'week', label: '本周' }, { key: 'all', label: '全部' }] as const).map(item => <button key={item.key} type="button" aria-pressed={range === item.key} onClick={() => { setRange(item.key); setSelectedId(null); setNewDay(''); setPreview(null); setError(''); }}>{item.label}</button>)}</div><select aria-label="按学习计划筛选" value={plan} onChange={event => { setPlan(event.target.value); setSelectedId(null); setNewDay(''); setPreview(null); setError(''); }}><option value="">全部计划</option>{plans.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
      <div className="mt-week-summary"><Clock3 /><span>本周已安排 {weekMinutes} 分钟</span></div>
      <div className="mt-task-list">{groups.map(day => <section key={day}><h2>{day < today ? `待补完 · ${dateLabel(day, today)}` : dateLabel(day, today)}</h2>{visible.filter(task => task.day === day).map(task => <article key={task.id} className="mt-task-row" data-selected={selected?.id === task.id} data-done={task.done}>
        {task.kind === '待办' ? <button type="button" className="mt-row-check" aria-label={`${task.done ? '取消完成' : '完成'}：${task.title}`} aria-pressed={task.done} onClick={() => updateDone(task)}>{task.done ? <Check /> : <Circle />}</button> : <span className="mt-kind-icon" aria-hidden="true">{task.done ? <Check /> : task.kind === '复述' ? <Mic /> : task.kind === '桌面任务' ? <Monitor /> : <BookOpen />}</span>}
        <button type="button" className="mt-open-task" aria-label={`打开任务：${task.title}`} aria-current={selected?.id === task.id ? 'true' : undefined} onClick={() => choose(task)}><span><strong>{task.title}</strong><small>{task.plan} · {task.kind} · {task.minutes} 分钟</small></span><ChevronRight aria-hidden="true" /></button>
      </article>)}</section>)}{!visible.length && <p className="mt-empty">{range === 'today' ? '今天暂无安排' : '没有匹配的任务'}</p>}{error && !selectedId && <p className="mt-error" role="alert">{error}</p>}</div>
    </section>{detail || <section className="mt-no-detail"><CalendarDays /><p>选择任务查看详情</p></section>}</div>
  </section>;
}
