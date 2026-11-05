/**
 * 场景 Skill 包读写（vault/scene-skills/）。
 *
 * 存储约定：
 * - manifest.json           索引清单（SceneManifestEntry[]，含 architecture 摘要）
 * - scenes/{sceneId}.json   完整 SceneSpec
 *
 * 写入顺序（防悬空引用）：先写 scenes/{id}.json，再 upsert manifest。
 * 路径穿越防护与目录自动创建在主进程 IPC 层完成（safeSceneId / ensureSceneSkillsDir）。
 */

import {
  SceneSpec,
  SceneSkillManifest,
  SceneManifestEntry,
  DialogueParadigm,
  SceneCapabilityId,
  ScenePromptModuleId,
  SCENE_SKILLS_DIR_NAME,
} from '../../types';
import { parseBehaviorSpec } from './sceneParadigm';
import { normalizeSceneInteractionProtocol } from './sceneInteraction';
import { isSceneRecipeCompatible, normalizeSceneCapabilityId, normalizeScenePromptModuleId, normalizeUnifiedSceneRecipeId } from './sceneCapabilityRegistry';
import { normalizeScenePresentation } from './scenePresentation';

/** 场景包 IPC 接口形态（与 preload.ts 暴露的 sceneSkills 一致） */
interface SceneSkillsApi {
  getDir(): Promise<string>;
  loadManifest(): Promise<unknown>;
  saveManifest(manifest: unknown): Promise<void>;
  loadScene(sceneId: string): Promise<unknown | null>;
  saveScene(sceneId: string, spec: unknown): Promise<void>;
  deleteScene(sceneId: string): Promise<void>;
}

/** 场景包 API 守卫：非 Electron 或 preload 未就绪时返回 undefined */
function getSceneApi(): SceneSkillsApi | undefined {
  return (window as unknown as { electronAPI?: { sceneSkills?: SceneSkillsApi } }).electronAPI?.sceneSkills;
}

/** 交互范式的「人话描述」，用于 manifest 的 architecture.paradigmLabel */
const PARADIGM_LABELS: Record<DialogueParadigm, string> = {
  'single-role-dialogue': '单角色对话 · 用户与 NPC 流式交互',
  'multi-role-independent-memory': '多角色独立记忆 · 用户交互对话',
  'multi-role-event-response': '多角色 · 用户指定事件查看角色应对',
};

/** 生成唯一 sceneId（时间戳 + 随机后缀；仅含字母数字与连字符，满足 IPC 安全校验） */
export function generateSceneId(): string {
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 空清单骨架（manifest 缺失/损坏时使用） */
export function emptyManifest(): SceneSkillManifest {
  return { version: '1.0', updatedAt: new Date().toISOString(), scenes: [] };
}

/** 把 SceneSpec 压缩为 manifest 索引条目（体现架构核心，供 LLM 判断可复用性） */
export function toManifestEntry(spec: SceneSpec, reuseCount = 0): SceneManifestEntry {
  const cfg = spec.engineConfig;
  const isS2Canvas = spec.meta?.sceneSkill === 'S2' && spec.canvasWorkspace?.version === 1;
  return {
    sceneId: spec.sceneId,
    name: spec.meta?.name || '未命名场景',
    subject: spec.meta?.subject || '',
    sceneSkill: spec.meta?.sceneSkill || 'S1',
    knowledgePoints: spec.meta?.knowledgePoints || [],
    goal: spec.meta?.goal || '',
    architecture: {
      paradigmLabel: isS2Canvas ? 'S2 通用画布 · 试验' : PARADIGM_LABELS[cfg?.paradigm] || PARADIGM_LABELS['single-role-dialogue'],
      behaviorKind: spec.behavior?.kind,
      recipeId: spec.capabilityRecipeId || spec.behavior?.recipeId,
      capabilityIds: spec.capabilityIds,
      promptModuleIds: spec.promptModuleIds,
      interactionTypes: isS2Canvas ? [] : spec.behavior
        ? normalizeSceneInteractionProtocol(spec.behavior.interaction).allowedTypes
        : ['text'],
      technologies: cfg?.technologies || [],
      engines: cfg?.engines || [],
      hasEvents: Array.isArray(spec.events) && spec.events.length > 0,
      eventInjection: spec.eventInjection !== false,
      injectProfile: spec.injectProfile === true,
    },
    createdAt: spec.createdAt || new Date().toISOString(),
    reuseCount,
  };
}

/**
 * 归一化从磁盘读到的 SceneSpec：补齐缺失的数组/对象字段，避免 UI 因 undefined 崩溃。
 * 不做业务校验（如 mode 降级由 sceneGenerator.parseSceneSpec 负责）。
 */
export function normalizeSceneSpec(raw: unknown): SceneSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<SceneSpec>;
  if (!value.sceneId || typeof value.sceneId !== 'string') return null;
  const s = normalizeScenePresentation(value);
  const sceneSkill = s.meta?.sceneSkill || 'S1';
  const rawRecipeId = normalizeUnifiedSceneRecipeId(s.capabilityRecipeId || s.behavior?.recipeId);
  const capabilityRecipeId = rawRecipeId && isSceneRecipeCompatible(rawRecipeId, sceneSkill)
    ? rawRecipeId
    : sceneSkill === 'S4' ? 'guided-derivation' : undefined;
  return {
    ...(s as SceneSpec),
    meta: {
      name: s.meta?.name || '未命名场景',
      subject: s.meta?.subject || '',
      sceneSkill,
      knowledgePoints: s.meta?.knowledgePoints || [],
      goal: s.meta?.goal || '',
    },
    capabilityRecipeId,
    capabilityIds: Array.isArray(s.capabilityIds)
      ? [...new Set(s.capabilityIds.map(normalizeSceneCapabilityId).filter((id): id is SceneCapabilityId => Boolean(id)))]
      : undefined,
    promptModuleIds: Array.isArray(s.promptModuleIds)
      ? [...new Set(s.promptModuleIds.map(normalizeScenePromptModuleId).filter((id): id is ScenePromptModuleId => Boolean(id)))]
      : undefined,
    role: s.role || { id: 'role-1', name: 'NPC', attributes: [] },
    userRole: s.userRole || '',
    openingNarrative: s.openingNarrative || '',
    situation: s.situation || '',
    task: s.task || '',
    resources: s.resources || [],
    rules: s.rules || [],
    metrics: s.metrics || [],
    evaluationDimensions: s.evaluationDimensions || [],
    events: s.events || [],
    engineConfig: {
      paradigm: s.engineConfig?.paradigm || 'single-role-dialogue',
      roleMemory: s.engineConfig?.roleMemory !== false,
      technologies: s.engineConfig?.technologies || [],
      engines: s.engineConfig?.engines || [],
    },
    completion: {
      mode: s.completion?.mode === 'signal' ? 'signal' : 'metric',
      successExpression: s.completion?.successExpression || '',
      failureExpression: s.completion?.failureExpression,
      maxTurns: typeof s.completion?.maxTurns === 'number' ? s.completion.maxTurns : 12,
    },
    eventInjection: s.eventInjection !== false,
    injectProfile: s.injectProfile === true,
    behavior: parseBehaviorSpec(s.behavior),
    origin: s.origin === 'adapted' ? 'adapted' : 'new',
    version: s.version || '1.0',
    createdAt: s.createdAt || new Date().toISOString(),
    updatedAt: s.updatedAt || new Date().toISOString(),
  };
}

/** Generation tolerates a missing library; interactive pickers must distinguish read failure from empty. */
export async function loadManifest(options: { strict?: boolean } = {}): Promise<SceneSkillManifest> {
  const api = getSceneApi();
  if (!api) {
    if (options.strict) throw new Error('场景库需要桌面环境，请在桌面应用中读取。');
    return emptyManifest();
  }
  try {
    const raw = await api.loadManifest();
    const m = raw as Partial<SceneSkillManifest> | null;
    if (!m || !Array.isArray(m.scenes)) {
      if (options.strict) throw new Error('场景库索引无法读取，请重试或检查数据目录。');
      return emptyManifest();
    }
    return {
      version: m.version || '1.0',
      updatedAt: m.updatedAt || new Date().toISOString(),
      scenes: m.scenes.filter((e) => e && typeof e.sceneId === 'string'),
    };
  } catch (error) {
    if (options.strict) throw error;
    return emptyManifest();
  }
}

/** 覆盖写入 manifest（自动刷新 updatedAt） */
export async function saveManifest(manifest: SceneSkillManifest): Promise<void> {
  const api = getSceneApi();
  if (!api) return;
  const next: SceneSkillManifest = { ...manifest, updatedAt: new Date().toISOString() };
  await api.saveManifest(next);
}

/** 列出场景索引（按复用次数降序，其次按创建时间降序） */
export async function listScenes(options: { strict?: boolean } = {}): Promise<SceneManifestEntry[]> {
  const m = await loadManifest(options);
  return [...m.scenes].sort((a, b) => {
    if (b.reuseCount !== a.reuseCount) return b.reuseCount - a.reuseCount;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

/** 读取单个场景完整定义；不存在或异常时返回 null */
export async function loadScene(sceneId: string): Promise<SceneSpec | null> {
  const api = getSceneApi();
  if (!api || !sceneId) return null;
  try {
    const raw = await api.loadScene(sceneId);
    return normalizeSceneSpec(raw);
  } catch {
    return null;
  }
}

/** upsert 一条 manifest 条目（同 sceneId 覆盖，保留原 reuseCount） */
export async function upsertManifestEntry(spec: SceneSpec): Promise<void> {
  const manifest = await loadManifest({ strict: true });
  const idx = manifest.scenes.findIndex((e) => e.sceneId === spec.sceneId);
  const entry = toManifestEntry(spec, idx >= 0 ? manifest.scenes[idx].reuseCount : 0);
  if (idx >= 0) manifest.scenes[idx] = entry;
  else manifest.scenes.push(entry);
  await saveManifest(manifest);
}

/**
 * 保存场景：先写 scenes/{id}.json，再 upsert manifest（防悬空引用）。
 * 返回补齐了时间戳的最终 spec（调用方据此更新本地状态）。
 */
export async function saveScene(spec: SceneSpec): Promise<SceneSpec> {
  const api = getSceneApi();
  const now = new Date().toISOString();
  const finalSpec: SceneSpec = {
    ...spec,
    sceneId: spec.sceneId || generateSceneId(),
    createdAt: spec.createdAt || now,
    updatedAt: now,
  };
  if (!api) return finalSpec;
  // Do not start writing a new scene when the existing index is unreadable.
  await loadManifest({ strict: true });
  // 顺序不可颠倒：场景文件先落盘，manifest 再引用它
  await api.saveScene(finalSpec.sceneId, finalSpec);
  await upsertManifestEntry(finalSpec);
  return finalSpec;
}

/** 删除场景：删除场景文件后从 manifest 移除 */
export async function deleteScene(sceneId: string, options: { strict?: boolean } = {}): Promise<void> {
  const api = getSceneApi();
  if (!api || !sceneId) {
    if (options.strict) throw new Error('场景库暂不可用，未删除场景。');
    return;
  }
  // A failed index read must never be interpreted as an empty index after deleting a file.
  const manifest = await loadManifest(options);
  await api.deleteScene(sceneId);
  const next = manifest.scenes.filter((e) => e.sceneId !== sceneId);
  if (next.length !== manifest.scenes.length) {
    await saveManifest({ ...manifest, scenes: next });
  }
}

/** 复用计数 +1（场景被成功改编为新场景时调用，用于检索排序） */
export async function bumpReuseCount(sceneId: string): Promise<void> {
  if (!sceneId) return;
  const manifest = await loadManifest({ strict: true });
  const idx = manifest.scenes.findIndex((e) => e.sceneId === sceneId);
  if (idx < 0) return;
  manifest.scenes[idx] = {
    ...manifest.scenes[idx],
    reuseCount: (manifest.scenes[idx].reuseCount || 0) + 1,
  };
  await saveManifest(manifest);
}

/** 返回场景包目录（便于设置页展示/备份入口） */
export async function getSceneSkillsDir(): Promise<string | null> {
  const api = getSceneApi();
  if (!api) return null;
  try {
    return await api.getDir();
  } catch {
    return null;
  }
}

/** 场景包在 vault 下的子目录名（对外暴露，供提示文案使用） */
export { SCENE_SKILLS_DIR_NAME };
