/**
 * 一对一对话页：按 speakerType 分样式渲染 5 类消息，支持手动注入突发事件。
 * 流式增量由 onStreamUpdate 驱动，本组件只负责渲染与输入。
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Send, Loader2, Zap, Square, RotateCcw, Trophy, XCircle,
  PanelLeftClose, PanelLeftOpen, Target, Clock3, UserRound, Bot,
  BookOpen, CircleHelp, Flag,
} from 'lucide-react';
import { SceneSpec, SceneRunState, SceneMessage, SceneInteractionResponse } from '../../types';
import { SceneMetricPanel } from './SceneMetricPanel';
import { SceneRichMessage } from './SceneRichMessage';
import { SceneExperimentLedger } from './SceneExperimentLedger';
import { SceneDynamicForm } from './SceneDynamicForm';
import { resolveSceneInputAvailability } from '../../services/scene/sceneInputAvailability';
import { isSupportedStructuredInteraction, SceneInteractionInput } from './SceneInteractionInput';
import { getUnifiedSceneRecipe } from '../../services/scene/sceneCapabilityRegistry';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from '../../services/scene/sceneRuntimeContract';
import { getPendingSceneInteraction } from '../../services/scene/scenePendingTask';
import { useDialog } from '../useDialog';
import { SceneWidgetContent, SceneWidgetErrorBoundary } from './SceneWidgetErrorBoundary';

const isNarrowRoleRail = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;

interface Props {
  spec: SceneSpec;
  run: SceneRunState;
  sending: boolean;
  onSend: (text: string, interactionResponse?: SceneInteractionResponse, formSubmission?: import('../../types').SceneFormSubmission, inputKind?: 'response' | 'conversation') => void;
  onInjectEvent: (text: string) => void;
  onEnd: () => void;
  onExit?: () => void;
  onRerun: () => void;
  hasPrevRun: boolean;
  onOpenNote?: (noteId: string) => void;
  /** 仅在本局终态显示；任务完成与退出场景是两个独立操作。 */
  completionContent?: React.ReactNode;
  turnError?: string;
  partialReply?: string;
  onRetryTurn?: () => void;
  onReviseTurn?: () => void;
}

export const SceneChatView: React.FC<Props> = ({
  spec, run, sending, onSend, onInjectEvent, onEnd, onExit, onRerun, hasPrevRun, onOpenNote, completionContent,
  turnError, partialReply, onRetryTurn, onReviseTurn,
}) => {
  const [input, setInput] = useState('');
  const [conversationInput, setConversationInput] = useState('');
  const [showEventBox, setShowEventBox] = useState(false);
  const [eventText, setEventText] = useState('');
  const [narrowRoleRail, setNarrowRoleRail] = useState(isNarrowRoleRail);
  const [roleRailCollapsed, setRoleRailCollapsed] = useState(isNarrowRoleRail);
  const roleRailRef = useRef<HTMLElement>(null);
  const roleDrawerOpen = narrowRoleRail && !roleRailCollapsed;
  useDialog(roleDrawerOpen, roleRailRef, () => setRoleRailCollapsed(true));
  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const update = () => {
      setNarrowRoleRail(media.matches);
      if (media.matches) setRoleRailCollapsed(true);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const turnErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (turnError) turnErrorRef.current?.focus({ preventScroll: false }); }, [turnError]);

  // 新消息自动滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.messages.length, run.messages[run.messages.length - 1]?.content]);

  const finished = run.status !== 'running';
  const inputAvailability = resolveSceneInputAvailability(spec, run);
  const inputForm = inputAvailability.inputForm;
  const canInject = spec.eventInjection && isScenePromptModuleEnabled(spec, 'event-system') && !finished && !turnError;
  const contract = resolveSceneRuntimeContract(spec);
  const activeInteraction = getPendingSceneInteraction(run)?.interaction;
  const activeStructuredInteraction = isSupportedStructuredInteraction(activeInteraction) ? activeInteraction : undefined;
  const showConversationInput = !finished && contract.allowConversation
    && Boolean(activeInteraction || inputAvailability.formConfigured || !contract.allowTextFallback);
  const conversationInputId = 'scene-conversation-input-' + run.runId;
  const focusConversation = showConversationInput
    ? () => {
      setRoleRailCollapsed(true);
      window.requestAnimationFrame(() => document.getElementById(conversationInputId)?.focus());
    }
    : undefined;
  const recipe = getUnifiedSceneRecipe(spec.capabilityRecipeId || spec.behavior?.recipeId);
  const openAnswerMode = !activeStructuredInteraction
    && !finished
    && (activeInteraction?.type === 'text' || recipe?.id === 'socratic-dialogue');
  const choicePresentation = recipe?.id === 'decision-simulation' ? 'strategy' : 'answer';
  const remainingTurns = Math.max(0, spec.completion.maxTurns - run.turnCount);
  const displayedTurn = Math.min(run.turnCount, spec.completion.maxTurns);
  const progressSteps = Math.min(spec.completion.maxTurns, 10);
  const completedSteps = spec.completion.maxTurns > 0
    ? Math.min(progressSteps, Math.ceil((run.turnCount / spec.completion.maxTurns) * progressSteps))
    : 0;

  const submit = () => {
    const t = input.trim();
    if (!t || sending || finished || turnError) return;
    if (activeInteraction?.type === 'text') {
      onSend(t, {
        interactionId: activeInteraction.id,
        type: 'text',
        value: t,
        submittedAt: new Date().toISOString(),
      });
    } else {
      onSend(t);
    }
    setInput('');
  };

  const submitConversation = () => {
    const text = conversationInput.trim();
    if (!text || !contract.allowConversation || sending || finished || turnError) return;
    onSend(text, undefined, undefined, 'conversation');
    setConversationInput('');
  };

  const submitEvent = () => {
    const t = eventText.trim();
    if (!t || !canInject || sending) return;
    onInjectEvent(t);
    setEventText('');
    setShowEventBox(false);
  };

  const renderMsg = (m: SceneMessage) => {
    // 动作描写：斜体灰字，居中细排，与对话正文区分
    if (m.speakerType === 'action') {
      return <div key={m.id} className="scene-msg-action">{m.content}</div>;
    }
    if (m.speakerType === 'system') {
      return <div key={m.id} className="scene-msg-system">{m.content}</div>;
    }
    if (m.speakerType === 'event') {
      return (
        <div key={m.id} className="scene-msg-event">
          <Zap className="w-3.5 h-3.5" />
          <div>
            <div className="scene-msg-event-tag">突发事件</div>
            <div>{m.content}</div>
          </div>
        </div>
      );
    }
    const isUser = m.speakerType === 'user';
    const speakerName = m.speakerName || spec.behavior?.kind || spec.role.name || 'NPC';
    return (
      <div key={m.id} className={`scene-msg-row ${isUser ? 'is-user' : 'is-role'}`}>
        {!isUser && (
          <div className="scene-msg-speaker">
            <span className="scene-msg-speaker-avatar">{speakerName.slice(0, 1)}</span>
            <span className="scene-msg-speaker-rule" aria-hidden="true" />
            <div>
              <strong>{speakerName}</strong>
              <small>AI 角色 · 当前发言</small>
            </div>
          </div>
        )}
        <div className="scene-msg-bubble">
          {m.isStreaming && !m.content.trim() ? (
            <div className="scene-msg-waiting" role="status" aria-live="polite">
              <span className="scene-msg-waiting-mark"><Loader2 className="animate-spin" /></span>
              <span><strong>正在组织回应</strong><small>结合本轮信息生成下一步反馈</small></span>
              <span className="scene-msg-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
            </div>
          ) : (
            <div
              className="scene-msg-text"
              data-selection-surface={!isUser ? 'scene' : undefined}
              data-selection-source-id={!isUser ? m.id : undefined}
              data-selection-context-id={!isUser ? run.runId : undefined}
              data-selection-source-title={!isUser ? spec.meta.name : undefined}
            >
              <SceneRichMessage content={m.content} citations={m.citations} onOpenNote={onOpenNote} externalLinksDisabled />
              {m.isStreaming && <span className="scene-caret" />}
            </div>
          )}
          {m.metricDeltas && m.metricDeltas.length > 0 && (
            <div className="scene-msg-deltas">
              {m.metricDeltas.map((d) => (
                <span key={d.metricId} className="scene-msg-delta" title={d.reason}>
                  {d.metricName} {String(d.delta)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="scene-chat scene-s1-stage">
      <header className="scene-chat-head scene-s1-head">
        <SceneWidgetErrorBoundary key={run.runId + ':heading'} widget="heading" label="场景信息" onFocusConversation={focusConversation}>
        <SceneWidgetContent>{() => (
        <div className="scene-s1-heading">
          <span className="scene-s1-kicker">S1 · {recipe?.label || spec.behavior?.kind || '对话场景'}</span>
          <div className="scene-chat-title">{spec.meta.name}</div>
          <div className="scene-chat-sub">{spec.situation}</div>
        </div>
        )}</SceneWidgetContent>
        </SceneWidgetErrorBoundary>
        <div className="scene-s1-rounds" aria-label={`第 ${displayedTurn} / ${spec.completion.maxTurns} 回合`}>
          <span>回合 {displayedTurn} / {spec.completion.maxTurns}</span>
          <div className="scene-s1-round-dots" aria-hidden="true">
            {Array.from({ length: progressSteps }, (_, index) => (
              <i key={index} className={index < completedSteps ? 'is-done' : index === completedSteps ? 'is-current' : ''} />
            ))}
          </div>
        </div>
        <SceneWidgetErrorBoundary key={run.runId + ':goal'} widget="heading" label="场景目标" onFocusConversation={focusConversation}>
        <SceneWidgetContent>{() => <div className="scene-s1-goal">
          <Target className="w-4 h-4" />
          <div><span>场景目标</span><strong>{spec.meta.goal || spec.task}</strong></div>
        </div>}</SceneWidgetContent>
        </SceneWidgetErrorBoundary>
        <div className="scene-s1-budget" title="本场景没有独立倒计时，按剩余回合控制进度">
          <Clock3 className="w-4 h-4" />
          <div><span>剩余预算</span><strong>{remainingTurns} 回合</strong></div>
        </div>
        <div className="scene-s1-actions">
          {hasPrevRun && finished && (
            <button type="button" className="scene-btn scene-btn--ghost" onClick={onRerun} title="反事实重跑">
              <RotateCcw className="w-3.5 h-3.5" />重跑
            </button>
          )}
          {!finished && (
            <button type="button" className="scene-btn scene-btn--primary" disabled={sending} onClick={onEnd}>
              <Square className="w-3.5 h-3.5" />结束场景
            </button>
          )}
          {finished && onExit && <button type="button" className="scene-btn scene-btn--primary" onClick={onExit}>退出场景</button>}
        </div>
      </header>

      <div className="scene-chat-body scene-s1-body">
        {roleDrawerOpen && <button type="button" className="scene-role-backdrop" tabIndex={-1}
          aria-label="收起角色栏并返回作答" onClick={() => setRoleRailCollapsed(true)} />}
        <aside ref={roleRailRef} className={`scene-role-rail ${roleRailCollapsed ? 'is-collapsed' : ''}`}
          role={roleDrawerOpen ? 'dialog' : undefined} aria-modal={roleDrawerOpen || undefined}
          aria-label="角色与发言顺序">
          <div className="scene-role-rail-head">
            {!roleRailCollapsed && (
              <div>
                <span>角色与发言顺序</span>
                <small>单角色场景 · 当前发言者高亮</small>
              </div>
            )}
            <button type="button" onClick={() => setRoleRailCollapsed((value) => !value)}
              aria-expanded={!roleRailCollapsed}
              aria-label={roleRailCollapsed ? '展开角色栏' : '收起角色栏'}>
              {roleRailCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </button>
          </div>
          <SceneWidgetErrorBoundary key={run.runId + ':role-rail'} widget="role-rail" label="角色信息" onFocusConversation={focusConversation}>
          <SceneWidgetContent>{() => <>
          <div className="scene-role-sequence">
            <div className={`scene-role-step ${sending ? 'is-active' : ''}`}>
              <span className="scene-role-avatar is-ai"><Bot /></span>
              {!roleRailCollapsed && <div><strong>{spec.role.name || '场景引导者'}</strong><small>AI 角色</small></div>}
            </div>
            <div className="scene-role-line" />
            <div className={`scene-role-step ${!sending && !finished ? 'is-active' : ''}`}>
              <span className="scene-role-avatar is-user"><UserRound /></span>
              {!roleRailCollapsed && <div><strong>{spec.userRole || '你'}</strong><small>当前参与者</small></div>}
            </div>
          </div>
          {!roleRailCollapsed && (
            <div className="scene-role-rail-note">当前版本为单 AI 角色对话；角色栏沿用多角色场景的信息结构，为后续扩展保留位置。</div>
          )}
          </>}</SceneWidgetContent>
          </SceneWidgetErrorBoundary>
        </aside>

        <main className="scene-s1-main" tabIndex={0} aria-label="场景作答区">
          <div className="scene-chat-list" ref={listRef} tabIndex={0} role="region" aria-label="场景对话"
            style={finished && completionContent != null
              ? { minHeight: 'min(120px, 25%)', paddingTop: 14, paddingBottom: 14 }
              : undefined}>
            <SceneWidgetErrorBoundary key={run.runId + ':message-list'} widget="message-list" label="对话列表" onFocusConversation={focusConversation}>
            <SceneWidgetContent>{() => run.messages.filter((message) => message.isStreaming
              || typeof message.content !== 'string' || message.content.trim() || (message.metricDeltas?.length ?? 0) > 0).map(message => (
              <SceneWidgetErrorBoundary key={message.id} widget="message" label="本条消息" onFocusConversation={focusConversation}>
                <SceneWidgetContent>{() => renderMsg(message)}</SceneWidgetContent>
              </SceneWidgetErrorBoundary>
            ))}</SceneWidgetContent>
            </SceneWidgetErrorBoundary>
          </div>

          {finished && run.endReason && (
            <SceneWidgetErrorBoundary key={run.runId + ':end-banner'} widget="completion" label="场景结束信息">
            <SceneWidgetContent>{() => (
            <div className={`scene-end-banner ${run.completionOutcome === 'stopped' || run.completionOutcome === 'limit-reached' ? '' : run.status === 'success' ? 'is-success' : 'is-failure'}`}>
              {run.completionOutcome === 'stopped' || run.completionOutcome === 'limit-reached' ? <Flag className="w-4 h-4" /> : run.status === 'success' ? <Trophy className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {run.endReason}
            </div>
            )}</SceneWidgetContent>
            </SceneWidgetErrorBoundary>
          )}

          {showEventBox && (
            <div className="scene-event-inject">
              <input className="scene-input" value={eventText} disabled={sending || finished || Boolean(turnError)} autoFocus placeholder="描述一个突发事件，立即注入对话"
                onChange={(e) => setEventText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); submitEvent(); } }} />
              <button type="button" className="scene-btn scene-btn--primary" disabled={!eventText.trim() || sending || finished || Boolean(turnError)} onClick={submitEvent}>注入</button>
              <button type="button" className="scene-btn scene-btn--ghost" onClick={() => { setShowEventBox(false); setEventText(''); }}>取消</button>
            </div>
          )}

          {turnError && !finished && (
            <section className="scene-response-zone" aria-label="本轮回复恢复" style={{ maxHeight: '55%', minHeight: 0, flexShrink: 1, overflowY: 'auto' }}>
              <div role="alert" ref={turnErrorRef} tabIndex={-1} className="scene-end-banner" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
                <XCircle aria-hidden="true" className="w-4 h-4" />
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>本轮回复未完成：{turnError}</span>
              </div>
              <p>{run.messages.some((message) => message.speakerType === 'user') ? '你的回答已保留，重试会继续本轮。' : '开场回复未完成，重试会继续准备本轮。'}也可以结束训练，再从结果页退出场景。</p>
              {partialReply && <SceneWidgetErrorBoundary key={run.runId + ':partial-reply'} widget="partial-reply" label="部分回复">
                <details><summary>查看已收到的部分回复</summary><SceneRichMessage content={partialReply} externalLinksDisabled /></details>
              </SceneWidgetErrorBoundary>}
              <div className="scene-loading-actions">
                {onReviseTurn && <button type="button" className="scene-btn scene-btn--ghost" disabled={sending} onClick={onReviseTurn}>补充或缩短输入后继续</button>}
                <button type="button" className="scene-btn scene-btn--primary" disabled={sending} onClick={onRetryTurn}><RotateCcw className="w-4 h-4" />重试本轮</button>
                <button type="button" className="scene-btn scene-btn--ghost" disabled={sending} onClick={onEnd}>结束训练</button>
              </div>
            </section>
          )}
          {finished && completionContent != null && (
            <section className="scene-response-zone learning-completion-slot" aria-label="本次训练对应任务"
              style={{ maxHeight: '55%', minHeight: 0, flexShrink: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              <SceneWidgetErrorBoundary key={run.runId + ':completion'} widget="completion" label="训练结果">{completionContent}</SceneWidgetErrorBoundary>
            </section>
          )}
          {!finished && <section className={`scene-response-zone ${openAnswerMode ? 'is-open-answer' : ''} ${activeStructuredInteraction?.type === 'question-set' ? 'is-question-set' : ''}`}
            hidden={Boolean(turnError)}
            style={{ ...(inputAvailability.formConfigured || (showConversationInput && activeInteraction?.type === 'text') ? { maxHeight: '60%', minHeight: 0, flexShrink: 1, overflowY: 'auto' as const, overscrollBehavior: 'contain' as const } : {}),
              ...(turnError ? { display: 'none' } : {}) }}>
            <SceneWidgetErrorBoundary key={run.runId + ':answer'} widget="answer" label="答题控件" onFocusConversation={focusConversation}>
            <SceneWidgetContent>{() => <>
            <div className="scene-response-zone-head">
              <div><Flag className="w-4 h-4" /><span>{activeStructuredInteraction?.type === 'question-set' ? '完成本次测评' : activeStructuredInteraction ? '选择本轮回应' : openAnswerMode ? '组织你的回答' : '你的回应'}</span></div>
              <small>{spec.behavior?.userAction || '根据当前情境给出你的判断或行动'}</small>
            </div>
            {activeStructuredInteraction ? (
              <SceneInteractionInput
                directive={activeStructuredInteraction}
                disabled={sending || finished || Boolean(turnError)}
                choicePresentation={choicePresentation}
                onSubmit={(response) => onSend('', response)}
              />
            ) : (
              <>
              {(contract.allowTextFallback || activeInteraction?.type === 'text') && <div className={`scene-chat-input ${openAnswerMode ? 'scene-open-answer-input' : ''}`}>
                {canInject && (
                  <button type="button" className="scene-icon-btn" disabled={sending} title="注入突发事件" aria-label="注入突发事件"
                    onClick={() => setShowEventBox((v) => !v)}>
                    <Zap className="w-4 h-4" />
                  </button>
                )}
                <textarea className="scene-textarea scene-chat-textarea" aria-label="本轮回答" value={input} rows={openAnswerMode ? 5 : 1} disabled={sending || finished || Boolean(turnError)}
                  placeholder={finished ? '场景已结束' : activeInteraction?.type === 'text' && activeInteraction.placeholder ? activeInteraction.placeholder : openAnswerMode ? '先写出你的核心判断，再用依据和例子展开…' : '输入你的回应…（Enter 发送，Shift+Enter 换行）'}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); submit(); }
                  }} />
                {openAnswerMode && <span className="scene-open-answer-hint">支持多段作答 · Shift+Enter 换行
                </span>}
                <button type="button" className="scene-btn scene-btn--primary" aria-label={sending ? '正在等待回应' : '提交回答'} disabled={!input.trim() || sending || finished || Boolean(turnError)} onClick={submit}>
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {openAnswerMode && !sending ? '提交回答' : null}
                </button>
              </div>}
              </>
            )}
            </>}</SceneWidgetContent>
            </SceneWidgetErrorBoundary>
            {inputAvailability.formConfigured && (
              <SceneWidgetErrorBoundary key={run.runId + ':form'} widget="form" label="场景表单" onFocusConversation={focusConversation}>
              <SceneWidgetContent>{() => <details open aria-describedby={run.runId + '-form-availability'}>
                <summary>填写场景表单</summary>
                <p id={run.runId + '-form-availability'} role="status" aria-live="polite">
                  {inputAvailability.formBlockedReason || '表单可填写；提交表单不会代替当前题目的答案。'}
                </p>
                {inputForm && <SceneDynamicForm key={`${run.runId}:${inputForm.id}`} form={inputForm}
                  disabled={sending || !inputAvailability.formAvailable || Boolean(turnError)}
                  initialSubmission={run.messages.findLast(message => message.speakerType === 'user' && message.formSubmission?.formId === inputForm.id)?.formSubmission}
                  onSubmit={submission => { if (inputAvailability.formAvailable && !sending && !turnError) onSend('', undefined, submission); }} />}
                {showConversationInput && <p>调整要求或求助请使用下方“场景交流”，无需提交表单。</p>}
              </details>}</SceneWidgetContent>
              </SceneWidgetErrorBoundary>
            )}
            {showConversationInput && (
              <div className="scene-conversation-zone" role="group" aria-label="调整要求与求助">
                <div className="scene-conversation-head">
                  <label htmlFor={conversationInputId}>场景交流 · 调整要求与求助</label>
                  <small id={conversationInputId + '-hint'}>不提交当前答案，不计答题轮次</small>
                </div>
                <div className="scene-chat-input scene-conversation-input">
                  <textarea id={conversationInputId} className="scene-textarea scene-chat-textarea" aria-label="场景交流"
                    aria-describedby={conversationInputId + '-hint'} rows={2}
                    placeholder="例如：先举个生活例子；下一题更难；改用已允许的题型"
                    value={conversationInput} disabled={sending || Boolean(turnError)}
                    onChange={event => setConversationInput(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                        event.preventDefault(); submitConversation();
                      }
                    }} />
                  <button type="button" className="scene-btn scene-btn--ghost" aria-label="发送交流"
                    disabled={sending || Boolean(turnError) || !conversationInput.trim()} onClick={submitConversation}>
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}发送交流
                  </button>
                </div>
              </div>
            )}
          </section>}
        </main>

        <aside className="scene-chat-side scene-s1-side">
          {spec.promptModuleIds?.includes('model-experiment') && <SceneWidgetErrorBoundary key={run.runId + ':experiment-ledger'} widget="experiment-ledger" label="实验记录" onFocusConversation={focusConversation}>
            <SceneExperimentLedger records={run.experimentRecords || []} />
          </SceneWidgetErrorBoundary>}
          <SceneWidgetErrorBoundary key={run.runId + ':metrics'} widget="metrics" label="场景指标" onFocusConversation={focusConversation}>
          <section>
            <div className="scene-side-title"><Target />场景状态</div>
            <SceneMetricPanel specs={spec.metrics} values={run.metrics} />
          </section>
          </SceneWidgetErrorBoundary>
          <SceneWidgetErrorBoundary key={run.runId + ':materials'} widget="materials" label="可用资料" onFocusConversation={focusConversation}>
          <SceneWidgetContent>{() => (
          <section>
            <div className="scene-side-title"><BookOpen />可用资料</div>
            <div className="scene-context-list">
              {(spec.resources.length > 0 ? spec.resources : spec.meta.knowledgePoints).slice(0, 5).map((item, index) => (
                <div key={`${item}-${index}`} className="scene-context-item"><span>{index + 1}</span><p>{item}</p></div>
              ))}
              {spec.resources.length === 0 && spec.meta.knowledgePoints.length === 0 && (
                <p className="scene-side-empty">本场景没有附加资料</p>
              )}
            </div>
          </section>
          )}</SceneWidgetContent>
          </SceneWidgetErrorBoundary>
          <SceneWidgetErrorBoundary key={run.runId + ':citations'} widget="citations" label="引用依据" onFocusConversation={focusConversation}>
          <SceneWidgetContent>{() => {
            const citationSources = Array.from(new Map(
              run.messages.flatMap(message => message.citations || []).map(citation => [
                JSON.stringify([citation.sourceType, citation.noteId, citation.documentId, citation.chunkId]), citation,
              ]),
            ).values()).slice(0, 5);
            return citationSources.length > 0 && (
            <section>
              <div className="scene-side-title"><BookOpen />已引用依据</div>
              <div className="scene-context-list">
                {citationSources.map((citation, index) => (
                  <button key={JSON.stringify([citation.sourceType, citation.noteId, citation.documentId, citation.chunkId])} type="button" className="scene-context-item is-action"
                    onClick={() => onOpenNote?.(citation.noteId)}>
                    <span>{index + 1}</span><p>{citation.title}</p>
                  </button>
                ))}
              </div>
            </section>
          ); }}</SceneWidgetContent>
          </SceneWidgetErrorBoundary>
          <SceneWidgetErrorBoundary key={run.runId + ':task'} widget="task" label="待解决任务" onFocusConversation={focusConversation}>
          <SceneWidgetContent>{() => <section>
            <div className="scene-side-title"><CircleHelp />待解决</div>
            <p className="scene-side-task">{spec.task}</p>
          </section>}</SceneWidgetContent>
          </SceneWidgetErrorBoundary>
          <SceneWidgetErrorBoundary key={run.runId + ':events'} widget="events" label="事件线" onFocusConversation={focusConversation}>
          <SceneWidgetContent>{() => run.events.length > 0 && (
            <section>
              <div className="scene-side-title"><Zap />事件线</div>
              <div className="scene-side-events">
                {run.events.map((event) => (
                  <div key={event.id} className={`scene-side-event ${event.fired ? 'is-fired' : ''}`}>
                    <span className="scene-side-event-dot" />
                    <span className="scene-side-event-text">{event.description}</span>
                  </div>
                ))}
              </div>
            </section>
          )}</SceneWidgetContent>
          </SceneWidgetErrorBoundary>
        </aside>
      </div>
    </div>
  );
};
