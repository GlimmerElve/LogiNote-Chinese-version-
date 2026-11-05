import React, { useEffect, useRef, useState, useId } from 'react';
import type { SceneFormSubmission, SceneInputForm } from '../../types';
import { readSceneFormSubmission } from '../../services/scene/sceneInputForm';

export const SceneDynamicForm: React.FC<{ form: SceneInputForm; disabled: boolean; initialSubmission?: SceneFormSubmission; onSubmit: (value: SceneFormSubmission) => void }> = ({ form, disabled, initialSubmission, onSubmit }) => {
  const reactId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => {
    try { return initialSubmission ? readSceneFormSubmission(initialSubmission, form).values : {}; }
    catch { return {}; }
  });
  const [error, setError] = useState('');
  const submissionLock = useRef(false);
  useEffect(() => { if (!disabled) submissionLock.current = false; }, [disabled]);
  const change = (id: string, value: string) => { submissionLock.current = false; setError(''); setValues(previous => ({ ...previous, [id]: value })); };
  return <form className="scene-interaction-input" aria-label={form.title} aria-busy={disabled} onSubmit={event => {
    event.preventDefault();
    if (disabled || submissionLock.current) return;
    try { const submission = readSceneFormSubmission({ formId: form.id, values }, form); submissionLock.current = true; onSubmit(submission); }
    catch (failure) { submissionLock.current = false; setError(failure instanceof Error ? failure.message : '表单未通过检查。'); }
  }}>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12, minWidth: 0 }}>
      <legend>{form.title}</legend>
      {form.description && <p>{form.description}</p>}
      {form.fields.map(field => { const fieldId = `${reactId}-${field.id}`; return <div key={field.id} style={{ display: 'grid', gap: 6 }}>
        <label htmlFor={fieldId}>{field.label}{field.required ? '（必填）' : '（可选）'}</label>
        {field.kind === 'select' ? <select id={fieldId} className="scene-input" value={values[field.id] || ''} required={field.required}
          onChange={event => change(field.id, event.target.value)}><option value="">请选择</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : field.kind === 'textarea' ? <textarea id={fieldId} className="scene-textarea" rows={field.purpose === 'prompt' ? 6 : 3}
            value={values[field.id] || ''} maxLength={field.maxLength} required={field.required} placeholder={field.placeholder}
            aria-describedby={`${fieldId}-hint`} onChange={event => change(field.id, event.target.value)} />
          : <input id={fieldId} className="scene-input" value={values[field.id] || ''} maxLength={field.maxLength} required={field.required}
            placeholder={field.placeholder} aria-describedby={`${fieldId}-hint`} onChange={event => change(field.id, event.target.value)} />}
        {field.kind !== 'select' && <small id={`${fieldId}-hint`}>{(values[field.id] || '').length}/{field.maxLength} 字符；原文保留</small>}
      </div>; })}
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="scene-btn scene-btn--primary" disabled={disabled}>提交表单并继续</button>
    </fieldset>
  </form>;
};
