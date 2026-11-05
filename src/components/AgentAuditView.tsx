import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialog } from './useDialog';
import './AgentAuditView.css';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Blocks,
  CheckCircle2,
  ClipboardEdit,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  clearAgentAuditDashboard,
  loadAgentAuditDashboard,
  type AgentAuditDashboardSnapshot,
  type AuditCountItem,
} from '../services/agent/auditDashboard';

type AuditTab = 'overview' | 'acceptance' | 'agent' | 'handoff' | 'scene';

const STATUS_LABELS: Record<string, string> = {
  completed: '已完成', failed: '失败', truncated: '达到上限', running: '运行中',
  'pending-approval': '待确认', pending: '待确认', approved: '已批准', rejected: '已取消',
  created: '已生成', accepted: '已接受', dismissed: '已忽略', superseded: '已替换',
  arrived: '已到达', 'route-mismatch': '路由不匹配', ready: '可运行', blocked: '已阻断',
  'text-fallback': '文本降级', none: '无交互',
  passed: '通过', incomplete: '未完成', 'not-run': '未运行',
};

const STAGE_LABELS: Record<string, string> = { plan: '计划', scene: '场景', review: '复习' };

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (['completed', 'approved', 'arrived', 'ready', 'accepted', 'passed'].includes(status)) return 'good';
  if (['pending', 'pending-approval', 'running', 'created', 'text-fallback', 'truncated', 'incomplete'].includes(status)) return 'warn';
  if (['failed', 'rejected', 'route-mismatch', 'blocked', 'none'].includes(status)) return 'bad';
  return 'neutral';
}

const Metric: React.FC<{ label: string; value: string | number; detail?: string; tone?: 'good' | 'warn' | 'bad' }> = ({ label, value, detail, tone }) => (
  <div className={`agent-audit-metric${tone ? ` is-${tone}` : ''}`}>
    <span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}
  </div>
);

const Counts: React.FC<{ items: AuditCountItem[]; empty: string }> = ({ items, empty }) => (
  <div className="agent-audit-counts">
    {items.length ? items.map((item) => (
      <div key={item.key}><span title={item.key}>{item.key}</span><strong>{item.count}</strong></div>
    )) : <p className="agent-audit-empty-line">{empty}</p>}
  </div>
);

export const AgentAuditView: React.FC<{
  onBack: () => void;
  onUseAcceptancePrompt?: (prompt: string) => void;
}> = ({ onBack, onUseAcceptancePrompt }) => {
  const [tab, setTab] = useState<AuditTab>('overview');
  const [snapshot, setSnapshot] = useState<AgentAuditDashboardSnapshot | null>(null);
  const [operation, setOperation] = useState<'read' | 'clear' | null>('read');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const loading = operation !== null;
  useDialog(confirmClear, confirmRef, () => { if (!busy.current) setConfirmClear(false); });

  const refresh = useCallback(async (fromButton = false) => {
    if (busy.current) return;
    busy.current = true;
    focusAfter.current = fromButton;
    setOperation('read');
    setError('');
    try {
      const next = await loadAgentAuditDashboard();
      if (mounted.current) setSnapshot(next);
    } catch {
      if (mounted.current) setError('读取审计记录失败，已显示的内容可能不是最新。请重新读取；不会自动清除或覆盖记录。');
    } finally {
      busy.current = false;
      if (mounted.current) setOperation(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (loading || !focusAfter.current) return;
    focusAfter.current = false;
    if (document.activeElement === document.body) refreshRef.current?.focus();
  }, [loading]);

  const clearAll = async () => {
    if (busy.current || !confirmClear) return;
    busy.current = true;
    focusAfter.current = true;
    setOperation('clear');
    setError('');
    setNotice('');
    let cleared = false;
    try {
      await clearAgentAuditDashboard();
      cleared = true;
      if (!mounted.current) return;
      // A successful clear invalidates the previous snapshot, even if rereading fails.
      setSnapshot(null);
      setConfirmClear(false);
      setOperation('read');
      const next = await loadAgentAuditDashboard();
      if (mounted.current) {
        setSnapshot(next);
        setNotice('本次审计记录已清除；正在运行的活动仍可能产生新记录。');
      }
    } catch {
      if (mounted.current) {
        setConfirmClear(false);
        setError(cleared ? '清除已成功，但重新读取失败。请重新读取，无需再次清除。'
          : '审计记录未全部清除，部分记录可能已清除。请重新读取后核对，再决定是否清除。');
        setNotice(cleared ? '本次清除已获得保存回执。' : '上次清除未全部成功，请核对重新读取的结果。');
      }
    } finally {
      busy.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const tabs: Array<{ id: AuditTab; label: string }> = [
    { id: 'overview', label: '概览' }, { id: 'acceptance', label: '验收' }, { id: 'agent', label: 'Agent' },
    { id: 'handoff', label: '移交' }, { id: 'scene', label: '场景' },
  ];

  return (
    <section className="agent-audit-view audit-workspace" aria-label="Agent 本地运行审计">
      <div className="agent-audit-toolbar">
        <button type="button" onClick={onBack} disabled={operation === 'clear'}><ArrowLeft aria-hidden="true" />返回对话</button>
        <span><strong>本地运行审计</strong><small>{snapshot ? `更新于 ${formatTime(snapshot.generatedAt)}` : loading ? '正在读取' : error ? '读取未完成' : '尚无记录'}</small></span>
        <button ref={refreshRef} type="button" onClick={() => void refresh(true)} disabled={loading || confirmClear}><RefreshCw className={loading ? 'is-spinning' : ''} aria-hidden="true" />{loading ? operation === 'clear' ? '清除中…' : '读取中…' : '重新读取'}</button>
      </div>

      <div ref={tabsRef} className="agent-audit-tabs" role="tablist" aria-label="审计分类">
        {tabs.map((item) => (
          <button key={item.id} id={`${id}-${item.id}`} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1}
            type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} onKeyDown={event => {
              if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const current = tabs.findIndex(value => value.id === item.id);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{item.label}</button>
        ))}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0} className="agent-audit-scroll">
        {loading && <div role="status" className="agent-audit-state"><RefreshCw className="is-spinning" aria-hidden="true" /><span>{operation === 'clear' ? '正在清除审计记录…' : snapshot ? '正在重新读取，保留上次内容供查看。' : '正在读取本地审计记录…'}</span></div>}
        {error && <div role="alert" className="agent-audit-state is-error"><AlertTriangle aria-hidden="true" /><span>{error}</span></div>}
        {notice && <p role="status" className="agent-audit-notice">{notice}</p>}
        {snapshot && tab === 'overview' && (
          <>
            <div className="agent-audit-metrics">
              <Metric label="Agent 运行" value={snapshot.agent.total} detail={`${snapshot.agent.completionRate}% 完成`} />
              <Metric label="端到端验收" value={`${snapshot.acceptance.passed}/${snapshot.acceptance.total}`} detail={`${snapshot.acceptance.passRate}% 通过`} tone={snapshot.acceptance.failed ? 'bad' : snapshot.acceptance.incomplete || snapshot.acceptance.notRun ? 'warn' : 'good'} />
              <Metric label="工具失败" value={snapshot.agent.toolFailures} detail={`${snapshot.agent.toolCalls} 次调用`} tone={snapshot.agent.toolFailures ? 'bad' : 'good'} />
              <Metric label="移交到达" value={`${snapshot.handoff.arrivalRate}%`} detail={`${snapshot.handoff.totalAccepted} 次接受`} />
            </div>
            <section className="agent-audit-card">
              <h3><ShieldCheck aria-hidden="true" />需要关注</h3>
              <div className="agent-audit-health-list">
                <div className={snapshot.agent.failed + snapshot.agent.truncated ? 'is-bad' : 'is-good'}><span>Agent 失败 / 达到上限</span><strong>{snapshot.agent.failed + snapshot.agent.truncated}</strong></div>
                <div className={snapshot.agent.coordinationDegraded ? 'is-warn' : 'is-good'}><span>专家编排降级</span><strong>{snapshot.agent.coordinationDegraded}</strong></div>
                <div className={snapshot.handoff.totalRouteMismatch + snapshot.handoff.totalFailed ? 'is-bad' : 'is-good'}><span>移交路由异常</span><strong>{snapshot.handoff.totalRouteMismatch + snapshot.handoff.totalFailed}</strong></div>
                <div className={snapshot.assembly.blocked ? 'is-bad' : 'is-good'}><span>场景装配阻断</span><strong>{snapshot.assembly.blocked}</strong></div>
              </div>
            </section>
            <section className="agent-audit-card">
              <h3><Activity aria-hidden="true" />Skill 运行分布</h3>
              <div className="agent-audit-skill-list">
                {snapshot.agent.skills.length ? snapshot.agent.skills.slice(0, 6).map((skill) => (
                  <div key={skill.id}><span><strong>{skill.name}</strong><small>{skill.completed} 次完成 · {skill.issues} 次异常</small></span><b>{skill.runs}</b></div>
                )) : <p className="agent-audit-empty-line">暂无 Agent 运行记录</p>}
              </div>
            </section>
          </>
        )}

        {snapshot && tab === 'acceptance' && (
          <>
            <div className="agent-audit-metrics">
              <Metric label="已通过" value={snapshot.acceptance.passed} tone="good" />
              <Metric label="失败" value={snapshot.acceptance.failed} tone={snapshot.acceptance.failed ? 'bad' : 'good'} />
              <Metric label="未完成" value={snapshot.acceptance.incomplete} tone={snapshot.acceptance.incomplete ? 'warn' : undefined} />
              <Metric label="尚无样本" value={snapshot.acceptance.notRun} />
            </div>
            <section className="agent-audit-card">
              <h3><CheckCircle2 aria-hidden="true" />真实 Provider 验收基线</h3>
              <p className="agent-audit-empty-line">测试指令只会填入输入框，不会自动发送或写入；发送后仍遵守联网和写操作确认。</p>
              <div className="agent-acceptance-list">
                {snapshot.acceptance.scenarios.map((scenario) => (
                  <article key={scenario.id}>
                    <div className="agent-acceptance-head">
                      <span>
                        <strong>{scenario.name}</strong>
                        <small>{scenario.updatedAt ? formatTime(scenario.updatedAt) : '尚未取得真实运行样本'}{scenario.issues.length ? ` · ${scenario.issues[0]}` : ''}</small>
                      </span>
                      <b className={`is-${statusTone(scenario.status)}`}>{STATUS_LABELS[scenario.status] || scenario.status}</b>
                    </div>
                    <details>
                      <summary>查看测试要求与结果</summary>
                      <ul aria-label={`${scenario.name}前置条件`}>
                        {scenario.prerequisites.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                      {scenario.checks.length > 0 && (
                        <ul className="agent-acceptance-checks" aria-label={`${scenario.name}验收结果`}>
                          {scenario.checks.map((check) => (
                            <li key={check.id} className={check.passed ? 'is-good' : 'is-bad'}>
                              {check.passed ? '通过' : '未通过'} · {check.label}{check.detail ? `：${check.detail}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                      {scenario.testPrompt && onUseAcceptancePrompt && (
                        <button type="button" onClick={() => onUseAcceptancePrompt(scenario.testPrompt || '')}>
                          <ClipboardEdit aria-hidden="true" />填入测试指令
                        </button>
                      )}
                    </details>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}

        {snapshot && tab === 'agent' && (
          <>
            <div className="agent-audit-metrics">
              <Metric label="已完成" value={snapshot.agent.completed} tone="good" />
              <Metric label="失败" value={snapshot.agent.failed} tone={snapshot.agent.failed ? 'bad' : 'good'} />
              <Metric label="待确认" value={snapshot.agent.pendingApproval} tone={snapshot.agent.pendingApproval ? 'warn' : undefined} />
              <Metric label="内部编排" value={snapshot.agent.coordinationRuns} detail={`${snapshot.agent.coordinationDegraded} 次降级`} />
              <Metric label="主 Agent 请求" value={snapshot.agent.llmCalls} detail={`${snapshot.agent.promptTokens + snapshot.agent.completionTokens} tokens`} />
            </div>
            <section className="agent-audit-card"><h3><AlertTriangle aria-hidden="true" />工具失败分布</h3><Counts items={snapshot.agent.toolFailureNames} empty="暂无工具失败" /></section>
            <section className="agent-audit-card">
              <h3><Activity aria-hidden="true" />最近运行</h3>
              <div className="agent-audit-event-list">
                {snapshot.agent.recentRuns.length ? snapshot.agent.recentRuns.map((run) => (
                  <div key={run.id}><span><strong>{run.skillName}</strong><small>{formatTime(run.updatedAt)} · {run.toolCalls} 次工具{run.toolFailures ? ` · ${run.toolFailures} 次失败` : ''}</small></span><b className={`is-${statusTone(run.status)}`}>{STATUS_LABELS[run.status] || run.status}</b></div>
                )) : <p className="agent-audit-empty-line">暂无运行记录</p>}
              </div>
            </section>
          </>
        )}

        {snapshot && tab === 'handoff' && (
          <>
            <div className="agent-audit-metrics">
              <Metric label="已生成" value={snapshot.handoff.totalCreated} />
              <Metric label="接受率" value={`${snapshot.handoff.acceptanceRate}%`} />
              <Metric label="到达率" value={`${snapshot.handoff.arrivalRate}%`} />
              <Metric label="路由异常" value={snapshot.handoff.totalRouteMismatch + snapshot.handoff.totalFailed} tone={snapshot.handoff.totalRouteMismatch + snapshot.handoff.totalFailed ? 'bad' : 'good'} />
            </div>
            <section className="agent-audit-card">
              <h3><Route aria-hidden="true" />已接受路线</h3>
              <div className="agent-audit-route-list">
                {snapshot.handoff.routes.length ? snapshot.handoff.routes.map((route) => (
                  <div key={`${route.sourceStage}-${route.targetSkillId}`}><span>{STAGE_LABELS[route.sourceStage] || route.sourceStage} → {route.targetSkillId}</span><strong>{route.arrived}/{route.accepted} 到达</strong></div>
                )) : <p className="agent-audit-empty-line">暂无已接受的流程移交</p>}
              </div>
            </section>
            <section className="agent-audit-card">
              <h3><Activity aria-hidden="true" />最近移交事件</h3>
              <div className="agent-audit-event-list">
                {snapshot.handoff.recent.length ? snapshot.handoff.recent.map((event) => (
                  <div key={event.id}><span><strong>{STAGE_LABELS[event.sourceStage] || event.sourceStage} → {event.expectedTargetSkillId || event.actualTargetSkillId || '候选 Skill'}</strong><small>{formatTime(event.createdAt)}</small></span><b className={`is-${statusTone(event.status)}`}>{STATUS_LABELS[event.status] || event.status}</b></div>
                )) : <p className="agent-audit-empty-line">暂无移交事件</p>}
              </div>
            </section>
          </>
        )}

        {snapshot && tab === 'scene' && (
          <>
            <div className="agent-audit-metrics">
              <Metric label="交互回合" value={snapshot.interaction.total} />
              <Metric label="已采用组件" value={snapshot.interaction.accepted} tone="good" />
              <Metric label="文本降级" value={snapshot.interaction.textFallbacks} tone={snapshot.interaction.textFallbacks ? 'warn' : 'good'} />
              <Metric label="装配阻断" value={snapshot.assembly.blocked} tone={snapshot.assembly.blocked ? 'bad' : 'good'} />
            </div>
            <section className="agent-audit-card"><h3><Blocks aria-hidden="true" />交互诊断</h3><Counts items={snapshot.interaction.topReasons} empty="暂无交互诊断" /></section>
            <section className="agent-audit-card"><h3><AlertTriangle aria-hidden="true" />装配诊断</h3><Counts items={snapshot.assembly.topDiagnostics} empty="暂无装配诊断" /></section>
            <section className="agent-audit-card">
              <h3><CheckCircle2 aria-hidden="true" />最近场景装配</h3>
              <div className="agent-audit-event-list">
                {snapshot.assembly.recent.length ? snapshot.assembly.recent.map((event) => (
                  <div key={event.id}><span><strong>{event.sceneSkill} · {event.recipeId || '旧版场景'}</strong><small>{formatTime(event.createdAt)} · {event.surface || '未知运行面'}</small></span><b className={`is-${statusTone(event.outcome)}`}>{STATUS_LABELS[event.outcome] || event.outcome}</b></div>
                )) : <p className="agent-audit-empty-line">暂无场景装配记录</p>}
              </div>
            </section>
          </>
        )}
      </div>

      <footer className="agent-audit-footer">
        <p><ShieldCheck aria-hidden="true" />仅展示状态、Skill、工具和诊断码，不展示对话、笔记正文或提示词。</p>
        <button type="button" className="agent-audit-clear" onClick={() => { if (!busy.current) setConfirmClear(true); }} disabled={loading || Boolean(error) || !snapshot}><Trash2 aria-hidden="true" />清除审计记录</button>
      </footer>
      {confirmClear && <div className="agent-audit-confirm-layer">
        <div ref={confirmRef} tabIndex={-1} className="agent-audit-clear-confirm" role="dialog" aria-modal="true" aria-labelledby={`${id}-clear-title`} aria-describedby={`${id}-clear-description`}>
          <h3 id={`${id}-clear-title`}>清除本地审计记录？</h3>
          <p id={`${id}-clear-description`}>会移除 Agent 运行、流程移交和场景诊断记录，无法撤销。不会删除笔记、计划或学习记录，也不会停止正在运行的活动。</p>
          <div><button type="button" onClick={() => { if (!busy.current) setConfirmClear(false); }} disabled={loading}>保留记录</button>
            <button type="button" className="is-danger" onClick={() => void clearAll()} disabled={loading}>{operation === 'clear' ? '清除中…' : '确认清除'}</button></div>
        </div>
      </div>}
    </section>
  );
};
