import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NoteItem } from '../types';
import type { ProgressiveConcept, ProgressiveLessonPage } from '../services/progressiveLearning/types';
import { readSavedVaultNotesByIds, saveVaultNotesDelta } from './vaultNoteDelta';
import { withSavedVaultSnapshot } from './vaultSnapshot';
import { parseNoteMetadata } from '../services/noteMetadata';
import { generatedMathMarkdown } from '../services/textbook/generatedMath';
import { appendProjectKnowledgeRows, type ProgressiveKnowledgeChange, type ProjectKnowledgeRow } from '../services/progressiveLearning/knowledgeProjection';
import { readKnowledgeLifecycle } from './knowledgeLifecycle';
import { knowledgeDestination, knowledgeDisposition } from '../services/knowledgeLifecycle';

const normalized = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();

/** Conservative upgrade for stage-one pages: literal definition sections, never invented completion text. */
export function progressivePageConcepts(page: ProgressiveLessonPage): ProgressiveConcept[] {
  if (page.concepts !== undefined) return page.concepts;
  const lines = page.body.split('\n'), result: ProgressiveConcept[] = [];
  for (let i = 0; i < lines.length && result.length < 4; i++) {
    const title = lines[i].match(/^#{2,3}\s+(.{2,80})$/u)?.[1].trim();
    if (!title || !/定义|概念|法则|定理|机制|原则|必要条件/u.test(title) || /学习目标|目录|小结|复述|练习|观察问题/u.test(title)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && body.join('\n').length < 1200; j++) {
      if (/^#{1,6}\s/u.test(lines[j])) break;
      body.push(lines[j]);
    }
    const summary = body.join('\n').trim().slice(0, 1200);
    if (summary.length < 30 || /```|~~~|@@/u.test(summary)) continue;
    result.push({ key: normalized(title), title, summary });
  }
  return result;
}

/** Host-local materialization. Existing authored knowledge is reused unchanged; no mastery evidence is created. */
export async function materializeProgressiveKnowledge(vaultRoot: string, userStateDir: string,
  projectNoteId: string, courseId: string, concepts: ProgressiveConcept[], isCurrent: () => boolean,
  committed?: (notes: NoteItem[], change?: ProgressiveKnowledgeChange) => void): Promise<string[]> {
  if (!concepts.length) return [];
  const directory = await withSavedVaultSnapshot(vaultRoot, userStateDir, async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'));
    if (metadata?.version !== 1 || !metadata.notesMeta || !Object.hasOwn(metadata.notesMeta, projectNoteId)) throw Error('知识点关联项目已移除');
    return metadata.notesMeta as Record<string, NoteItem>;
  }, isCurrent);
  const created: NoteItem[] = [], ids: string[] = [], rows: ProjectKnowledgeRow[] = [], now = new Date().toISOString();
  const lifecycle = await readKnowledgeLifecycle(userStateDir);
  for (const concept of concepts) {
    const key = normalized(concept.title);
    const candidates = Object.entries(directory).filter(([, note]) => note.noteType === 'knowledge'
      && [note.title, ...(note.aliases || [])].some(title => normalized(title) === key));
    if (candidates.length === 1) { ids.push(candidates[0][0]); rows.push({ title: candidates[0][1].title, summary: concept.summary }); continue; }
    const id = `pk-${createHash('sha256').update(`${courseId}\n${concept.key}`).digest('hex').slice(0, 32)}`;
    const disposition = knowledgeDisposition(lifecycle, id, concept.title);
    if (disposition) {
      const destination = knowledgeDestination(lifecycle, disposition.id);
      if (destination && directory[destination]?.noteType === 'knowledge') ids.push(destination);
      // Old page recovery must not recreate a deleted object or rewrite its
      // project's original Wiki rows after an explicit maintenance operation.
      continue;
    }
    // A prior create can have succeeded before a job checkpoint. Never overwrite subsequent edits.
    if (Object.hasOwn(directory, id)) { ids.push(id); rows.push({ title: directory[id].title, summary: concept.summary }); continue; }
    let title = concept.title;
    if (Object.values(directory).some(note => [note.title, ...(note.aliases || [])].some(name => normalized(name) === normalized(title)))) {
      title = `${concept.title} · ${directory[projectNoteId].title.slice(0, 40)}`;
      if (Object.values(directory).some(note => normalized(note.title) === normalized(title))) title += ` · ${id.slice(-6)}`;
    }
    const note: NoteItem = { id, title, noteType: 'knowledge', parentId: projectNoteId,
      content: `# ${title}\n\n${generatedMathMarkdown(concept.summary)}\n`, tags: [], links: [], backlinks: [], dueDates: [], createdAt: now, updatedAt: now };
    directory[id] = note; created.push(note); ids.push(id); rows.push({ title, summary: concept.summary });
  }
  const [project] = await readSavedVaultNotesByIds(vaultRoot, userStateDir, [projectNoteId], { isCurrent });
  if (!project || project.noteType !== 'project') throw Error('知识点关联项目已移除');
  const content = appendProjectKnowledgeRows(project.content, rows);
  const links = parseNoteMetadata({ ...project, content }).links;
  const projected = content === project.content && JSON.stringify(links) === JSON.stringify(project.links) ? project : { ...project, content, links, updatedAt: now };
  if (created.length || projected !== project) {
    await saveVaultNotesDelta(vaultRoot, userStateDir, { upserts: [...created.map(note => ({ note, before: null as NoteItem | null })),
      ...(projected !== project ? [{ note: projected, before: project }] : [])], removed: [] }, {
      isCurrent,
      guardMetadata: async metadata => {
        const latestLifecycle = await readKnowledgeLifecycle(userStateDir);
        if (created.some(note => knowledgeDisposition(latestLifecycle, note.id, note.title))) throw Error('知识点已删除或合并，旧后台任务未重新创建');
        if (metadata.notesMeta[projectNoteId]?.noteType !== 'project') throw Error('知识点关联项目已移除');
        for (const note of created) if (Object.entries(metadata.notesMeta).some(([id, current]) => id !== note.id
          && [current.title, ...(current.aliases || [])].some(title => normalized(title) === normalized(note.title)))) {
          throw Error('已有同名或别名知识点，请重试以复用新对象');
        }
      },
    });
    // Read only involved IDs, including derived backlinks; never reload the vault bodies.
    const saved = await readSavedVaultNotesByIds(vaultRoot, userStateDir, [...new Set([...ids, projectNoteId])], { isCurrent });
    const savedProject = saved.find(note => note.id === projectNoteId)!;
    const createdIds = new Set(created.map(note => note.id));
    committed?.(saved.filter(note => createdIds.has(note.id)), { before: project, note: savedProject, rows,
      knowledgeBacklinks: saved.filter(note => note.id !== projectNoteId).map(note => ({ id: note.id, backlinks: note.backlinks })) });
  }
  return [...new Set(ids)];
}
