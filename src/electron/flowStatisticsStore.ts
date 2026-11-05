import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteItem, UserProfile } from '../types';
import { deserializeLearningEpisodeState, deserializeProfileState, USER_STATE_FILES } from '../services/userStateService';
import { appendFlowStatistics, readFlowStatisticsFile, readFlowStatisticsSubmission, statisticsEvent,
  type FlowStatisticsFile, type FlowStatisticsSubmission } from '../services/profile/flowStatistics';
import { isFlowRubric, partitionFlowProfileEvidence } from '../services/profile/evidenceGateCore';
import { computeWordCloud } from '../services/profile/wordCloud';
import { atomicWriteTextFile } from './atomicWrite';

export const FLOW_STATISTICS_FILE = USER_STATE_FILES.flowStatistics;
const queues = new Map<string, Promise<unknown>>();
async function optional(file: string) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
const empty = (): FlowStatisticsFile => ({ version: 1, events: [], snapshots: [] });
async function readFile(directory: string): Promise<FlowStatisticsFile | null> {
  const text = await optional(path.join(directory, FLOW_STATISTICS_FILE));
  return text === null ? null : readFlowStatisticsFile(JSON.parse(text));
}
export async function loadFlowStatistics(directory: string) {
  await queues.get(directory);
  return readFile(directory);
}
async function sources(directory: string) {
  const [episodesText, profileText] = await Promise.all([
    optional(path.join(directory, USER_STATE_FILES.learningEpisodes)), optional(path.join(directory, USER_STATE_FILES.profile)),
  ]);
  const episodes = episodesText === null ? [] : deserializeLearningEpisodeState(episodesText, true)?.episodes;
  const profile = profileText === null ? null : deserializeProfileState(profileText)?.profile;
  if (!episodes || profileText !== null && (!profile?.ability || !profile.cognitiveStyle)) throw new Error('复盘统计来源格式无效，未覆盖统计');
  return { episodes, profile };
}
function serial<T>(directory: string, run: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(directory)) return Promise.reject(new Error('复盘统计目录无效'));
  const task = (queues.get(directory) || Promise.resolve()).catch(() => undefined).then(run);
  const settled = task.catch(() => undefined); queues.set(directory, settled);
  void settled.finally(() => { if (queues.get(directory) === settled) queues.delete(directory); });
  return task;
}
async function persist(directory: string, previous: FlowStatisticsFile | null, next: FlowStatisticsFile) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  readFlowStatisticsFile(next);
  await fs.mkdir(directory, { recursive: true });
  await atomicWriteTextFile(path.join(directory, FLOW_STATISTICS_FILE), JSON.stringify(next));
}
export function recordFlowStatistics(directory: string, raw: unknown): Promise<void> {
  const input = readFlowStatisticsSubmission(raw); // Freeze before async work, no caller paths accepted.
  return serial(directory, async () => {
    const previous = await readFile(directory), { episodes, profile } = await sources(directory);
    const episode = episodes.find(e => e.id === input.episodeId);
    if (!episode || !profile) throw new Error('复盘事件或画像尚未保存，未写统计');
    if (JSON.stringify(episode.flowStatistics) !== JSON.stringify(input)) throw new Error('复盘统计与已保存事件不一致');
    const next = appendFlowStatistics(previous || empty(), statisticsEvent(input, episode, profile), profile);
    await persist(directory, previous, next);
  });
}

/** Backfill only stored observations and raw saved review words. Historical error
 * counts cannot be reconstructed from summaries, so remain null, never zero. */
export function backfillFlowStatistics(directory: string, notes: readonly NoteItem[]): Promise<void> {
  const reviews = new Map(notes.flatMap(note => (note.learningReviewRecords || []).filter(r =>
    r.projectNoteId === note.id && typeof r.rawRestatement === 'string').map(r => [r.sessionId, r.rawRestatement] as const)));
  return serial(directory, async () => {
    const previous = await readFile(directory), { episodes, profile } = await sources(directory);
    if (!profile) return;
    let next = previous || empty();
    const admitted = Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {});
    for (const episode of [...episodes].sort((a, b) => a.endedAt.localeCompare(b.endedAt))) {
      if (episode.type !== 'flow' || episode.status !== 'completed' || episode.error) continue;
      const sample = admitted.filter(a => isFlowRubric(a.rubricVersion)).flatMap(a => a.samples).find(s => s.episodeId === episode.id && isFlowRubric(s.rubricVersion));
      if (!sample && !episode.flowStatistics) continue;
      const text = reviews.get(episode.id);
      const input: FlowStatisticsSubmission = episode.flowStatistics || { version: 1, episodeId: episode.id, observedAt: sample!.observedAt,
        rubricVersion: sample!.rubricVersion!, sampleChars: text?.length || 0, errors: null, words: text ? computeWordCloud(text) : [] };
      next = appendFlowStatistics(next, statisticsEvent(input, episode, profile), profile as UserProfile);
    }
    if (next.events.length) await persist(directory, previous, next);
  });
}
