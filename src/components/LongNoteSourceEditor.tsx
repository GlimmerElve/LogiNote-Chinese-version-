import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, historyKeymap, redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { openSearchPanel, searchKeymap } from '@codemirror/search';
import { registerPendingCapture } from '../services/agent/dataFreshness';
import { registerEditorInputLeave } from '../services/ui/editorInputLeave';
import { rebaseLongNoteSource, sourceCoordinateMap } from '../services/ui/longNoteSource';
import { createLongNoteSourceState, replaceLongNoteSource } from '../services/ui/longNoteSourceState';
import type { MdxNoteEditorHandle } from './noteEditorHandle';
import { noteHeadingSourceOffset } from '../services/ui/noteHeadingNavigation';
import './LongNoteSourceEditor.css';

const externalReplacement = Annotation.define<boolean>();
const sourceHighlight = HighlightStyle.define([
  { tag: [tags.heading, tags.link], color: 'var(--ln-accent)' },
  { tag: [tags.url, tags.comment, tags.meta], color: 'var(--ln-text-secondary)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);

interface Props {
  content: string;
  active?: boolean;
  darkMode?: boolean;
  onChange?: (markdown: string) => void;
  toolbarExtra?: React.ReactNode;
}

/** One CodeMirror document/history, with viewport-only DOM. Source is never
 * imported through MDX/Lexical merely to open a long note for editing. */
export const LongNoteSourceEditor = forwardRef<MdxNoteEditorHandle, Props>(function LongNoteSourceEditor(
  { content, active = true, darkMode = false, onChange, toolbarExtra }, ref,
) {
  const host = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const callbackRef = useRef(onChange); callbackRef.current = onChange;
  const sourceRef = useRef(content), lastReceived = useRef(content), lastEmitted = useRef(content);
  const composing = useRef(false), ending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ base: string; incoming: string } | null>(null);
  const conflict = useRef<{ base: string; incoming: string } | null>(null);
  const [notice, setNotice] = useState(''), [hasConflict, setHasConflict] = useState(false);
  const editable = useRef(new Compartment());
  const replaceRef = useRef<(markdown: string) => void>(() => {});
  const publishRef = useRef<(force?: boolean) => void>(() => {});
  publishRef.current = (force = false) => {
    if (conflict.current || !force && sourceRef.current === lastEmitted.current) return;
    lastEmitted.current = sourceRef.current;
    callbackRef.current?.(sourceRef.current);
  };

  useEffect(() => {
    if (!host.current) return;
    const raw = createLongNoteSourceState(sourceRef.current);
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: sourceRef.current, extensions: [
      ...raw.extensions,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      lineNumbers(), drawSelection(), highlightSpecialChars(), highlightActiveLine(),
      markdown(), syntaxHighlighting(sourceHighlight), EditorView.lineWrapping,
      editable.current.of([EditorView.editable.of(activeRef.current), EditorState.readOnly.of(!activeRef.current)]),
      EditorView.contentAttributes.of({ 'aria-label': '长文 Markdown 编辑器', spellcheck: 'false' }),
      EditorView.updateListener.of(update => {
        sourceRef.current = update.state.field(raw.field).source;
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalReplacement))) publishRef.current();
      }),
      EditorView.domEventHandlers({
        compositionstart() { composing.current = true; setNotice(''); return false; },
        compositionend() {
          composing.current = false;
          if (ending.current) clearTimeout(ending.current);
          // Let CodeMirror observe the browser's final IME mutation before
          // rebasing a replacement that arrived while composing.
          ending.current = setTimeout(() => {
            ending.current = null;
            const replacement = pending.current; pending.current = null;
            if (replacement) {
              const merged = rebaseLongNoteSource(replacement.base, sourceRef.current, replacement.incoming);
              if (merged === null) {
                conflict.current = replacement; setHasConflict(true);
                setNotice('输入期间收到重叠的外部更新，请选择要保留的版本；当前输入仍在编辑器中。');
              } else { replaceRef.current(merged); publishRef.current(true); setNotice(''); }
            } else setNotice('');
          }, 0);
          return false;
        },
      }),
    ] }) });
    viewRef.current = view;
    replaceRef.current = (incoming: string) => {
      if (view.compositionStarted || composing.current) {
        pending.current = { base: pending.current?.base ?? sourceRef.current, incoming }; return;
      }
      if (conflict.current) { conflict.current = { ...conflict.current, incoming }; return; }
      if (incoming === sourceRef.current) return;
      const before = view.state.doc.toString(), after = view.state.toText(incoming).toString();
      let from = 0, beforeEnd = before.length, afterEnd = after.length;
      while (from < beforeEnd && from < afterEnd && before[from] === after[from]) from++;
      while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
      view.dispatch({ changes: { from, to: beforeEnd, insert: after.slice(from, afterEnd) }, effects: replaceLongNoteSource.of({ source: incoming }),
        annotations: externalReplacement.of(true) });
      sourceRef.current = incoming;
      lastEmitted.current = incoming;
    };
    const releaseCapture = registerPendingCapture(() => publishRef.current());
    const releaseLeave = registerEditorInputLeave({
      pending: () => !activeRef.current ? null : composing.current || view.compositionStarted || ending.current
        ? '正在使用输入法，请先完成或取消当前输入，再切换页面或关闭窗口。'
        : conflict.current ? '长文有待确认的外部更新，请先选择要保留的版本。' : null,
      element: () => host.current, notify: setNotice,
    });
    return () => {
      releaseCapture(); releaseLeave();
      if (ending.current) clearTimeout(ending.current);
      view.destroy(); viewRef.current = null; replaceRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    if (!active || content === lastReceived.current) return;
    lastReceived.current = content;
    // Parent save acknowledgements are snapshots of our own published source.
    if (content !== sourceRef.current) replaceRef.current(content);
  }, [content, active]);
  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    view.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(active), EditorState.readOnly.of(!active)]) });
    if (active) view.requestMeasure();
  }, [active]);

  useImperativeHandle(ref, () => ({
    getMarkdown: () => sourceRef.current,
    setMarkdown: markdown => { lastReceived.current = markdown; replaceRef.current(markdown); },
    insertMarkdown: markdown => {
      const view = viewRef.current; if (!view || !activeRef.current) return;
      if (view.compositionStarted || composing.current) { setNotice('请先完成当前输入法输入，再插入内容。'); return; }
      view.dispatch(view.state.replaceSelection(markdown));
    },
    getSelectionMarkdown: () => {
      const view = viewRef.current; if (!view) return '';
      const selection = view.state.selection.main, rawPosition = sourceCoordinateMap(sourceRef.current);
      return sourceRef.current.slice(rawPosition(selection.from), rawPosition(selection.to));
    },
    focus: () => { if (activeRef.current) viewRef.current?.focus(); },
    scrollToHeading: heading => {
      const view = viewRef.current; if (!view || !activeRef.current) return false;
      const position = noteHeadingSourceOffset(view.state.doc.toString(), heading);
      if (position === undefined) return false;
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) });
      return true;
    },
  }), []);

  const command = (run: (view: EditorView) => unknown) => {
    const view = viewRef.current; if (!view || !activeRef.current || composing.current || view.compositionStarted) return;
    run(view); view.focus();
  };
  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict.current?.incoming;
    conflict.current = null; setHasConflict(false); setNotice('');
    if (useIncoming && incoming !== undefined) replaceRef.current(incoming);
    publishRef.current(true);
  };
  return <div className="long-note-source" data-dark={darkMode || undefined} aria-hidden={!active}>
    <div className="long-note-source-toolbar" role="toolbar" aria-label="长文编辑工具">
      <span>Markdown</span>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(undo)} title="撤销（Ctrl/Cmd + Z）">撤销</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(redo)} title="重做（Ctrl/Cmd + Shift + Z）">重做</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(openSearchPanel)}>查找</button>
      {toolbarExtra}
    </div>
    {notice && <div className="long-note-source-notice" role="status">{notice}{hasConflict && <span>
      <button type="button" onClick={() => resolveConflict(false)}>保留当前输入</button>
      <button type="button" onClick={() => resolveConflict(true)}>使用外部更新</button>
    </span>}</div>}
    <div ref={host} className="long-note-source-host" />
  </div>;
});
