import React, { useRef, useState } from 'react';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2Field } from '../../types/sceneS2';
import { S2ControlInput } from './S2FieldEditor';
import { S2SimpleValueInput, focusS2SimpleValueIssue } from './S2SimpleValueInput';
import { s2ParameterFormDraft, submitS2ParameterForm } from '../../services/scene/sceneS2ParameterForm';
import { s2SimpleValueDraft, submitS2SimpleValueDraft, s2SimpleValueIssue } from '../../services/scene/sceneS2SimpleValueForm';
import { s2ControlIssue } from '../../services/scene/sceneS2ControlIssue';
import type { S2ParameterDraft, S2ParameterDrafts, S2SubmitVia } from '../../services/scene/sceneS2ControlDrafts';
import type { S2FieldControlState } from '../../services/scene/sceneS2Events';

/** Staged JSON editing: invalid partial typing never changes the committed graph. */
export function S2JsonParameter({ nodeId = 'local', portId, value, sourceKey, drafts: providedDrafts, disabled, onCommit, onStateChange, formField, valueForm = false, label }: {
  nodeId?: string; portId: string; value?: S2Json; sourceKey?: string; drafts?: S2ParameterDrafts; disabled: boolean;
  formField?: S2Field; valueForm?: boolean; label?: string;
  onCommit: (value: S2Json, base: string, via?: S2SubmitVia) => string | void;
  onStateChange?: (state: S2FieldControlState, base: string, via?: S2SubmitVia) => void;
}) {
  const localDrafts = useRef<S2ParameterDrafts>(new Map()), submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focusOwner = useRef<object | null>(null), owner = {};
  focusOwner.current = owner;
  const drafts = providedDrafts ?? localDrafts.current, key = JSON.stringify([nodeId, portId]);
  const currentSource = sourceKey ?? JSON.stringify([value === undefined, value ?? null]);
  const simpleEnabled = valueForm && !formField;
  const schema = formField ? JSON.stringify(formField) : '', title = formField?.label ?? (simpleEnabled ? label || '固定内容' : `JSON 参数 ${portId}`);
  const named = !!formField || simpleEnabled;
  const [, refresh] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  let saved = drafts.get(key);
  if (!saved) {
    if (drafts.size >= 320) drafts.delete(drafts.keys().next().value!);
    saved = initial(); drafts.set(key, saved);
  }
  function initial() {
    const formatted = value === undefined ? '' : JSON.stringify(value, null, 2);
    const entry: NonNullable<ReturnType<S2ParameterDrafts['get']>> = { base: currentSource, draft: formatted.length > 24000 ? JSON.stringify(value) : formatted };
    if (formField) try { entry.form = { schema, draft: s2ParameterFormDraft(formField, value) }; entry.mode = 'form'; } catch { entry.mode = 'json'; }
    else if (simpleEnabled) try { entry.simple = s2SimpleValueDraft(value); entry.mode = 'simple'; } catch { entry.mode = 'json'; }
    return entry;
  }
  const conflict = saved.base !== currentSource || !!saved.form && saved.form.schema !== schema || saved.mode === 'simple' && !simpleEnabled, errorId = `s2-parameter-${encodeURIComponent(key)}-error`;
  const formMode = !!formField && saved.mode === 'form' && !!saved.form && saved.form.schema === schema;
  const simpleMode = simpleEnabled && saved.mode === 'simple' && !!saved.simple;
  const simpleIssue = simpleMode && saved.state === 'invalid' && !conflict ? saved.simpleIssue : undefined;
  const formIssue = formMode && saved.state === 'invalid' && !conflict ? saved.formIssue : undefined;
  const staleDraft = () => named && (drafts.get(key) !== saved || focusOwner.current !== owner);
  const displayError = error || (saved.state === 'invalid' ? '草稿上次校验未通过，请修改后重新提交。' : '');
  const report = (state: S2FieldControlState, base = saved!.base, via?: S2SubmitVia) => { try { onStateChange?.(state, base, via); } catch { /* Observation cannot block editing. */ } };
  function locateIssue(entry: S2ParameterDraft) {
    const issue = simpleMode && entry.mode === 'simple' ? entry.simpleIssue
      : formMode && entry.mode === 'form' && entry.form?.schema === schema ? entry.formIssue : undefined;
    if (disabled || conflict || entry.state !== 'invalid' || !issue
      || drafts.get(key) !== entry || entry.base !== currentSource || focusOwner.current !== owner || !formRef.current) return;
    focusS2SimpleValueIssue(formRef.current!, issue.control);
  }
  function submit(via: S2SubmitVia) {
    if (disabled || staleDraft()) return;
    if (conflict) { report('conflict', saved!.base, via); return; }
    if (submitting.current) return;
    submitting.current = true;
    let validating = true;
    try {
      if (!simpleMode && saved!.draft.length > 24000) throw new Error('JSON 参数超过长度限制');
      const parsed: S2Json = formMode ? submitS2ParameterForm(formField!, saved!.form!.draft) : simpleMode ? submitS2SimpleValueDraft(saved!.simple!) : JSON.parse(saved!.draft);
      validating = false;
      const committed = onCommit(parsed, saved!.base, via);
      const base = typeof committed === 'string' ? committed : sourceKey ?? JSON.stringify([false, parsed]);
      const jsonDraft = JSON.stringify(parsed, null, 2);
      drafts.set(key, { ...saved!, simpleIssue: undefined, formIssue: undefined, draft: formMode || simpleMode ? simpleMode && jsonDraft.length > 24000 ? JSON.stringify(parsed) : jsonDraft : saved!.draft, base, state: 'submitted' }); report('submitted', base, via); setError(''); setNotice('已应用参数；未执行插件'); refresh(v => v + 1);
    } catch (error) {
      submitting.current = false;
      const invalid: S2ParameterDraft = { ...saved!, state: 'invalid', simpleIssue: validating && simpleMode ? s2SimpleValueIssue(error) : undefined,
        formIssue: validating && formMode ? s2ControlIssue(error) : undefined };
      drafts.set(key, invalid); report('invalid', saved!.base, via); setError(error instanceof Error ? error.message : 'JSON 参数无效');
      try { locateIssue(invalid); } catch { /* Focus is best effort; validation and the original draft still survive. */ }
    }
  }
  return <form ref={formRef} className="s2-json-parameter" aria-label={`编辑${named ? title : ` JSON 参数 ${portId}`}`} aria-invalid={!!displayError || conflict} aria-describedby={displayError || conflict ? errorId : undefined} noValidate onSubmit={event => { event.preventDefault(); submit('form'); }}>
    {formMode ? <S2ControlInput field={formField!} descriptionId={errorId} draft={saved.form!.draft} issue={formIssue ? { ...formIssue, errorId } : undefined} disabled={disabled || conflict} onChange={draft => {
      if (disabled || conflict || staleDraft()) return;
      drafts.set(key, { ...saved!, form: { schema, draft }, formIssue: undefined, state: 'editing' }); submitting.current = false; report('editing'); setError(''); setNotice('尚未应用'); refresh(v => v + 1);
    }} /> : simpleMode ? <S2SimpleValueInput label={title} draft={saved.simple!} issue={simpleIssue ? { ...simpleIssue, errorId } : undefined} disabled={disabled || conflict} onChange={draft => {
      if (disabled || conflict || staleDraft()) return;
      drafts.set(key, { ...saved!, simple: draft, simpleIssue: undefined, state: 'editing' }); submitting.current = false; report('editing'); setError(''); setNotice('尚未应用'); refresh(v => v + 1);
    }} /> : <label>JSON 参数 {named ? title : portId}<textarea value={saved.draft} disabled={disabled || conflict} maxLength={24000} aria-label={`JSON 参数 ${named ? title : portId}`}
      aria-invalid={!!displayError || conflict} aria-describedby={displayError || conflict ? errorId : undefined}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
          && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); submit('shortcut'); }
      }} onChange={event => {
        if (disabled || conflict || staleDraft()) return;
        drafts.set(key, { ...saved!, draft: event.target.value, formIssue: undefined, simpleIssue: undefined, state: 'editing' }); submitting.current = false; report('editing'); setError(''); setNotice('尚未应用'); refresh(v => v + 1);
      }} /></label>}
    {formField && !formMode && <p>当前使用完整 JSON 编辑。只有表单能完整保留全部字段、空值和类型时才可切回；原材料未被改写。</p>}
    {simpleEnabled && !simpleMode && <p>当前使用高级 JSON 编辑，原有字段与类型完整保留。常用表单支持每层32项、32条记录、一层信息分组，以及顶层或字段内32项列表；列表项可为普通值或单层具名内容。列表项内再套对象或列表、更深对象及超范围内容继续高级编辑。</p>}
    <p>{formMode || simpleMode ? '按名称填写，点击应用后更新材料；不会自动运行。草稿仅在本局保留。' : '草稿仅在本局保留，不自动应用或执行。提交时校验完整 JSON 和端口类型；Ctrl/⌘+Enter 可提交，普通 Enter 换行。'}</p>
    <button type="submit" disabled={disabled || conflict}>{named ? `应用${title}` : `应用 JSON 参数 ${portId}`}</button>
    <button type="button" disabled={disabled} onClick={() => {
      if (disabled || staleDraft()) return;
      drafts.set(key, { ...initial(), state: 'reloaded' });
      submitting.current = false; report('reloaded', currentSource); setError(''); setNotice('已载入当前参数'); refresh(v => v + 1);
    }}>{named ? `载入当前${title}` : `载入当前 JSON 参数 ${portId}`}</button>
    {formField && <button type="button" disabled={disabled || conflict} onClick={() => {
      if (disabled || conflict || staleDraft()) return;
      try {
        if (formMode) drafts.set(key, { ...saved!, draft: JSON.stringify(submitS2ParameterForm(formField, saved!.form!.draft), null, 2), mode: 'json', formIssue: undefined });
        else drafts.set(key, { ...saved!, form: { schema, draft: s2ParameterFormDraft(formField, saved!.draft === '' ? undefined : JSON.parse(saved!.draft)) }, mode: 'form', formIssue: undefined });
        submitting.current = false; setError(''); setNotice('已切换编辑方式；未应用或运行'); refresh(v => v + 1);
      } catch { setError('当前草稿不能无损切换，请先修正内容；原草稿已保留。'); }
    }}>{formMode ? '改用 JSON 编辑（高级）' : '切回表单填写'}</button>}
    {simpleEnabled && <button type="button" disabled={disabled || conflict} onClick={() => {
      if (disabled || conflict || staleDraft()) return;
      try {
        if (simpleMode) {
          const next = submitS2SimpleValueDraft(saved!.simple!);
          let text = JSON.stringify(next, null, 2); if (text.length > 24000) text = JSON.stringify(next);
          try { if (saved!.draft.length <= 24000 && JSON.stringify(JSON.parse(saved!.draft)) === JSON.stringify(next)) text = saved!.draft; } catch { /* New form draft has no previous valid JSON. */ }
          if (text.length > 24000) throw new Error('完整 JSON 超过编辑长度；原草稿已保留。');
          drafts.set(key, { ...saved!, draft: text, mode: 'json', simpleIssue: undefined });
        } else {
          const next = saved!.draft === '' ? undefined : JSON.parse(saved!.draft);
          let simple = s2SimpleValueDraft(next);
          try { if (saved!.simple && JSON.stringify(submitS2SimpleValueDraft(saved!.simple)) === JSON.stringify(next)) simple = saved!.simple; } catch { /* Current JSON is the authoritative edited mode. */ }
          drafts.set(key, { ...saved!, simple, mode: 'simple', simpleIssue: undefined });
        }
        submitting.current = false; setError(''); setNotice('已切换编辑方式；未应用或运行'); refresh(v => v + 1);
      } catch { setError('当前草稿不能无损切换；请补全内容或继续高级编辑，原草稿已保留。'); }
    }}>{simpleMode ? '改用 JSON 编辑（高级）' : '切回常用表单'}</button>}
    {(displayError || conflict) && <p id={errorId} role="alert">{conflict ? '参数来源已变化，草稿已保留；请载入当前参数后重新编辑。' : displayError}</p>}
    {(simpleIssue || formIssue) && <button type="button" disabled={disabled || conflict} onClick={() => { try { locateIssue(saved!); } catch { /* A detached control cannot block editing. */ } }}>定位填写问题</button>}
    <span role="status">{notice}</span>
  </form>;
}
