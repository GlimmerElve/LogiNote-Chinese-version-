import type { NoteItem } from '../../types';
import { isLearningProject } from '../projectRole';
import type { AgentRuntimeContext } from '../agent/types';
import { extractProjectTasks } from '../agent/resourceDraftService';
import { extractWikiTargets } from '../planAdjustmentService';
import { searchCurrentPersonalCognition } from '../cognition/store';
import type { CognitionRetrieval } from '../cognition/retrieval';
import { loadLearningEpisodes } from '../memory/episodeStore';
import { deriveResourcePreferenceSignals, getResourceStateSnapshot } from '../resourceState';
import { projectPlanningContent } from './noteContent.ts';
import { textbookRoot } from './fingerprint.ts';
import type { TextbookContext } from './generationTypes';
type ContextApi = { queryProfile(input: { includeEvidence: boolean }): Promise<{ text: string }>;
  queryMastery(input: { noteTitles: string[] }): Promise<{ rows: unknown[] }>; reviewQueue(): Promise<{ items: unknown[] }> };
function contextApi(): ContextApi | undefined { return typeof window === 'undefined' ? undefined
  : (window as unknown as { electronAPI?: { agent?: ContextApi } }).electronAPI?.agent; }

export function textbookProject(ctx: AgentRuntimeContext, id?: string): NoteItem {
  const note = id ? ctx.getNotes().find((item) => item.id === id) : ctx.getActiveNote?.();
  if (!isLearningProject(note)) throw new Error('请选中学习项目，资料型项目不生成受管教材');
  return note;
}
export function textbookKnowledge(project: NoteItem, notes: NoteItem[]): NoteItem[] {
  const titles = new Set(extractWikiTargets(projectPlanningContent(project.content, project.textbook), notes));
  return notes.filter((note) => note.noteType === 'knowledge' && (titles.has(note.title) || note.aliases?.some((alias) => titles.has(alias))));
}
export function rootLearningNotes(project: NoteItem, notes: NoteItem[]): NoteItem[] {
  const root = textbookRoot(project, notes);
  return notes.filter((note) => {
    if (!isLearningProject(note)) return false;
    try { return textbookRoot(note, notes).id === root.id; } catch { return false; }
  });
}
export async function buildTextbookContext(ctx: AgentRuntimeContext, projectId: string): Promise<TextbookContext> {
  const notes = ctx.getNotes(); const project = textbookProject(ctx, projectId); const root = textbookRoot(project, notes);
  const knowledge = textbookKnowledge(project, notes); const scope = rootLearningNotes(project, notes); const scopeIds = new Set(scope.map((note) => note.id));
  const warnings: string[] = [];
  const api = contextApi();
  const profile = api ? await api.queryProfile({ includeEvidence: false }).catch(() => { warnings.push('画像读取失败，采用中性教学设计'); return { text: '可信画像不可用，不推断能力或风格。' }; })
    : { text: '画像接口不可用；采用中性讲解，不推断能力或偏好。' };
  const mastery = api && knowledge.length ? await api.queryMastery({ noteTitles: knowledge.map((note) => note.title) }).catch(() => { warnings.push('掌握度不可读，不能推断已掌握或薄弱'); return { rows: [] }; }) : { rows: [] };
  const query = knowledge.map((note) => note.title).join(' ') || project.title;
  const cognition: CognitionRetrieval = await searchCurrentPersonalCognition(query).catch(() => ({ status: 'unavailable', method: 'local-lexical-v1', items: [], materials: [], warning: '认知读取失败，不据此推断认知遗漏或错误。' }));
  if (cognition.status !== 'ready') warnings.push('认知库不可用，不等于没有认知记录');
  warnings.push(cognition.warning);
  const personal: TextbookContext['personal'] = cognition.items.slice(0, 4).map((item, index) => ({ evidenceId: `C${index + 1}`, kind: 'confirmed_view', text: item.text,
    reference: { recordId: item.recordId, revisionId: item.revisionId, branchId: item.branchId, nodeId: item.nodeId, stance: item.stance, needsReview: item.needsReview, context: item.context }, usableAsFactEvidence: false }));
  personal.push(...(cognition.materials || []).filter((item) => scopeIds.has(item.noteId)).slice(0, 3).map((item, index): TextbookContext['personal'][number] => ({
    evidenceId: `M${index + 1}`, kind: 'unconfirmed_material', text: item.text, reference: { noteId: item.noteId, passageId: item.passageId, sourceKind: item.sourceKind }, usableAsFactEvidence: false })));
  const episodes = (await loadLearningEpisodes().catch(() => { warnings.push('学习记录不可读，不编造上次学习经历'); return []; })).filter((episode) => episode.status === 'completed'
    && ['flow', 'review', 'scene'].includes(episode.type) && Number.isFinite(Date.parse(episode.endedAt))
    && Date.parse(episode.endedAt) <= Date.now()
    && (episode.rootProjectId ? episode.rootProjectId === root.id : !!episode.noteId && scopeIds.has(episode.noteId)))
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  const previous = episodes[0];
  // Edited user restatements remain an independent, explicitly unconfirmed channel.
  const record = scope.flatMap((note) => note.learningReviewRecords || []).filter((item) => item.status === 'completed'
    && item.rootProjectId === root.id && scopeIds.has(item.projectNoteId) && Number.isFinite(Date.parse(item.endedAt)) && Date.parse(item.endedAt) <= Date.now())
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];
  if (record?.editedRestatement.trim()) personal.push({ evidenceId: 'R1', kind: 'learning_record', text: record.editedRestatement.slice(0, 1800),
    reference: { id: record.id, projectNoteId: record.projectNoteId, endedAt: record.endedAt }, usableAsFactEvidence: false });
  const state = getResourceStateSnapshot();
  return { project: { id: project.id, rootId: root.id, title: project.title, rootTitle: root.title,
    tasks: extractProjectTasks(project.content, project.textbook), knowledgeTitles: knowledge.map((note) => note.title) },
    profile: profile.text, mastery, preferences: deriveResourcePreferenceSignals(Object.values(state.discoveryPreferences).filter((item) => scopeIds.has(item.noteId)),
      Object.values(state.feedback).filter((item) => scopeIds.has(item.noteId))), personal,
    previousLearning: previous ? { id: previous.id, title: previous.title, endedAt: previous.endedAt, summary: previous.summary || '', unresolvedQuestions: previous.unresolvedQuestions || [] } : undefined,
    warnings: warnings.filter(Boolean) };
}
/** Review stays in conversation and existing review entry, never in textbook chapters. */
export async function textbookReviewRecommendation(ctx: AgentRuntimeContext, project: NoteItem): Promise<unknown> {
  const scope = rootLearningNotes(project, ctx.getNotes());
  const titles = new Set(scope.flatMap((note) => textbookKnowledge(note, ctx.getNotes()).map((item) => item.title)));
  const queue = await contextApi()?.reviewQueue();
  return { items: (queue?.items || []).filter((item) => titles.has(String((item as { title?: string }).title || ''))).slice(0, 4),
    message: '仅推荐先在现有复习入口查漏补缺；用户可跳过。教材生成需要单独确认，不自动进入复习。' };
}
