/**
 * 角色模板库读写（vault/scene-skills/roles.json，全局共享）。
 *
 * 与场景库独立：角色模板是跨场景复用的「角色快照」，不绑定任何 SceneSpec。
 * 载入模板时由 UI 层整体替换当前角色（替换前二次确认），本模块只负责存取。
 *
 * 与 sceneSkillStore 保持同构：API 守卫 + 异常兜底返回空骨架，不抛错。
 */

import { RoleAttribute, RoleTemplate, RoleTemplateFile } from '../../types';

/** 角色模板 IPC 接口形态（与 preload.ts 暴露的 sceneSkills 一致） */
interface RolesApi {
  loadRoles(): Promise<unknown>;
  saveRoles(file: unknown): Promise<void>;
}

/** API 守卫：非 Electron 或 preload 未就绪时返回 undefined */
function getRolesApi(): RolesApi | undefined {
  return (window as unknown as { electronAPI?: { sceneSkills?: RolesApi } }).electronAPI?.sceneSkills;
}

/** 生成唯一模板 id（时间戳 + 随机后缀） */
export function generateRoleTemplateId(): string {
  return `role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 空模板库骨架（文件缺失/损坏时使用） */
export function emptyRoleTemplateFile(): RoleTemplateFile {
  return { version: '1.0', updatedAt: new Date().toISOString(), roles: [] };
}

/** 归一化单条模板：补齐缺失字段，避免 UI 因 undefined 崩溃 */
function normalizeTemplate(raw: unknown): RoleTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<RoleTemplate>;
  if (!t.id || typeof t.id !== 'string') return null;
  return {
    id: t.id,
    name: t.name || '未命名模板',
    attributes: Array.isArray(t.attributes)
      ? t.attributes.filter((a): a is RoleAttribute => !!a && typeof a.key === 'string')
      : [],
    createdAt: t.createdAt || new Date().toISOString(),
    useCount: typeof t.useCount === 'number' ? t.useCount : 0,
  };
}

/** 读取模板库；API 不可用或异常时返回空骨架（不抛错） */
export async function loadRoleTemplateFile(): Promise<RoleTemplateFile> {
  const api = getRolesApi();
  if (!api || typeof api.loadRoles !== 'function') return emptyRoleTemplateFile();
  try {
    const raw = await api.loadRoles();
    const f = raw as Partial<RoleTemplateFile> | null;
    if (!f || !Array.isArray(f.roles)) return emptyRoleTemplateFile();
    const roles = f.roles.map(normalizeTemplate).filter((t): t is RoleTemplate => t !== null);
    return {
      version: f.version || '1.0',
      updatedAt: f.updatedAt || new Date().toISOString(),
      roles,
    };
  } catch {
    return emptyRoleTemplateFile();
  }
}

/** 列出模板（按使用次数降序，其次按创建时间降序） */
export async function loadRoleTemplates(): Promise<RoleTemplate[]> {
  const file = await loadRoleTemplateFile();
  return [...file.roles].sort((a, b) => {
    if (b.useCount !== a.useCount) return b.useCount - a.useCount;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

/** 覆盖写入模板库（自动刷新 updatedAt） */
async function saveRoleTemplateFile(file: RoleTemplateFile): Promise<void> {
  const api = getRolesApi();
  if (!api || typeof api.saveRoles !== 'function') return;
  const next: RoleTemplateFile = { ...file, updatedAt: new Date().toISOString() };
  await api.saveRoles(next);
}

/**
 * 保存模板（upsert）：
 * - 传入 `id` 且已存在 → 覆盖 name/attributes，保留原 useCount 与 createdAt
 * - 未传 `id` 或 id 不存在 → 新增，useCount 归零
 * 返回最终落盘的模板（调用方据此更新本地列表）。
 */
export async function saveRoleTemplate(input: {
  id?: string;
  name: string;
  attributes: RoleAttribute[];
}): Promise<RoleTemplate> {
  const file = await loadRoleTemplateFile();
  const idx = input.id ? file.roles.findIndex((t) => t.id === input.id) : -1;

  const template: RoleTemplate =
    idx >= 0
      ? {
          ...file.roles[idx],
          name: input.name || file.roles[idx].name,
          attributes: input.attributes,
        }
      : {
          id: input.id || generateRoleTemplateId(),
          name: input.name || '未命名模板',
          attributes: input.attributes,
          createdAt: new Date().toISOString(),
          useCount: 0,
        };

  if (idx >= 0) file.roles[idx] = template;
  else file.roles.push(template);

  await saveRoleTemplateFile(file);
  return template;
}

/** 删除模板 */
export async function deleteRoleTemplate(id: string): Promise<void> {
  if (!id) return;
  const file = await loadRoleTemplateFile();
  const next = file.roles.filter((t) => t.id !== id);
  if (next.length === file.roles.length) return;
  await saveRoleTemplateFile({ ...file, roles: next });
}

/** 使用计数 +1（模板被载入时调用，用于排序） */
export async function bumpRoleUseCount(id: string): Promise<void> {
  if (!id) return;
  const file = await loadRoleTemplateFile();
  const idx = file.roles.findIndex((t) => t.id === id);
  if (idx < 0) return;
  file.roles[idx] = { ...file.roles[idx], useCount: (file.roles[idx].useCount || 0) + 1 };
  await saveRoleTemplateFile(file);
}