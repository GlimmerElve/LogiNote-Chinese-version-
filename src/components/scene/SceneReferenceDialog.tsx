import { useRef } from 'react';
import { BookOpen, X } from 'lucide-react';
import type { NoteItem } from '../../types';
import { useDialog } from '../useDialog';
import { SceneRichMessage } from './SceneRichMessage';
export function SceneReferenceDialog({ note, onClose }: { note: NoteItem; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useDialog(true, ref, onClose, 75);
  return <div className="scene-reference-backdrop" onMouseDown={onClose}>
    <section ref={ref} className="scene-reference-dialog" role="dialog" aria-modal="true" aria-label={`场景内资料：${note.title}`} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><BookOpen /><div><small>场景内资料 · 只读</small><h2>{note.title}</h2></div><button type="button" aria-label="关闭资料，继续场景" onClick={onClose}><X /></button></header>
      <article><SceneRichMessage content={note.content || '暂无内容'} externalLinksDisabled /></article>
      <footer><button type="button" onClick={onClose}>返回场景</button></footer>
    </section>
  </div>;
}
