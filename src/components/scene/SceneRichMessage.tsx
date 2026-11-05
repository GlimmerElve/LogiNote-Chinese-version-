import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import katex from 'katex';
import type { SceneCitation } from '../../types';
import { openDocument } from '../../services/documentRagClient';
import {
  prepareSceneCitationMarkdown,
  prepareSceneMarkdown,
  readSceneCitationHref,
  readSceneMathToken,
} from '../../services/scene/sceneRichText';

interface Props {
  content: string;
  citations?: SceneCitation[];
  onOpenNote?: (noteId: string) => void;
  externalLinksDisabled?: boolean;
}

const SceneMath: React.FC<{ latex: string; display: boolean }> = ({ latex, display }) => {
  const html = useMemo(() => katex.renderToString(latex, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    trust: false,
  }), [latex, display]);

  return (
    <span
      className={display ? 'scene-math scene-math--display' : 'scene-math scene-math--inline'}
      aria-label={latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

const CitationBadge: React.FC<{ citation: SceneCitation; onOpenNote?: (noteId: string) => void }> = ({ citation, onOpenNote }) => (
  <sup className="scene-cite-wrap">
    <button
      type="button"
      className="scene-cite"
      aria-label={`来源 ${citation.index}：${citation.title}`}
      onClick={() => {
        if (citation.sourceType === 'document' && citation.documentId) {
          void openDocument(citation.documentId).catch(error => console.warn('[scene-citation] 资料打开失败:', error));
        } else if (citation.noteId) onOpenNote?.(citation.noteId);
      }}
    >
      [{citation.index}]
    </button>
    <span className="scene-cite-card" role="tooltip">
      <strong>{citation.title}</strong>
      <span>{citation.snippet}</span>
      <small>相关度 {Math.round(citation.score * 100)}%</small>
    </span>
  </sup>
);

export const SceneRichMessage: React.FC<Props> = ({ content, citations = [], onOpenNote, externalLinksDisabled = false }) => {
  const citationByIndex = useMemo(
    () => new Map(citations.map((citation) => [citation.index, citation])),
    [citations],
  );
  const prepared = useMemo(() => {
    const withCitations = prepareSceneCitationMarkdown(content, new Set(citationByIndex.keys()));
    return { ...withCitations, markdown: prepareSceneMarkdown(withCitations.markdown) };
  }, [content, citationByIndex]);
  const showFallback = citations.length > 0 && prepared.referencedIndexes.length === 0;

  return (
    <div className="scene-msg-rich">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ children, className, ...props }) => {
            const value = String(children);
            const math = readSceneMathToken(value);
            if (math) return <SceneMath {...math} />;
            return <code className={className} {...props}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="scene-msg-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href, ...props }) => {
            const citationIndex = readSceneCitationHref(href);
            const citation = citationIndex ? citationByIndex.get(citationIndex) : undefined;
            if (citation) return <CitationBadge citation={citation} onOpenNote={onOpenNote} />;
            if (externalLinksDisabled) return <span title="退出场景后可查看外部链接">{children}</span>;
            return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
          img: ({ alt, ...props }) => (
            <img {...props} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />
          ),
        }}
      >
        {prepared.markdown}
      </ReactMarkdown>
      {showFallback && (
        <div className="scene-cite-fallback" aria-label="本轮参考来源">
          <span>参考来源</span>
          {citations.map((citation) => (
            <CitationBadge key={citation.index} citation={citation} onOpenNote={onOpenNote} />
          ))}
        </div>
      )}
    </div>
  );
};
