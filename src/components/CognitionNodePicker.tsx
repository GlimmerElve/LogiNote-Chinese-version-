import React, { useEffect, useId, useRef, useState } from 'react';
import type { ManagedCognitionNode } from '../services/cognition/management';

/** Search text is never a node identity. Only choosing an actual result changes the endpoint. */
export function CognitionNodePicker({ label, nodes, value, onChange }: {
  label: string; nodes: ManagedCognitionNode[]; value: string; onChange: (id: string) => void;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), changeButton = useRef<HTMLButtonElement>(null);
  const restoreSelectionFocus = useRef(false);
  const [editing, setEditing] = useState(false), [query, setQuery] = useState(''), [open, setOpen] = useState(false), [activeId, setActiveId] = useState('');
  const chosen = nodes.find(node => node.id === value);
  const matches = nodes.filter(node => `${node.title} ${node.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const options = matches.slice(0, 40), active = options.findIndex(node => node.id === activeId);
  const showInput = editing || !chosen;
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  useEffect(() => { if (restoreSelectionFocus.current && chosen) { changeButton.current?.focus(); restoreSelectionFocus.current = false; } }, [chosen, editing]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !root.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false);
      if (chosen) { setEditing(false); changeButton.current?.focus(); }
    };
    // The picker consumes its own first Escape before the enclosing modal does.
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, chosen]);
  useEffect(() => { if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [open, active, id]);
  function choose(nodeId: string) { restoreSelectionFocus.current = true; onChange(nodeId); setEditing(false); setOpen(false); setQuery(''); setActiveId(''); }
  return <div ref={root} className="cm-node-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <div className="cm-endpoint-heading"><span>{label}</span>{chosen && <button ref={changeButton} type="button"
      onMouseDown={event => event.preventDefault()}
      onClick={() => { setEditing(true); setOpen(true); input.current?.focus(); }}>更换{label}</button>}</div>
    {chosen && <p className="cm-endpoint" aria-label={`${label}当前选择`} data-endpoint-id={value}>{chosen.title} · {chosen.text}</p>}
    {!!value && !chosen && <p role="status">原选择已不存在，请重新选择；不会自动替换。</p>}
    {showInput && <><input ref={input} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`}
      aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined} aria-invalid={!!value && !chosen}
      data-cognition-nonedit value={query} placeholder={`搜索并选择${label}`} onFocus={() => setOpen(true)}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActiveId(''); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          if (options.length) setActiveId(options[active < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
            : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].id);
        } else if (event.key === 'Enter' && open && active >= 0) { event.preventDefault(); if (!event.repeat) choose(options[active].id); }
      }} />
      {open && <div id={`${id}-options`} role="listbox" aria-label={`可选${label}`} className="cm-picker-options">
        {options.map((node, index) => <button key={node.id} id={`${id}-option-${index}`} type="button" role="option" aria-selected={active === index} tabIndex={-1}
          data-node-id={node.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(node.id)}>{node.title} · {node.text}</button>)}
        {!options.length && <p role="status">没有匹配的认知块，请换一个关键词。</p>}
        {matches.length > 40 && <p>显示前 40 项，请输入关键词缩小范围。</p>}
      </div>}
    </>}
  </div>;
}
