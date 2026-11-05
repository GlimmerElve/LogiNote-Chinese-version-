/**
 * 场景知识点推导（纯函数，无外部依赖，便于自检）。
 *
 * 规则：给定一个项目笔记 id，收集其项目子树通过 [[wiki]] 显式关联的全局知识点；
 * 同时兼容旧版直接用 parentId 挂在项目子树下的知识点。
 *
 * 设计说明：原实现内联在 SceneBuilderPanel 组件中，抽出以便：
 * 1. UI 组件不承担数据推导职责；
 * 2. 递归逻辑可被独立断言（层级 > 2 的深层知识点不得遗漏）。
 */

import type { NoteItem, SceneSpec } from '../../types';
import { collectProjectKnowledgeNotes } from '../knowledgePointSelector';
import { hasSubstantiveReferenceText, referenceNoteContent } from '../ragSourcePolicy';
import { resolveSceneRuntimeContract } from './sceneRuntimeContract';

/**
 * 递归收集某项目子树内所有知识类笔记的标题。
 *
 * @param projectId 项目笔记 id（其自身标题不参与，仅取其子孙）
 * @param allNotes  全量笔记
 * @returns 去重后的知识点标题数组
 */
export function collectKnowledgePoints(projectId: string, allNotes: NoteItem[]): string[] {
  return collectProjectKnowledgeNotes(projectId, allNotes).map((note) => note.title);
}

/** Inspect already-loaded note metadata locally; never send all note bodies to the builder. */
export function getSceneProjectMaterials(projectId: string | undefined, allNotes: NoteItem[]) {
  if (!projectId) return undefined;
  const project = allNotes.find(note => note.id === projectId && note.noteType === 'project');
  if (!project) throw new Error('所选场景项目不存在，请重新选择项目。');
  const candidates = collectProjectKnowledgeNotes(projectId, allNotes);
  const usable = candidates.filter(note => hasSubstantiveReferenceText(referenceNoteContent(note)));
  return {
    scope: { projectId, noteIds: usable.map(note => note.id), documentIds: [] as string[] },
    summary: { candidateCount: candidates.length, usableCount: usable.length, emptyCount: candidates.length - usable.length },
  };
}

export function bindSceneProjectMaterials(scene: SceneSpec, materials: ReturnType<typeof getSceneProjectMaterials>): SceneSpec {
  if (!materials) return scene;
  const scoped = { ...scene, referenceScope: materials.scope };
  if (scene.meta.sceneSkill === 'S4') return scoped;
  // Project selection is an outer ceiling, not permission to widen an accepted narrower whitelist.
  const contract = resolveSceneRuntimeContract(scoped);
  return { ...scoped, runtimeContract: contract };
}
