import React, { useMemo } from 'react';
import { Cell, useCellValues, usePublisher } from '@mdxeditor/gurx';
import { addTopAreaChild$, insertMarkdown$, markdown$, markdownProcessingError$, realmPlugin, setMarkdown$, viewMode$ } from '@mdxeditor/editor';
import { prepareMarkdownForMdx } from '../services/markdownMdxCompatibility';
import { assertMdxNoteImportable, MdxNoteCompatibilityError } from './mdxNotePreflight';
const rejectedInsertion$ = Cell<string | null>(null);

function CompatibilityNotice() {
  const [error, viewMode, rejectedInsertion] = useCellValues(markdownProcessingError$, viewMode$, rejectedInsertion$);
  const setViewMode = usePublisher(viewMode$);
  const dismissInsertion = usePublisher(rejectedInsertion$);
  const message = useMemo(() => {
    if (!error && !rejectedInsertion) return '';
    try { assertMdxNoteImportable(error?.source || rejectedInsertion!); }
    catch (cause) { return cause instanceof MdxNoteCompatibilityError ? cause.message : '富文本暂不可用；原文已保留，请查看源码。'; }
    return '富文本暂不可用；原文已保留，请查看源码。';
  }, [error, rejectedInsertion]);
  if (!error && !rejectedInsertion) return null;
  return <section role="alert" className="border-b border-[var(--ln-border)] bg-[var(--ln-bg-surface)] px-3 py-2 text-sm text-[var(--ln-text-primary)]">
    <div className="flex items-center gap-3">
      <p className="min-w-0 flex-1">{rejectedInsertion && !error ? '这段内容未插入，当前笔记未改动。' : ''}{message}</p>
      {error && viewMode !== 'source' && <button type="button" className="min-h-11 shrink-0 rounded px-3 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
        onClick={() => setViewMode('source')}>查看源码</button>}
      {!error && <button type="button" className="min-h-11 shrink-0 rounded px-3 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
        onClick={() => dismissInsertion(null)}>关闭</button>}
    </div>
    {rejectedInsertion && <details><summary className="min-h-11 cursor-pointer py-3">查看未插入的源码</summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{rejectedInsertion}</pre>
    </details>}
  </section>;
}

/** Covers source-mode → rich-text imports too, which bypass the React handle.
 * Recover only a proven compatible, idempotent local patch, outside Lexical's
 * current transaction. A stale callback cannot overwrite a newly opened note. */
export const mdxMarkdownCompatibilityPlugin = realmPlugin<{ onInsertionReporter?: (report: (source: string | null) => void) => void }>({ init(realm, params) {
  realm.pub(addTopAreaChild$, CompatibilityNotice);
  params?.onInsertionReporter?.(source => realm.pub(rejectedInsertion$, source));
  let latestRequested: string | undefined;
  realm.sub(setMarkdown$, source => { latestRequested = source; });
  realm.sub(insertMarkdown$, source => { latestRequested = source; });
  realm.sub(markdownProcessingError$, error => {
    if (!error) return;
    const { source } = error;
    const prepared = prepareMarkdownForMdx(source);
    if (!prepared.patches.length) return;
    queueMicrotask(() => {
      if ((latestRequested !== undefined && latestRequested !== source)
        || realm.getValue(markdown$) !== source || realm.getValue(viewMode$) !== 'rich-text') return;
      try { assertMdxNoteImportable(prepared.markdown); }
      catch { return; } // Unknown/malformed structures remain exact and editable.
      realm.pub(setMarkdown$, prepared.markdown);
    });
  });
} });
