import React, { useEffect, useRef, useState } from 'react';
import { applyCognitionMutation, latestCognition } from '../services/cognition/core';
import { useCognitionWrite } from './useCognitionWrite';
import { useCognitionLeaveProtection } from './useCognitionLeaveProtection';
import './PersonalCognition.css';
import { ALL_ARGUMENT_ROLES, ARGUMENT_ROLE_LABELS, type ArgumentRole } from '../services/argumentDoc/types';
import { COGNITION_OPERATION_LABELS } from '../services/cognition/types';
import { cognitionRoleLabel } from '../services/cognition/roles';
import type { CognitionCandidate, CognitionFile, CognitionMutation, CognitionOperation } from '../services/cognition/types';

const field = 'cognition-field';
const button = 'cognition-action is-primary';
type Pending = Extract<CognitionCandidate, { status: 'pending' }>;

/** One explicit save action with an optional comparison. No extra confirmation checkbox. */
export function CognitionEditForm({ file, candidate, recordId, initialTarget, assistedContext = false, onSaved, onCancel, onLeaveBlocked, disabled = false, writeLock, onBusyChange, storageScopeId }: {
  file: CognitionFile; candidate?: Pending; recordId?: string;
  initialTarget?: { branchId: string; nodeId: string };
  assistedContext?: boolean;
  onSaved: (file: CognitionFile) => void; onCancel?: () => void;
  onLeaveBlocked?: () => void;
  disabled?: boolean; writeLock?: { current: boolean }; onBusyChange?: (busy: boolean) => void;
  storageScopeId?: string;
}) {
  // Freeze the reviewed baseline; subscriptions must not silently rebase the user's edit.
  const [base, setBase] = useState(file);
  const choices = base.records.filter((r) => !r.withdrawn && (!recordId || r.id === recordId)).flatMap((record) => {
    const revision = latestCognition(record);
    return revision.branches.flatMap((branch) => branch.graph.nodes.map((node) => ({ record, revision, branch, node,
      key: JSON.stringify([record.id, branch.id, node.id]) })));
  });
  const fixedTarget = !!initialTarget && !candidate;
  const initialMatches = initialTarget ? choices.filter((c) => c.branch.id === initialTarget.branchId && c.node.id === initialTarget.nodeId) : [];
  const initialChoice = initialTarget ? (initialMatches.length === 1 ? initialMatches[0] : undefined) : choices[0];
  const [mode, setMode] = useState(candidate ? 'new' : 'update');
  const [selected, setSelected] = useState(candidate ? '' : initialChoice?.key || '');
  const target = choices.find((c) => c.key === selected);
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState<Exclude<CognitionOperation, 'initial'>>(candidate ? 'supplement' : 'revise');
  const [text, setText] = useState(candidate?.observation.answer || initialChoice?.node.text || '');
  const [role, setRole] = useState<ArgumentRole | ''>(candidate ? 'claim' : initialChoice?.node.role || '');
  const [reason, setReason] = useState('');
  const [conditionBaseline, setConditionBaseline] = useState((initialChoice?.node.conditions || []).join('\n'));
  const [oldCondition, setOldCondition] = useState(''), [newCondition, setNewCondition] = useState('');
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const pendingButton = useRef<HTMLButtonElement>(null);
  const targetSelect = useRef<HTMLSelectElement>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (pendingTarget !== null) pendingButton.current?.focus();
    else if (wasPending.current) targetSelect.current?.focus();
    wasPending.current = pendingTarget !== null;
  }, [pendingTarget]);
  const { busy, error, write, writeLock: activeWriteLock, clearError } = useCognitionWrite((next) => { leave.setDirty(false); onSaved(next); }, { lock: writeLock, onBusyChange });
  const leave = useCognitionLeaveProtection(busy, activeWriteLock, onLeaveBlocked);
  const { dirty, setDirty } = leave;
  const stale = base.revision !== file.revision;
  const parallel = mode === 'update' && (operation === 'contextual' || operation === 'alternative');
  const unresolved = mode === 'update' && (operation === 'alternative' || (target?.branch.kind === 'alternative' && operation !== 'contextual'));
  const assisted = assistedContext || (!!candidate && (candidate.observation.hintLevel !== 0 || candidate.observation.consultedMaterialIds.length > 0));
  // Compatibility metadata is not a belief-strength control. Ordinary text edits
  // preserve the reviewed stance; new user expressions are recorded as endorsed.
  const stance = unresolved ? 'tentative' as const : mode === 'update' && target
    ? target.node.stance || target.branch.stance : 'endorsed' as const;
  const authorship = assisted ? 'adopted_with_assistance' as const : 'own_expression' as const;
  // Revisions are full snapshots. Match this exact branch/node, not the first
  // record-level source or a similarly titled block (including appended nodes).
  const firstNode = target?.record.revisions.flatMap(revision => {
    const node = revision.branches.find(branch => branch.id === target.branch.id)?.graph.nodes.find(node => node.id === target.node.id);
    return node ? [node] : [];
  })[0];
  const updateTarget = target ? { recordId: target.record.id, revisionId: target.revision.id, branchId: target.branch.id,
    nodeId: target.node.id, operation, reason: reason.trim() || (parallel ? '' : `用户确认${COGNITION_OPERATION_LABELS[operation]}`) } : undefined;
  const detailedConditions = mode === 'update' && operation.endsWith('_conditions');
  // Saved conditions belong to the frozen reviewed target, not editable textarea state.
  // An explicit setBase(file) reload advances this baseline without replacing the draft.
  const storedConditions = target?.node.conditions;
  const conditionChoices = storedConditions ?? conditionBaseline.split('\n').map(value => value.trim()).filter(Boolean);
  const oldConditionIndex = conditionChoices.indexOf(oldCondition);
  const meaning = detailedConditions ? { interpretation: reason.trim() || COGNITION_OPERATION_LABELS[operation], preserved: [], conditions: {
    before: [...conditionChoices], changes: operation === 'add_conditions'
      ? [{ kind: 'add' as const, after: newCondition.trim() }] : operation === 'remove_conditions'
        ? [{ kind: 'remove' as const, before: oldCondition.trim() }] : [{ kind: 'replace' as const, before: oldCondition.trim(), after: newCondition.trim() }],
  } } : undefined;
  const normalizedBody = text.replace(/\r\n?/gu, '\n'), condition = newCondition.trim().replace(/\r\n?/gu, '\n');
  const oldPhrase = oldCondition.trim().replace(/\r\n?/gu, '\n'), oldAt = normalizedBody.indexOf(oldPhrase);
  const conditionDraft = !condition ? undefined : operation === 'add_conditions' && !normalizedBody.includes(condition)
    ? `${text}${text ? '\n' : ''}${condition}` : operation === 'replace_conditions' && oldPhrase && oldAt >= 0 && normalizedBody.indexOf(oldPhrase, oldAt + 1) < 0
      ? normalizedBody.slice(0, oldAt) + condition + normalizedBody.slice(oldAt + oldPhrase.length) : undefined;
  const common = { expectedRevision: base.revision, confirmed: true as const, text, ...(role ? { role } : {}), stance, authorship, ...(meaning ? { meaning } : {}),
    ...(storageScopeId ? { storageScopeId } : {}) };
  const input: CognitionMutation | null = mode === 'new' && candidate
    ? { ...common, kind: 'accept_candidate', candidateId: candidate.id }
    : updateTarget ? (candidate ? { ...common, kind: 'accept_candidate', candidateId: candidate.id, target: updateTarget }
      : { ...common, kind: 'update_cognition', target: updateTarget }) : null;
  let previewError = '', reviewCount = 0;
  if (input) {
    try {
      const preview = applyCognitionMutation(base, input, { id: 'preview', at: new Date().toISOString() });
      if (updateTarget && mode === 'update') reviewCount = latestCognition(preview.records.find((r) => r.id === updateTarget.recordId)!).branches
        .reduce((count, b) => count + (b.reviewNeededNodeIds?.length || 0), 0);
    } catch (e) { previewError = (e as Error).message; }
  }
  function replaceTarget(key: string) {
    setSelected(key); clearError(); setPendingTarget(null); setDirty(false);
    if (!candidate) {
      setReason('');
      const c = choices.find((item) => item.key === key);
      if (c) { setText(c.node.text); setRole(c.node.role || ''); setConditionBaseline((c.node.conditions || []).join('\n')); setOldCondition(''); setNewCondition(''); }
    }
  }
  function select(key: string) {
    if (key === selected) return;
    if (!candidate && dirty) { setPendingTarget(key); return; }
    replaceTarget(key);
  }
  async function save() {
    if (!input || previewError || stale || disabled || pendingTarget !== null) return;
    await write(input);
  }
  const visible = choices.filter((c) => c.key === selected || `${c.branch.graph.title} ${c.node.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div ref={leave.root} tabIndex={-1} className="cognition-ui space-y-3" aria-label="整理个人理解" aria-busy={busy}>
    {leave.notice && <p role="status" className="cognition-notice">{leave.notice}</p>}
    {stale && <div role="alert" className="cognition-notice">认知库已变化，当前草稿尚未保存。
      <div className="cognition-actions"><button type="button" className="cognition-action" disabled={busy || disabled} onClick={() => { setBase(file); clearError(); setPendingTarget(null); }}>加载最新版本并重新核对</button></div>
    </div>}
    {pendingTarget !== null && <div role="alert" className="cognition-notice">当前主张有未保存的修改。切换主张会放弃这些修改。
      <div className="cognition-actions"><button ref={pendingButton} type="button" className="cognition-action" disabled={busy || disabled || stale} onClick={() => setPendingTarget(null)}>继续编辑当前主张</button>
        <button type="button" className="cognition-action is-danger" disabled={busy || disabled || stale} onClick={() => replaceTarget(pendingTarget)}>切换并放弃修改</button></div>
    </div>}
    <fieldset disabled={busy || stale || disabled || pendingTarget !== null} className="space-y-3" onChange={(e) => { if (!(e.target as HTMLElement).hasAttribute('data-cognition-nonedit')) setDirty(true); }}>
      <legend className="sr-only">核对变更后确认保存</legend>
      {candidate && <label className="block">保存为<select className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="new">新增理解</option><option value="update" disabled={!choices.length}>更新已有理解</option>
      </select></label>}
      {mode === 'update' && <>
        {!fixedTarget && <>{choices.length > 5 && <label className="block">查找原认知<input data-cognition-nonedit className={field} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入标题或原话" /></label>}
        <label className="block">原认知<select ref={targetSelect} data-cognition-nonedit className={field} value={selected} onChange={(e) => select(e.target.value)}>
          <option value="">请选择要更新的主张</option>{visible.map((c) => <option key={c.key} value={c.key}>{c.branch.graph.title || '未命名'} · {c.branch.kind === 'primary' ? '' : c.branch.kind === 'contextual' ? '不同情境 · ' : '未决分歧 · '}{c.node.text.slice(0, 90)}</option>)}
        </select></label></>}
        {fixedTarget && !target && <p role="alert" className="cognition-notice">原选中的认知块已不存在或无法唯一定位，草稿仍保留；不会改为其他认知块。</p>}
        {firstNode && <details className="cognition-original"><summary>查看首次记录</summary>
          <p className="whitespace-pre-wrap break-words" aria-label="首次记录原文">{firstNode.text}</p>
        </details>}
        <details><summary>特殊更新方式{operation !== 'revise' ? ` · ${COGNITION_OPERATION_LABELS[operation]}` : ''}</summary>
          <label className="block">如何更新<select aria-label="如何更新" className={field} value={operation} onChange={e => {
            const next = e.target.value as typeof operation;
            if (!candidate && next === 'supplement' && text === target?.node.text) setText('');
            else if (!candidate && operation === 'supplement' && next !== 'supplement' && !text) setText(target?.node.text || '');
            setOperation(next);
          }}>
            {Object.entries(COGNITION_OPERATION_LABELS).filter(([key]) => !['initial', 'qualify', 'certainty'].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </details>
      </>}
      {detailedConditions && <div className="cognition-field-group">
        <label className="block">原条件（每行一项）<textarea aria-label="原条件（每行一项）" className={field} rows={2} maxLength={20000} readOnly={storedConditions !== undefined} value={storedConditions?.join('\n') ?? conditionBaseline} onChange={event => setConditionBaseline(event.target.value)} /></label>
        {target?.node.conditions === undefined && <p className="cognition-muted">原记录尚未标注条件；请从原文逐字摘录并核对，不代表原观点没有其他隐含条件。</p>}
        {operation !== 'add_conditions' && <label className="block">要移除或替换的原条件<select aria-label="要移除或替换的原条件" className={field} aria-invalid={!!oldCondition && oldConditionIndex < 0}
          value={!oldCondition ? '' : oldConditionIndex < 0 ? 'missing' : String(oldConditionIndex)} onChange={event => setOldCondition(event.target.value === '' ? '' : conditionChoices[Number(event.target.value)] || '')}>
          <option value="">请选择原条件</option>{!!oldCondition && oldConditionIndex < 0 && <option value="missing" disabled>原选择已变化，请重新选择</option>}
          {conditionChoices.map((condition, index) => <option key={condition} value={String(index)}>条件 {index + 1} · {condition.replace(/\s+/gu, ' ').slice(0, 160)}</option>)}
        </select></label>}
        {operation !== 'remove_conditions' && <label className="block">新条件<textarea aria-label="新条件" className={field} rows={2} maxLength={2000} value={newCondition} onChange={event => setNewCondition(event.target.value)} /></label>}
        {operation !== 'remove_conditions' && <button type="button" className="cognition-action" disabled={conditionDraft === undefined || conditionDraft.length > 20000} onClick={() => {
          if (conditionDraft !== undefined) { setText(conditionDraft); setDirty(true); }
        }}>{operation === 'add_conditions' ? '插入正文末尾' : '替换正文中的原条件'}</button>}
        {operation === 'replace_conditions' && !!oldPhrase && oldAt >= 0 && normalizedBody.indexOf(oldPhrase, oldAt + 1) >= 0 && <p className="cognition-muted">正文有多处相同条件，请手动核对修改，不自动替换多处内容。</p>}
      </div>}
      <label className="block">{mode === 'update' && operation === 'supplement' ? '补充的理解' : '我的理解'}<textarea className={field} rows={3} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {parallel && <label className="block">{operation === 'contextual' ? '适用情境' : '保留分歧的说明'}<input className={field} maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <details className="text-xs"><summary className="cursor-pointer">更多设置 · {role ? ARGUMENT_ROLE_LABELS[role] : '未标注角色'}</summary>
        <div className="mt-2 space-y-2">
          <label className="block">论证角色<select aria-label="论证角色" className={field} value={role} onChange={(e) => setRole(e.target.value as ArgumentRole)}>{!role && <option value="">未标注角色</option>}{ALL_ARGUMENT_ROLES.map((r) => <option key={r} value={r}>{ARGUMENT_ROLE_LABELS[r]}</option>)}</select></label>
          {target?.node.mainType && !target.node.role && <p className="cognition-muted">历史分类：{target.node.mainType}（仅保留来源，不作为当前论证角色）</p>}
          {mode === 'update' && !parallel && <label className="block">更新说明（选填）<input className={field} maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        </div>
      </details>
      <div className="cognition-preview space-y-2 cognition-muted" aria-label="本次变更预览">
        <details><summary>查看本次修改对比</summary>
          {mode === 'update' && target && <p className="whitespace-pre-wrap break-words">修改前：{target.node.text}</p>}
          <p className="whitespace-pre-wrap break-words">{mode === 'new' ? '新增' : operation === 'supplement' || parallel ? '保留原理解，另外记录' : '修改后'}：{text || '（尚未填写）'}</p>
        </details>
        <p>论证角色：{mode === 'update' && target ? `${cognitionRoleLabel(target.node)} → ` : ''}{role ? ARGUMENT_ROLE_LABELS[role] : '未标注角色'}</p>
        <p>{mode === 'new' ? '不覆盖旧认知。' : '其他主张保持不变，旧版本保留。'}不自动建立论证关系，不提高掌握度。</p>
        {meaning?.conditions.changes.map((change, index) => <p key={index}>{change.kind === 'add' ? `新增条件：${change.after}` : change.kind === 'remove' ? `移除条件：${change.before}` : `替换条件：${change.before} → ${change.after}`}</p>)}
        {reviewCount > 0 && <p>保存后有 {reviewCount} 条关联主张待复核；仍保留，不代表已被判错。</p>}
      </div>
      {previewError && <p role="status" className="cognition-muted">{previewError}</p>}
    </fieldset>
    <div className="cognition-actions"><button type="button" className={button} disabled={!input || !!previewError || busy || stale || disabled || pendingTarget !== null} onClick={() => void save()}>{busy ? '正在保存…' : mode === 'new' ? '确认新增理解' : '确认更新理解'}</button>
      {onCancel && <button type="button" disabled={busy || disabled} className="cognition-action" onClick={() => { if (busy || activeWriteLock.current || disabled) return; setDirty(false); onCancel(); }}>取消编辑</button>}</div>
    {error && <p role="alert" className="cognition-error">保存未成功，当前草稿已保留。{error}</p>}
  </div>;
}
