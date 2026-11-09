import type {
  UserProfile,
  LlmSettings,
  VaultSettings,
  ProfileStateFile,
  RawAnalysisFile,
  StyleSnapshotFile,
  StyleTrendFile,
  WordCloudFile,
} from '../types';
import type { MasteryTimelineFile } from './learningAbility/types';
import { normalizeMasteryTimeline } from './learningAbility/timelineCompatibility';

/**
 * 前端对 window.electronAPI.userState 的薄封装。
 * 采用「localStorage 运行时缓存 + user-state 文件持久化权威」策略：
 * - hydrateFromUserState() 在 App 启动时把各文件灌入 localStorage；
 * - saveXxx 同步写 localStorage（已有服务会做），异步调用这里把数据落盘到 user-state 文件。
 */

function getApi(): { [k: string]: (...args: unknown[]) => Promise<unknown> } | undefined {
  return (window as unknown as { electronAPI?: { userState?: { [k: string]: (...args: unknown[]) => Promise<unknown> } } })
    .electronAPI?.userState;
}

function isElectron(): boolean {
  return !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;
}

let profileWriteQueue: Promise<void> = Promise.resolve();

/** 仅 Electron 环境才落盘；web 版跳过（维持 localStorage 行为） */
export function userStateAvailable(): boolean {
  return isElectron() && !!getApi();
}

export async function saveProfileState(profile: UserProfile, conceptAliasMap: Record<string, string>): Promise<void> {
  const api = getApi();
  if (!api) return;
  const write = profileWriteQueue.then(() => api.saveProfile(profile, conceptAliasMap) as Promise<void>);
  profileWriteQueue = write.catch((e) => { console.warn('[user-state] save profile failed:', e); });
  await write;
}

export function flushProfileStateWrites(): Promise<void> {
  return profileWriteQueue;
}

/** 单独装载 profile.json（返回 { profile, conceptAliasMap }，供 profileStore 内存缓存 hydrate） */
export async function loadProfileState(strict = false): Promise<ProfileStateFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadProfile(strict);
    if (raw && typeof raw === 'object') {
      const p = raw as { profile?: UserProfile; conceptAliasMap?: Record<string, string> };
      if (strict && (!p.profile || !p.profile.ability || !p.profile.cognitiveStyle)) throw new Error('画像文件无效，未载入空画像');
      return { version: 1, profile: p.profile as UserProfile, conceptAliasMap: p.conceptAliasMap || {} };
    }
    if (strict && raw !== null) throw new Error('画像文件无效，未载入空画像');
    return null;
  } catch (e) {
    console.warn('[user-state] load profile state failed:', e);
    if (strict) throw e;
    return null;
  }
}

/** 装载 mastery-timeline.json（周报，异步读，无内存缓存） */
export async function loadMasteryTimelineState(): Promise<MasteryTimelineFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadMasteryTimeline(true);
    return raw === null ? null : normalizeMasteryTimeline(raw);
  } catch (e) {
    console.warn('[user-state] load mastery timeline failed:', e);
    throw e; // IO/schema failure must not become an empty timeline that the next save overwrites.
  }
}

/** 保存 mastery-timeline.json（周报） */
export async function saveMasteryTimelineState(file: MasteryTimelineFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.saveMasteryTimeline(file);
}

/* ===== 表达风格 / 词云文件 ===== */

export async function loadStyleRawState(): Promise<RawAnalysisFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadStyleRaw();
    return raw && typeof raw === 'object' ? (raw as RawAnalysisFile) : null;
  } catch (e) {
    console.warn('[user-state] load style raw failed:', e);
    return null;
  }
}

export async function saveStyleRawState(file: RawAnalysisFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveStyleRaw(file); } catch (e) { console.warn('[user-state] save style raw failed:', e); }
}

export async function loadStyleSnapshotState(): Promise<StyleSnapshotFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadStyleSnapshot();
    return raw && typeof raw === 'object' ? (raw as StyleSnapshotFile) : null;
  } catch (e) {
    console.warn('[user-state] load style snapshot failed:', e);
    return null;
  }
}

export async function saveStyleSnapshotState(file: StyleSnapshotFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveStyleSnapshot(file); } catch (e) { console.warn('[user-state] save style snapshot failed:', e); }
}

export async function loadStyleTrendState(): Promise<StyleTrendFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadStyleTrend();
    return raw && typeof raw === 'object' ? (raw as StyleTrendFile) : null;
  } catch (e) {
    console.warn('[user-state] load style trend failed:', e);
    return null;
  }
}

export async function saveStyleTrendState(file: StyleTrendFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveStyleTrend(file); } catch (e) { console.warn('[user-state] save style trend failed:', e); }
}

export async function loadWordCloudState(): Promise<WordCloudFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadWordCloud();
    return raw && typeof raw === 'object' ? (raw as WordCloudFile) : null;
  } catch (e) {
    console.warn('[user-state] load word cloud failed:', e);
    return null;
  }
}

export async function saveWordCloudState(file: WordCloudFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveWordCloud(file); } catch (e) { console.warn('[user-state] save word cloud failed:', e); }
}

export async function saveSettingsState(settings: VaultSettings): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.saveSettings(settings);
}

export async function saveLlmState(settings: LlmSettings): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.saveLlm(settings);
}

/**
 * 启动时从 user-state 文件灌入 localStorage 缓存。
 * 各文件若不存在（null）则保持 localStorage 现值（可能为空/默认）。
 */
export async function hydrateFromUserState(options: { skipSettings?: boolean; skipLlm?: boolean } = {}): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    const profile = await api.loadProfile();
    if (profile && typeof profile === 'object') {
      // profile.json 形如 { version, profile, conceptAliasMap }
      const p = profile as { profile?: UserProfile; conceptAliasMap?: Record<string, string> };
      if (p.profile) localStorage.setItem('loginote_user_profile_v1', JSON.stringify(p.profile));
      if (p.conceptAliasMap) localStorage.setItem('loginote_concept_alias_map_v1', JSON.stringify(p.conceptAliasMap));
    }
  } catch (e) { console.warn('[user-state] hydrate profile failed:', e); }

  if (!options.skipSettings) try {
    const settings = await api.loadSettings();
    if (settings && typeof settings === 'object') {
      localStorage.setItem('loginote_vault_settings_v1', JSON.stringify(settings));
    }
  } catch (e) { console.warn('[user-state] hydrate settings failed:', e); }

  if (!options.skipLlm) try {
    const llm = await api.loadLlm();
    if (llm && typeof llm === 'object') {
      localStorage.setItem('loginote_llm_settings', JSON.stringify(llm));
    }
  } catch (e) { console.warn('[user-state] hydrate llm failed:', e); }

  try {
    const resourceState = await api.loadResourceState();
    if (resourceState && typeof resourceState === 'object') {
      localStorage.setItem('loginote_resource_state_v1', JSON.stringify(resourceState));
    }
  } catch (e) { console.warn('[user-state] hydrate resource state failed:', e); }

}
