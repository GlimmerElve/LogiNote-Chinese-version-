import React, { useEffect, useRef, useState } from 'react';
import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import { s2ComposeStructure, type S2ComposeStructureConfig } from './composeControls';

export interface S2ComposeEditorProps {
  definition: S2CanvasDefinition; document: S2Document; nodeId: string; scopeKey?: string; disabled?: boolean;
  onStructureChange: (config: S2ComposeStructureConfig, base: string) => void;
  onError?: (message: string) => void;
}
type Draft = { owner: string; base: string; value: string };

/** The canvas owns wires. This small editor changes only titles and the separator. */
export function S2ComposeEditor(props: S2ComposeEditorProps) {
  const state = s2ComposeStructure(props.definition, props.document, props.nodeId), owner = JSON.stringify([props.scopeKey, props.nodeId]);
  const live = useRef(props), mounted = useRef(true), composing = useRef(false), renderOwner = useRef<object | null>(null);
  const render = {}; live.current = props; renderOwner.current = render;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [error, setError] = useState<{ owner: string; key: string; message: string } | null>(null), lastCommit = useRef('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && renderOwner.current === render && live.current === props && !props.disabled && state.simple;
  const updateDrafts = (next: Record<string, Draft>) => { draftsRef.current = next; setDrafts(next); };
  const fail = (key: string, message: string) => {
    setError({ owner, key, message });
    try { props.onError?.(message); } catch { /* Error observation cannot discard a draft. */ }
  };
  const control = (key: string, label: string, saved: string, prefixIndex?: number, placeholder?: string) => {
    const draft = drafts[key]?.owner === owner ? drafts[key] : undefined, conflict = !!draft && draft.base !== state.base;
    const value = draft?.value ?? saved, errorId = `s2-compose-${props.nodeId}-${key}-error`;
    const message = error?.owner === owner && error.key === key ? error.message : conflict ? '结构已变化，草稿保留且未保存；继续修改此项后可按当前结构保存。' : '';
    const commit = () => {
      if (!current() || composing.current) return;
      const entry = draftsRef.current[key];
      // A native blur without explicit typing must not normalize old whitespace,
      // materialize defaults or replace a title after a scene/node switch.
      if (!entry || entry.owner !== owner) return;
      if (entry.base !== state.base) { fail(key, '结构已变化，草稿保留且未保存；继续修改此项后可按当前结构保存。'); return; }
      if (entry.value.length > 120) { fail(key, '标题和分隔文字最多120字，草稿已保留'); return; }
      const signature = JSON.stringify([owner, key, entry.base, entry.value]);
      if (lastCommit.current === signature) return;
      if (entry.value !== saved) {
        const config: S2ComposeStructureConfig = { prefixes: [...state.prefixes], separator: state.separator };
        if (prefixIndex === undefined) config.separator = entry.value; else config.prefixes[prefixIndex] = entry.value;
        try { props.onStructureChange(config, entry.base); } catch (cause) { fail(key, cause instanceof Error ? cause.message : '结构未保存，草稿已保留'); return; }
      }
      lastCommit.current = signature;
      const next = { ...draftsRef.current }; delete next[key]; updateDrafts(next); setError(null);
    };
    const common = { 'aria-label': label, 'aria-invalid': !!message, 'aria-describedby': message ? errorId : undefined,
      disabled: !!props.disabled || !state.simple, maxLength: 120, value, placeholder,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (!current()) return;
        updateDrafts({ ...draftsRef.current, [key]: { owner, base: state.base, value: event.target.value } }); setError(null); lastCommit.current = '';
      },
      onBlur: commit,
      onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.nativeEvent?.isComposing && !composing.current && event.keyCode !== 229
          && !event.altKey && !event.shiftKey && (prefixIndex !== undefined ? !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey)) {
          event.preventDefault(); commit();
        }
      } };
    return <label key={key}>{label}{prefixIndex === undefined ? <textarea {...common} rows={2} /> : <input {...common} type="text" />}
      {message ? <small role="alert" id={errorId}>{message}</small> : draft && draft.value !== saved ? <small role="status">草稿尚未保存</small> : null}
    </label>;
  };
  return <section className="s2-compose-editor nodrag nopan nowheel" aria-label="组装结构">
    {state.slots.map((slot, index) => <div key={slot.portId} className="s2-compose-slot" data-s2-compose-port={slot.portId}>
      {control(slot.portId, `入口${index + 1}标题`, slot.prefix, index, slot.title)}<small>{slot.sourceLabel}</small>
    </div>)}
    <details><summary>分隔文字</summary>{control('separator', '入口间的分隔文字', state.separator)}</details>
    {!state.simple && <small>标题或分隔由其他步骤提供，当前连线与草稿保留。</small>}
  </section>;
}
