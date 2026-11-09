import React, { useEffect, useState } from 'react';
import { Check, CircleAlert, Clock3, RotateCcw } from 'lucide-react';
import type { TextbookProgress } from '../../services/textbook/generationTypes';
import { TEXTBOOK_STEPS } from '../../services/textbook/progress';
import './TextbookProgressCard.css';

const statusLabels = { pending: '待执行', running: '进行中', saved: '已保存', failed: '失败', cancelled: '已停止', needs_repair: '待修复' };
const sectionLabels = { explanation: '概念与机制', boundaries: '适用边界', workedExample: '例子与反例', practice: '迁移练习', answer: '参考答案', selfCheck: '自检', summary: '本章小结' };
const thinkingLabels = { off: '关闭', low: '低档', medium: '中档', high: '高档' };
function duration(start: string, end: number): string {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000)) || 0;
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
export function TextbookProgressCard({ progress, disabled, onResume, restoreError }: {
  progress: TextbookProgress; disabled: boolean; onResume: (jobId: string) => void; restoreError?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!progress.running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [progress.running]);
  const published = progress.jobStage === 'published';
  const clock = progress.running ? now : Date.parse(progress.updatedAt);
  const stageTitle = TEXTBOOK_STEPS.find((step) => step.stage === progress.currentStage)?.title;
  // This exception is emitted only after code has revalidated the saved book;
  // request/token limits and actual generation still enforce their original caps.
  const continueValidation = progress.resumeAfterCodeFix === true && (!progress.cost?.stopped || progress.cost.stopped === 'repairs');
  const budgetStopped = !!progress.cost?.stopped && !continueValidation;
  const headline = progress.archived ? '教材任务已归档' : published ? '教材已写入' : progress.running ? '教材生成中' : budgetStopped ? '教材已达预算上限' : progress.requiresReprepare ? '教材需要重新准备' : progress.jobStage === 'prepared' ? '教材等待确认' : '教材等待继续';
  const blueprintPreference = progress.thinkingPreferences?.['textbook-blueprint'];
  const chapterPreference = progress.thinkingPreferences?.['textbook-chapter'];
  const qualityPreference = progress.thinkingPreferences?.['textbook-quality'];
  return <section className="textbook-progress-card" aria-label="教材生成进度" data-job-id={progress.jobId}>
    <header><strong>{headline}</strong><span>{progress.total ? `已保存 ${progress.completed}/${progress.total} 章` : '尚未生成章节'}</span></header>
    <p className="textbook-progress-project">{progress.projectTitle}</p>
    <p className="textbook-progress-project">任务：{progress.jobId}</p>
    {progress.modelPolicyVersion && <p>任务策略 v{progress.modelPolicyVersion} · 蓝图思考{blueprintPreference ? `手动${thinkingLabels[blueprintPreference]}` : progress.thinkingModes?.blueprint === 'enabled' ? '启用' : '关闭'} · 章节{progress.complexChapterThinkingLimit ? '默认' : ''}思考{chapterPreference ? `手动${thinkingLabels[chapterPreference]}` : progress.thinkingModes?.chapter === 'enabled' ? '启用' : '关闭'}
      {qualityPreference ? ` · 质检思考手动${thinkingLabels[qualityPreference]}` : ''}
      {progress.complexChapterThinkingLimit ? ` · 复杂章节按需启用（最多 ${progress.complexChapterThinkingLimit} 章）` : ''}</p>}
    {progress.thinkingAdjustmentNotes?.map((note, index) => <p key={`thinking-note-${index}`} role="status">{note}</p>)}
    {(progress.modelPolicyVersion === 2 || progress.modelPolicyVersion === 3) && !progress.thinkingPreferences && <p role="status">此任务保留原批准的关闭思考策略；如需蓝图思考与复杂章节按需思考，请重新准备并确认新任务，已有草稿不会自动切换。</p>}
    {progress.modelPolicyVersion === 1 && <p role="status">这是旧版任务，仍按原批准策略执行；重启或继续不会自动切换新版。若需关闭思考，请停止后重新准备并确认。</p>}
    <ol className="textbook-progress-steps" aria-label="固定生成阶段">{progress.steps.map((step, index) => {
      const status = step.status === 'running' && !progress.running ? 'cancelled' : step.status;
      return <li key={step.stage} data-status={status} aria-current={progress.running && step.stage === progress.currentStage ? 'step' : undefined}>
        <span className="textbook-step-icon" aria-hidden="true">{status === 'saved' ? <Check /> : status === 'failed' ? <CircleAlert /> : index + 1}</span>
        <span>{TEXTBOOK_STEPS[index].title}<small>{status === 'cancelled' && step.status === 'running' ? '待继续' : statusLabels[status]}</small></span>
      </li>;
    })}</ol>
    <div className="textbook-progress-current" role="status" aria-live="polite" aria-atomic="true">
      <strong>{progress.running || published ? progress.label : budgetStopped ? '已停止追加请求，检查点保留' : progress.requiresReprepare ? `${stageTitle}已达到截断重试上限，检查点保留` : `${stageTitle}阶段已保留，确认后继续`}</strong>
      {progress.chapterId && <span>当前第 {progress.chapterIndex}/{progress.total} 章：{progress.chapterTitle}</span>}
      {progress.retry > 0 && <span>当前调用重试 {progress.retry}/{progress.retryLimit}；不重做已完成阶段</span>}
      {progress.running && progress.requestMaxTokens && <span>本次发送额度：{progress.requestMaxTokens} tokens · {progress.requestThinkingResolved
        ? `实际思考${progress.requestThinkingMode === 'enabled' ? '启用' : progress.requestThinkingMode === 'disabled' ? '关闭' : '由模型控制'}${progress.requestThinkingMode === 'enabled'
          ? progress.requestReasoningEffort && progress.requestThinkingLevel && progress.requestThinkingLevel !== 'off' ? ` · ${thinkingLabels[progress.requestThinkingLevel]}` : '（模型默认档位）' : ''}`
        : `请求思考${progress.requestThinkingMode === 'enabled' ? '启用' : '关闭'}`}</span>}
    </div>
    <div className="textbook-progress-time"><Clock3 aria-hidden="true" /><span>本轮 {duration(progress.startedAt, clock)} · 当前步骤 {duration(progress.stageStartedAt, clock)} · 第 {progress.attempt} 次执行</span></div>
    {progress.error && <p className="textbook-progress-error">{progress.error}</p>}
    {progress.qualityReview?.status === 'needs_recheck' && <p role="status">需要纠正的是复核报告的定位；已保存章节保留，继续时只重新复核。
      {progress.qualityReview.reportIssues?.map((issue, index) => <span key={index}> 第 {issue.findingIndex} 条意见{issue.chapterId ? `（${progress.chapters.find(chapter => chapter.id === issue.chapterId)?.title || issue.chapterId}${issue.section ? ` · ${sectionLabels[issue.section]}` : ''}）` : ''}：{issue.field.startsWith('target.') ? '教材位置' : issue.field.startsWith('basis[') ? `第 ${Number(issue.field.match(/\[(\d+)\]/u)?.[1]) + 1} 个依据位置` : '意见格式'}未能核验。</span>)}
    </p>}
    {!!progress.qualityReview?.ignoredAdviceCount && <p>已忽略 {progress.qualityReview.ignoredAdviceCount} 条无法定位的非阻断建议，不因此重写教材或追加复核请求。</p>}
    {!!progress.localMaterialWarnings?.length && <details><summary>物料读取与可选联网补缺提示</summary><ul>{progress.localMaterialWarnings.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
    {progress.supplementStatus && <p>可选联网补缺：{progress.supplementStatus.searches} 次查询，加入 {progress.supplementStatus.sources} 个来源{progress.supplementStatus.warnings ? '；部分补充未取得，已跳过，不阻断已有物料生成' : ''}。</p>}
    {!!progress.materialStatus?.length && <details><summary>已绑定 URL 读取情况（{progress.materialStatus.filter((item) => item.status === 'saved').length}/{progress.materialStatus.length} 已保存）</summary>
      <ul>{progress.materialStatus.map((item) => <li key={item.id}>{item.title}：{item.status === 'saved' ? '正文快照已保存，后续复用' : `未读取 · ${item.error}`}</li>)}</ul>
    </details>}
    {progress.cost && <div aria-label="教材累计用量">
      <p>累计输入 {progress.cost.promptTokens.toLocaleString()} · 输出 {progress.cost.completionTokens.toLocaleString()} tokens（输出已含思考，不重复累计）
        {progress.cost.reservedTokens > 0 && ` · 待确认用量估算 ${progress.cost.reservedTokens.toLocaleString()}`}</p>
      <p>请求 {progress.cost.requests}/{progress.cost.limits.maxRequests} 次 · 内容修订 {progress.cost.repairRounds}/{progress.cost.limits.maxRepairRounds} 轮 · 报告重检 {progress.cost.reviewRechecks}/{progress.cost.limits.maxReviewRechecks} 次</p>
      <small>累计控制上限 {progress.cost.limits.maxTotalTokens.toLocaleString()} tokens；包含输入和输出，未返回用量的请求按估算保留，不是账单。
        {progress.cost.legacyUsageIncomplete && ' 旧任务升级前仅能恢复部分响应用量。'}</small>
    </div>}
    {budgetStopped && <p role="status">预算不会因重试或重启而重置。请在对话中检查失败位置、缩小修订范围或调整生成方案；不会自动重写整本教材。</p>}
    {continueValidation && <p role="status">旧类型错误已修复，全部章节保留；仅继续质量校验，不重新生成章节。已消耗的修订次数不重置，请求与 token 上限继续生效。</p>}
    {progress.archived && <p role="status">任务草稿与已生成章节保留在本机，不永久删除。可在对话中要求恢复该任务；恢复不重置累计用量。</p>}
    {progress.modelDiagnostics && <p>最近响应对应额度：{progress.modelDiagnostics.maxTokens} tokens · 正文 {progress.modelDiagnostics.outputChars} 字符
      {progress.modelDiagnostics.completionTokens !== undefined && ` · 实际生成 ${progress.modelDiagnostics.completionTokens} tokens`}
      {progress.modelDiagnostics.reasoningTokens !== undefined ? `（其中思考 ${progress.modelDiagnostics.reasoningTokens} tokens）` : progress.modelDiagnostics.hadReasoningContent ? '（服务商返回了思考内容，未报告思考 token 数）' : ''}</p>}
    {progress.requiresReprepare && <p role="status">请在对话中要求“使用新版教材策略重新准备”，核对范围后确认；不会自动重复已耗尽的请求。</p>}
    {!!progress.repairTargets?.length && <p>待修复：{progress.repairTargets.map((target) => target.stage === 'blueprint' ? '教学蓝图及受影响章节' : target.stage === 'validating' ? '质量复核定位（保留蓝图与章节）'
      : `${progress.chapters.find((chapter) => chapter.id === target.chapterId)?.title || target.chapterId}${target.section ? ` · ${sectionLabels[target.section]}` : ''}`).join('；')}</p>}
    {restoreError && <p className="textbook-progress-error">进度读取失败：{restoreError}。当前显示最后一次已知状态。</p>}
    {!!progress.chapters.length && <details><summary>查看章节检查点</summary><ol className="textbook-progress-chapters">{progress.chapters.map((chapter, index) => <li key={chapter.id}><span>{index + 1}. {chapter.title}</span><small>{statusLabels[chapter.status]}</small></li>)}</ol></details>}
    {!!progress.history.length && <details><summary>查看最近阶段记录</summary><ol className="textbook-progress-history">{progress.history.map((item, index) => <li key={`${item.at}-${index}`}><time>{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{Date.parse(item.at) < Date.parse(progress.startedAt) ? '此前执行：' : '本轮：'}{item.label}</span></li>)}</ol></details>}
    <footer><small>{published ? '完整教材已落盘，可进入心流学习。' : '检查点保存在本机；完整校验通过后才写入笔记。'}</small>
      {!progress.archived && !progress.running && !published && !progress.requiresReprepare && !budgetStopped && <button type="button" disabled={disabled} onClick={() => onResume(progress.jobId)}><RotateCcw aria-hidden="true" />{continueValidation ? '从原稿继续校验（需确认）' : '从检查点继续（需确认）'}</button>}
    </footer>
  </section>;
}
