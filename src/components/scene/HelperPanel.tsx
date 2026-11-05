/**
 * S4 助手面板（对应实施计划 F18）。
 *
 * 双模式：
 * - 分析模式（默认）：展示当前步骤或最近提交步骤的验证反馈与建议
 * - 求助模式：展示历史求助卡 + 输入框
 *
 * 对应《场景设计原则》：
 * - 原则 7「状态可感知」：求助剩余次数常驻显示，低量时变红警示
 * - 原则 6「行动有后果」：每次求助产生一张 HelpCard，可一键插入画布生成新节点
 * - 原则 3「认知冲突」：AnalysisView 并列展示「引擎结论」与「AI 解释」，
 *   让用户看到系统判定与自然语言解释之间的对应关系
 *
 * 本组件为纯展示 + 事件上抛，不直接调用服务层（由 SceneDerivationView 编排）。
 *
 * 受控化说明（阶段八）：
 * - `tab` 改为受控：画布节点上的「求助」按钮需要把面板直接切到求助页，
 *   若 Tab 状态留在本组件内部，父组件无从指挥。
 * - `prefill` 用于「带着节点上下文进入求助」：父组件递增 `seq` 即可让本组件
 *   写入提问草稿并聚焦输入框，且**不会自动发起求助**（次数由用户确认后消耗）。
 */

import React, { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import { Lightbulb, AlertTriangle, CheckCircle2, Plus, Send, Loader2 } from 'lucide-react';
import type { DerivationNode, HelpResponse, NodeVerification, S4HelpSource } from '../../types/sceneS4';
import { DERIVATION_STATUS_LABEL } from '../../types/sceneS4';

/* ================================================================
 * 工具：LaTeX 静态渲染
 * ================================================================ */

/** HTML 转义（KaTeX 渲染失败时的兜底输出）。
 *  用 Unicode 转义序列书写，避免自动格式化把实体还原成裸字符而丢失转义效果。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '\u0026amp;')
    .replace(/\u003c/g, '\u0026lt;')
    .replace(/\u003e/g, '\u0026gt;');
}

/**
 * 把 LaTeX 渲染为 KaTeX HTML。
 * 渲染失败时回退为**已转义**的纯文本（不抛错、不阻塞面板，也不产生注入风险）。
 */
function renderLatex(latex: string): string {
  try {
    return katex.renderToString(latex.replace(/\\doubleprime\b/g, '\\prime\\prime'), {
      throwOnError: false,
      output: 'html',
      displayMode: false,
    });
  } catch {
    return escapeHtml(latex);
  }
}

/** 只读公式（KaTeX 渲染） */
const FormulaView: React.FC<{ latex: string; className?: string }> = ({ latex, className }) => (
  <span
    className={className}
    // KaTeX 输出为受控 HTML（throwOnError: false 保证不外抛），此处不引入用户可注入的脚本
    dangerouslySetInnerHTML={{ __html: renderLatex(latex) }}
  />
);

/* ================================================================
 * 分析视图
 * ================================================================ */

export interface AnalysisViewProps {
  /** 当前分析对象；可以是未验证的草稿，null 表示尚无分析对象 */
  node: DerivationNode | null;
  /** 是否正在分析中 */
  streaming?: boolean;
  goalChecking?: boolean;
  goalRetryAvailable?: boolean;
  goalRetryDisabled?: boolean;
  goalRetryNotice?: string;
  onRetryGoal?: () => void;
}

/** 判定来源徽标：区分「引擎验证」与「AI 裁决」（原则 10 的可视化） */
const VerdictBadge: React.FC<{ source: NodeVerification['verdictSource'] }> = ({ source }) => {
  if (source === 'llm') {
    return (
      <span className="scene-s4-verdict-badge is-llm">
        <Lightbulb className="w-3 h-3" />
        AI 裁决
      </span>
    );
  }
  if (source === 'engine') {
    return (
      <span className="scene-s4-verdict-badge is-engine">
        <CheckCircle2 className="w-3 h-3" />
        引擎验证
      </span>
    );
  }
  return null;
};

export const AnalysisView: React.FC<AnalysisViewProps> = ({ node, streaming = false, goalChecking=false,
  goalRetryAvailable=false, goalRetryDisabled=false, goalRetryNotice, onRetryGoal }) => {
  if (streaming) {
    return (
      <div className="scene-s4-analysis-empty" role="status">
        <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2" />
        正在验证你的推导…
      </div>
    );
  }

  if (!node) {
    return (
      <div className="scene-s4-analysis-empty">
        提交一个公式节点后，
        <br />
        这里会显示引擎判定与改进建议。
      </div>
    );
  }

  if (!node.data.verification) {
    return (
      <div className="scene-s4-analysis" role="status">
        <div className="scene-s4-analysis-block">
          <div className="scene-s4-analysis-label">
            {node.data.label || '当前步骤'}
            <span className="scene-s4-analysis-status">{DERIVATION_STATUS_LABEL[node.data.status] ?? node.data.status}</span>
          </div>
          {node.data.latex && <div className="scene-s4-analysis-formula"><FormulaView latex={node.data.latex} /></div>}
          <p className="scene-s4-analysis-text">
            {node.type === 'given' ? '这是场景给定的已知条件，无需提交验证。'
              : node.data.status === 'warn' ? '本步尚无有效验证结果，请重新提交。'
                : '本步尚未验证，提交后显示判定与改进建议。'}
          </p>
        </div>
      </div>
    );
  }

  const v = node.data.verification;
  const statusLabel = DERIVATION_STATUS_LABEL[node.data.status] ?? node.data.status;

  return (
    <div className="scene-s4-analysis">
      <div className="scene-s4-analysis-block">
        <div className="scene-s4-analysis-label">{node.data.label || '当前步骤'}</div>
        <div className="scene-s4-analysis-label">
          判定结果
          <span className="scene-s4-analysis-status">{statusLabel}</span>
          <VerdictBadge source={v.verdictSource} />
        </div>
        {node.data.latex && (
          <div className="scene-s4-analysis-formula">
            <FormulaView latex={node.data.latex} />
          </div>
        )}
      </div>

      {v.feedback && (
        <div className="scene-s4-analysis-block">
          <div className="scene-s4-analysis-label">引擎反馈</div>
          <p className="scene-s4-analysis-text">{v.feedback}</p>
        </div>
      )}

      {node.type === 'conclusion' && (
        <div className="scene-s4-analysis-block" role="status" aria-live="polite">
          <div className="scene-s4-analysis-label">题目目标覆盖（不替代数学验证）</div>
          <p className="scene-s4-analysis-text">
            {goalChecking ? '正在检查题目目标，不会重新验证数学步骤。'
              : v.goalAssessment?.status === 'achieved' ? '已覆盖题目目标。'
              : v.goalAssessment?.status === 'not-achieved' ? '本步尚未完整回答题目目标。' : '题目目标覆盖尚未确认。'}
            {v.goalAssessment?.reason || '请继续推导或重新提交结论；仅数学验证通过不会自动结束场景。'}
          </p>
          {goalRetryNotice && <p className="scene-s4-analysis-text">{goalRetryNotice}</p>}
          {goalRetryAvailable && onRetryGoal && <button type="button" className="scene-s4-help-insert"
            disabled={goalRetryDisabled || goalChecking} onClick={onRetryGoal}>
            {goalChecking ? '正在检查题目目标…' : '仅重试目标检查'}
          </button>}
        </div>
      )}

      {/**
         * 引擎识别到的函数（轮次 A：识别透明化）。
         *
         * 为什么必须显示：把「某个标识符被当作函数」这一系统内部决策摆到台面上。
         * 用户写 a(x+1) 本意是乘法时，若只收到「与参考解不等价」，
         * 既不知原因也不知怎么改；看到「已识别为函数：a」即可自行改为 a*(x+1)。
         */}
        {(v.detectedFunctions ?? []).length > 0 && (
          <div className="scene-s4-analysis-block">
            <div className="scene-s4-analysis-label">已识别为函数</div>
            <p className="scene-s4-analysis-text">
              {(v.detectedFunctions ?? []).join('、')}
              <span className="scene-s4-func-hint">
                （非变量；若本意是相乘，请写显式乘号）
              </span>
          </p>
        </div>
      )}

      {typeof v.numerical_error === 'number' && (
        <div className="scene-s4-analysis-block">
          <div className="scene-s4-analysis-label">数值误差</div>
          <p className="scene-s4-analysis-text">{v.numerical_error.toExponential(2)}</p>
        </div>
      )}

      {v.boundary_coverage && v.boundary_coverage.length > 0 && (
        <div className="scene-s4-analysis-block">
          <div className="scene-s4-analysis-label">已覆盖的边界条件</div>
          <ul className="scene-s4-analysis-list">
            {v.boundary_coverage.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {v.suggestions && v.suggestions.length > 0 && (
        <div className="scene-s4-analysis-block">
          <div className="scene-s4-analysis-label">改进建议</div>
          <ul className="scene-s4-analysis-list">
            {v.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/* ================================================================
 * 求助卡
 * ================================================================ */

export interface HelpCardProps {
  content: HelpResponse;
  /** 剩余求助次数（扣减后） */
  remaining: number;
  /** 插入画布：把 latex 作为新节点加在当前节点之后 */
  onInsert: () => void;
  disabled?: boolean;
  sourceNotice?: string;
}

export const HelpCard: React.FC<HelpCardProps> = ({ content, remaining, onInsert, disabled = false, sourceNotice }) => (
  <div className="scene-s4-help-card">
    <div className="scene-s4-help-card-head">
      <Lightbulb className="w-3.5 h-3.5" />
      <span>第 {content.step_number} 步指引</span>
      <span className="scene-s4-help-remaining">剩余 {remaining} 次</span>
    </div>

    {content.correction && (
      <p className="scene-s4-help-correction">
        <AlertTriangle className="w-3 h-3 inline mr-1" />
        {content.correction}
      </p>
    )}

    {content.step_content && <p className="scene-s4-help-reason">{content.step_content}</p>}

    {content.latex && (
      <div className="scene-s4-help-formula">
        <FormulaView latex={content.latex} />
      </div>
    )}

    {content.reason && <p className="scene-s4-help-reason">{content.reason}</p>}
    {sourceNotice && content.latex.trim() && <p className="scene-s4-help-reason">{sourceNotice}</p>}

    {content.related_knowledge.length > 0 && (
      <div className="scene-s4-help-tags">
        {content.related_knowledge.map((k, i) => (
          <span key={i} className="scene-s4-help-tag">
            {k}
          </span>
        ))}
      </div>
    )}

    {content.latex.trim() && <button type="button" className="scene-s4-help-insert" disabled={disabled} onClick={onInsert}>
      <Plus className="w-3.5 h-3.5" />
      插入画布
    </button>}
  </div>
);

/* ================================================================
 * 主面板
 * ================================================================ */

/** 助手面板页签 */
export type HelperTab = 'analysis' | 'help';

export interface HelperPanelProps {
  /** 最近提交的节点（分析模式展示） */
  analyzedNode: DerivationNode | null;
  /** 分析中 */
  analyzing: boolean;
  /** 历史求助卡（按时间正序） */
  helpHistory: Array<{ content: HelpResponse; remaining: number; nodeId?: string | null; inputKey?: string }>;
  /** 剩余求助次数 */
  remaining: number;
  /** 求助上限（用于展示 "N/M"） */
  maxHelp: number;
  /** Same configured penalty as the host's local accounting. */
  penaltyPerHelp?: number;
  /** 求助中 */
  asking: boolean;
  /** 错误提示（求助失败等），null 表示无 */
  error: string | null;
  /** 发起求助 */
  onAsk: (query: string) => Promise<boolean>;
  disabled?: boolean;
  /** 把求助得到的公式插入画布 */
  onInsert: (latex: string, source?: S4HelpSource) => void;
  goalChecking?: boolean;
  goalRetryAvailable?: boolean;
  goalRetryDisabled?: boolean;
  goalRetryNotice?: string;
  onRetryGoal?: (nodeId: string) => void;
  /** 受控页签 */
  tab: HelperTab;
  /** 切换页签 */
  onTabChange: (tab: HelperTab) => void;
  /**
   * 预填求助提问（画布节点的「求助」按钮使用）。
   *
   * `seq` 递增即触发一次「写入草稿 + 聚焦输入框」；
   * 用序号而非文本本身做触发条件，保证同一节点重复点击仍然生效。
   * **只预填，不自动发起** —— 求助次数是稀缺资源，须由用户确认后消耗。
   */
  prefill?: { text: string; seq: number } | null;
}

export const HelperPanel: React.FC<HelperPanelProps> = ({
  analyzedNode,
  analyzing,
  helpHistory,
  remaining,
  maxHelp,
  penaltyPerHelp = .1,
  asking,
  error,
  onAsk,
  onInsert,
  tab,
  onTabChange,
  prefill = null,
  disabled = false,
  goalChecking = false,
  goalRetryAvailable = false,
  goalRetryDisabled = false,
  goalRetryNotice,
  onRetryGoal,
}) => {
  const [query, setQuery] = useState('');
  const [requestError, setRequestError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  /** 已处理过的预填序号，避免重复写入覆盖用户正在输入的内容 */
  const handledPrefillSeqRef = useRef(0);
  const askBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { if (error || requestError) errorRef.current?.focus(); }, [error, requestError]);

  /** 响应父组件的「带上下文进入求助」请求 */
  useEffect(() => {
    if (!prefill || prefill.seq === handledPrefillSeqRef.current) return;
    handledPrefillSeqRef.current = prefill.seq;

    setQuery(prefill.text);
    // 滚动到输入区并聚焦（延后一帧，确保页签已渲染出输入框）
    const frame = requestAnimationFrame(() => {
      inputWrapRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // 光标置于末尾，用户可以接着补充
      try {
        const end = el.value.length;
        el.setSelectionRange(end, end);
      } catch {
        /* 某些环境不支持，忽略 */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [prefill]);

  const handleAsk = async () => {
    if (disabled || asking || askBusyRef.current || remaining <= 0) return;
    askBusyRef.current = true;
    setRequestError(null);
    try {
      const submitted = await onAsk(query.trim());
      if (submitted && mountedRef.current) setQuery('');
    } catch (failure) {
      if (mountedRef.current) setRequestError((failure as Error)?.message || '求助失败，请重试');
    } finally { askBusyRef.current = false; }
  };

  const exhausted = remaining <= 0;

  return (
    <div className="scene-s4-helper">
      {/* 头部：Tab 切换 + 求助计数（原则 7 状态可感知） */}
      <div className="scene-s4-helper-head">
        <div className="scene-s4-helper-tabs">
          <button
            type="button"
            className={`scene-s4-helper-tab${tab === 'analysis' ? ' is-active' : ''}`}
            aria-pressed={tab === 'analysis'}
            onClick={() => onTabChange('analysis')}
          >
            分析
          </button>
          <button
            type="button"
            className={`scene-s4-helper-tab${tab === 'help' ? ' is-active' : ''}`}
            aria-pressed={tab === 'help'}
            onClick={() => onTabChange('help')}
          >
            求助
            {helpHistory.length > 0 && (
              <span className="scene-s4-helper-tab-count">{helpHistory.length}</span>
            )}
          </button>
        </div>
        <span className={`scene-s4-help-counter${remaining <= 1 ? ' is-low' : ''}`}>
          {remaining} / {maxHelp} 次
        </span>
      </div>

      {(error || requestError) && <div ref={errorRef} tabIndex={-1} role="alert" className="scene-s4-helper-error">{error || requestError}</div>}

      {/* 分析模式 */}
      {tab === 'analysis' && <AnalysisView node={analyzedNode} streaming={analyzing}
        goalChecking={goalChecking} goalRetryAvailable={goalRetryAvailable} goalRetryDisabled={goalRetryDisabled}
        goalRetryNotice={goalRetryNotice} onRetryGoal={()=>{if(analyzedNode)onRetryGoal?.(analyzedNode.id);}} />}

      {/* 求助模式 */}
      {tab === 'help' && (
        <>
          <div className="scene-s4-analysis">
            {helpHistory.length === 0 ? (
              <div className="scene-s4-analysis-empty">
                卡在某一步时，
                <br />
                可以让助手给出当前步骤或下一步的解法。
              </div>
            ) : (
              helpHistory.map((h, i) => (
                <HelpCard
                  key={i}
                  content={h.content}
                  remaining={h.remaining}
                  disabled={disabled || asking || analyzing}
                  sourceNotice={!h.inputKey ? '旧提示没有来源记录，将插入为未连线草稿，请手动连接前提。' : undefined}
                  onInsert={() => onInsert(h.content.latex,{nodeId:h.nodeId ?? null,inputKey:h.inputKey})}
                />
              ))
            )}
          </div>

          <div className="scene-s4-input" ref={inputWrapRef}>
            <p className="scene-s4-input-hint">当前求助对象：{analyzedNode ? `${analyzedNode.data.label || '步骤'} [${analyzedNode.id}]` : '整个画布'}。</p>
            <div className="scene-s4-input-row">
              <textarea
                ref={inputRef}
                className="scene-textarea scene-s4-input-textarea"
                aria-label="描述卡住的推导步骤"
                placeholder={exhausted ? '求助次数已用尽' : '描述你卡住的地方（可留空）'}
                value={query}
                disabled={disabled || exhausted || asking}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault();
                    void handleAsk();
                  }
                }}
              />
              <button
                type="button"
                className="scene-s4-send"
                disabled={disabled || exhausted || asking}
                onClick={() => void handleAsk()}
                aria-label={asking ? '正在请求求助' : '发起求助'}
                title={exhausted ? '求助次数已用尽' : '发起求助'}
              >
                {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            <p className="scene-s4-input-hint">
              每次有效求助（含纯讲解）消耗 1 次机会，独立性扣减 {penaltyPerHelp}
            </p>
          </div>
        </>
      )}
    </div>
  );
};
