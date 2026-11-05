import fs from 'fs/promises';
import path from 'path';
import type { NoteItem, StyleSnapshotFile, UserProfile } from '../../types';
import type { LearningEpisode } from '../../services/memory/types';
import {
  deserializeLearningEpisodeState,
  deserializeProfileState,
  deserializeStyleSnapshotState,
  deserializeUserStateFile,
  mergeNote,
  USER_STATE_FILES,
} from '../../services/userStateService';
import { deserializeVault } from '../../services/vaultFsService';
import { recoverVaultSnapshot } from '../vaultSnapshot';
import type { AgentDataChangedPayload, DataCenterPaths, DataEntity } from './types';

interface CacheState {
  notes: NoteItem[] | null;
  profile: UserProfile | null | undefined;
  episodes: LearningEpisode[] | null;
  styleSnapshot: StyleSnapshotFile | null | undefined;
}

let paths: DataCenterPaths | null = null;
let version = 0;
let cache: CacheState = { notes: null, profile: undefined, episodes: null, styleSnapshot: undefined };
let onChanged: ((payload: AgentDataChangedPayload) => void) | null = null;

export function initDataCenter(nextPaths: DataCenterPaths): void {
  paths = nextPaths;
  cache = { notes: null, profile: undefined, episodes: null, styleSnapshot: undefined };
  version = 0;
}

export function setDataCenterChangeListener(listener: ((payload: AgentDataChangedPayload) => void) | null): void {
  onChanged = listener;
}

export function getVersion(): number {
  return version;
}

export function bumpVersion(): number {
  version += 1;
  return version;
}

export function invalidate(entity: DataEntity | 'all'): void {
  if (entity === 'all' || entity === 'notes') cache.notes = null;
  if (entity === 'all' || entity === 'profile') {
    cache.profile = undefined;
    cache.styleSnapshot = undefined;
  }
  if (entity === 'all' || entity === 'episodes') cache.episodes = null;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function readMergedNotes(): Promise<NoteItem[]> {
  if (!paths) return [];
  await recoverVaultSnapshot(paths.vaultRoot, paths.userStateDir);
  const metadataText = await readText(path.join(paths.vaultRoot, 'metadata.json'));
  if (!metadataText) return [];
  const notesDir = path.join(paths.vaultRoot, 'notes');
  const mdMap = new Map<string, string>();
  try {
    const files = await fs.readdir(notesDir);
    await Promise.all(files.filter((file) => file.endsWith('.md')).map(async (file) => {
      const content = await readText(path.join(notesDir, file));
      if (content !== null) mdMap.set(file, content);
    }));
  } catch {
    return [];
  }
  try {
    const notes = deserializeVault(metadataText, mdMap);
    const stateText = await readText(path.join(paths.userStateDir, USER_STATE_FILES.noteStates));
    const states = stateText ? deserializeUserStateFile(stateText) : {};
    return notes.map((note) => mergeNote(note, states[note.id]));
  } catch {
    return [];
  }
}

export async function getNotes(): Promise<NoteItem[]> {
  if (cache.notes === null) cache.notes = await readMergedNotes();
  return cache.notes;
}

export async function getProfile(): Promise<UserProfile | null> {
  if (cache.profile !== undefined) return cache.profile;
  if (!paths) return null;
  const text = await readText(path.join(paths.userStateDir, USER_STATE_FILES.profile));
  cache.profile = text ? deserializeProfileState(text)?.profile || null : null;
  return cache.profile;
}

export async function getEpisodes(): Promise<LearningEpisode[]> {
  if (cache.episodes !== null) return cache.episodes;
  if (!paths) return [];
  const text = await readText(path.join(paths.userStateDir, USER_STATE_FILES.learningEpisodes));
  cache.episodes = text ? deserializeLearningEpisodeState(text)?.episodes || [] : [];
  return cache.episodes;
}

export async function readStyleSnapshot(): Promise<StyleSnapshotFile | null> {
  if (cache.styleSnapshot !== undefined) return cache.styleSnapshot;
  if (!paths) return null;
  const text = await readText(path.join(paths.userStateDir, USER_STATE_FILES.styleSnapshot));
  cache.styleSnapshot = text ? deserializeStyleSnapshotState(text) : null;
  return cache.styleSnapshot;
}

export function onWriteCommitted(entity: DataEntity | null): void {
  if (!entity) return;
  invalidate(entity);
  const nextVersion = bumpVersion();
  onChanged?.({ entity, version: nextVersion, op: 'update' });
}
