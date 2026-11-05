/**
 * 场景预览与确认：七要素展示 + 可编辑指标初值/阈值 + extras 折叠区
 * + injectProfile 开关 + 突发事件增删 + 来源标注（new / adapted）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Plus, Play, Sparkles, GitBranch, RefreshCw, Loader2 } from 'lucide-react';
import { SceneSpec, SceneEvent, MetricSpec } from '../../types';
import { SCENE_SKILL_S4 } from '../../types/sceneS4';
import { SceneRoleEditor } from './SceneRoleEditor';
import { getSceneCapability, getUnifiedSceneRecipe } from '../../services/scene/sceneCapabilityRegistry';
import { preflightSceneSpec } from '../../services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../../services/scene/sceneRuntimeContract';
import { isS4HelpAuthorized, s4HelpPenalty, s4SubmissionLimit } from '../../services/scene/sceneS4Policy';

interface Props {
  spec: SceneSpec;
  busy: boolean;
  busyLabel?: string;
  startError?: string;
  onChange: (spec: SceneSpec) => void;
  onStart: (experimentConsent?: boolean) => void;
  /** 重新生成（复用已有 / 自定义场景无此语义时省略） */
  onRegenerate?: () => void;
  onDelete: () => void;
  /** 顶部提示条：自定义场景等模式下的引导文案 */
  modeHint?: string;
}

export const SceneSpecPreview: React.FC<Props> = ({ spec, busy, busyLabel, startError, onChange, onStart, onRegenerate, onDelete, modeHint }) => {
  const startErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (startError) startErrorRef.current?.focus({ preventScroll: false }); }, [startError]);
  const [showExtras, setShowExtras] = useState(false);
  const [newEvent, setNewEvent] = useState('');
  const [newRule, setNewRule] = useState('');
  const [helpPenaltyError, setHelpPenaltyError] = useState('');
  const [experimentConsent, setExperimentConsent] = useState(false);
  const needsExperimentConsent = spec.promptModuleIds?.includes('model-experiment') === true;
  const experimentConsentKey = JSON.stringify([spec.sceneId, spec.experimentPolicy]);
  useEffect(() => { setExperimentConsent(false); }, [experimentConsentKey]);
  const sceneRecipe = getUnifiedSceneRecipe(spec.capabilityRecipeId || spec.behavior?.recipeId);
  const assembly = preflightSceneSpec(spec, { allowDeferredCompute: true });
  const assemblyErrors = assembly.diagnostics.filter((item) => item.severity === 'error');
  const assemblyWarnings = assembly.diagnostics.filter((item) => item.severity === 'warning');
  const runtimeContract = (() => { try { return resolveSceneRuntimeContract(spec); } catch { return undefined; } })();
  const toolLabels = { 'knowledge-notes': '知识笔记', documents: '导入资料', 'document-arguments': '资料论证结构',
    'argument-chain': '个人论证链', 'learner-profile': '学习画像', 'model-experiment': '独立模型实验（消耗额度）' };

  /**
   * 是否 S4 数理场景。
   * S4 的确认页与 S1 有三处结构性差异（S1 路径不受影响）：
   * - 无「开场旁白」（画布不承载对话流）
   * - 无「突发事件」与「允许运行中注入事件」（S4 不用事件机制）
   * - 数理推演配置上移到任务之后（它才是 S4 的核心信息），并新增求助配置
   */
  const isS4 = spec.meta.sceneSkill === SCENE_SKILL_S4;
  const hasPromptModule = (id: NonNullable<SceneSpec['promptModuleIds']>[number]) => (
    !spec.promptModuleIds || spec.promptModuleIds.includes(id)
  );

  /** 指标来源徽标（原则 10/11 的可见性：让用户知道哪些由系统判定、哪些 AI 可影响） */
  const sourceLabel = (s?: string): { text: string; cls: string } | null => {
    if (s === 'engine') return { text: '引擎', cls: 'is-engine' };
    if (s === 'rule') return { text: '规则', cls: 'is-rule' };
    if (s === 'llm') return { text: 'AI', cls: 'is-llm' };
    return null;
  };

  /** 更新单个指标定义的初值 / 阈值 */
  const patchMetric = (id: string, patch: Partial<MetricSpec>) => {
    onChange({ ...spec, metrics: spec.metrics.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  };

  /** 数值化输入：空串回退原值，非法输入不写入 */
  const patchMetricNumber = (m: MetricSpec, key: 'initial' | 'target', raw: string) => {
    if (raw.trim() === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    patchMetric(m.id, { [key]: n } as Partial<MetricSpec>);
  };

  const addEvent = () => {
    const desc = newEvent.trim();
    if (!desc) return;
    const ev: SceneEvent = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description: desc,
      trigger: { type: 'turn', turn: Math.max(2, spec.completion.maxTurns - 4) },
      fired: false,
    };
    onChange({ ...spec, events: [...spec.events, ev] });
    setNewEvent('');
  };

  const addRule = () => {
    const text = newRule.trim();
    if (!text) return;
    onChange({ ...spec, rules: [...spec.rules, text] });
    setNewRule('');
  };

  const extrasKeys = Object.keys(spec.extras || {});

  return (
    <div className="scene-preview">
      {/* 模式引导（自定义场景等） */}
      {modeHint && <div className="scene-preview-hint">{modeHint}</div>}

      {/* 来源标注 */}
      <div className="scene-preview-origin">
        {spec.origin === 'adapted' ? (
          <>
            <GitBranch className="w-3.5 h-3.5" />
            基于已有场景改编
            {spec.sourceSceneId && <span className="text-slate-400">（源：{spec.sourceSceneId}）</span>}
          </>
        ) : (
          <>
            <Sparkles className="w-3.5 h-3.5" />
            全新生成
          </>
        )}
      </div>

      <div className="scene-field-row">
        <label className="scene-field-label">场景名称</label>
        <input className="scene-input" value={spec.meta.name} disabled={busy}
          onChange={(e) => onChange({ ...spec, meta: { ...spec.meta, name: e.target.value } })} />
      </div>

      <div className="scene-preview-grid">
        <div>
          <span className="scene-kv-label">学科</span>
          <input className="scene-input" value={spec.meta.subject} disabled={busy} placeholder="如：数学"
            onChange={(e) => onChange({ ...spec, meta: { ...spec.meta, subject: e.target.value } })} />
        </div>
        <div><span className="scene-kv-label">Skill</span>{spec.meta.sceneSkill}</div>
        <div className="col-span-2">
          <span className="scene-kv-label">学习目标</span>
          <input className="scene-input" value={spec.meta.goal} disabled={busy} placeholder="这次学习想达成什么"
            onChange={(e) => onChange({ ...spec, meta: { ...spec.meta, goal: e.target.value } })} />
        </div>
        <div className="col-span-2">
          <span className="scene-kv-label">知识点</span>
          {/* 非受控 + onBlur：顿号分隔转换会丢弃空片段，受控写法会导致分隔符无法输入 */}
          <input className="scene-input" defaultValue={spec.meta.knowledgePoints.join('、')} disabled={busy}
            placeholder="多个知识点用「、」分隔"
            onBlur={(e) => onChange({
              ...spec,
              meta: {
                ...spec.meta,
                knowledgePoints: e.target.value.split('、').map((s) => s.trim()).filter(Boolean),
              },
            })} />
        </div>
      </div>

      {/* S4 使用「助理设定」形态：顶部展示不可编辑的功能约束 */}
      {(isS4 || !spec.behavior) && (
        <fieldset disabled={busy} className="scene-role-edit-fieldset">
        <SceneRoleEditor
          role={spec.role}
          onChange={(role) => onChange({ ...spec, role })}
          variant={isS4 ? 'assistant' : 'npc'}
        />
        </fieldset>
      )}

      {hasPromptModule('role-context') && <div className="scene-field-row">
        <label className="scene-field-label">用户身份</label>
        <input className="scene-input" value={spec.userRole} disabled={busy} placeholder="你在场景中扮演谁"
          onChange={(e) => onChange({ ...spec, userRole: e.target.value })} />
      </div>}

      {hasPromptModule('scenario-framing') && <div className="scene-preview-block">
        <span className="scene-kv-label">情境</span>
        <textarea className="scene-textarea" rows={2} value={spec.situation} disabled={busy}
          placeholder="场景发生在哪里、当前是什么状况"
          onChange={(e) => onChange({ ...spec, situation: e.target.value })} />
      </div>}
      <div className="scene-preview-block">
        <span className="scene-kv-label">任务</span>
        <textarea className="scene-textarea" rows={2} value={spec.task} disabled={busy}
          placeholder="你在场景中需要完成什么"
          onChange={(e) => onChange({ ...spec, task: e.target.value })} />
      </div>

      <section
        className={`scene-assembly-status ${assembly.valid ? 'is-ready' : 'is-error'}`}
        aria-live="polite"
        aria-label="场景装配状态"
      >
        <div className="scene-assembly-status__header">
          <span>{assembly.valid ? '装配就绪' : '装配需要修正'}</span>
          <span className="scene-assembly-status__surface">
            {assembly.surface === 'canvas' ? '画布运行面' : '回合运行面'}
          </span>
        </div>
        <div className="scene-assembly-capabilities" aria-label="已启用能力">
          {assembly.enabledCapabilities.map((id) => (
            <span key={id} className="scene-assembly-capability" title={id}>
              {getSceneCapability(id)?.label || id}
            </span>
          ))}
        </div>
        {assembly.enabledPromptModules.length > 0 && (
          <div className="scene-assembly-capabilities" aria-label="已启用提示词模块">
            {assembly.enabledPromptModules.map((id) => (
              <span key={id} className="scene-assembly-capability" title={id}>{id}</span>
            ))}
          </div>
        )}
        {[...assemblyErrors, ...assemblyWarnings].map((item, index) => (
          <p key={`${item.code}-${item.capabilityId || index}`} className={`scene-assembly-diagnostic is-${item.severity}`}>
            {item.message}
          </p>
        ))}
      </section>

      {!isS4 && runtimeContract && <section className="scene-preview-block" aria-label="场景互动约定">
        <span className="scene-kv-label">互动约定</span>
        <p>{runtimeContract.initiator === 'user' ? '由你提问' : runtimeContract.initiator === 'agent' ? '由助手引导' : '双方自然交流'}
          {' · '}{runtimeContract.evaluation === 'none' ? '不评价学习表现' : runtimeContract.evaluation === 'on-request' ? '仅在你要求时评价' : '根据作答反馈'}
          {' · '}{runtimeContract.completion === 'user-controlled' ? '由你决定结束' : '按目标完成情况收场'}</p>
        <p>可用材料：{runtimeContract.allowedTools.map(id => toolLabels[id]).join('、') || '仅使用本局对话'}</p>
        <p>{runtimeContract.flowGuidance}</p>
        {spec.capabilityPlan && <ul>{spec.capabilityPlan.needs.map(need => <li key={need.id}>{need.goal}：{need.capabilityIds.join('、')}</li>)}</ul>}
        {needsExperimentConsent && <label className="scene-field-label">
          <input type="checkbox" checked={experimentConsent} disabled={busy} aria-describedby="scene-experiment-consent"
            onChange={event => setExperimentConsent(event.target.checked)} />
          我允许本局使用已配置模型执行实验
          <span id="scene-experiment-consent">将发送我提交或确认的提示词与测试输入，不自动读取笔记。本局最多 {spec.experimentPolicy?.maxExperiments || 6} 次实验，每次至多两次模型调用；测试输出上限 {spec.experimentPolicy?.maxOutputTokens || 1024} tokens，独立评估上限 2048 tokens。失败也可能计费。</span>
          <span>实验输出验收标准：{spec.experimentPolicy?.criteria.join('；')}</span>
          <span>每次实验执行包含待测与独立评价各一次请求；主持Agent的理解、规划和回应另有模型调用，规划格式异常最多修复一次。</span>
        </label>}
      </section>}

      {!isS4 && spec.behavior && (
        <>
        {spec.promptModuleIds?.includes('input-form') && spec.inputForm && <section className="scene-preview-block" aria-label="场景表单设计">
          <span className="scene-kv-label">{spec.inputForm.title}</span><p>{spec.inputForm.description}</p>
          <ul>{spec.inputForm.fields.map(field => <li key={field.id}>{field.label} · {field.kind} · {field.required ? '必填' : '可选'}</li>)}</ul>
          <p>表单只是已授权文本交互的填写方式，不增加任何工具权限；仍可直接对话。</p>
        </section>}
        <div className="scene-preview-block">
          <span className="scene-kv-label">交互行为契约 · {spec.behavior.kind}</span>
          {sceneRecipe && (
            <p className="scene-preview-text">
              <span className="scene-kv-inline">场景配方</span>
              {sceneRecipe.label} · {sceneRecipe.execution === 'batch' ? '整组提交' : '逐回合推进'}
            </p>
          )}
          <p className="scene-preview-text">
            <span className="scene-kv-inline">可用组件</span>
            {spec.behavior.interaction?.allowedTypes.join('、') || 'text'}
          </p>
          {([
            ['aiBehavior', 'AI 每轮行为'],
            ['userAction', '用户每轮行动'],
            ['evaluationRule', '评价规则'],
            ['progressionRule', '推进规则'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block mt-2">
              <span className="scene-kv-inline">{label}</span>
              <textarea className="scene-textarea" rows={2} value={spec.behavior![key]} disabled={busy}
                onChange={(e) => onChange({ ...spec, behavior: { ...spec.behavior!, [key]: e.target.value } })} />
            </label>
          ))}
          {spec.behavior.outputFormats && spec.behavior.outputFormats.length > 0 && (
            <p className="scene-preview-text">
              <span className="scene-kv-inline">输出格式</span>
              {spec.behavior.outputFormats.join('、')}
            </p>
          )}
        </div>
        </>
      )}

      {/*
        S4 数理推演配置（仅 S4 展示 —— 隔离点 I9）。
        位置：紧跟「任务」之后 —— 它才是 S4 的核心信息（用户要推导什么），
        排在角色/指标之前才符合「先确认要做什么，再确认怎么判」的阅读顺序。
      */}
      {isS4 && (
        <div className="scene-preview-block">
          <span className="scene-kv-label">
            数理推演配置
            <span className="scene-s4-badge">S4</span>
          </span>
          {sceneRecipe && (
            <p className="scene-preview-text">
              <span className="scene-kv-inline">场景配方</span>
              {sceneRecipe.label} · 画布工作流
            </p>
          )}
          {spec.compute ? (
            <>
              <p className="scene-preview-text">
                <span className="scene-kv-inline">运算类型</span>
                {spec.compute.operation}
              </p>
              <p className="scene-preview-text scene-s4-tip">
                运行配置已就绪。标准答案与参考步骤在预览中保持隐藏，结束推导后可查看；重试保存不会重复生成已有配置。
              </p>
              {spec.compute.symbols.length > 0 && (
                <p className="scene-preview-text">
                  <span className="scene-kv-inline">符号表</span>
                  {spec.compute.symbols
                    .map((s) => `${s.name}${s.display ? `（${s.display}）` : ''}`)
                    .join('、')}
                </p>
              )}
              {spec.compute.boundary_conditions.length > 0 && (
                <>
                  <span className="scene-kv-inline">边界条件</span>
                  <ul className="scene-s4-list">
                    {spec.compute.boundary_conditions.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="scene-preview-text scene-s4-pending">
              点击「保存并开始」后由 AI 生成数理推演配置（目标答案、符号表、边界条件与求助次数）。
            </p>
          )}
        </div>
      )}

      {/* S4 求助配置（可调）：影响求助次数上限与独立性扣分 */}
      {isS4 && isS4HelpAuthorized(spec) && spec.help && (
        <div className="scene-preview-block">
          <span className="scene-kv-label">求助配置</span>
          <div className="scene-s4-help-grid">
            <label>
              求助上限
              <input
                className="scene-input scene-input--sm"
                defaultValue={String(spec.help.max_help_count)}
                disabled={busy}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n) || n < 0) return;
                  onChange({ ...spec, help: { ...spec.help!, max_help_count: Math.floor(n) } });
                }}
              />
              次
            </label>
            <label>
              每次扣分
              <input
                type="number" min={0} max={1} step="any"
                className="scene-input scene-input--sm"
                defaultValue={String(s4HelpPenalty(spec))}
                disabled={busy}
                aria-invalid={Boolean(helpPenaltyError)}
                aria-describedby={helpPenaltyError ? 'scene-s4-help-policy scene-s4-penalty-error' : 'scene-s4-help-policy'}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (!e.target.value.trim() || !Number.isFinite(n) || n < 0 || n > 1) {
                    e.target.value = String(s4HelpPenalty(spec));
                    setHelpPenaltyError('每次扣分请输入 0 到 1 之间的数字；0 表示不扣分。');
                    return;
                  }
                  setHelpPenaltyError('');
                  onChange({ ...spec, help: { ...spec.help!, penalty_per_help: n } });
                }}
              />
            </label>
          </div>
          {helpPenaltyError && <p id="scene-s4-penalty-error" className="scene-start-error" role="alert">{helpPenaltyError}</p>}
          <p id="scene-s4-help-policy" className="text-xs mt-1" style={{ color: 'var(--ln-text-secondary)' }}>
            独立性初始 1.0，每次求助扣 {s4HelpPenalty(spec)}（最低为 0）；最终得分 = 基础得分 × (1 − 已求助 × 扣分) + 独立性 × 0.1，最终得分最低为 0。0 表示不扣分。
          </p>
        </div>
      )}

      {/* 开场旁白：S4 画布不承载对话流，整块不渲染（隔离点 I9） */}
      {!isS4 && hasPromptModule('scenario-framing') && (
        <div className="scene-preview-block">
          <span className="scene-kv-label">开场旁白</span>
          <textarea className="scene-textarea" rows={2} value={spec.openingNarrative} disabled={busy}
            placeholder="开场时 NPC 说的第一段话"
            onChange={(e) => onChange({ ...spec, openingNarrative: e.target.value })} />
        </div>
      )}

      <div className="scene-preview-block">
        {/* S4 的规则注入到分析/求助助手（而非 S1 的 NPC），文案需相应调整 */}
        <span className="scene-kv-label">{isS4 ? '推导约束（注入分析/求助助手）' : '规则约束'}</span>
        {spec.rules.length === 0 && (
          <p className="text-xs text-slate-400">
            {isS4 ? '未设定推导约束' : '未设定规则，NPC 行为不受额外约束'}
          </p>
        )}
        <div className="scene-rule-list">
          {spec.rules.map((r, i) => (
            <div key={i} className="scene-rule-item">
              <input className="scene-input" value={r} disabled={busy} placeholder="如：不得直接给出答案"
                onChange={(e) => {
                  const next = [...spec.rules];
                  next[i] = e.target.value;
                  onChange({ ...spec, rules: next });
                }} />
              <button type="button" className="scene-icon-btn" disabled={busy} title="删除"
                onClick={() => onChange({ ...spec, rules: spec.rules.filter((_, j) => j !== i) })}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="scene-kp-custom">
          <input className="scene-input" value={newRule} disabled={busy} placeholder="添加一条规则"
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } }} />
          <button type="button" className="scene-btn scene-btn--ghost" disabled={!newRule.trim() || busy} onClick={addRule}>
            <Plus className="w-3 h-3" />添加
          </button>
        </div>
      </div>

      {/* 指标：初值与阈值可改（反事实重跑的核心可调参数） */}
      {(isS4 || hasPromptModule('metric-state')) && <div className="scene-preview-block">
        <span className="scene-kv-label">
          完成指标 <span className="text-[10px] text-slate-400">（{isS4 ? '前提链与结论支路判定' : spec.completion.mode === 'signal' ? '信号判定模式，无量化指标' : '达标判定模式'}）</span>
        </span>
        {spec.metrics.length === 0 ? (
          <p className="text-xs text-slate-400">{isS4 ? '未设量化指标，仍需验证完整结论支路，或主动结束本次推导。' : '未设定指标，结束由对话自然推进决定'}</p>
        ) : (
          <div className="scene-metric-edit-list">
            {spec.metrics.map((m) => (
              <div key={m.id} className="scene-metric-edit">
                <div className="scene-metric-edit-name">
                  {m.name}
                  {(() => {
                    const badge = sourceLabel(m.source);
                    return badge ? (
                      <span className={`scene-metric-source scene-metric-source--${badge.cls}`}>
                        {badge.text}判定
                      </span>
                    ) : null;
                  })()}
                  <span className="text-[10px] text-slate-400">（{m.type}{m.unit ? ` · ${m.unit}` : ''}）</span>
                </div>
                <div className="scene-metric-edit-fields">
                  <label>
                    初值
                    <input className="scene-input scene-input--sm" defaultValue={String(m.initial)} disabled={busy}
                      onBlur={(e) => patchMetricNumber(m, 'initial', e.target.value)} />
                  </label>
                  <label>
                    目标
                    <input className="scene-input scene-input--sm" defaultValue={String(m.target)} disabled={busy}
                      onBlur={(e) => patchMetricNumber(m, 'target', e.target.value)} />
                  </label>
                </div>
                <p className="scene-metric-edit-desc">{m.description}</p>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-slate-400 mt-1">{isS4
          ? `最多接收 ${s4SubmissionLimit(spec)} 次节点验证提交；编辑、求助和讲解不计入次数。`
          : `成功条件：${spec.completion.successExpression || '—'}｜最多 ${spec.completion.maxTurns} 回合`}</p>
      </div>}

      {/* 突发事件：S4 不使用事件机制，整块不渲染（隔离点 I9） */}
      {!isS4 && hasPromptModule('event-system') && (
      <div className="scene-preview-block">
        <span className="scene-kv-label">突发事件</span>
        {spec.events.length === 0 && <p className="text-xs text-slate-400">未预设事件</p>}
        <div className="scene-event-list">
          {spec.events.map((ev) => (
            <div key={ev.id} className="scene-event-item">
              <span className="scene-event-trigger">
                {ev.trigger.type === 'turn' ? `第 ${ev.trigger.turn} 轮` : '条件触发'}
              </span>
              <span className="scene-event-desc">{ev.description}</span>
              <button type="button" className="scene-icon-btn" disabled={busy} title="删除"
                onClick={() => onChange({ ...spec, events: spec.events.filter((x) => x.id !== ev.id) })}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="scene-kp-custom">
          <input className="scene-input" value={newEvent} disabled={busy} placeholder="添加一个突发事件"
            onChange={(e) => setNewEvent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEvent(); } }} />
          <button type="button" className="scene-btn scene-btn--ghost" disabled={!newEvent.trim() || busy} onClick={addEvent}>
            <Plus className="w-3 h-3" />添加
          </button>
        </div>
      </div>
      )}

      {/* 扩展字段（自由扩展层，权重低于骨架） */}
      {hasPromptModule('scenario-framing') && extrasKeys.length > 0 && (
        <div className="scene-preview-block">
          <button type="button" className="scene-section-toggle" onClick={() => setShowExtras(!showExtras)}>
            {showExtras ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span>扩展字段</span>
            <span className="text-[10px] font-normal text-slate-400">{extrasKeys.length} 项</span>
          </button>
          {showExtras && (
            <div className="scene-extras-list">
              {extrasKeys.map((k) => (
                <div key={k} className="scene-field-row">
                  <label className="scene-field-label">{k}</label>
                  <input className="scene-input" value={spec.extras?.[k] ?? ''} disabled={busy}
                    onChange={(e) => onChange({ ...spec, extras: { ...(spec.extras || {}), [k]: e.target.value } })} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 两个开关 */}
      {(hasPromptModule('profile-personalization') || (!isS4 && hasPromptModule('event-system'))) && <div className="scene-switch-row">
        {hasPromptModule('profile-personalization') && (
        <label className="scene-switch-label">
          <button type="button" disabled={busy}
            className={`scene-attr-switch ${spec.injectProfile ? 'is-on' : ''}`}
            onClick={() => onChange({ ...spec, injectProfile: !spec.injectProfile })}>
            <span className="scene-attr-switch-dot" />
          </button>
          注入学习画像
          <span className="text-[10px] font-normal text-slate-400">
            {isS4 ? '（按你的能力水平调整推导难度与讲解详略）' : '（让 NPC 的提问贴合你的能力特点）'}
          </span>
        </label>
        )}
        {/* 事件注入开关：S4 不使用（隔离点 I9） */}
        {!isS4 && hasPromptModule('event-system') && (
          <label className="scene-switch-label">
            <button type="button" disabled={busy}
              className={`scene-attr-switch ${spec.eventInjection ? 'is-on' : ''}`}
              onClick={() => onChange({ ...spec, eventInjection: !spec.eventInjection })}>
              <span className="scene-attr-switch-dot" />
            </button>
            允许运行中注入事件
          </label>
        )}
      </div>}

      {spec.evaluationDimensions.length > 0 && (
        <p className="text-[10px] text-slate-400">
          评估维度（本期仅记录）：{spec.evaluationDimensions.join('、')}
        </p>
      )}

      <div className="scene-preview-actions">
        {startError && <div className="scene-start-error" role="alert" tabIndex={-1} ref={startErrorRef}>无法开始场景：{startError}。当前草稿已保留，可修改后再次保存并开始。</div>}
        {busy && <span className="scene-start-status" role="status">{busyLabel || '正在保存场景…'}</span>}
        {onRegenerate && (
          <button type="button" className="scene-btn scene-btn--ghost" disabled={busy} onClick={onRegenerate}>
            <RefreshCw className="w-4 h-4" />重新生成
          </button>
        )}
        <button type="button" className="scene-btn scene-btn--ghost scene-btn--danger" disabled={busy} onClick={onDelete}>
          <Trash2 className="w-4 h-4" />丢弃
        </button>
        <button
          type="button"
          className="scene-btn scene-btn--primary"
          disabled={busy || !assembly.valid || (needsExperimentConsent && !experimentConsent)}
          aria-disabled={busy || !assembly.valid || (needsExperimentConsent && !experimentConsent)}
          title={!assembly.valid ? '请先修正场景装配错误' : undefined}
          onClick={() => onStart(experimentConsent)}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}{busy ? '正在准备…' : '保存并开始'}
        </button>
      </div>
    </div>
  );
};
