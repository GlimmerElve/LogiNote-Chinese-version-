import type { NoteItem } from '../types';

/** Presentation only: practice recency never substitutes for recall scheduling. */
export function knowledgePracticeTime(note: NoteItem): { at?: string; kind: 'review' | 'practice' | 'none' } {
  const valid = (at: unknown): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at));
  const dsr = note.dsrState;
  const review = valid(dsr?.lastReviewedAt) ? dsr.lastReviewedAt : undefined;
  const shadow = dsr?.masteryShadow;
  // Older quick-checks lack activity timestamps. Read actual observation times
  // without mutating historical scores or pretending they were independent.
  const observed = shadow?.knowledgePointId === note.id && shadow.appliedObservationIds?.some(id => id.startsWith('quick-check:'))
    ? Object.values(shadow.layers || {}).flatMap(layer => [layer.lastObservedAt, ...Object.values(layer.criteria || {}).map(criterion => criterion.lastObservedAt)]).filter(valid) : [];
  const practice = [dsr?.lastPracticedAt, ...observed].filter(valid).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (review && (!practice || Date.parse(review) >= Date.parse(practice))) return { at: review, kind: 'review' };
  return practice ? { at: practice, kind: 'practice' } : { kind: 'none' };
}

export function knowledgePracticeRecency(note: NoteItem, now = Date.now()): string {
  const latest = knowledgePracticeTime(note);
  if (!latest.at) return '尚未复习';
  const days = Math.floor(Math.max(0, now - Date.parse(latest.at)) / 86_400_000);
  const activity = latest.kind === 'review' ? '复习' : '练习';
  return days === 0 ? `今天${activity}过` : `上次${activity} ${days} 天前`;
}
