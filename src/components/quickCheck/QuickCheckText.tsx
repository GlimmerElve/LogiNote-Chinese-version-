import React, { useMemo } from 'react';
import { FormulaBlock } from '../textbook/FormulaBlock';
import { answerPreviewParts } from './mathAnswer';
import { generatedMathMarkdown } from '../../services/textbook/generatedMath';

/** Text and delimited math only. Model/reference text never becomes HTML or executable Markdown. */
export function QuickCheckText({ text, recoverPlainMath = false }: { text: string; recoverPlainMath?: boolean }) {
  const parts = useMemo(() => answerPreviewParts(recoverPlainMath ? generatedMathMarkdown(text) : text), [text, recoverPlainMath]);
  return <span className="quick-check-math-text">{parts.map((part, index) => part.kind === 'text'
    ? <React.Fragment key={index}>{part.value}</React.Fragment>
    : <FormulaBlock key={index} latex={part.value} displayMode={part.display} inlineContainer />)}</span>;
}
