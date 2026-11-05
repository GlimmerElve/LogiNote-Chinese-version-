import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import katex from 'katex';
import type { AgentCitation, LlmConversationMessage } from '../types';
import { prepareSceneMarkdown, readSceneMathToken } from '../services/scene/sceneRichText';
import { AgentCognitionReferences } from './AgentCognitionReferences';
import { agentMessageDisplayContent } from '../services/agent/answerFormat';

interface Props {
  message: LlmConversationMessage;
  onOpenCitation: (citation: AgentCitation) => void;
}

function transformOutsideCode(markdown: string, transform: (text: string) => string): string {
  const codePattern = /(`{3,})[\s\S]*?\1|(~{3,})[\s\S]*?\2|(`+)[^\n]*?\3/g;
  let result = '';
  let cursor = 0;
  for (const match of markdown.matchAll(codePattern)) {
    const index = match.index ?? 0;
    result += transform(markdown.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + transform(markdown.slice(cursor));
}

function prepareCitationLinks(markdown: string, validIds: ReadonlySet<string>): string {
  return transformOutsideCode(markdown, (text) => text.replace(
    /(^|[^!\\])\[([NDM]\d+)\](?!\()/gi,
    (match, prefix: string, sourceId: string) => {
      const normalized = sourceId.toUpperCase();
      return validIds.has(normalized) ? `${prefix}[${normalized}](#agent-citation-${normalized})` : match;
    },
  ));
}

function AgentMath({ latex, display }: { latex: string; display: boolean }) {
  const html = useMemo(() => katex.renderToString(latex, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    trust: false,
  }), [display, latex]);
  return (
    <span
      className={display ? 'agent-math agent-math--display' : 'agent-math agent-math--inline'}
      aria-label={latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function citationLocation(citation: AgentCitation): string {
  const locator = citation.sourceLocation;
  if (!locator) return citation.sectionPath || '';
  const location = locator.kind === 'pdf'
    ? `第 ${locator.page} 页`
    : locator.kind === 'docx'
      ? `第 ${locator.paragraphIndex + 1} 段`
      : locator.kind === 'pptx'
        ? `第 ${locator.slideIndex + 1} 张幻灯片`
        : `字符 ${locator.charStart + 1}–${locator.charEnd}`;
  return [citation.sectionPath, location].filter(Boolean).join(' · ');
}

export const AgentRichMessage: React.FC<Props> = ({ message, onOpenCitation }) => {
  const citations = message.role === 'assistant' ? message.citations || [] : [];
  const citationById = useMemo(
    () => new Map(citations.map((citation) => [citation.sourceId.toUpperCase(), citation])),
    [citations],
  );
  const markdown = useMemo(() => prepareSceneMarkdown(prepareCitationLinks(
    agentMessageDisplayContent(message),
    new Set(citationById.keys()),
  )), [citationById, message.content, message.role, message.toolCalls]);

  return (
    <div className="agent-message-rich">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ children, className, ...props }) => {
            const math = readSceneMathToken(String(children));
            if (math) return <AgentMath {...math} />;
            return <code className={className} {...props}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="agent-message-table-wrap"><table>{children}</table></div>
          ),
          a: ({ children, href, ...props }) => {
            const match = href?.match(/^#agent-citation-([NDM]\d+)$/i);
            const citation = match ? citationById.get(match[1].toUpperCase()) : undefined;
            if (citation) {
              const location = citationLocation(citation);
              return (
                <button
                  type="button"
                  className="agent-citation-marker"
                  aria-label={`打开来源 ${citation.sourceId}：${citation.title}`}
                  title={`${citation.title}${location ? ` · ${location}` : ''}`}
                  onClick={() => onOpenCitation(citation)}
                >
                  [{citation.sourceId}]
                </button>
              );
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
          img: ({ alt, ...props }) => (
            <img {...props} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>

      {message.role === 'assistant' && !!message.cognitionReferences?.length && <AgentCognitionReferences references={message.cognitionReferences} />}
      {citations.length > 0 && (
        <div className="agent-citation-list" aria-label="本回答引用的本地来源">
          {citations.map((citation) => (
            <button
              type="button"
              key={`${citation.sourceId}-${citation.chunkId || citation.entityId}`}
              onClick={() => onOpenCitation(citation)}
            >
              <strong>{citation.sourceId}</strong>
              <span>{citation.title}</span>
              {citationLocation(citation) && <small>{citationLocation(citation)}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
