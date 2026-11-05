import React, { useEffect, useRef, useState } from 'react';
import type { S2Document } from '../../types/sceneS2';
import type { S2TextResourceUi } from '../../services/scene/sceneS2ResourceUi';
import { isS2TextResource } from '../../services/scene/sceneS2TextResource';

export interface S2TextMaterialInputProps {
  host: S2TextResourceUi | null;
  active: boolean;
  isCurrent: () => boolean;
  document: S2Document;
  selectedNodeId: string;
  disabled?: boolean;
  onBind: (resourceId: string) => void;
  onChange: () => void;
  onError: (message: string) => void;
}

/** A native file choice grants only a run-local handle. Reading remains an explicit workflow operation. */
export function S2TextMaterialInput(props: S2TextMaterialInputProps) {
  const { host, active, document, selectedNodeId } = props;
  const live = useRef(props), mounted = useRef(true); live.current = props;
  const [notice, setNotice] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setNotice(''); }, [host, active, selectedNodeId]);
  const resources = host?.textResourceSummary() ?? [];
  const selected = document.execution?.nodes.find(node => node.id === selectedNodeId && isS2TextResource(node));
  const connected = !!selected && document.execution?.links.some(link => link.target.nodeId === selected.id && link.target.portId === 'resource');
  const binding = selected?.bindings.resource;
  const value = binding?.kind === 'literal' && typeof binding.value === 'string' && resources.some(resource => resource.id === binding.value) ? binding.value : '';
  const resource = resources.find(item => item.id === value);
  const current = () => mounted.current && active && !!host && !props.disabled && live.current === props
    && live.current.host === host && props.isCurrent();
  const writable = () => current() && !!selected && !connected;
  const locked = !active || !host || !!props.disabled || !selected || connected;
  const report = (error: unknown) => { if (current()) props.onError(error instanceof Error ? error.message : '资料操作未完成，请重新选择。'); };
  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !writable()) return;
    let unbound: string | undefined;
    try {
      const provided = host!.approveTextFile(file); unbound = provided.id;
      if (!writable()) { host!.revokeTextFile(provided.id); unbound = undefined; return; }
      props.onBind(provided.id); unbound = undefined;
      props.onChange(); setNotice('资料已选用。');
    } catch (error) {
      if (unbound) try { host!.revokeTextFile(unbound); } catch { /* A rejected binding cannot retain its new grant. */ }
      report(error);
    }
  }
  return <section className="s2-text-inline nodrag nopan nowheel" aria-label="文本资料选择">
    <input type="file" aria-label="选择本地文本资料" accept=".txt,.md,.json,.csv" title="UTF-8 文本，每份最多 24000 字节及 6000 字符"
      disabled={locked || resources.length >= 4} onChange={choose} />
    {resources.length > 0 && <select aria-label="选用已提供的文本资料" value={value} disabled={locked} onChange={event => {
      const id = event.target.value;
      if (!writable()) return;
      try {
        if (id && !host!.textResourceSummary().some(item => item.id === id)) throw new Error('资料已撤回，请重新选择。');
        props.onBind(id); props.onChange(); setNotice(id ? '资料已选用。' : '已取消此步选用，资料仍保留在本局。');
      } catch (error) { report(error); }
    }}><option value="">不选用资料</option>{resources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
    {resource && <button type="button" disabled={locked} onClick={() => {
      if (!writable()) return;
      try {
        if (!host!.textResourceSummary().some(item => item.id === resource.id)) throw new Error('资料已经撤回。');
        props.onBind(''); host!.revokeTextFile(resource.id); props.onChange(); setNotice('已撤回资料；已读取的结果仍保留。');
      } catch (error) { report(error); }
    }}>移除资料</button>}
    {connected && <small>资料由连接的来源提供</small>}
    {!connected && !resource && <small>请选择本局文本资料；复用保存的场景时需要重新选择。</small>}
    {notice && <small role="status" aria-live="polite">{notice}</small>}
    {resources.length >= 4 && <small>本局已提供4份资料，可移除不再使用的资料后重新选择。</small>}
  </section>;
}
