import type { KnowledgeStatementStatus } from '../../types.ts';

const STATUSES = new Set<KnowledgeStatementStatus>(['asserted', 'research_question', 'hypothesis', 'unspecified']);
const compact = (text: string): string => text.replace(/\s+/gu, '').toLocaleLowerCase();

export function isKnowledgeStatementStatus(value: unknown): value is KnowledgeStatementStatus {
  return typeof value === 'string' && STATUSES.has(value as KnowledgeStatementStatus);
}

/** A narrow source-language backstop, NOT a general semantic reviewer or truth verifier. */
export function resolveKnowledgeStatementStatus(
  declared: KnowledgeStatementStatus | undefined,
  evidenceQuotes: string[],
): KnowledgeStatementStatus {
  const text = evidenceQuotes.join('\n');
  const chinese = compact(text);
  if (/(?:探究|探讨|考察).{0,80}(?:是否|影响)/u.test(chinese)
    || /(?:检验|验证).{0,80}是否/u.test(chinese)
    || /(?:实验目的|研究目的|研究问题|旨在).{0,100}(?:影响|关系|效应)/u.test(chinese)
    || /(?:explore|investigate|examine|test)\b[^.!?]{0,160}\b(?:whether|influence|effect|relationship)\b/iu.test(text)) {
    return 'research_question';
  }
  if (/(?:本研究假设|我们假设|有待进一步.{0,20}证实|尚待证实)/u.test(chinese)) return 'hypothesis';
  return isKnowledgeStatementStatus(declared) ? declared : 'unspecified';
}

export function knowledgeRelationSummary(input: {
  subject: string; predicate: string; object: string; qualifiers: string[]; statementStatus: KnowledgeStatementStatus;
}): string {
  const label = input.statementStatus === 'research_question' ? '研究问题，非研究结论'
    : input.statementStatus === 'hypothesis' ? '假设，不等于结论'
      : input.statementStatus === 'asserted' ? '原文陈述，未做事实核验'
        : '原文关系，陈述性质未标注';
  const scope = input.qualifiers.length ? `；适用条件：${input.qualifiers.join('、')}` : '';
  return `[${label}] ${input.subject} ${input.predicate} ${input.object}${scope}`;
}

/**
 * An explicit "this result differs from X's result" cannot oppose this result itself.
 * Only handles a named, explicit comparison in the source. Unresolved pronouns and
 * other relation patterns still need semantic review; no cross-chunk link is invented.
 */
export function hasExplicitComparisonTargetMismatch(sourceText: string, targetText: string): boolean {
  const source = compact(sourceText);
  const match = source.match(/(?:与|和)([^，。；;:]{1,80}?)的(?:实验|研究)?结果(?:并)?不一致/u);
  if (!match || /(?:本次|本研究|之前|上述|我们的|这些|他们|其他)/u.test(match[1])) return false;
  return !compact(targetText).includes(match[1]);
}
