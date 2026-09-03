import type {
  NoteItem,
  UserNoteState,
  UserStateFile,
  ProfileStateFile,
  SettingsStateFile,
  LlmStateFile,
  UserProfile,
  LlmSettings,
  VaultSettings,
} from '../types';
import type { MasteryTimelineFile } from './learningAbility/types';

/**
 * 存储重构核心：把 NoteItem 在磁盘层拆分为「可分享内容」与「个人状态」。
 * 本文件为纯函数层（无 DOM / localStorage 依赖），可供 Electron 主进程与前端共用。
 */

/** 可分享内容白名单（唯一来源，写进 vault/ metadata.json 的字段） */
export const SHARABLE_NOTE_FIELDS = [
  'id',
  'title',
  'content',
  'noteType',
  'parentId',
  'tags',
  'aliases',
  'links',
  'backlinks',
  'dueDates',
  'logicSegments',
  'resources',
  'createdAt',
  'updatedAt',
] as const;

/** 个人状态字段（唯一来源，从 NoteItem 抽离、写进 user-state/ 的字段） */
export const USER_STATE_FIELDS = [
  'dsrState',
  'flowSummary',
  'questions',
  'lastReferencedAt',
  'aiAnalyzedAt',
  'pinned',
  'isFavorite',
  'color',
] as const;

type SharableField = (typeof SHARABLE_NOTE_FIELDS)[number];
type UserStateField = (typeof USER_STATE_FIELDS)[number];

/** 从 NoteItem 提取「可分享内容」字段（白名单） */
export function splitSharableFields(note: NoteItem): NoteItem {
  const result: Record<string, unknown> = {};
  for (const key of SHARABLE_NOTE_FIELDS) {
    if (key in note) result[key] = note[key as SharableField];
  }
  return result as unknown as NoteItem;
}

/** 从 NoteItem 提取「个人状态」字段 */
export function splitUserStateFields(note: NoteItem): UserNoteState {
  const state: Record<string, unknown> = {};
  for (const key of USER_STATE_FIELDS) {
    if (key in note) state[key] = note[key as UserStateField];
  }
  return state as UserNoteState;
}

/** 判断单篇个人状态是否含有任何有效字段（用于迁移检测与过滤） */
export function hasAnyUserState(state?: UserNoteState): boolean {
  if (!state) return false;
  return USER_STATE_FIELDS.some((key) => {
    const v = (state as Record<string, unknown>)[key as string];
    return v !== undefined && v !== null;
  });
}

/** user-state 目录下的子文件名（主进程与前端约定一致） */
export const USER_STATE_FILES = {
  noteStates: 'user-state.json',
  profile: 'profile.json',
  settings: 'settings.json',
  llm: 'llm.json',
  masteryTimeline: 'mastery-timeline.json',
} as const;

/** 把「可分享内容」与「个人状态」合并回完整 NoteItem */
export function mergeNote(contentNote: NoteItem, state?: UserNoteState): NoteItem {
  const stateKeys = USER_STATE_FIELDS as readonly string[];
  const merged: Record<string, unknown> = { ...contentNote };
  if (state) {
    for (const key of stateKeys) {
      if (key in state) merged[key] = (state as Record<string, unknown>)[key];
    }
  }
  return merged as unknown as NoteItem;
}

/* ===== user-state 各子文件序列化 ===== */

function stringify(file: unknown): string {
  return JSON.stringify(file, null, 2);
}

export function serializeUserStateFile(noteStates: Record<string, UserNoteState>): string {
  const file: UserStateFile = { version: 1, noteStates };
  return stringify(file);
}

export function deserializeUserStateFile(text: string): Record<string, UserNoteState> {
  try {
    const parsed = JSON.parse(text) as UserStateFile;
    return parsed?.noteStates ?? {};
  } catch {
    return {};
  }
}

export function serializeProfileState(profile: UserProfile, conceptAliasMap: Record<string, string>): string {
  const file: ProfileStateFile = { version: 1, profile, conceptAliasMap };
  return stringify(file);
}

export function deserializeProfileState(text: string): ProfileStateFile | null {
  try {
    return JSON.parse(text) as ProfileStateFile;
  } catch {
    return null;
  }
}

export function serializeSettingsState(appSettings: VaultSettings): string {
  const file: SettingsStateFile = { version: 1, appSettings };
  return stringify(file);
}

export function deserializeSettingsState(text: string): VaultSettings | null {
  try {
    return (JSON.parse(text) as SettingsStateFile)?.appSettings ?? null;
  } catch {
    return null;
  }
}

export function serializeLlmState(settings: LlmSettings): string {
  const file: LlmStateFile = { version: 1, settings };
  return stringify(file);
}

export function deserializeLlmState(text: string): LlmSettings | null {
  try {
    return (JSON.parse(text) as LlmStateFile)?.settings ?? null;
  } catch {
    return null;
  }
}

export function serializeMasteryTimelineState(file: MasteryTimelineFile): string {
  return stringify(file);
}

export function deserializeMasteryTimelineState(text: string): MasteryTimelineFile | null {
  try {
    return JSON.parse(text) as MasteryTimelineFile;
  } catch {
    return null;
  }
}
