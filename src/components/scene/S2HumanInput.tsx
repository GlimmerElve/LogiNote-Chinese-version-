import React, { useRef, useState } from 'react';
import type { S2PluginHost } from '../../services/scene/sceneS2PluginHost';
import { S2ArtifactView } from './S2ArtifactView';
import { S2ControlInput } from './S2FieldEditor';
import { s2ParameterFormDraft, submitS2ParameterForm } from '../../services/scene/sceneS2ParameterForm';
import type { S2HumanDraft, S2HumanDrafts, S2DraftInputState, S2SubmitVia } from '../../services/scene/sceneS2ControlDrafts';
import { s2ControlIssue } from '../../services/scene/sceneS2ControlIssue';
import { focusS2SimpleValueIssue } from './S2SimpleValueInput';

export function S2HumanInput({ wait, nodeLabel, disabled, onSubmit, onCancel, drafts: providedDrafts, onStateChange, panelRef }: {
  wait: ReturnType<S2PluginHost['waitingHumanInputs']>[number]; disabled: boolean;
  nodeLabel?: string;
  onSubmit: (value: unknown, via?: S2SubmitVia) => void; onCancel: () => void; drafts?: S2HumanDrafts;
  onStateChange?: (state: S2DraftInputState, via?: S2SubmitVia) => void;
  panelRef?: React.Ref<HTMLElement>;
}) {
  const localDrafts = useRef<S2HumanDrafts>(new Map()), drafts = providedDrafts ?? localDrafts.current;
  const key = JSON.stringify([wait.workflowId, wait.id, wait.revision]);
  const [, refresh] = useState(0), [error, setError] = useState(''), [doneKey, setDone] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const submitting = useRef(''), done = doneKey === key;
  const formRef = useRef<HTMLFormElement>(null), renderOwner = useRef<object | null>(null), owner = {};
  const errorOwner = useRef(''); renderOwner.current = owner;
  const formField = wait.capabilityId === 'json' ? wait.responseForm : undefined, schema = formField ? JSON.stringify(formField) : '';
  if (!drafts.has(key)) {
    if (drafts.size >= 320) drafts.delete(drafts.keys().next().value!);
    drafts.set(key, { draft: '', ...(formField ? { form: { schema, draft: s2ParameterFormDraft(formField, undefined) }, mode: 'form' as const } : {}) });
  }
  const saved = drafts.get(key)!;
  const conflict = !!saved.form && saved.form.schema !== schema;
  const formMode = !!formField && saved.mode === 'form' && !!saved.form && !conflict;
  const stale = () => renderOwner.current !== owner || drafts.get(key) !== saved;
  const issue = formMode && saved.state === 'invalid' && !done && !conflict ? saved.issue : undefined;
  const showError = (message: string) => { errorOwner.current = key; setError(message); };
  const displayError = conflict ? '本次表单已变化，草稿仍保留；请取消后重新运行，不会按新字段提交旧答案。'
    : (errorOwner.current === key ? error : '') || (saved.state === 'invalid' ? '上次提交未成功，草稿已保留；请修改后重新提交。' : '');
  const report = (state: S2DraftInputState, via?: S2SubmitVia) => { try { onStateChange?.(state, via); } catch { /* Invalidated waits must not break the local draft. */ } };
  function locate(entry: S2HumanDraft) {
    if (disabled || done || conflict || !formMode || submitting.current === key || renderOwner.current !== owner
      || drafts.get(key) !== entry || entry.mode !== 'form' || entry.form?.schema !== schema
      || entry.state !== 'invalid' || !entry.issue || !formRef.current) return;
    focusS2SimpleValueIssue(formRef.current, entry.issue.control);
  }
  function submit(via: S2SubmitVia, confirmation?: boolean) {
    if (disabled || done || conflict || submitting.current === key || stale()) return;
    submitting.current = key; showError('');
    let validating = true;
    try {
      const value = wait.capabilityId === 'confirm' ? confirmation : formMode ? submitS2ParameterForm(formField!, saved.form!.draft)
        : wait.capabilityId === 'json' ? JSON.parse(saved.draft) : saved.draft;
      validating = false;
      onSubmit(value, via); drafts.delete(key); setCancelled(false); setDone(key);
    } catch (error) {
      const invalid: S2HumanDraft = { ...saved, state: 'invalid', issue: validating && formMode ? s2ControlIssue(error) : undefined };
      submitting.current = ''; drafts.set(key, invalid); report('invalid', via);
      showError(error instanceof Error && error.name === 'SyntaxError' && wait.capabilityId === 'json'
        ? 'JSON 格式无效，草稿已保留，等待尚未解除' : error instanceof Error ? error.message : '提交失败，草稿已保留'); refresh(v => v + 1);
      try { locate(invalid); } catch { /* Best-effort focus does not answer or cancel a wait. */ }
    }
  }
  const errorId = `s2-human-${wait.id}-error`;
  const title = nodeLabel?.trim() || '本步骤', descriptionId = `s2-human-${wait.id}-description`;
  const confirmationId = `s2-human-${wait.id}-confirmation`, shortcutId = `s2-human-${wait.id}-shortcut`;
  return <section ref={panelRef} tabIndex={-1} className="s2-human-input" aria-label={`需要你${wait.capabilityId === 'confirm' ? '确认' : '补充材料'}：${title}`}>
    <h4>{title} · 等待你{wait.capabilityId === 'confirm' ? '确认' : '补充材料'}</h4><p>{wait.prompt}</p>
    <p id={descriptionId}>流程在这里等你；提交后接着处理，前面已完成的结果会保留。你仍可与 Agent 讨论，但聊天不会代替这里的提交。</p>
    {wait.artifacts.length > 0 && <div aria-label="供你参考的材料"><p>参考材料</p>
      {wait.artifacts.map(artifact => <S2ArtifactView key={artifact.id} artifact={artifact} presentation="reading" />)}
    </div>}
    {wait.capabilityId === 'confirm' ? <div>
      <p id={confirmationId}>两种选择都会交给后续步骤处理，不会新增工具授权。“不同意”不等于取消运行；如果想停止，请使用下方的取消按钮。</p>
      <button aria-describedby={confirmationId} disabled={disabled || done} onClick={() => submit('form', true)}>同意并继续</button>
      <button aria-describedby={confirmationId} disabled={disabled || done} onClick={() => submit('form', false)}>不同意并继续</button>
    </div> : <form ref={formRef} noValidate aria-label={formField ? `填写${formField.label}` : undefined} aria-invalid={!!displayError}
      aria-describedby={`${descriptionId}${displayError ? ` ${errorId}` : ''}`} onKeyDown={event => {
        if (formMode && event.key === 'Enter' && !event.ctrlKey && !event.metaKey
          && !event.nativeEvent?.isComposing && event.keyCode !== 229
          && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); return; }
        if (formMode && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
          && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); submit('shortcut'); }
      }} onSubmit={event => {
      event.preventDefault();
      submit('form');
    }}>
      {formMode ? <S2ControlInput field={formField!} descriptionId={errorId} draft={saved.form!.draft} issue={issue ? { ...issue, errorId } : undefined} disabled={disabled || done || conflict} onChange={draft => {
        if (disabled || done || conflict || submitting.current === key || stale()) return;
        drafts.set(key, { ...saved, form: { schema, draft }, issue: undefined, state: 'editing' }); report('editing'); showError(''); refresh(v => v + 1);
      }} /> : <label>{wait.capabilityId === 'json' ? '补充数据（JSON 格式）' : '补充内容'}<textarea value={saved.draft} maxLength={wait.capabilityId === 'json' ? 24000 : 6000}
        aria-invalid={!!displayError} aria-describedby={`${descriptionId} ${shortcutId}${displayError ? ` ${errorId}` : ''}`} disabled={disabled || done || conflict}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
            && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); submit('shortcut'); }
        }} onChange={event => {
          if (disabled || done || conflict || submitting.current === key || stale()) return;
          drafts.set(key, { ...saved, draft: event.target.value, issue: undefined, state: 'editing' }); report('editing'); showError(''); refresh(v => v + 1);
        }} /></label>}
      {formField && <p>{formMode ? '按字段填写，提交后才交给后续步骤；填写和切换方式都不会运行。' : '完整 JSON 编辑会保留全部字段和原生类型；不能无损转换时不会强行切回表单。'}</p>}
      <p id={shortcutId}>{formMode ? '草稿仅在本局保留；多行文本可 Enter 换行，填写完成后点击提交或按 Ctrl/⌘+Enter。'
        : '草稿仅在本局保留；Ctrl/⌘+Enter 提交，普通 Enter 换行。'}</p>
      <button type="submit" disabled={disabled || done || conflict || !formMode && !saved.draft.trim()}>提交输入并继续</button>
      {issue && <button type="button" disabled={disabled || done || conflict} onClick={() => { try { locate(saved); } catch { /* Detached form. */ } }}>定位填写问题</button>}
      {formField && <button type="button" disabled={disabled || done || conflict} onClick={() => {
        if (disabled || done || conflict || submitting.current === key || stale()) return;
        try {
          if (formMode) drafts.set(key, { ...saved, draft: JSON.stringify(submitS2ParameterForm(formField, saved.form!.draft), null, 2), mode: 'json', issue: undefined });
          else drafts.set(key, { ...saved, form: { schema, draft: s2ParameterFormDraft(formField, saved.draft === '' ? undefined : JSON.parse(saved.draft)) }, mode: 'form', issue: undefined });
          showError(''); refresh(v => v + 1);
        } catch { showError('当前草稿不能无损切换，请先修正内容；原草稿已保留，等待未解除。'); }
      }}>{formMode ? '改用 JSON 编辑（高级）' : '切回表单填写'}</button>}
    </form>}
    {displayError && <p id={errorId} role="alert">{displayError}</p>}
    {done && <span role="status">{cancelled ? '已请求取消本次运行，已完成的记录仍保留；最终状态请查看运行记录。' : '已提交，流程将继续处理。'}</span>}
    <p>取消会停止这次运行中所有尚未完成的步骤，包括其他填写或确认等待；不会取消其他运行。已完成的记录与已用次数保留，正在执行的调用仍以实际返回记录为准。重新运行需要你再次提交，不能恢复旧等待或沿用旧答案。</p>
    <button disabled={disabled || done} onClick={() => {
      if (disabled || done || submitting.current === key || stale()) return;
      try { onCancel(); drafts.delete(key); setCancelled(true); setDone(key); submitting.current = key; }
      catch (error) { showError(error instanceof Error ? error.message : '等待已变化，未取消其他运行'); }
    }}>取消本次运行（保留已完成记录）</button>
    <details><summary>技术详情</summary><p>步骤编号：{wait.nodeId}</p><p>运行编号：{wait.workflowId}</p><p>等待编号：{wait.id}</p></details>
  </section>;
}
