import type { ExpressionStyleKind, StyleTrendFile, UserProfile, WordCloudFile } from '../../types';
import type { LearningEpisode } from '../memory/types';
import type { MasteryTimelineFile } from '../learningAbility/types';
import { partitionFlowProfileEvidence, isFlowRubric } from './evidenceGateCore';
import { EXPRESSION_KINDS } from './styleScoring';
import { statisticsDay, statisticsWeek, readFlowStatisticsSubmission, type FlowStatisticsSubmission } from './flowStatisticsSchema';
export { statisticsDay, statisticsWeek, readFlowStatisticsSubmission, type FlowStatisticsSubmission } from './flowStatisticsSchema';

export interface FlowStatisticsEvent extends FlowStatisticsSubmission {
  scores: { concept: number | null; judgment: number | null; reasoning: number | null };
}
export interface FlowStatisticsFile {
  version: 1; events: FlowStatisticsEvent[];
  snapshots: Array<StyleTrendFile['snapshots'][number] & { rubricVersion: string; observedAt: string }>;
}
const score = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
export function readFlowStatisticsFile(raw: unknown): FlowStatisticsFile {
  const v = raw as FlowStatisticsFile;
  if (!v || v.version !== 1 || !Array.isArray(v.events) || v.events.length > 1000 || !Array.isArray(v.snapshots)
    || v.snapshots.length > 5000 || new Set(v.events.map(e => e?.episodeId)).size !== v.events.length) throw new Error('复盘统计文件无效');
  for (const e of v.events) {
    readFlowStatisticsSubmission(e);
    if (!e.scores || ![e.scores.concept, e.scores.judgment, e.scores.reasoning].every(score)) throw new Error('复盘分数无效');
  }
  for (const s of v.snapshots) {
    if (!s || !isFlowRubric(s.rubricVersion) || typeof s.topStyle !== 'string' || statisticsDay(s.observedAt) !== s.date
      || !s.display || !EXPRESSION_KINDS.every(k => score(s.display[k]) && s.display[k] !== null)) throw new Error('复盘风格历史无效');
  }
  return v;
}

/** Scores come from the authoritative admitted cohort, not the UI's percentage placeholders. */
export function statisticsEvent(input: FlowStatisticsSubmission, episode: LearningEpisode, profile: UserProfile): FlowStatisticsEvent {
  if (episode.id !== input.episodeId || episode.type !== 'flow' || episode.status !== 'completed' || episode.error) throw new Error('复盘尚未完成，未写统计');
  const aggregates = Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {});
  const value = (indicator: string) => aggregates.find(a => a.dimension === 'ability' && a.indicator === indicator
    && a.rubricVersion === input.rubricVersion)?.samples.find(s => s.episodeId === input.episodeId)?.value ?? null;
  return { ...input, scores: { concept: value('conceptClarity'), judgment: value('judgmentReasonableness'), reasoning: value('reasoningValidity') } };
}

/** Append once per episode; later completion can fill unknown legacy counters without recounting. */
export function appendFlowStatistics(file: FlowStatisticsFile, event: FlowStatisticsEvent, profile: UserProfile): FlowStatisticsFile {
  const previous = file.events.find(e => e.episodeId === event.episodeId);
  if (previous && previous.rubricVersion !== event.rubricVersion) throw new Error('同一复盘的统计量规冲突，未覆盖原统计');
  const accepted = previous ? { ...previous, errors: previous.errors ?? event.errors,
    words: previous.words.length ? previous.words : event.words,
    scores: { concept: previous.scores.concept ?? event.scores.concept, judgment: previous.scores.judgment ?? event.scores.judgment,
      reasoning: previous.scores.reasoning ?? event.scores.reasoning } } : event;
  const events = [...file.events.filter(e => e.episodeId !== event.episodeId), accepted]
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.episodeId.localeCompare(b.episodeId)).slice(-1000);
  const groups = Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {})
    .filter(a => a.dimension === 'expression_style' && a.rubricVersion === event.rubricVersion);
  const current = EXPRESSION_KINDS.map(k => groups.find(a => a.indicator === k));
  let snapshots = [...file.snapshots];
  if (current.every(a => a?.status === 'trusted' && a.samples.at(-1)?.episodeId === event.episodeId)) {
    const observedAt = current.map(a => a!.updatedAt).sort().at(-1)!, date = statisticsDay(observedAt);
    const display = Object.fromEntries(current.map(a => [a!.indicator, a!.mean])) as Record<ExpressionStyleKind, number>;
    const item = { date, observedAt, display, rubricVersion: event.rubricVersion, topStyle: '同量规已采信表达风格' };
    const prior = snapshots.find(s => s.date === date && s.rubricVersion === item.rubricVersion);
    if (!prior || prior.observedAt <= observedAt) snapshots = [...snapshots.filter(s => s !== prior), item];
  }
  return { version: 1, events, snapshots: snapshots.sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-5000) };
}

export function projectFlowStatistics(file: FlowStatisticsFile): {
  timeline: MasteryTimelineFile['flowAnalysis']; trend: StyleTrendFile; cloud: WordCloudFile;
} {
  const rubricVersion = file.events.at(-1)?.rubricVersion;
  const byWeek = new Map<string, FlowStatisticsEvent[]>(), wordWeeks = new Map<string, Map<string, number>>();
  for (const e of file.events) {
    const week = statisticsWeek(e.observedAt);
    if (e.rubricVersion === rubricVersion) byWeek.set(week, [...(byWeek.get(week) || []), e]);
    const words = wordWeeks.get(week) || new Map<string, number>();
    e.words.forEach(w => words.set(w.word, (words.get(w.word) || 0) + w.count)); wordWeeks.set(week, words);
  }
  const mean = (values: Array<number | null>) => {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? Math.round(known.slice(1).reduce((v, n) => v * .6 + n * .4, known[0]) * 10) / 10 : null;
  };
  const weeks = [...byWeek].sort(([a], [b]) => a.localeCompare(b)).slice(-10).map(([weekStart, events]) => {
    const known = events.filter(e => e.errors !== null);
    const errors = known.reduce((sum, e) => sum + e.errors!.confirmed + e.errors!.gaps, 0);
    return { weekStart, analysisCount: events.length, vulnerabilityCount: errors,
      errorRate: known.length ? errors / known.length : null,
      conceptScore: mean(events.map(e => e.scores.concept)), judgmentScore: mean(events.map(e => e.scores.judgment)), logicScore: mean(events.map(e => e.scores.reasoning)) };
  });
  return { timeline: rubricVersion ? { rubricVersion, weeks } : undefined,
    trend: { snapshots: file.snapshots },
    cloud: { weeks: [...wordWeeks].sort(([a], [b]) => a.localeCompare(b)).slice(-10).map(([weekStart, words]) => ({ weekStart,
      words: [...words].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 20) })) } };
}

export function analysisWeeks(timeline: MasteryTimelineFile) {
  return timeline.flowAnalysis ? timeline.flowAnalysis.weeks : timeline.weeks.filter(w => !w.analysisCountUnknown && w.analysisCount > 0)
    .map(w => ({ weekStart: w.weekStart, analysisCount: w.analysisCount, errorRate: w.errorRate,
      vulnerabilityCount: w.reasoning.vulnerabilityCount, conceptScore: w.reasoning.conceptScore,
      judgmentScore: w.reasoning.judgmentScore, logicScore: w.reasoning.logicScore }));
}
