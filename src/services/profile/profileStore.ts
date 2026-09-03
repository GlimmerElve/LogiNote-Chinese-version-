import { UserProfile } from '../../types';
import { loadProfileState, saveProfileState } from '../electronUserState';
import { getDefaultLearningAbility } from '../learningAbility/types';

/**
 * 用户画像唯一权威存储（A1 内存缓存 + user-state/profile.json 落盘）。
 * - 启动时 hydrateProfileFromUserState() 把 profile.json 读入内存缓存；
 * - getUserProfile() 同步返回内存缓存（供 buildProfilePrefix 等同步调用）；
 * - saveUserProfile() 先更新内存缓存，再异步 IPC 落盘；
 * - 概念别名词典 conceptAliasCache 与画像同步 hydrate / 落盘。
 */

const PROFILE_KEY = 'loginote_user_profile_v1';
const CONCEPT_ALIAS_KEY = 'loginote_concept_alias_map_v1';

let profileCache: UserProfile | null = null;
let conceptAliasCache: Record<string, string> = {};

/** 构造默认画像骨架（v2，无 summary；学习能力零值占位） */
export function getDefaultUserProfile(): UserProfile {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    analysisCount: 0,
    ability: {
      conceptClarity: 50,
      judgmentReasonableness: 50,
      reasoningValidity: 50,
      evidenceCount: 0,
      evidenceChars: 0,
    },
    cognitiveStyle: {
      abstractVsConcrete: 0,
      systematicVsScattered: 0,
      divergentVsConvergent: 0,
      cautiousVsDogmatic: 0,
      deepVsSurface: 0,
    },
    expressionStyle: {
      prefersExample: 0,
      prefersAnalogy: 0,
      prefersDefinition: 0,
      prefersDerivation: 0,
      conclusionFirst: 0,
      terminologyAccuracy: 50,
      selfCorrection: 50,
    },
    learningAbility: getDefaultLearningAbility(),
  };
}

/** 同步读取画像：优先内存缓存；未 hydrate 时回退 localStorage（兼容旧调用） */
export function getUserProfile(): UserProfile {
  if (profileCache) return profileCache;
  // 回退：尝试从 localStorage（旧数据）读，若无则默认骨架
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile> & { summary?: string };
      // 剔除旧 v1 数据残留的 summary 僵尸字段（新类型已移除该字段，无任何功能调用）
      const { summary: _omitSummary, ...cleanParsed } = parsed;
      profileCache = {
        ...getDefaultUserProfile(),
        ...cleanParsed,
        ability: { ...getDefaultUserProfile().ability, ...(cleanParsed.ability || {}) },
        cognitiveStyle: { ...getDefaultUserProfile().cognitiveStyle, ...(cleanParsed.cognitiveStyle || {}) },
        expressionStyle: { ...getDefaultUserProfile().expressionStyle, ...(cleanParsed.expressionStyle || {}) },
        learningAbility: { ...getDefaultUserProfile().learningAbility, ...(cleanParsed.learningAbility || {}) },
        version: 2,
      };
      return profileCache;
    }
  } catch {
    /* ignore */
  }
  profileCache = getDefaultUserProfile();
  return profileCache;
}

/** 保存画像：同步更新内存缓存 + 异步落盘 user-state/profile.json */
export function saveUserProfile(profile: UserProfile): void {
  profile.updatedAt = new Date().toISOString();
  profile.version = 2;
  profileCache = { ...profile };
  // 兼容保留 localStorage（旧链路读它），最终 P6 移除
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profileCache));
  } catch {
    /* ignore */
  }
  persistProfileToUserState();
}

/** 异步落盘：画像 + 概念别名一并写 profile.json */
function persistProfileToUserState(): void {
  try {
    const p = profileCache;
    if (p) saveProfileState(p, conceptAliasCache).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** 启动 hydrate：从 user-state/profile.json 读入内存缓存 */
export async function hydrateProfileFromUserState(): Promise<void> {
  const state = await loadProfileState();
  if (state && state.profile) {
    // 剔除旧 v1 数据残留的 summary 僵尸字段（新类型已移除该字段）
    const { summary: _omitSummary, ...cleanProfile } = state.profile as UserProfile & { summary?: string };
    profileCache = {
      ...getDefaultUserProfile(),
      ...cleanProfile,
      ability: { ...getDefaultUserProfile().ability, ...(cleanProfile.ability || {}) },
      cognitiveStyle: { ...getDefaultUserProfile().cognitiveStyle, ...(cleanProfile.cognitiveStyle || {}) },
      expressionStyle: { ...getDefaultUserProfile().expressionStyle, ...(cleanProfile.expressionStyle || {}) },
      learningAbility: { ...getDefaultUserProfile().learningAbility, ...(cleanProfile.learningAbility || {}) },
      version: 2,
    };
    // 同步 localStorage，兼容旧读取
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profileCache));
    } catch {
      /* ignore */
    }
  }
  if (state?.conceptAliasMap) {
    conceptAliasCache = { ...state.conceptAliasMap };
    try {
      localStorage.setItem(CONCEPT_ALIAS_KEY, JSON.stringify(conceptAliasCache));
    } catch {
      /* ignore */
    }
  }
}

/** 同步读取概念别名映射 */
export function getConceptAliasMap(): Record<string, string> {
  if (Object.keys(conceptAliasCache).length > 0) return conceptAliasCache;
  try {
    const raw = localStorage.getItem(CONCEPT_ALIAS_KEY);
    if (raw) {
      conceptAliasCache = JSON.parse(raw) as Record<string, string>;
      return conceptAliasCache;
    }
  } catch {
    /* ignore */
  }
  return conceptAliasCache;
}

/** 批量更新别名映射（增量覆盖） */
export function saveConceptAliasMap(map: Record<string, string>): void {
  conceptAliasCache = { ...map };
  try {
    localStorage.setItem(CONCEPT_ALIAS_KEY, JSON.stringify(conceptAliasCache));
  } catch {
    /* ignore */
  }
  persistProfileToUserState();
}

/** 把一组别名与 canonicalName 写入归并映射 */
export function registerConceptAliases(canonicalName: string, aliases: string[]): void {
  if (!canonicalName) return;
  const map = getConceptAliasMap();
  map[canonicalName] = canonicalName;
  for (const a of aliases) {
    if (a && a.trim()) map[a.trim()] = canonicalName;
  }
  saveConceptAliasMap(map);
}