import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkGeneratedMath } from '../../services/textbook/generatedMath';
import { remarkGeneratedFormatting } from '../../services/textbook/generatedFormatting';
import { LongDocumentReader } from './LongDocumentReader';
import { LONG_READING_THRESHOLD } from '../../services/textbook/readingDocument';
import { needsBackgroundTextbookReading } from '../../services/textbook/readingBudget';
import { ReadingWorkerProvider } from './ReadingWorkerContext';
import { scrollToNoteHeading, type NoteHeadingRequest } from '../../services/ui/noteHeadingNavigation';
import { remarkMarkdownWikiLinks } from '../../services/markdownWikiLinks';
import { NoteReadingActivityContext, noteReadingComponents } from './NoteReadingMarkdown';

const plugins = [remarkGfm, remarkMath, [remarkGeneratedFormatting, { scope: 'knowledge-section' }] as any, remarkMarkdownWikiLinks, remarkGeneratedMath];
const ParsedPlainMarkdown = React.memo(function ParsedPlainMarkdown({ content, components }: { content: string; components: Components }) {
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{content || '这篇笔记暂时没有正文。你仍可以从右侧资源区打开其他材料，或直接开始复述。'}</ReactMarkdown>;
});
/** Keep the ordinary-note branch independent of the one-second flow timer too. */
interface PlainNoteReadingProps {
  noteId: string; title: string; content: string; active?: boolean; interactive?: boolean; selectionSurface?: 'flow' | 'note';
  headingRequest?: NoteHeadingRequest; onHeadingResolved?: (found: boolean) => void;
  onWikiLink?: (raw: string) => void;
}
export const PlainNoteReading = React.memo(function PlainNoteReading(props: PlainNoteReadingProps) {
  const snapshot = useRef<PlainNoteReadingProps | null>(null);
  const active = props.active !== false;
  const interactive = props.interactive ?? active;
  const wikiCallback = useRef(props.onWikiLink); wikiCallback.current = props.onWikiLink;
  const openWiki = useCallback((raw: string) => wikiCallback.current?.(raw), []);
  // Activity changes update the visual/link consumers without replacing their
  // component types, reparsing Markdown or remounting an already drawn figure.
  const components = useMemo(() => noteReadingComponents(openWiki, true), [openWiki]);
  if (active) snapshot.current = props;
  const current = snapshot.current;
  const article = useRef<HTMLElement>(null), appliedHeading = useRef<string | undefined>(undefined);
  const headingCallback = useRef(props.onHeadingResolved); headingCallback.current = props.onHeadingResolved;
  useEffect(() => {
    if (!active || !current || needsBackgroundTextbookReading(current.content, LONG_READING_THRESHOLD) || !props.headingRequest
      || appliedHeading.current === props.headingRequest.key || !article.current) return;
    appliedHeading.current = props.headingRequest.key;
    headingCallback.current?.(scrollToNoteHeading(article.current, props.headingRequest.heading));
  }, [active, current?.content, props.headingRequest?.key, props.headingRequest?.heading]);
  if (!snapshot.current) return null;
  const { noteId, title, content, selectionSurface = 'flow' } = snapshot.current;
  return <ReadingWorkerProvider><NoteReadingActivityContext.Provider value={interactive}>{needsBackgroundTextbookReading(content, LONG_READING_THRESHOLD) ? <LongDocumentReader key={noteId} content={content} noteId={noteId} title={title}
    active={active} interactive={interactive} selectionSurface={selectionSurface} components={components} headingRequest={props.headingRequest} onHeadingResolved={props.onHeadingResolved} />
    : <article ref={article} className="focus-flow-note-preview" data-selection-surface={selectionSurface} data-selection-source-id={noteId}
    data-selection-context-id={noteId} data-selection-source-title={title} data-selection-note-id={noteId}>
    <div className="focus-flow-source-line">来源：当前项目笔记 · {title}</div>
    <ParsedPlainMarkdown content={content} components={components} />
  </article>}</NoteReadingActivityContext.Provider></ReadingWorkerProvider>;
});
