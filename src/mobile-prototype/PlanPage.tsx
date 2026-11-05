import React, { useState } from 'react';
import { ArrowRight, Check, MoreHorizontal, Plus } from 'lucide-react';
import type { Task } from './data';
import './plan-page.css';

type Props = {
  tasks: Task[];
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onAdjust: (task: Task) => void;
  onCreate: () => void;
  onAdjustAll: () => void;
};

export function PlanPage({ tasks, onToggle, onOpen, onAdjust, onCreate, onAdjustAll }: Props) {
  const [filter, setFilter] = useState<'today' | 'all'>('today');
  const today = tasks.filter(t => t.day === '今天');
  const complete = today.filter(t => t.done).length;
  const remainingMinutes = today.filter(t => !t.done).reduce((sum, t) => sum + t.minutes, 0);
  const filtered = filter === 'today' ? today : tasks;
  const groups = [...new Set(filtered.map(t => t.day))].sort((a, b) => {
    const order = ['今天', '明天', '本周末'];
    const rank = (day: string) => order.includes(day) ? order.indexOf(day) : order.length;
    return rank(a) - rank(b);
  });
  return <section className="pl-page" aria-label="学习计划">
    <header className="pl-header"><h1>计划</h1><button className="mp-icon" aria-label="新计划" onClick={onCreate}><Plus size={23} /></button></header>
    <div className="pl-today"><div><span>今天</span><strong>{complete}<small> / {today.length}</small></strong></div><span>{remainingMinutes} 分钟待完成</span><div className="pl-progress" role="progressbar" aria-label="今日任务进度" aria-valuenow={complete} aria-valuemin={0} aria-valuemax={today.length || 1}><span style={{ width: `${today.length ? complete / today.length * 100 : 0}%` }} /></div></div>
    <div className="pl-toolbar"><div className="pl-filters" aria-label="计划范围"><button aria-pressed={filter === 'today'} onClick={() => setFilter('today')}>今天</button><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button></div><button className="mp-text-button" disabled={!tasks.some(t => !t.done)} onClick={onAdjustAll}>调整<ArrowRight size={15} /></button></div>
    {groups.map(day => <section className="pl-group" key={day} aria-label={day}>{filter === 'all' && <h2>{day}</h2>}{filtered.filter(t => t.day === day).map(task => <article className={`pl-task ${task.done ? 'is-done' : ''}`} key={task.id}>
      <button className="pl-task-check" aria-label={`${task.done ? '取消完成' : '完成'}：${task.title}`} aria-pressed={task.done} onClick={() => onToggle(task)}><span>{task.done && <Check size={16} />}</span></button>
      <button className="pl-task-open" aria-label={`打开任务：${task.title}`} onClick={() => onOpen(task)}><strong>{task.title}</strong><span>{task.kind} · {task.minutes} 分钟</span></button>
      <button className="mp-icon" aria-label={`调整：${task.title}`} onClick={() => onAdjust(task)}><MoreHorizontal size={20} /></button>
    </article>)}</section>)}
    {!filtered.length && <div className="pl-empty"><span>{filter === 'today' ? '今天暂无安排' : '还没有计划'}</span><button className="mp-text-button" onClick={() => filter === 'today' && tasks.length ? setFilter('all') : onCreate()}>{filter === 'today' && tasks.length ? '查看全部' : '创建计划'}</button></div>}
  </section>;
}
