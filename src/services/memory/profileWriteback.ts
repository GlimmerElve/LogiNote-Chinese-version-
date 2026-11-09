import type { LearningEpisode } from './types';
import { profileWritebackEvidenceKey, profileWritebackPacketKey } from './types';
import { acknowledgeProfileWriteback, loadLearningEpisodes, saveLearningEpisode } from './episodeStore';
import { ingestProfileSignals } from '../profile/evidenceGate';
import { ensureProfileHydrated } from '../profile/profileStore';
import { saveFlowStatistics } from '../flowAnalysis/postStatistics';

const running = new Map<string, Promise<void>>();
const sourceSaves = new Map<string, Promise<void>>();
const saving = new Set<Promise<void>>();
const owners = new WeakMap<object, number>();
let ownerSequence = 0;
type ScopeApi = { getAgentTaskScope?: () => Promise<string> };
const currentApi = (): ScopeApi | undefined => typeof window === 'undefined' ? undefined
  : (window as unknown as { electronAPI?: { userState?: ScopeApi } }).electronAPI?.userState;
async function boundary(isCurrent: () => boolean | Promise<boolean> = () => true) {
  const api = currentApi(), scope = await api?.getAgentTaskScope?.();
  if (api && !owners.has(api)) owners.set(api, ++ownerSequence);
  const key = JSON.stringify([api ? owners.get(api) : 'browser', scope || '']);
  const current = async () => await isCurrent() && currentApi() === api
    && (scope === undefined || scope === await api?.getAgentTaskScope?.());
  const check = async () => { if (!await current()) throw new Error('画像写回所属资料库已变化，未写入其他资料库'); };
  await check();
  return { key, current, check };
}

/** Recover only saved evidence and its original sample size; never infer it from a summary. */
export async function completeProfileWriteback(episodeId: string, isCurrent: () => boolean | Promise<boolean> = () => true): Promise<void> {
  const source = await boundary(isCurrent), key = JSON.stringify([source.key, episodeId]);
  const previous = running.get(key);
  if (previous) {
    await previous;
    // A newer source save can land as the previous drainer settles. Joining its
    // promise alone is not acknowledgement of this caller's durable packet.
    await source.check();
    return completeProfileWriteback(episodeId, source.current);
  }
  const operation = (async () => {
    for (;;) {
      const episode = (await loadLearningEpisodes()).find(item => item.id === episodeId);
      await source.check();
      if (!episode?.profileWriteback || episode.profileWriteback.status === 'completed') return;
      if (episode.status !== 'completed') throw new Error('分析尚未完成，未将其写入画像');
      const packet = profileWritebackPacketKey(episode);
      try {
        await ingestProfileSignals({ episodeId, signals: episode.profileSignals || [],
          sampleChars: episode.profileWriteback.sampleChars, isCurrent: source.current });
        await source.check();
        // Reapply the durable statistics input after profile recovery, including
        // a newer revision that arrived while an older native reply was delayed.
        if (episode.type === 'flow' && episode.flowStatistics) await saveFlowStatistics(episode.flowStatistics);
        await source.check();
        await acknowledgeProfileWriteback(episode, source.current);
      } catch (error) {
        await source.check();
        const latest = (await loadLearningEpisodes()).find(item => item.id === episodeId);
        await source.check();
        // Only an actually replaced packet may supersede this attempt. IO and
        // same-version failures remain visible and pending for a later retry.
        if (!latest?.profileWriteback || profileWritebackPacketKey(latest) === packet) throw error;
      }
    }
  })();
  const pending = operation.finally(() => { if (running.get(key) === pending) running.delete(key); });
  running.set(key, pending);
  return pending;
}

/** The event is the durable retry record. Callers cannot report completion before both writes succeed. */
export function saveEpisodeWithProfileEvidence(episode: LearningEpisode, sampleChars: number,
  isCurrent: () => boolean | Promise<boolean> = () => true): Promise<void> {
  const operation = (async () => {
    if (episode.status !== 'completed' || !Number.isSafeInteger(sampleChars) || sampleChars < 0) {
      throw new Error('画像写回必须绑定已完成的活动和原始样本长度');
    }
    const source = await boundary(isCurrent);
    const key = JSON.stringify([source.key, episode.id]);
    const save = (sourceSaves.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
      await source.check();
      const current = (await loadLearningEpisodes()).find(item => item.id === episode.id);
      await source.check();
      if (current?.profileWriteback && profileWritebackEvidenceKey(current, current.profileWriteback.sampleChars)
        !== profileWritebackEvidenceKey(episode, sampleChars)) {
        throw new Error('同一学习事件的画像证据或样本长度已变化，请使用新的活动标识；未覆盖原证据');
      }
      const next: LearningEpisode = { ...episode, profileWriteback: { version: 1, status: 'pending', sampleChars } };
      if (current?.profileWriteback && profileWritebackPacketKey(current) === profileWritebackPacketKey(next)) return;
      await saveLearningEpisode(next, source.current);
    });
    const queued = save.finally(() => { if (sourceSaves.get(key) === queued) sourceSaves.delete(key); });
    sourceSaves.set(key, queued);
    await queued;
    await source.check();
    await completeProfileWriteback(episode.id, source.current);
  })();
  const pending = operation.finally(() => saving.delete(pending));
  saving.add(pending);
  return pending;
}

/** One bounded startup pass. Failed entries remain pending for an explicit retry or next startup. */
export async function retryPendingProfileWritebacks(isCurrent: () => boolean = () => true): Promise<{ completed: number; pending: number }> {
  await ensureProfileHydrated();
  if (!isCurrent()) return { completed: 0, pending: 0 };
  const episodes = (await loadLearningEpisodes()).filter(episode => episode.status === 'completed'
    && episode.profileWriteback?.status === 'pending');
  let completed = 0, pending = 0;
  for (const episode of episodes) {
    if (!isCurrent()) break;
    try { await completeProfileWriteback(episode.id, isCurrent); completed++; }
    catch (error) { pending++; console.warn('[profile-writeback] 已保存证据仍待重试:', error); }
  }
  return { completed, pending };
}

export async function flushProfileWritebacks(): Promise<void> {
  while (saving.size || running.size) await Promise.all([...saving, ...running.values()]);
}
