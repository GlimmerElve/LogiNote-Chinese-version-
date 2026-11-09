import type { LearningEpisode, LearningEpisodeFile } from './types';
import { emptyLearningEpisodeFile, normalizeLearningEpisodeFile, profileWritebackPacketKey, upsertEpisodeInFile } from './types';
import { evaluateEpisodeMemory } from './interactionMemoryPolicy.ts';

const WEB_STORAGE_KEY = 'loginote-learning-episodes-v1';
let mutationQueue: Promise<void> = Promise.resolve();

type EpisodeApi = {
  loadLearningEpisodes: (strict?: boolean) => Promise<unknown>;
  saveLearningEpisodes: (file: LearningEpisodeFile) => Promise<void>;
};

function getApi(): EpisodeApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: { userState?: EpisodeApi } }).electronAPI?.userState || null;
}

async function loadFile(): Promise<LearningEpisodeFile> {
  const api = getApi();
  // Only a genuine missing file means empty. IO/schema failures must abort the
  // read-modify-write transaction, preserving history and pending receipts.
  if (api) return normalizeLearningEpisodeFile(await api.loadLearningEpisodes(true), true);
  const raw = localStorage.getItem(WEB_STORAGE_KEY);
  if (raw === null) return emptyLearningEpisodeFile();
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) throw new Error('学习事件文件格式无效');
  return normalizeLearningEpisodeFile(parsed, true);
}

async function saveFile(file: LearningEpisodeFile): Promise<void> {
  const api = getApi();
  if (api) {
    await api.saveLearningEpisodes(file);
    return;
  }
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(file));
}

function mutate(mutator: (file: LearningEpisodeFile) => LearningEpisodeFile,
  isCurrent?: () => boolean | Promise<boolean>): Promise<void> {
  const check = async () => { if (isCurrent && !await isCurrent()) throw new Error('学习事件所属资料库已变化，未写入其他资料库'); };
  const task = mutationQueue.then(async () => {
    await check();
    const next = mutator(await loadFile());
    await check();
    await saveFile(next);
  });
  mutationQueue = task.catch((error) => {
    console.warn('[memory] learning episode save failed:', error);
  });
  return task;
}

export function saveLearningEpisode(episode: LearningEpisode, isCurrent?: () => boolean | Promise<boolean>): Promise<void> {
  if (!evaluateEpisodeMemory(episode).persist) return Promise.resolve();
  return mutate((file) => upsertEpisodeInFile(file, episode), isCurrent);
}

export function patchLearningEpisode(id: string, patch: Partial<LearningEpisode>): Promise<void> {
  return mutate((file) => {
    const current = file.episodes.find((item) => item.id === id);
    if (!current) return file;
    const updated = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    if (!evaluateEpisodeMemory(updated).persist) {
      return { ...file, episodes: file.episodes.filter((item) => item.id !== id) };
    }
    return upsertEpisodeInFile(file, updated);
  });
}

/** Acknowledge the exact saved evidence, never a newer packet sharing its event ID. */
export function acknowledgeProfileWriteback(episode: LearningEpisode, isCurrent?: () => boolean | Promise<boolean>): Promise<void> {
  return mutate(file => {
    const current = file.episodes.find(item => item.id === episode.id);
    if (!current?.profileWriteback) throw new Error('画像待写回事件已变化，未确认完成');
    if (profileWritebackPacketKey(current) !== profileWritebackPacketKey(episode)) {
      throw new Error('学习事件或统计版本已变化，未确认新版本完成');
    }
    if (current.profileWriteback.status === 'completed') return file;
    return upsertEpisodeInFile(file, { ...current,
      profileWriteback: { ...current.profileWriteback, status: 'completed' } });
  }, isCurrent);
}

/** Clear only the chosen recovery records, preserving scored evidence and unrelated/new drafts. */
export function clearReviewDraftsForNote(noteId: string, draftIds: readonly string[]): Promise<void> {
  if (!draftIds.length) return Promise.resolve();
  const ids = new Set(draftIds);
  return mutate(file => ({ ...file, episodes: file.episodes.flatMap(episode => {
    if (episode.type !== 'review' || episode.noteId !== noteId || !episode.draftAnswer || !ids.has(episode.draftAnswer.id)) return [episode];
    const { draftAnswer: _draft, ...cleared } = episode;
    // Keep this small empty checkpoint: deleting the latest session would resurrect an older draft.
    // It is still excluded from semantic memory by the ordinary admission policy.
    return [cleared];
  }) }));
}

export async function loadLearningEpisodes(): Promise<LearningEpisode[]> {
  return (await loadFile()).episodes;
}

export function flushLearningEpisodeWrites(): Promise<void> {
  return mutationQueue;
}
