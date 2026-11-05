import React, { useEffect, useRef, useState } from 'react';
import type { S2Document, S2InputBinding, S2WorkflowNode } from '../../types/sceneS2';
import { s2ParameterSource } from './uiHost';

export interface S2ModelParametersProps {
  node: S2WorkflowNode;
  document: S2Document;
  active: boolean;
  /** Only a positive capability declaration enables new thinking-mode overrides. */
  supportsThinking?: boolean;
  /** Approved per-request ceiling; omitted while designing without a run-local grant. */
  maxOutputTokens?: number;
  onChange: (portId: string, binding: S2InputBinding | null, sourceKey: string) => void;
  onError?: (message: string) => void;
}
type NumericPort = 'maxOutputTokens' | 'temperature';
type Draft = { nodeId: string; source: string; value: string };
/** Local next-run configuration only. Editing never grants budget, sends, or changes a completed result. */
export function S2ModelParameters(props: S2ModelParametersProps) {
  const { node, document, active } = props;
  const live = useRef(props), mounted = useRef(true), lastCommit = useRef(''); live.current = props;
  const [drafts, setDrafts] = useState<Partial<Record<NumericPort, Draft>>>({});
  const [error, setError] = useState<{ port: string; message: string } | null>(null), [notice, setNotice] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && active && live.current.active && live.current.node === node && live.current.document === document
    && live.current.maxOutputTokens === props.maxOutputTokens && live.current.supportsThinking === props.supportsThinking;
  const approved = typeof props.maxOutputTokens === 'number' && Number.isInteger(props.maxOutputTokens) && props.maxOutputTokens >= 256;
  const ceiling = approved ? props.maxOutputTokens! : 2048;
  const source = (port: string) => {
    const result = s2ParameterSource(document, node.id, port), binding = node.bindings[port];
    return { ...result, binding, advanced: result.connected || !!binding && binding.kind !== 'literal' };
  };
  const fail = (port: string, message: string) => {
    setError({ port, message }); setNotice('');
    try { props.onError?.(message); } catch { /* An error observer cannot break local parameter controls. */ }
  };
  const update = (port: string, binding: S2InputBinding | null, key: string, text: string) => {
    if (!current()) return;
    const latest = source(port);
    if (latest.key !== key || latest.advanced) return;
    const signature = JSON.stringify([node.id, port, key, text]);
    if (lastCommit.current === signature) return;
    const clearNumericDraft = () => {
      if (port === 'maxOutputTokens' || port === 'temperature') setDrafts(previous => { const next = { ...previous }; delete next[port]; return next; });
    };
    if (JSON.stringify(latest.binding ?? null) === JSON.stringify(binding)) { clearNumericDraft(); setError(null); return; }
    try {
      props.onChange(port, binding, key); lastCommit.current = signature;
      setError(null); setNotice('参数已保存');
      clearNumericDraft();
    } catch (cause) { fail(port, cause instanceof Error ? cause.message : '参数未更新，请重试。'); }
  };
  const numeric = (port: NumericPort, label: string, minimum: number, maximum: number, step: number, hint: string) => {
    const state = source(port), configured = state.binding?.kind === 'literal' ? state.binding.value : undefined;
    const saved = typeof configured === 'number' && Number.isFinite(configured) ? String(configured) : '';
    const draft = drafts[port]?.nodeId === node.id && drafts[port]?.source === state.key ? drafts[port]!.value : saved;
    const invalidSaved = state.binding?.kind === 'literal' && (typeof configured !== 'number' || !Number.isFinite(configured)
      || configured < minimum || configured > maximum || port === 'maxOutputTokens' && !Number.isInteger(configured));
    const errorId = `s2-model-${node.id}-${port}-error`;
    const commit = (raw: string) => {
      if (!current() || state.advanced || source(port).key !== state.key) return;
      const text = raw.trim();
      if (!text) { update(port, null, state.key, ''); return; }
      const value = Number(text);
      if (!Number.isFinite(value) || value < minimum || value > maximum || port === 'maxOutputTokens' && !Number.isInteger(value)) {
        fail(port, `${label}应为${minimum}至${maximum}${port === 'maxOutputTokens' ? '之间的整数' : '之间的数字'}；草稿未参与运行。`); return;
      }
      update(port, { kind: 'literal', value }, state.key, text);
    };
    return <label key={port}>{label}<input type="number" aria-label={label} min={minimum} max={maximum} step={step}
      className="nodrag nowheel" value={draft} placeholder="沿用配置默认值"
      disabled={!active || state.advanced} aria-invalid={error?.port === port || invalidSaved} aria-describedby={error?.port === port ? errorId : undefined} title={hint}
      onChange={event => { if (!current() || state.advanced) return; const value = event.target.value; lastCommit.current = ''; setError(null); setNotice(''); setDrafts(previous => ({ ...previous, [port]: { nodeId: node.id, source: state.key, value } })); }}
      onBlur={event => commit(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent?.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); commit(event.currentTarget.value);
        }
      }} />
      {state.advanced && <small>由连接的内容提供</small>}
      {invalidSaved && !state.advanced && <small role="status">现有值无效或超出本局上限，请修改后运行。</small>}
      {draft !== saved && <small role="status">数字草稿尚未生效；按 Enter 或离开输入框后生效，运行仍使用已保存参数。</small>}
      {error?.port === port && <small id={errorId} role="alert">{error.message}</small>}
    </label>;
  };
  if (node.pluginId !== 'model-test' || node.capabilityId !== 'generate') return null;
  const thinking = source('thinkingMode'), thinkingValue = thinking.binding?.kind === 'literal' ? thinking.binding.value : undefined;
  const thinkingSelection = thinkingValue === undefined ? '' : thinkingValue === 'enabled' || thinkingValue === 'disabled' ? thinkingValue : 'unsupported';
  return <fieldset className="s2-model-parameters nodrag nowheel" disabled={!active} aria-label="模型运行参数">
    {numeric('maxOutputTokens', '输出长度上限', 256, ceiling, 1, `256–${ceiling} tokens；留空沿用配置默认值。`)}
    {numeric('temperature', '随机性（Temperature）', 0, 2, 0.1, '0–2；越低通常越稳定。留空沿用模型默认值，具体模型仍可能不支持此参数。')}
    <label>思考模式<select className="nodrag nowheel" aria-label="思考模式" value={thinkingSelection} disabled={!active || thinking.advanced}
      aria-invalid={error?.port === 'thinkingMode' || thinkingSelection === 'unsupported'}
      aria-describedby={error?.port === 'thinkingMode' ? `s2-model-${node.id}-thinking-error` : undefined}
      title={props.supportsThinking === true ? '设置下一次请求的思考模式' : '当前模型未声明支持手动切换思考模式'}
      onChange={event => {
        if (!current() || thinking.advanced || source('thinkingMode').key !== thinking.key) return;
        const value = event.target.value;
        if (value !== '' && (props.supportsThinking !== true || !['enabled', 'disabled'].includes(value))) { fail('thinkingMode', '当前模型未声明支持切换思考模式；原参数保留。'); return; }
        update('thinkingMode', value === '' ? null : { kind: 'literal', value }, thinking.key, value);
      }}>
      <option value="">沿用模型默认</option><option value="enabled" disabled={props.supportsThinking !== true}>开启</option><option value="disabled" disabled={props.supportsThinking !== true}>关闭</option>
      {thinkingSelection === 'unsupported' && <option value="unsupported" disabled>当前高级配置（保留）</option>}
    </select>
      {thinking.advanced && <small>由连接的内容提供</small>}
      {!thinking.advanced && thinkingValue !== undefined && props.supportsThinking !== true && <small role="status">此设置不可用；可改为模型默认。</small>}
      {error?.port === 'thinkingMode' && <small id={`s2-model-${node.id}-thinking-error`} role="alert">{error.message}</small>}
    </label>
    {notice && <small role="status" aria-live="polite">参数已保存</small>}
  </fieldset>;
}
