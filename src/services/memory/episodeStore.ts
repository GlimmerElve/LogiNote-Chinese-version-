import type { LearningEpisode, LearningEpisodeFile } from './types';
import { emptyLearningEpisodeFile, normalizeLearningEpisodeFile, upsertEpisodeInFile } from './types';
import { evaluateEpisodeMemory } from './interactionMemoryPolicy.ts';

const WEB_STORAGE_KEY = 'loginote-learning-episodes-v1';
let mutationQueue: Promise<void> = Promise.resolve();

type EpisodeApi = {
  loadLearningEpisodes: () => Promise<unknown>;
  saveLearningEpisodes: (file: LearningEpisodeFile) => Promise<void>;
};

function getApi(): EpisodeApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: { userState?: EpisodeApi } }).electronAPI?.userState || null;
}

async function loadFile(): Promise<LearningEpisodeFile> {
  const api = getApi();
  if (api) return normalizeLearningEpisodeFile(await api.loadLearningEpisodes());
  try {
    const raw = localStorage.getItem(WEB_STORAGE_KEY);
    return raw ? normalizeLearningEpisodeFile(JSON.parse(raw)) : emptyLearningEpisodeFile();
  } catch {
    return emptyLearningEpisodeFile();
  }
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

function mutate(mutator: (file: LearningEpisodeFile) => LearningEpisodeFile): Promise<void> {
  const task = mutationQueue.then(async () => saveFile(mutator(await loadFile())));
  mutationQueue = task.catch((error) => {
    console.warn('[memory] learning episode save failed:', error);
  });
  return task;
}

export function saveLearningEpisode(episode: LearningEpisode): Promise<void> {
  if (!evaluateEpisodeMemory(episode).persist) return Promise.resolve();
  return mutate((file) => upsertEpisodeInFile(file, episode));
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
