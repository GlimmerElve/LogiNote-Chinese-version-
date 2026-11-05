/** Small IO contract. No stores, transports, scoring, DOM or Node dependencies. */
export interface FlowStatisticsSubmission {
  version: 1; episodeId: string; observedAt: string; rubricVersion: string; sampleChars: number;
  errors: { confirmed: number; gaps: number } | null;
  words: Array<{ word: string; count: number }>;
}
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const statisticsDay = (at: string) => {
  const d = new Date(at); if (!Number.isFinite(d.getTime())) throw new Error('复盘统计日期无效');
  return dayFormat.format(d);
};
export function statisticsWeek(at: string): string {
  const date = new Date(`${statisticsDay(at)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
export function readFlowStatisticsSubmission(raw: unknown): FlowStatisticsSubmission {
  const v = raw as FlowStatisticsSubmission;
  if (!v || v.version !== 1 || typeof v.episodeId !== 'string' || !v.episodeId || v.episodeId.length > 300
    || typeof v.observedAt !== 'string' || typeof v.rubricVersion !== 'string' || !/^flow-evidence-rubric-v\d+-/u.test(v.rubricVersion)
    || !count(v.sampleChars) || v.errors !== null && (!v.errors || !count(v.errors.confirmed) || !count(v.errors.gaps))
    || !Array.isArray(v.words) || v.words.length > 40 || v.words.some(w => !w || typeof w.word !== 'string'
      || w.word.length < 2 || w.word.length > 50 || !count(w.count) || w.count < 1)) throw new Error('复盘统计字段无效');
  statisticsDay(v.observedAt);
  // Whitelist compact statistics. Unknown fields must never retain a transcript.
  return { version: 1, episodeId: v.episodeId, observedAt: v.observedAt, rubricVersion: v.rubricVersion,
    sampleChars: v.sampleChars, errors: v.errors === null ? null : { confirmed: v.errors.confirmed, gaps: v.errors.gaps },
    words: v.words.map(w => ({ word: w.word, count: w.count })) };
}
