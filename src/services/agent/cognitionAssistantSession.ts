import type { LlmConversationMessage } from '../../types';
import type { CognitionNodeReference } from '../cognition/types';
import { loadPersonalCognition } from '../cognition/store';
import { discardCognitionChangeProposal, discardOwnedCognitionProposals } from '../cognition/changeProposals';
import { runAgentTurn, resolveAgentApproval } from './agentEngine';
import type { AgentLlmCaller } from './runtime/types';
import type { AgentPendingApproval, AgentRuntimeContext, AgentToolStep, AgentTurnResult } from './types';
import { agentTaskScope, flushAgentTaskStateWrites, loadAgentTaskState, saveAgentTaskState } from './taskStateClient';
import { registerCognitionTools } from './tools/cognitionTools';
import { COGNITION_ASSISTANT_ROLE } from './cognitionAssistantPolicy';
import { cognitionAssistantReference, compactCognitionAssistantState, emptyCognitionAssistantState,
  observeCognitionAssistantRead, prepareCognitionAssistantRead, COGNITION_COMPLETION_LIMIT, type CognitionCompletionReceipt, type CognitionAssistantState } from './cognitionAssistantState';

export interface CognitionAssistantView {
  messages: LlmConversationMessage[]; work: CognitionAssistantState['work']; ready: boolean; busy: boolean;
  pending: AgentPendingApproval | null; error: string; notice: string;
}
/** A separate renderer session. No general-agent tabs, jobs, drafts or page ports are mounted. */
export class CognitionAssistantSession {
  private stored = emptyCognitionAssistantState();
  private history: LlmConversationMessage[] = [];
  private scope = '';
  private ready = false;
  private busy = false;
  private pending: AgentPendingApproval | null = null;
  private error = '';
  private notice = '';
  private disposed = false;
  private readonly proposalOwner = crypto.randomUUID();
  private generation = 0;
  private initializing?: Promise<void>;
  private controller?: AbortController;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  readonly ctx: AgentRuntimeContext;
  constructor(private options: { blocked?: () => boolean; callLlm?: AgentLlmCaller } = {}) {
    registerCognitionTools();
    const deny = () => { throw new Error('本窗口仅允许认知库操作'); };
    const ports = {
      getConversationId: () => this.stored.sessionId,
      getNotes: () => [], getActiveNote: () => null, getPlanDraftSession: () => null, getResourceDraftSession: () => null,
      hasPendingPlanEditorDraft: () => false, getAgentExecutionMode: () => 'standard',
      getCognitionAssistantWork: () => structuredClone(this.stored.work),
      getCognitionAssistantCompletions: () => structuredClone(this.stored.completions || []),
      getCognitionProposalOwner: () => this.proposalOwner,
      ensureDataFresh: async () => { await this.ensureScope(); if (this.options.blocked?.()) throw new Error('请先保存或取消认知图谱中的手工编辑'); await this.writes; },
      prepareCognitionRead: (args: Record<string, unknown>) => prepareCognitionAssistantRead(args, this.stored.work),
      observeCognitionRead: (args: Record<string, unknown>, result: unknown) => {
        if (this.disposed) return;
        this.controller?.signal.throwIfAborted();
        this.stored.work = observeCognitionAssistantRead(args, result, this.stored.work); this.publish(); this.persistLater();
      },
    };
    this.ctx = new Proxy(ports, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : undefined }) as unknown as AgentRuntimeContext;
    // Required general ports are explicitly denied too, even if a caller bypasses the tool catalog.
    for (const key of ['navigate', 'openNoteByTitle', 'enterLearningMode', 'createKnowledgeNote', 'applyPlanTaskChange', 'createProjectPlan',
      'appendProjectStudyTasks', 'appendProjectStudyTaskBatch', 'startPlanDraftSession', 'stagePlanDraftBatch', 'discardPlanDraftSession',
      'commitPlanDraftSession', 'startResourceDraftSession', 'discardResourceDraftSession', 'commitResourceDraftSession']) Reflect.set(ports, key, deny);
  }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  view(): CognitionAssistantView {
    return { messages: this.history.filter(message => ['user', 'assistant'].includes(message.role) && message.content?.trim() && !message.toolCalls?.length),
      work: structuredClone(this.stored.work), ready: this.ready, busy: this.busy, pending: this.pending, error: this.error, notice: this.notice };
  }
  private publish() { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private async ensureScope() {
    if (this.disposed) throw new Error('认知助手已关闭');
    const generation = this.generation, scope = await agentTaskScope();
    if (this.disposed || generation !== this.generation) throw new Error('认知助手会话已失效');
    if (!this.scope || this.scope !== scope) {
      discardOwnedCognitionProposals(this.proposalOwner);
      this.controller?.abort(); this.ready = false; this.pending = null; this.history = []; this.stored = emptyCognitionAssistantState();
      this.error = '资料库已切换，旧认知对话已清除；请重新打开认知窗口'; this.publish(); throw new Error(this.error);
    }
  }
  async initialize() {
    if (this.disposed || this.ready || this.busy) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeSession();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }
  private async initializeSession() {
    const generation = ++this.generation;
    this.error = ''; this.notice = '';
    try {
      // A disposed predecessor may already have sent a native write. Drain it
      // before restoring; callbacks that have not reached storage are revoked.
      await flushAgentTaskStateWrites().catch(() => {});
      const loaded = await loadAgentTaskState();
      if (this.disposed || generation !== this.generation) return;
      this.scope = loaded.scopeId;
      const file = await loadPersonalCognition(); await this.ensureScope();
      this.stored = loaded.state.cognitionAssistant || emptyCognitionAssistantState();
      this.history = [...this.stored.messages];
      const notices: string[] = [];
      if (this.stored.interrupted) notices.push('上次对话或待确认操作已中断；不会自动续跑或写入，请重新读取并预览。');
      if (this.stored.completions?.length) notices.push(`已恢复最近${this.stored.completions.length}项已保存认知变更的历史回执，不会因回复中断而重做；当前内容仍需重新读取核对。`);
      if (this.stored.work.revision !== undefined && this.stored.work.revision !== file.revision) {
        this.stored.work = { candidates: [] }; notices.push('认知库版本已变化，旧分页与节点定位已失效，请重新查询。');
      }
      this.notice = notices.join('');
      this.stored.interrupted = false; await this.persist(false);
      if (!this.disposed && generation === this.generation) this.ready = true;
    } catch (error) { if (!this.disposed) { this.ready = false; this.error = error instanceof Error ? error.message : String(error); } }
    this.publish();
  }
  private persist(interrupted = this.busy || !!this.pending, snapshot?: CognitionAssistantState) {
    const state = snapshot || compactCognitionAssistantState(this.stored, this.history, interrupted), scope = this.scope;
    const generation = this.generation, isCurrent = () => !this.disposed && generation === this.generation;
    const write = this.writes.catch(() => {}).then(async () => {
      if (!isCurrent()) return;
      const currentScope = await agentTaskScope();
      if (!isCurrent()) return;
      if (scope !== currentScope) throw new Error('资料库已切换，未保存旧认知对话');
      await saveAgentTaskState(scope, { kind: 'cognition-assistant', state }, isCurrent);
    });
    this.writes = write; return write;
  }
  private persistLater() {
    if (this.disposed) return;
    void this.persist().catch(error => { if (!this.disposed) { this.error = `对话状态未保存：${error instanceof Error ? error.message : String(error)}`; this.publish(); } });
  }
  async flush() { await this.writes; }
  async focus(reference: CognitionNodeReference) {
    if (!this.ready || this.busy || this.pending || this.options.blocked?.()) return;
    this.busy = true; this.publish();
    try {
      await this.ensureScope();
      const file = await loadPersonalCognition(); await this.ensureScope();
      if (file.revision !== this.stored.work.revision) this.stored.work = { candidates: [], revision: file.revision };
      this.stored.work.focused = cognitionAssistantReference(reference);
      await this.persist(false); this.notice = '已定位选中的认知块；助手将精确读取后再讨论或提出修改。';
    } finally { this.busy = false; this.publish(); }
  }
  async clear() {
    if (!this.ready || this.busy || this.pending) return;
    this.busy = true; this.publish();
    try {
      await this.ensureScope();
      const next = emptyCognitionAssistantState();
      await this.persist(false, next);
      if (this.disposed) return;
      discardOwnedCognitionProposals(this.proposalOwner);
      this.stored = next; this.history = []; this.error = ''; this.notice = '';
    } catch (error) {
      if (!this.disposed) this.error = '未能清除对话，原聊天已保留，请稍后重试。';
      throw error;
    } finally { this.busy = false; this.publish(); }
  }
  async send(text: string) {
    text = text.trim();
    if (!text || !this.ready || this.busy || this.pending || this.options.blocked?.()) return;
    if (text.length > 12000) { this.error = '单次消息请控制在12000字符以内'; this.publish(); return; }
    const history = this.history;
    this.notice = '';
    this.history = [...history, { role: 'user', content: text }];
    await this.run(() => runAgentTurn({ role: COGNITION_ASSISTANT_ROLE, userText: text, history, ctx: this.ctx,
      memoryPrefixLoader: async () => '', enableMultiAgent: false, signal: this.controller!.signal,
      callLlm: this.options.callLlm, onStep: step => this.onStep(step) }));
  }
  async approve(approved: boolean) {
    if (!this.pending || this.busy || this.options.blocked?.()) return;
    const approval = this.pending;
    await this.run(() => resolveAgentApproval({ role: COGNITION_ASSISTANT_ROLE, approval, approved, history: this.history, ctx: this.ctx,
      signal: this.controller!.signal, callLlm: this.options.callLlm, onStep: step => this.onStep(step) }));
    for (const item of approval.items) if (item.call.name === 'commit_cognition_change') discardCognitionChangeProposal(item.call.arguments.proposalId);
  }
  private onStep(step: AgentToolStep) {
    if (this.disposed) return;
    if (step.ok && step.call.name === 'commit_cognition_change' && (step.result as { saved?: boolean })?.saved) {
      const result = step.result as { fileRevision: number; action: CognitionCompletionReceipt['action'] };
      const request = this.pending?.continuation.userText || this.history.findLast(message => message.role === 'user')?.content || '';
      const receipt: CognitionCompletionReceipt = { proposalId: String(step.call.arguments.proposalId), action: result.action, fileRevision: result.fileRevision,
        at: new Date().toISOString(), request: request.length > 1000 ? `${request.slice(0, 970)}…（历史请求节选）` : request };
      this.stored.completions = [...(this.stored.completions || []).filter(row => row.proposalId !== receipt.proposalId), receipt].slice(-COGNITION_COMPLETION_LIMIT);
      this.stored.work = { candidates: [] }; this.notice = '已保存你具体确认的认知变更；后续中断不会撤回已完成的写入。';
      this.publish(); this.persistLater();
    }
  }
  private async run(operation: () => Promise<AgentTurnResult>) {
    const completedBefore = new Set(this.stored.completions?.map(receipt => receipt.proposalId));
    this.busy = true; this.error = ''; this.controller = new AbortController(); this.publish();
    try {
      await this.ensureScope(); await this.persist();
      const result = await operation(); await this.ensureScope();
      this.history = result.updatedHistory; this.pending = result.pendingApproval || null;
    } catch (error) {
      // Retain private coordinates, not an incomplete tool protocol or replayable write.
      this.pending = null; this.history = compactCognitionAssistantState(this.stored, this.history, false).messages;
      const completed = this.stored.completions?.filter(receipt => !completedBefore.has(receipt.proposalId)) || [];
      if (completed.length) this.history.push({ role: 'assistant', content: `已按你确认的具体变更保存${completed.length}项个人认知操作；后续处理已中断，已保存部分不会撤回。不要重复执行；需要继续时先只读核对当前内容。` });
      this.error = this.ready && this.controller?.signal.aborted ? '已停止后续步骤；已完成的具体确认写入会保留，不会自动重试。' : error instanceof Error ? error.message : String(error);
    } finally {
      // Keep only proposals referenced by the actual pending card. Unsubmitted
      // suggestions, failed/stopped work and previews from an old controller expire now.
      discardOwnedCognitionProposals(this.proposalOwner, new Set(this.pending?.items.filter(item => item.call.name === 'commit_cognition_change').map(item => item.call.arguments.proposalId)));
      if (this.ready && !this.disposed) { try { await this.persist(!!this.pending); } catch (error) { this.error = `对话状态未保存：${error instanceof Error ? error.message : String(error)}`; } }
      this.busy = false; this.controller = undefined;
      this.publish();
    }
  }
  stop() { this.controller?.abort(); }
  dispose() {
    this.disposed = true; this.generation++; this.stop(); this.listeners.clear();
    discardOwnedCognitionProposals(this.proposalOwner);
    for (const item of this.pending?.items || []) if (item.call.name === 'commit_cognition_change') discardCognitionChangeProposal(item.call.arguments.proposalId);
  }
}
