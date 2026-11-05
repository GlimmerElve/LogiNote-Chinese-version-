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
  RawAnalysisFile,
  StyleSnapshotFile,
  StyleTrendFile,
  WordCloudFile,
} from '../types';
import type { MasteryTimelineFile } from './learningAbility/types';
import type { LearningEpisodeFile } from './memory/types';
import { normalizeLearningEpisodeFile } from './memory/types';
import { normalizeMasteryTimeline } from './learningAbility/timelineCompatibility.ts';
import { readFlowStructure } from './argumentDoc/flowStructure';

/**
 * 存储重构核心：把 NoteItem 在磁盘层拆分为「可分享内容」与「个人状态」。
 * 本文件为纯函数层（无 DOM / localStorage 依赖），可供 Electron 主进程与前端共用。
 */

/** 可分享内容白名单（唯一来源，写进 vault/ metadata.json 的字段） */
export const SHARABLE_NOTE_FIELDS = [
  'id',
  'title',
  'content',
  'generatedContentBlocks',
  'textbook',
  'noteType',
  'projectRole',
  'parentId',
  'tags',
  'aliases',
  'links',
  'backlinks',
  'dueDates',
  'planMeta',
  'planOutcome',
  'resources',
  'referenceSources',
  'createdAt',
  'updatedAt',
  'argumentDocs',
] as const;

/** Direct NoteItem personal fields. Derived argumentFlowStructures is handled by
 * split/merge below, not writable through the generic personal-field patch API. */
export const USER_STATE_FIELDS = [
  'communityImport',
  'dsrState',
  'flowSummary',
  'learningReviewRecords',
  'learningContentMigration',
  'textbookReadingState',
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
  // Never export historical words hidden behind an edited/deleted canvas node.
  // Keep the live doc intact; the lossless snapshot belongs to private state.
  if (note.argumentDocs) result.argumentDocs = note.argumentDocs.map(({ flowStructure: _private, ...doc }) => doc);
  return result as unknown as NoteItem;
}

/** 从 NoteItem 提取「个人状态」字段 */
export function splitUserStateFields(note: NoteItem): UserNoteState {
  const state: Record<string, unknown> = {};
  for (const key of USER_STATE_FIELDS) {
    if (key in note) state[key] = note[key as UserStateField];
  }
  const structures = (note.argumentDocs || []).flatMap(doc => doc.flowStructure === undefined ? []
    : [[doc.doc_id, readFlowStructure(doc.flowStructure)!] as const]);
  if (structures.length) state.argumentFlowStructures = Object.fromEntries(structures);
  return state as UserNoteState;
}

/** 判断单篇个人状态是否含有任何有效字段（用于迁移检测与过滤） */
export function hasAnyUserState(state?: UserNoteState): boolean {
  if (!state) return false;
  if (state.argumentFlowStructures !== undefined) return true;
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
  styleRaw: 'style-raw-analysis.json',
  styleSnapshot: 'style-snapshot.json',
  styleTrend: 'style-trend.json',
  wordCloud: 'style-wordcloud.json',
  learningEpisodes: 'learning-episodes.json',
  flowStatistics: 'flow-review-statistics.json',
  cognition: 'personal-cognition.json',
  resourceState: 'resource-state.json',
  agentAudit: 'agent-audit.json',
  agentCheckpoints: 'agent-checkpoints.json',
  agentWorkflowDrafts: 'agent-workflow-drafts.json',
  agentSessions: 'agent-sessions.json',
  agentOperations: 'agent-operations.json',
  knowledgeLifecycle: 'knowledge-lifecycle.json',
  agentTasks: 'agent-tasks.json',
  sceneInteractionAudit: 'scene-interaction-audit.json',
  sceneAssemblyAudit: 'scene-assembly-audit.json',
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
  if (state?.argumentFlowStructures !== undefined) {
    const structures = state.argumentFlowStructures;
    if (!structures || typeof structures !== 'object' || Array.isArray(structures)) throw new Error('私人复盘结构格式错误，未替换原始快照');
    if (contentNote.argumentDocs) merged.argumentDocs = contentNote.argumentDocs.map(({ flowStructure: _legacy, ...doc }) => {
      const flowStructure = Object.hasOwn(structures, doc.doc_id) ? readFlowStructure(structures[doc.doc_id]) : undefined;
      return { ...doc, ...(flowStructure ? { flowStructure } : {}) };
    });
  }
  return merged as unknown as NoteItem;
}

/** Legacy inline fields never overwrite newer private state during format migration.
 * An existing (including empty) private snapshot map is authoritative.
 */
export function mergeLegacyNoteState(legacy: UserNoteState, current?: UserNoteState): UserNoteState {
  return { ...legacy, ...current };
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
    return normalizeMasteryTimeline(JSON.parse(text));
  } catch {
    return null;
  }
}

export function serializeLearningEpisodeState(file: LearningEpisodeFile): string {
  return stringify(normalizeLearningEpisodeFile(file));
}

export function deserializeLearningEpisodeState(text: string, strict = false): LearningEpisodeFile | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (strict && parsed === null) return null;
    return normalizeLearningEpisodeFile(parsed, strict);
  } catch {
    return null;
  }
}

/* ===== 表达风格 / 词云文件（style-raw-analysis / style-snapshot / style-trend / style-wordcloud） ===== */

export function serializeStyleRawState(file: RawAnalysisFile): string {
  return stringify(file);
}

export function deserializeStyleRawState(text: string): RawAnalysisFile | null {
  try {
    return JSON.parse(text) as RawAnalysisFile;
  } catch {
    return null;
  }
}

export function serializeStyleSnapshotState(file: StyleSnapshotFile): string {
  return stringify(file);
}

export function deserializeStyleSnapshotState(text: string): StyleSnapshotFile | null {
  try {
    return JSON.parse(text) as StyleSnapshotFile;
  } catch {
    return null;
  }
}

export function serializeStyleTrendState(file: StyleTrendFile): string {
  return stringify(file);
}

export function deserializeStyleTrendState(text: string): StyleTrendFile | null {
  try {
    return JSON.parse(text) as StyleTrendFile;
  } catch {
    return null;
  }
}

export function serializeWordCloudState(file: WordCloudFile): string {
  return stringify(file);
}

export function deserializeWordCloudState(text: string): WordCloudFile | null {
  try {
    return JSON.parse(text) as WordCloudFile;
  } catch {
    return null;
  }
}
