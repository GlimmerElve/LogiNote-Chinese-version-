import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Layers3, Loader2, Pencil } from 'lucide-react';
import type { NoteItem, PlanMilestone, PlanNode, PlanTaskBlueprint, VaultSettings } from '../types';
import { buildPublishedPlanEditorValue, type PublishedPlanEditorValue } from '../services/publishedPlanEditor';
import { PlanBuilder, type PlanBuilderDraftValue } from './PlanBuilder';
import './PlanPortfolioEditor.css';

export interface PlanPortfolioEditorProps {
  drafts: PublishedPlanEditorValue[];
  notes: NoteItem[];
  capacitySettings?: Partial<VaultSettings>;
  isActive?: boolean;
  onDraftChange: (rootId: string, value: PlanBuilderDraftValue) => void;
  onFocusRoot?: (rootId: string) => void;
  onConfirm: (drafts: PublishedPlanEditorValue[]) => Promise<void>;
  onCancel: () => void;
}

interface Change { key: string; title: string; before: string; after: string }
interface FlatNode { node: PlanNode; parentKey?: string }
const same = (before: unknown, after: unknown): boolean => JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
const range = (value?: { startDate?: string; dueDate?: string }): string => value
  ? `${value.startDate || '未设开始日期'} — ${value.dueDate || '未设结束日期'}` : '不存在';
const flatten = (nodes: PlanNode[], parentKey?: string): FlatNode[] => nodes.flatMap(node => [{ node, parentKey }, ...flatten(node.children || [], node.key)]);
const labels: Record<string, string> = {
  new: '从零开始', basic: '了解基础', intermediate: '已有实践', advanced: '进阶提升',
  relaxed: '舒缓', balanced: '均衡', intensive: '密集', morning: '上午', afternoon: '下午', evening: '晚上', flexible: '灵活',
  hard: '硬截止', light: '轻量', standard: '标准', high: '高', medium: '中', low: '低',
  ask: '先询问', automatic: '自动', off: '关闭', active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档', draft: '草稿',
  learn: '学习', practice: '练习', review: '复习', assessment: '测验', todo: '待办', flow: '专注', scene: '场景', none: '无',
  daily: '每天', weekdays: '工作日', weekly: '每周', custom: '自定义', skip: '跳过', rollover: '顺延', keep: '保留',
  additional: '额外占用', included: '已计入项目',
};
function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return labels[value] || value;
  if (Array.isArray(value)) return value.length ? value.map(text).join('、') : '无';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>, fields: Record<string, string>): string[] {
  return Object.entries(fields).filter(([key]) => !same(before[key], after[key]))
    .map(([key, label]) => `${label}：${text(before[key])} → ${text(after[key])}`);
}
function compareItems<T>(before: T[], after: T[], key: (value: T) => string, title: (value: T) => string, describe: (value: T) => string): Change[] {
  const oldByKey = new Map(before.map(value => [key(value), value]));
  const newByKey = new Map(after.map(value => [key(value), value]));
  return [...new Set([...oldByKey.keys(), ...newByKey.keys()])].flatMap(id => {
    const oldValue = oldByKey.get(id), newValue = newByKey.get(id);
    if (same(oldValue, newValue)) return [];
    return [{ key: id, title: `${!oldValue ? '新增 · ' : !newValue ? '移除 · ' : ''}${title(newValue || oldValue!)}`,
      before: oldValue ? describe(oldValue) : '不存在', after: newValue ? describe(newValue) : '移除' }];
  });
}
function milestones(value: PublishedPlanEditorValue): PlanMilestone[] {
  const result = new Map((value.planMeta.milestones || []).map(item => [item.id, item]));
  flatten(value.tree).forEach(({ node }) => {
    if (node.milestone && !result.has(node.milestone.id)) result.set(node.milestone.id, {
      id: node.milestone.id, title: node.milestone.title, dueDate: node.milestone.dueDate,
      criteria: node.milestone.description ? [node.milestone.description] : undefined, projectId: node.key,
    });
  });
  return [...result.values()];
}
function buildReview(before: PublishedPlanEditorValue, after: PublishedPlanEditorValue) {
  const oldNodes = flatten(before.tree), newNodes = flatten(after.tree);
  const titleByKey = new Map([...oldNodes, ...newNodes].map(({ node }) => [node.key, node.title]));
  const projectName = (key?: string) => key ? titleByKey.get(key) || key : '无父级';
  const structure = compareItems(oldNodes, newNodes, item => item.node.key, item => item.node.title, item => {
    const node = item.node;
    return [node.title, range(node), `父级：${projectName(item.parentKey)}`, `优先级：${text(node.priority)}`,
      `成果：${text(node.outcome)}`, `独立时长：${node.estimatedMinutes ? `${node.estimatedMinutes} 分钟` : '继承计划每日投入'}`].join('；');
  }).filter(item => {
    const oldValue = oldNodes.find(value => value.node.key === item.key), newValue = newNodes.find(value => value.node.key === item.key);
    // Tasks and milestones have their own complete change lists below.
    return !oldValue || !newValue || !same({ ...oldValue, node: { ...oldValue.node, children: undefined, tasks: undefined, milestone: undefined } },
      { ...newValue, node: { ...newValue.node, children: undefined, tasks: undefined, milestone: undefined } });
  });
  const changedKeys = new Set(structure.map(item => item.key));
  const parentRanges = compareItems(oldNodes, newNodes, item => item.node.key, item => item.node.title,
    item => `${range(item.node)}；${item.node.children.length} 个直接子项目`)
    .filter(item => {
      const oldValue = oldNodes.find(value => value.node.key === item.key), newValue = newNodes.find(value => value.node.key === item.key);
      return Boolean(oldValue?.node.children.length || newValue?.node.children.length)
        && (changedKeys.has(item.key) || flatten(oldValue?.node.children || []).some(value => changedKeys.has(value.node.key))
          || flatten(newValue?.node.children || []).some(value => changedKeys.has(value.node.key)));
    });
  const tasks = (values: FlatNode[]) => values.flatMap(({ node }) => (node.tasks || []).map(task => ({ ...task, linkedProjectKey: task.linkedProjectKey || node.key })));
  const isRule = (task: PlanTaskBlueprint) => Boolean(task.recurrence && task.recurrence.frequency !== 'none');
  const describeTask = (task: PlanTaskBlueprint) => [
    task.text, range(task), `${task.estimatedMinutes} 分钟`, `类型：${text(task.executionKind || task.kind)}`,
    `关联：${projectName(task.linkedProjectKey)}`, `优先级：${text(task.priority)}`,
    ...(task.recurrence ? [`重复：${text(task.recurrence.frequency)}，间隔 ${task.recurrence.interval || 1}，星期 ${text(task.recurrence.weekdays)}，时刻 ${text(task.recurrence.timeOfDay)}，结束 ${text(task.recurrence.endDate)}，错过 ${text(task.recurrence.missedPolicy)}`] : []),
    `依赖：${text(task.dependencyKeys)}`, `里程碑：${text(task.milestoneId)}`, `启动：${text(task.launchMode)}`,
    `提醒：${task.reminderMinutes === undefined ? '未设置' : `${task.reminderMinutes} 分钟前`}`, `容量：${text(task.capacityKind)}`,
    `知识关联：${text(task.linkedKnowledgeIds)}`, `显示行：${task.displayRow || 0}`, `任务类别：${text(task.kind)}`,
    `来源：${text(task.source)}`,
  ].join('；');
  const oldTasks = tasks(oldNodes), newTasks = tasks(newNodes);
  const execution = compareItems(oldTasks.filter(task => !isRule(task)), newTasks.filter(task => !isRule(task)), task => task.key, task => task.text, describeTask);
  const rules = compareItems(oldTasks.filter(isRule), newTasks.filter(isRule), task => task.key, task => task.text, describeTask);
  const milestoneChanges = compareItems(milestones(before), milestones(after), item => item.id, item => item.title,
    item => `${item.title}；截止 ${item.dueDate}；关联：${projectName(item.projectId)}；验收：${text(item.criteria)}；完成：${text(item.completed)}；完成时间：${text(item.completedAt)}`);
  const conditionChanges = fieldChanges({ ...before.planMeta.conditions }, { ...after.planMeta.conditions }, {
    goalEvidence: '达成证据', startingLevel: '起点', pace: '节奏', preferredSessionMinutes: '单次专注分钟',
    preferredTimeOfDay: '偏好时段', deadlineMode: '截止方式', reviewCadence: '复习频率', constraintNotes: '限制说明',
  });
  const metaChanges = fieldChanges(before.planMeta as Record<string, unknown>, after.planMeta as Record<string, unknown>, {
    shortTitle: '计划简称', summary: '计划说明', status: '计划状态', dailyStudyMinutes: '每日学习分钟', activeWeekdays: '可学习星期（0 为周日）',
    startDate: '计划开始日期', targetDate: '计划目标日期',
    portfolioPriority: '组合优先级', autoAdjustPolicy: '自动调整策略', weeklyBudgetMinutes: '兼容周预算', preparationDocuments: '准备资料', research: '研究依据',
  });
  const rangeWarnings = newNodes.flatMap(({ node, parentKey }) => {
    const parent = newNodes.find(item => item.node.key === parentKey)?.node;
    return parent && ((node.startDate && parent.startDate && node.startDate < parent.startDate)
      || (node.dueDate && parent.dueDate && node.dueDate > parent.dueDate))
      ? [`“${node.title}”超出父级“${parent.title}”的新范围，请编辑核对。`] : [];
  });
  return { structure, parentRanges, execution, rules, milestoneChanges, conditionChanges: [...conditionChanges, ...metaChanges], rangeWarnings };
}

function Changes({ title, items }: { title: string; items: Change[] }) {
  return <section className="plan-portfolio-change-group" aria-label={title}>
    <h4>{title}<span>{items.length ? `${items.length} 项变化` : '未改动'}</span></h4>
    {!!items.length && <ul>{items.map(item => <li key={item.key}>
      <strong>{item.title}</strong><div className="plan-portfolio-diff"><span><small>原</small>{item.before}</span>
        <ArrowRight aria-hidden="true" /><span><small>新</small>{item.after}</span></div>
    </li>)}</ul>}
  </section>;
}

/** A single explicit confirmation for the entire reviewed portfolio; this component never writes notes itself. */
export function PlanPortfolioEditor({ drafts, notes, capacitySettings, isActive = true, onDraftChange, onFocusRoot, onConfirm, onCancel }: PlanPortfolioEditorProps) {
  const [workingDrafts, setWorkingDrafts] = useState(() => structuredClone(drafts));
  const latestDrafts = useRef(workingDrafts);
  const [editingRootId, setEditingRootId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const snapshot = structuredClone(drafts);
    latestDrafts.current = snapshot;
    setWorkingDrafts(snapshot);
  }, [drafts]);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [editingRootId]);
  const reviews = useMemo(() => {
    const seen = new Set<string>();
    return workingDrafts.map((draft, index) => {
      let problem: string | undefined;
      if (!draft.rootId || seen.has(draft.rootId)) problem = '根计划标识缺失或重复，不能保存整组。';
      seen.add(draft.rootId);
      if (draft.tree.length !== 1 || draft.tree[0]?.key !== draft.rootId) problem = '草稿根节点与目标计划不匹配，不能保存整组。';
      const before = buildPublishedPlanEditorValue(notes, draft.rootId);
      if (!before) problem = `源计划“${draft.tree[0]?.title || draft.rootId || index + 1}”已不存在或不可编辑，不能跳过该计划。`;
      return { draft, before, problem, review: before && !problem ? buildReview(before, draft) : undefined };
    });
  }, [workingDrafts, notes]);
  const hasProblem = !reviews.length || reviews.some(item => item.problem || item.review?.rangeWarnings.length);
  const updateDraft = (rootId: string, value: PlanBuilderDraftValue) => {
    if (savingRef.current) return;
    const snapshot = structuredClone(value);
    const next = latestDrafts.current.map(draft => draft.rootId === rootId ? { ...draft, tree: snapshot.tree, planMeta: snapshot.planMeta } : draft);
    latestDrafts.current = next;
    setWorkingDrafts(next);
    setError(null);
    onDraftChange(rootId, structuredClone(snapshot));
  };
  const confirmAll = async () => {
    if (savingRef.current || !isActive || hasProblem || editingRootId) return;
    savingRef.current = true;
    setSaving(true); setError(null);
    try {
      // Clone at the explicit click, not after awaiting; external mutations cannot change the approved group.
      await onConfirm(structuredClone(latestDrafts.current));
    } catch (reason) {
      setError(`整组保存未完成：${reason instanceof Error ? reason.message : '请重试'}。所有计划草稿仍保留，请核对后重试整组保存。`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const editing = reviews.find(item => item.draft.rootId === editingRootId && !item.problem);
  return <section className={`plan-portfolio-editor${editing ? ' is-editing' : ''}`} aria-label="跨计划组合编辑" aria-busy={saving}>
    <header className="plan-portfolio-heading">
      <div><span className="plan-portfolio-kicker"><Layers3 aria-hidden="true" />组合草稿 · 尚未保存</span>
        <h2 ref={headingRef} tabIndex={-1}>{editing ? `编辑：${editing.draft.tree[0].title}` : '核对全部计划改动'}</h2>
        <p>{editing ? '此处只调整草稿。返回组合总览后，统一确认全部计划。' : `共 ${workingDrafts.length} 个根计划。请核对原日期、新日期及父级范围；只有下方的整组确认会保存。`}</p>
        <p>本次组合调整修改排期；结构变动请单独处理。</p>
      </div>
      {!editing && <button type="button" className="plan-portfolio-button" disabled={saving} onClick={() => { if (!savingRef.current) onCancel(); }}><ArrowLeft aria-hidden="true" />取消本次组合</button>}
    </header>
    {editing ? <div className="plan-portfolio-plan-builder">
      <PlanBuilder key={editing.draft.rootId} initialValue={editing.draft}
        draftValue={{ tree: editing.draft.tree, planMeta: editing.draft.planMeta, sourceLabel: '组合中的草稿 · 尚未保存' }}
        capacitySettings={capacitySettings} allPlanNotes={notes} isActive={isActive && !saving}
        onDraftChange={value => updateDraft(editing.draft.rootId, value)}
        onReviewPortfolio={value => { updateDraft(editing.draft.rootId, value); setEditingRootId(null); }}
        onBatchCreate={() => { throw new Error('组合中的计划不能单独保存，请返回组合总览。'); }} />
    </div> : <>
      <div className="plan-portfolio-cards">
        {!reviews.length && <p role="alert" className="plan-portfolio-error">当前组合没有可审核的计划，不能保存。</p>}
        {reviews.map(({ draft, before, problem, review }, index) => <article className="plan-portfolio-card" key={`${draft.rootId}-${index}`}>
          <header><div><small>计划 {index + 1} / {workingDrafts.length}</small><h3>{draft.tree[0]?.title || '无法识别的计划'}</h3></div>
            <button type="button" className="plan-portfolio-button" disabled={saving || !isActive || Boolean(problem)} aria-label={`编辑此计划：${draft.tree[0]?.title || draft.rootId}`}
              onClick={() => { if (!savingRef.current) { onFocusRoot?.(draft.rootId); setEditingRootId(draft.rootId); } }}><Pencil aria-hidden="true" />编辑此计划</button>
          </header>
          {problem ? <p className="plan-portfolio-error" role="alert">{problem}</p> : before && review && <>
            <div className="plan-portfolio-root-range"><span><small>原日期</small>{range(before.tree[0])}</span><ArrowRight aria-hidden="true" /><span><small>新日期</small>{range(draft.tree[0])}</span></div>
            <Changes title="结构项目 · 原日期 → 新日期" items={review.structure} />
            <Changes title="父级范围影响" items={review.parentRanges} />
            {!!review.rangeWarnings.length && <ul className="plan-portfolio-error" role="alert">{review.rangeWarnings.map(message => <li key={message}>{message}</li>)}</ul>}
            <Changes title="执行事项" items={review.execution} />
            <Changes title="重复规则" items={review.rules} />
            <Changes title="里程碑" items={review.milestoneChanges} />
            <section className="plan-portfolio-change-group" aria-label="条件与计划设置"><h4>条件与计划设置<span>{review.conditionChanges.length ? `${review.conditionChanges.length} 项变化` : '未改动'}</span></h4>
              {!!review.conditionChanges.length && <ul>{review.conditionChanges.map((message, i) => <li key={i}>{message}</li>)}</ul>}
            </section>
          </>}
        </article>)}
      </div>
      <footer className="plan-portfolio-confirm">
        {error && <p role="alert" className="plan-portfolio-error">{error}</p>}
        {!isActive && <p role="status">当前组合不在活动页面，暂不能提交。返回此页面后再确认。</p>}
        <p>{saving ? '正在保存整组计划，请保留此页面…' : '将一起保存上述全部计划，不会逐根保存。取消不会写入笔记。'}</p>
        <button type="button" className="plan-portfolio-button is-primary" disabled={saving || !isActive || hasProblem} onClick={confirmAll}>
          {saving ? <Loader2 className="plan-portfolio-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
          {saving ? `正在保存全部 ${workingDrafts.length} 个计划…` : `确认并保存全部 ${workingDrafts.length} 个计划`}
        </button>
      </footer>
    </>}
  </section>;
}
