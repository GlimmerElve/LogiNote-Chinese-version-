import React, { useRef, useState } from 'react';
import type { S2Field } from '../../types/sceneS2';
import { s2ControlDraft, s2DefaultFieldText, s2SubmitControlDraft, type S2ControlDraft, type S2FieldSubmission } from '../../services/scene/sceneS2Controls';
import type { S2TableDraft, S2TableCellDraft } from '../../services/scene/sceneS2DataViews';
import { S2FieldPreview } from './S2FieldPreview';
import type { S2FieldControlState } from '../../services/scene/sceneS2Events';
import { s2ControlIssue, s2ControlTarget, type S2ControlIssue, type S2ControlPath } from '../../services/scene/sceneS2ControlIssue';
import { focusS2SimpleValueIssue } from './S2SimpleValueInput';
import { s2FieldRequirement } from '../../services/scene/sceneS2ControlHints';

export interface S2FieldDraft { base: string; schema: string; draft: S2ControlDraft; state?: S2FieldControlState; issue?: S2ControlIssue }
export type S2FieldDrafts = Map<string, S2FieldDraft>;
/** Controlled inputs never execute model-generated markup or handlers. */
export function S2ControlInput({ field, draft, disabled, onChange, path = field.label, issue, controlPath = [], descriptionId }: {
  field: S2Field; draft: S2ControlDraft; disabled: boolean; onChange: (value: S2ControlDraft) => void; path?: string;
  issue?: S2ControlIssue & { errorId: string }; controlPath?: S2ControlPath; descriptionId?: string;
}) {
  const requirement = s2FieldRequirement(field);
  const requirementId = requirement && descriptionId ? `${descriptionId}-requirements-${encodeURIComponent(s2ControlTarget(controlPath))}` : undefined;
  const requirementHint = requirement ? <small id={requirementId} className="s2-control-requirement">{requirement}</small> : null;
  const controlProps = (target = controlPath) => {
    const control = s2ControlTarget(target), invalid = !disabled && issue?.control === control;
    const description = [requirementId, invalid ? `${issue!.errorId}-field` : undefined].filter(Boolean).join(' ');
    return { 'data-s2-simple-control': control, 'aria-invalid': invalid || undefined, 'aria-describedby': description || undefined };
  };
  const feedback = (target = controlPath) => !disabled && issue?.control === s2ControlTarget(target)
    ? <small className="s2-simple-value-issue" id={`${issue.errorId}-field`}>{issue.message}</small> : null;
  if (field.kind === 'table') {
    const rows = draft as S2TableDraft;
    const update = (i: number, key: string, cell: S2TableCellDraft) => onChange(rows.map((row, index) => index === i ? { ...row, [key]: cell } : row));
    return <fieldset disabled={disabled} aria-describedby={requirementId}><legend>{path}{field.required ? '（必填）' : ''}</legend>{requirementHint}<div className="s2-data-table s2-editable-table"><table>
      <caption>表格草稿 · {rows.length} 行</caption><thead><tr>{field.columns!.map(col => <th key={col.id} scope="col">{col.label} · {{ string: '文字', number: '数字', boolean: '是／否' }[col.type]}{col.required ? '（必填）' : ''}</th>)}<th scope="col">行操作</th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{field.columns!.map(col => {
        const cell = row[col.id], label = `${path} / 第 ${i + 1} 行 / ${col.label}`;
        const cellPath = [...controlPath, 'cells', i, col.id];
        return <td key={col.id}><label>{label}状态<select {...controlProps([...cellPath, 'state'])} aria-label={`${label}状态`} value={cell.state} disabled={disabled} onChange={e => update(i, col.id, { ...cell, state: e.target.value as S2TableCellDraft['state'] })}>
          <option value="missing">未填写</option><option value="value">已填写</option>{col.nullable && <option value="null">空值</option>}</select></label>
          {feedback([...cellPath, 'state'])}
          {cell.state === 'value' && <label>{label}{col.type === 'boolean' ? <select {...controlProps([...cellPath, 'text'])} aria-label={label} disabled={disabled} value={cell.text} onChange={e => update(i, col.id, { ...cell, text: e.target.value })}>
            <option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
            : <input {...controlProps([...cellPath, 'text'])} aria-label={label} type="text" inputMode={col.type === 'number' ? 'decimal' : undefined} value={cell.text} maxLength={2000} disabled={disabled} onChange={e => update(i, col.id, { ...cell, text: e.target.value })} />}{feedback([...cellPath, 'text'])}</label>}</td>;
      })}<td><button type="button" disabled={disabled} aria-label={`删除${path}第${i + 1}行`} onClick={() => onChange(rows.filter((_, index) => index !== i))}>删除行</button></td></tr>)}</tbody>
    </table></div><button {...controlProps([...controlPath, 'add'])} type="button" disabled={disabled || rows.length >= (field.maxItems ?? 32)} onClick={() => onChange([...rows, Object.fromEntries(field.columns!.map(col => [col.id, { state: col.required ? 'value' : 'missing', text: '' }]))])}>添加{path}行</button>{feedback([...controlPath, 'add'])}
      <small>“未填写”不提供该项；“空值”明确记录此项没有值；“已填写”保留你输入的文字、数字或选择。</small></fieldset>;
  }
  if (field.kind === 'json' || field.kind === 'code') return <label>{path}{field.required ? '（必填）' : ''}
    <textarea {...controlProps()} aria-label={path} className="s2-code-input" spellCheck={false} disabled={disabled} maxLength={field.maxLength ?? 6000} value={(draft as string) ?? ''} onChange={e => onChange(e.target.value)} />{requirementHint}{feedback()}
    <small>{field.kind === 'json' ? '提交时校验完整 JSON，保留原文格式。' : `代码文本 · ${field.language ?? 'plain'} · 仅编辑展示`}</small></label>;
  if (field.kind === 'form') return <fieldset disabled={disabled}><legend>{path}{field.required ? '（必填）' : ''}</legend>
    {field.fields!.map(child => <S2ControlInput key={child.id} field={child} descriptionId={descriptionId} issue={issue} controlPath={[...controlPath, 'fields', child.id]} path={`${path} / ${child.label}`} draft={(draft as Record<string, S2ControlDraft>)[child.id]}
      disabled={disabled} onChange={value => onChange({ ...(draft as Record<string, S2ControlDraft>), [child.id]: value })} />)}</fieldset>;
  if (field.kind === 'list') {
    const rows = draft as S2ControlDraft[];
    return <fieldset disabled={disabled} aria-describedby={requirementId}><legend>{path}{field.required ? '（必填）' : ''} · {rows.length} 项</legend>{requirementHint}
      {rows.map((value, i) => <div key={i}><S2ControlInput field={field.item!} descriptionId={descriptionId} issue={issue} controlPath={[...controlPath, 'items', i]} path={`${path} / 第 ${i + 1} 项`} draft={value} disabled={disabled}
        onChange={next => onChange(rows.map((row, index) => index === i ? next : row))} />
        <button type="button" disabled={disabled} aria-label={`删除 ${path} 第 ${i + 1} 项`} onClick={() => onChange(rows.filter((_, index) => index !== i))}>删除该项</button></div>)}
      <button {...controlProps([...controlPath, 'add'])} type="button" disabled={disabled || rows.length >= (field.maxItems ?? 32)} onClick={() => onChange([...rows, s2ControlDraft(field.item!, s2DefaultFieldText(field.item!))])}>添加{path}项</button>{feedback([...controlPath, 'add'])}
    </fieldset>;
  }
  return <label>{path}{field.required ? '（必填）' : ''}
    {field.kind === 'enum' || field.kind === 'boolean' ? <select {...controlProps()} aria-label={path} aria-required={!!field.required} disabled={disabled} value={(draft as string) ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">请选择</option>{(field.kind === 'boolean' ? ['true', 'false'] : field.options!).map(value => <option key={value} value={value}>{field.kind === 'boolean' ? value === 'true' ? '是' : '否' : value}</option>)}
    </select> : field.kind === 'multiline' ? <textarea {...controlProps()} aria-label={path} aria-required={!!field.required} disabled={disabled} maxLength={field.maxLength ?? 6000} value={(draft as string) ?? ''} onChange={e => onChange(e.target.value)} />
      : <input {...controlProps()} aria-label={path} aria-required={!!field.required} disabled={disabled} type="text" inputMode={field.kind === 'number' ? 'decimal' : undefined} maxLength={field.maxLength ?? 6000} value={(draft as string) ?? ''} onChange={e => onChange(e.target.value)} />}{requirementHint}{feedback()}
  </label>;
}
/** Drafts survive selection changes, but never silently overwrite a newer committed field. */
export function S2FieldEditor({ nodeId, field, value, drafts, disabled, onSubmit, onStateChange, variant = 'panel', onDone, autoFocus = true }: {
  nodeId: string; field: S2Field; value: string; drafts: S2FieldDrafts; disabled: boolean; onSubmit: (event: S2FieldSubmission) => void;
  onStateChange?: (state: S2FieldControlState, baseValue: string) => void;
  variant?: 'panel' | 'inline'; onDone?: () => void; autoFocus?: boolean;
}) {
  const key = JSON.stringify([nodeId, field.id]), schema = JSON.stringify(field);
  const inline = variant === 'inline', compactText = inline && ['text', 'multiline'].includes(field.kind);
  const [, refresh] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const submitting = useRef(false), composing = useRef(false);
  const formRef = useRef<HTMLFormElement>(null), renderOwner = useRef<object | null>(null), owner = {};
  renderOwner.current = owner;
  let saved = drafts.get(key);
  if (!saved) {
    if (drafts.size >= 320) drafts.delete(drafts.keys().next().value!);
    saved = { base: value, schema, draft: s2ControlDraft(field, value) }; drafts.set(key, saved);
  }
  const conflict = saved.base !== value || saved.schema !== schema;
  const stale = () => renderOwner.current !== owner || drafts.get(key) !== saved;
  const issue = !conflict && saved.state === 'invalid' ? saved.issue : undefined;
  // Only trusted local control evidence survives, never a host exception body.
  const displayError = conflict ? '字段已被修改，草稿仍保留。请先载入当前值后重新编辑。'
    : error || (saved.state === 'invalid' ? '草稿上次校验未通过，请修改后重新提交。' : '');
  const errorId = `s2-field-error-${encodeURIComponent(key)}`;
  const report = (state: S2FieldControlState, base = saved!.base) => { try { onStateChange?.(state, base); } catch { /* Metadata observation never blocks editing or a successful commit. */ } };
  const locate = (entry: S2FieldDraft) => {
    if (disabled || conflict || renderOwner.current !== owner || drafts.get(key) !== entry || entry.base !== value
      || entry.schema !== schema || entry.state !== 'invalid' || !entry.issue || !formRef.current) return;
    focusS2SimpleValueIssue(formRef.current, entry.issue.control);
  };
  const reload = () => { if (disabled || stale()) return; drafts.set(key, { base: value, schema, draft: s2ControlDraft(field, value), state: 'reloaded' }); report('reloaded', value); submitting.current = false; setError(''); setNotice('已载入当前值'); refresh(v => v + 1); };
  const submit = () => {
    if (disabled || composing.current || submitting.current || stale()) return;
    if (conflict) { report('conflict'); return; }
    submitting.current = true;
    let validating = true;
    try {
      const next = s2SubmitControlDraft(field, saved!.draft);
      validating = false;
      onSubmit({ version: 1, kind: 'field-submit', nodeId, fieldId: field.id, previousValue: saved!.base, value: next });
      drafts.set(key, { ...saved!, base: next, state: 'submitted', issue: undefined }); report('submitted', next); setError(''); setNotice('已提交'); refresh(v => v + 1);
    } catch (e) {
      const invalid: S2FieldDraft = { ...saved!, state: 'invalid' };
      delete invalid.issue;
      const localIssue = validating ? s2ControlIssue(e) : undefined;
      if (localIssue) invalid.issue = localIssue;
      drafts.set(key, invalid); report('invalid'); submitting.current = false; setError(e instanceof Error ? e.message : '提交失败，草稿已保留');
      try { locate(invalid); } catch { /* Best-effort focus cannot discard the draft. */ }
      return;
    }
    if (inline) onDone?.();
  };
  const cancel = () => {
    if (disabled || stale()) return;
    // Escape restores the latest committed value, never an earlier successful submission.
    drafts.set(key, { base: value, schema, draft: s2ControlDraft(field, value), state: 'reloaded' });
    report('reloaded', value); submitting.current = false; setError(''); setNotice(''); refresh(v => v + 1); onDone?.();
  };
  const change = (draft: S2ControlDraft) => {
      if (disabled || conflict || stale()) return;
      drafts.set(key, { ...saved!, draft, issue: undefined, state: 'editing' }); report('editing'); submitting.current = false; setError(''); setNotice('尚未提交'); refresh(v => v + 1);
  };
  const textProps = { 'aria-label': field.label, 'aria-required': !!field.required, 'aria-invalid': !!displayError,
    'aria-describedby': displayError ? errorId : undefined, 'data-s2-simple-control': s2ControlTarget([]),
    disabled: disabled || conflict, autoFocus, maxLength: field.maxLength ?? 6000,
    value: (saved.draft as string) ?? '', onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(event.target.value) };
  return <form ref={element => { formRef.current = element; renderOwner.current = element ? owner : null; }}
    className={`s2-control-editor${inline ? ' s2-control-editor--inline nodrag nopan nowheel' : ''}`}
    aria-label={`编辑字段 ${field.label}`} aria-invalid={!!displayError} aria-describedby={displayError ? errorId : undefined} noValidate
    onPointerDown={inline ? event => event.stopPropagation() : undefined}
    onClick={inline ? event => event.stopPropagation() : undefined}
    onDoubleClick={inline ? event => event.stopPropagation() : undefined}
    onCompositionStart={inline ? () => { composing.current = true; } : undefined}
    onCompositionEnd={inline ? () => { composing.current = false; } : undefined}
    onKeyDown={inline ? event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      else if (compactText && event.key === 'Enter' && (field.kind === 'text' || event.ctrlKey || event.metaKey)) {
        event.preventDefault(); submit();
      }
    } : undefined}
    onBlur={compactText ? event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) submit();
    } : undefined}
    onSubmit={event => { event.preventDefault(); if (inline) event.stopPropagation(); submit(); }}>
    {saved.schema === schema && (compactText
      ? field.kind === 'multiline' ? <textarea {...textProps} className="s2-inline-text" /> : <input {...textProps} type="text" className="s2-inline-input" />
      : <S2ControlInput field={field} descriptionId={errorId} draft={saved.draft} issue={issue ? { ...issue, errorId } : undefined} disabled={disabled || conflict} onChange={change} />)}
    {displayError && <p id={errorId} role="alert">{displayError}</p>}
    {issue && <button type="button" disabled={disabled || conflict} onClick={() => { try { locate(saved!); } catch { /* Detached control. */ } }}>定位填写问题</button>}
    {!compactText && <><p>草稿仅在本局保留，提交后更新画布。</p>
      <button type="submit" disabled={disabled || conflict}>提交{field.label}</button></>}
    {(!compactText || !!displayError) && <button type="button" disabled={disabled} onClick={reload}>载入当前{field.label}</button>}
    {!compactText && <span role="status">{notice}</span>}
    {['table', 'json', 'code'].includes(field.kind) && value !== '' && <S2FieldPreview field={field} value={value} />}
  </form>;
}
