import React, { createContext, useContext, useMemo } from 'react';
import type { Components } from 'react-markdown';
import { FormulaBlock } from './FormulaBlock';
import { TextbookVisualGate } from './TextbookVisualGate';
import { WIKI_LINK_PREFIX } from '../../services/markdownWikiLinks';
import { MermaidBlock } from './MermaidBlock';
import { TextbookFormatFallback } from './CodeBlock';
import { isTextbookBlockLanguage, parseControlledTextbookBlock, parseTextbookAnswer, parseTextbookTip } from '../../services/textbook/contentSchema';
import { lazyFeature } from '../lazyFeature';
import type { PreparedFormula } from '../../services/textbook/readingFormula';
import { TextbookQuote } from './TextbookQuote';
import { EmbeddedReadingBody, ReadingAnswer } from './ReadingFragment';

const Chart = lazyFeature('数据图表', () => import('./ChartBlock').then(module => ({ default: module.ChartBlock })));
const FunctionPlot = lazyFeature('函数图', () => import('./FunctionPlotBlock').then(module => ({ default: module.FunctionPlotBlock })));
const ScienceDiagram = lazyFeature('理科示意图', () => import('./ScienceDiagramBlock').then(module => ({ default: module.ScienceDiagramBlock })));
const Molecule = lazyFeature('分子结构', () => import('./MoleculeBlock').then(module => ({ default: module.MoleculeBlock })));
const visuals: Record<string, { label: string; height: number }> = {
  mermaid: { label: '结构图', height: 300 }, chart: { label: '数据图表', height: 390 },
  'function-plot': { label: '函数图', height: 390 }, 'science-diagram': { label: '理科示意图', height: 300 },
  molecule: { label: '分子结构', height: 300 },
};
export const NoteReadingActivityContext = createContext(true);
export const NoteReadingCitationContext = createContext<readonly string[] | undefined>(undefined);

/** Validation and all runtime imports wait until the existing visibility gate mounts this component. */
function NoteDiagram({ language, code }: { language: string; code: string }) {
  const error = useMemo(() => {
    try { parseControlledTextbookBlock(language, code); return ''; }
    catch (reason) { return reason instanceof Error ? reason.message : '格式无效'; }
  }, [language, code]);
  if (error) return <TextbookFormatFallback language={language} code={code} message={`图示暂不可展示：${error}`} />;
  if (language === 'mermaid') return <MermaidBlock code={code} />;
  if (language === 'chart') return <Chart code={code} />;
  if (language === 'function-plot') return <FunctionPlot code={code} />;
  if (language === 'science-diagram') return <ScienceDiagram code={code} />;
  return <Molecule code={code} />;
}

/** The same adapters serve the short Markdown reader and worker-prepared long chunks. */
export function noteReadingComponents(onWikiLink: (raw: string) => void, active: boolean): Components {
  const components: Components = {
    blockquote: TextbookQuote,
    table: ({ children }) => <div className="flow-md-table-wrap"><table>{children}</table></div>,
    pre: ({ children, node }) => {
      const enabled = useContext(NoteReadingActivityContext) && active;
      const citationIds = useContext(NoteReadingCitationContext);
      const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
      if (code?.type === 'element') {
        const classes = String(code.properties.className || '').split(/[ ,]+/u);
        const source = code.children.filter(child => child.type === 'text').map(child => child.value).join('');
        if (classes.includes('math-display')) return <FormulaBlock latex={source} displayMode prepared={code.data?.preparedFormula as PreparedFormula | undefined} />;
        const language = classes.find(name => name.startsWith('language-'))?.slice('language-'.length) || '';
        const visual = visuals[language];
        if (visual) return <TextbookVisualGate active={enabled} label={visual.label} minHeight={visual.height}>
          <NoteDiagram language={language} code={source} />
        </TextbookVisualGate>;
        if (language === 'textbook-tip' || language === 'textbook-answer') {
          try {
            if (language === 'textbook-answer') {
              const answer = parseTextbookAnswer(source);
              return <ReadingAnswer title={answer.title}>
                <EmbeddedReadingBody body={answer.text} active={enabled} fragmentKind="note" components={components} citationIds={citationIds} />
              </ReadingAnswer>;
            }
            const tip = parseTextbookTip(source);
            return <aside className={`textbook-tip textbook-tip-${tip.kind}`} role="note"><strong>{tip.title}</strong>
              <EmbeddedReadingBody body={tip.text} active={enabled} fragmentKind="note" components={components} citationIds={citationIds} /></aside>;
          } catch (reason) {
            return <TextbookFormatFallback language={language} code={source} message={`格式块暂不可展示：${reason instanceof Error ? reason.message : '格式无效'}`} />;
          }
        }
        if (isTextbookBlockLanguage(language)) return <TextbookFormatFallback language={language} code={source}
          message="该教材格式需要对应的来源或图片信息，请查看源码或在原教材中阅读。" />;
      }
      return <pre>{children}</pre>;
    },
    code: ({ className, children, node }) => className?.split(/\s+/u).includes('math-inline')
      ? <FormulaBlock latex={String(children)} prepared={node?.data?.preparedFormula as PreparedFormula | undefined} /> : <code className={className}>{children}</code>,
    a: ({ href, title, children }) => {
      const enabled = useContext(NoteReadingActivityContext) && active;
      if (href?.startsWith(WIKI_LINK_PREFIX)) {
        let destination = '';
        try { destination = decodeURIComponent(href.slice(WIKI_LINK_PREFIX.length)); } catch { /* Invalid fragments remain inert. */ }
        return destination ? <button type="button" role="link" className="wiki-link-node knowledge-preview-wiki-link"
          data-wiki-target={destination} disabled={!enabled} title={`预览关联笔记：${destination}`} onClick={event => {
            event.preventDefault(); event.stopPropagation(); onWikiLink(destination);
          }}>{children}</button> : <span>{children}</span>;
      }
      return <a href={href} title={title}>{children}</a>;
    },
  };
  return components;
}
