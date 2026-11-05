import React, { useEffect, useRef } from 'react';
import type { S2Document } from '../../types/sceneS2';
import type { S2NoteResourceUi } from '../../services/scene/sceneS2ResourceUi';
import { isS2ProjectNotes } from '../../services/scene/sceneS2ProjectNotes';

export function S2ProjectNoteInput(props: { host: S2NoteResourceUi | null; active: boolean; document: S2Document; selectedNodeId: string;
  isCurrent(): boolean; onBind(id: string): void; onChange(): void; onError(message: string): void }) {
  const live = useRef(props), mounted = useRef(true); live.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { host, active, document, selectedNodeId } = props;
  const selected = document.execution?.nodes.find(node => node.id === selectedNodeId && isS2ProjectNotes(node));
  const connected = document.execution?.links.some(link => link.target.nodeId === selectedNodeId && link.target.portId === 'resource');
  const current = () => mounted.current && live.current === props && active && !!host && props.isCurrent();
  let choices: ReturnType<S2NoteResourceUi['projectNoteChoices']> = [], resources: ReturnType<S2NoteResourceUi['projectNoteSummary']> = [], error = '';
  try { choices = host?.projectNoteChoices() ?? []; resources = host?.projectNoteSummary() ?? []; } catch (issue) { error = String(issue); }
  const binding = selected?.bindings.resource;
  const resource = binding?.kind === 'literal' ? resources.find(item => item.id === binding.value) : undefined;
  return <section className="s2-note-inline nodrag nopan nowheel" aria-label="项目笔记选择">
    <label>选择并允许本局读取知识笔记<select aria-label="选择并允许本局读取知识笔记" value={resource?.available ? resource.noteId : ''}
      disabled={!active || !host || !selected || !!connected || !!error} onChange={event => {
        const id = event.target.value; if (!current() || connected) return;
        let newlyApproved: string | undefined;
        try {
          if (!id) { props.onBind(''); props.onChange(); return; }
          if (!host!.projectNoteChoices().some(item => item.noteId === id)) throw new Error('项目笔记范围已变化，请在当前节点重新选择。');
          const existing = host!.projectNoteSummary().find(item => item.noteId === id && item.available);
          const next = existing ?? host!.approveProjectNote(id); if (!existing) newlyApproved = next.id;
          props.onBind(next.id); newlyApproved = undefined; props.onChange();
        } catch (issue) {
          if (newlyApproved) host!.revokeProjectNote(newlyApproved);
          if (current()) props.onError(issue instanceof Error ? issue.message : String(issue));
        }
      }}><option value="">请选择本局项目笔记</option>{choices.map(item => <option key={item.noteId} value={item.noteId}>{item.label}</option>)}</select></label>
    {resource && <button type="button" disabled={!active || !!connected} onClick={() => {
      if (!current() || connected) return;
      try { props.onBind(''); host!.revokeProjectNote(resource.id); props.onChange(); } catch (issue) { if (current()) props.onError(String(issue)); }
    }}>移除笔记</button>}
    {error && <small role="alert">{error}</small>}
    {resource && !resource.available && <small role="status">笔记已变化或移除，请重新选择；不会自动读取替代内容。</small>}
    {connected ? <small>笔记入口由连线提供材料。</small> : <small>只列当前项目允许范围内的笔记；选择即允许并选用，不读取正文。复用场景时需要重新选择。</small>}
    {!choices.length && !connected && !error && <small>当前项目没有可选笔记；可返回场景搭建处选择项目。</small>}
  </section>;
}
