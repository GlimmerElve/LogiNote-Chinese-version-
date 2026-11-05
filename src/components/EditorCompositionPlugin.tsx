import React, { useEffect, useRef, useState } from 'react';
import { useCellValue } from '@mdxeditor/gurx';
import { realmPlugin, addTopAreaChild$, editorWrapperElementRef$ } from '@mdxeditor/editor';
import { registerEditorInputLeave } from '../services/ui/editorInputLeave';

function CompositionNotice() {
  const wrapper = useCellValue(editorWrapperElementRef$), composing = useRef(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const root = wrapper?.current; if (!root) return;
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; setMessage(''); };
    root.addEventListener('compositionstart', start, true); root.addEventListener('compositionend', end, true);
    const release = registerEditorInputLeave({
      pending: () => composing.current ? '正在使用输入法，请先完成或取消当前输入，再切换页面或关闭窗口。' : null,
      element: () => root, notify: setMessage,
    });
    return () => { release(); root.removeEventListener('compositionstart', start, true); root.removeEventListener('compositionend', end, true); };
  }, [wrapper]);
  return message ? <div role="status" className="px-3 py-2 text-sm text-[var(--ln-text-secondary)]">{message}</div> : null;
}
/** Observe DOM composition only. Never prevent/finish it, change selection,
 * dispatch editor commands or add history entries. No per-keystroke rendering. */
export const editorCompositionPlugin = realmPlugin({ init(realm) {
  realm.pub(addTopAreaChild$, CompositionNotice);
} });
