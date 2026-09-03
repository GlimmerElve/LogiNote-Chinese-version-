import type { UserProfile, LlmSettings, VaultSettings, ProfileStateFile } from '../types';
import type { MasteryTimelineFile } from './learningAbility/types';

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

/** 仅 Electron 环境才落盘；web 版跳过（维持 localStorage 行为） */
export function userStateAvailable(): boolean {
  return isElectron() && !!getApi();
}

export async function saveProfileState(profile: UserProfile, conceptAliasMap: Record<string, string>): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveProfile(profile, conceptAliasMap); } catch (e) { console.warn('[user-state] save profile failed:', e); }
}

/** 单独装载 profile.json（返回 { profile, conceptAliasMap }，供 profileStore 内存缓存 hydrate） */
export async function loadProfileState(): Promise<ProfileStateFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadProfile();
    if (raw && typeof raw === 'object') {
      const p = raw as { profile?: UserProfile; conceptAliasMap?: Record<string, string> };
      return { version: 1, profile: p.profile as UserProfile, conceptAliasMap: p.conceptAliasMap || {} };
    }
    return null;
  } catch (e) {
    console.warn('[user-state] load profile state failed:', e);
    return null;
  }
}

/** 装载 mastery-timeline.json（周报，异步读，无内存缓存） */
export async function loadMasteryTimelineState(): Promise<MasteryTimelineFile | null> {
  const api = getApi();
  if (!api) return null;
  try {
    const raw = await api.loadMasteryTimeline();
    if (raw && typeof raw === 'object') {
      return raw as MasteryTimelineFile;
    }
    return null;
  } catch (e) {
    console.warn('[user-state] load mastery timeline failed:', e);
    return null;
  }
}

/** 保存 mastery-timeline.json（周报） */
export async function saveMasteryTimelineState(file: MasteryTimelineFile): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveMasteryTimeline(file); } catch (e) { console.warn('[user-state] save mastery timeline failed:', e); }
}

export async function saveSettingsState(settings: VaultSettings): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveSettings(settings); } catch (e) { console.warn('[user-state] save settings failed:', e); }
}

export async function saveLlmState(settings: LlmSettings): Promise<void> {
  const api = getApi();
  if (!api) return;
  try { await api.saveLlm(settings); } catch (e) { console.warn('[user-state] save llm failed:', e); }
}

/**
 * 启动时从 user-state 文件灌入 localStorage 缓存。
 * 各文件若不存在（null）则保持 localStorage 现值（可能为空/默认）。
 */
export async function hydrateFromUserState(): Promise<void> {
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

  try {
    const settings = await api.loadSettings();
    if (settings && typeof settings === 'object') {
      localStorage.setItem('loginote_vault_settings_v1', JSON.stringify(settings));
    }
  } catch (e) { console.warn('[user-state] hydrate settings failed:', e); }

  try {
    const llm = await api.loadLlm();
    if (llm && typeof llm === 'object') {
      localStorage.setItem('loginote_llm_settings', JSON.stringify(llm));
    }
  } catch (e) { console.warn('[user-state] hydrate llm failed:', e); }

}
