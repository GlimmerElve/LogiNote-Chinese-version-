import React, { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareSceneMarkdown, readSceneMathToken } from '../services/scene/sceneRichText';
import { FormulaBlock } from './textbook/FormulaBlock';

const plugins = [remarkGfm];
const components: Components = {
  code: ({ children, className, node: _node, ...props }) => {
    const math = readSceneMathToken(String(children));
    if (math) return <FormulaBlock latex={math.latex} displayMode={math.display} inlineContainer />;
    return <code className={className} {...props}>{children}</code>;
  },
  table: ({ children }) => <div className="flow-md-table-wrap"><table>{children}</table></div>,
};

/** Adapt delimiters before Markdown consumes their backslashes. This changes
 * only presentation: the saved answer and its links/references stay intact.
 * A flow timer, resource update or restatement keystroke must not parse again. */
export const FlowQuestionAnswer = React.memo(function FlowQuestionAnswer({ content }: { content: string }) {
  const markdown = useMemo(() => prepareSceneMarkdown(content), [content]);
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{markdown}</ReactMarkdown>;
});
