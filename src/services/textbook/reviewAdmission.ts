import type { FlowSession } from '../../types';
import type { LearningReviewRecord } from './types';

/** Only the exact heading inserted by FlowMode's microphone button is boilerplate.
 * Inspect a copy for admission; never rewrite the user's stored restatement. */
export function flowReviewContentText(value: string | undefined): string {
  return (value || '').replace(/^[ \t]{0,3}## 复盘 · \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ \t]*\r?$/gmu, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').trim();
}

/** Review blocks are artifacts, not activity/episode memory. Elapsed time,
 * inherited questions, timestamps and an enabled analysis switch are not review
 * content. Short real input is retained even below the existing analysis limit. */
export function flowReviewAdmission(session: FlowSession) {
  // An explicitly cleared final text must not resurrect stale incremental input.
  const restatement = session.restateText !== undefined ? session.restateText : session.incrementalText || '';
  const analysisText = flowReviewContentText(restatement);
  const hasContent = Boolean(analysisText || flowReviewContentText(session.summary));
  return { restatement, analysisText, hasContent, needsAnalysis: session.analyze !== false && analysisText.length >= 10 };
}

/** Recovery/finalization must not expose empty legacy placeholders. Preserve real
 * original/user-edited text and graph-only records; never delete existing data. */
export function hasLearningReviewContent(record: LearningReviewRecord): boolean {
  return Boolean(flowReviewContentText(record.rawRestatement) || flowReviewContentText(record.editedRestatement)
    || flowReviewContentText(record.summary) || record.argumentDocIds?.some(id => id.trim()));
}
