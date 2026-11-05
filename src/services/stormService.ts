/**
 * STORM 学习法（第一步·拓宽视野）流水线编排。
 * 四步：多视角扫描 → 矛盾图谱 → 综合简报 → 同行评审。
 * 多视角分析后额外做一次内部摘要（不落盘），压缩长文本供矛盾图谱使用。
 */

import { NoteItem, LlmWorkflowId } from '../types';
import { callLLM } from './llmService';
import { rememberGeneratedContent } from './ragSourcePolicy';
import { collectStormResearch, stormResearchContext, stormSourceAppendix, checkStormCitations, type StormResearchBundle } from './stormResearch';

/** STORM 四步标识 */
export type StormStep = 'multi-perspective' | 'contradiction' | 'brief' | 'peer-review';

/** 流水线进度状态 */
export interface StormPipelineStatus {
  current: StormStep;
  state: 'running' | 'done' | 'error';
  error?: string;
  detail?: string;
}

/** 四步的元信息（标题 / workflow id / 展示标签） */
const STORM_STEPS: Array<{ key: StormStep; title: string; workflow: LlmWorkflowId }> = [
  { key: 'multi-perspective', title: '多视角分析', workflow: 'storm-multi-perspective' },
  { key: 'contradiction', title: '矛盾图谱', workflow: 'storm-contradiction' },
  { key: 'brief', title: '综合简报', workflow: 'storm-brief' },
  { key: 'peer-review', title: '同行评审', workflow: 'storm-peer-review' },
];

export { STORM_STEPS };

/** 生成一个 project 笔记的基础结构 */
function makeProjectNote(id: string, title: string, parentId: string | undefined): NoteItem {
  return {
    id,
    title,
    noteType: 'project',
    parentId,
    content: '',
    tags: ['学习计划'],
    links: [],
    backlinks: [],
    dueDates: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 基于父项目构建 STORM 报告笔记树。
 * 返回 [STORM报告, 多视角分析, 矛盾图谱, 综合简报, 同行评审] 5 个笔记（顺序稳定）。
 */
export function buildStormNoteTree(parentProject: NoteItem): NoteItem[] {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stormReport = makeProjectNote(`note-${ts}-storm-report`, 'STORM报告', parentProject.id);
  const perspective = makeProjectNote(`note-${ts}-storm-perspective`, '多视角分析', stormReport.id);
  const contradiction = makeProjectNote(`note-${ts}-storm-contradiction`, '矛盾图谱', stormReport.id);
  const brief = makeProjectNote(`note-${ts}-storm-brief`, '综合简报', stormReport.id);
  const peerReview = makeProjectNote(`note-${ts}-storm-peer-review`, '同行评审', stormReport.id);
  return [stormReport, perspective, contradiction, brief, peerReview];
}

/** 新建根项目笔记（供 StormMode 用） */
export function makeRootProjectNote(title: string): NoteItem {
  return makeProjectNote(`note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-storm-root`, title, undefined);
}

export interface StormPipelineSession {
  subject: string;
  parentProject: NoteItem;
  createRoot: boolean;
  tree: NoteItem[];
  persistedIds: Set<string>;
  completedSteps: Set<StormStep>;
  outputs: Partial<Record<StormStep, string>>;
  abstractContent?: string;
  webResearch?: StormResearchBundle;
}

/** A retry keeps the same report identity and completed output; nothing is written here. */
export function createStormPipelineSession(parentProject: NoteItem, subject: string, createRoot = false): StormPipelineSession {
  return { parentProject, subject, createRoot, tree: buildStormNoteTree(parentProject),
    persistedIds: new Set(), completedSteps: new Set(), outputs: {} };
}

interface RunStormPipelineOpts {
  subject: string;
  parentProject: NoteItem;
  session?: StormPipelineSession;
  signal?: AbortSignal;
  onUpdateNote: (note: NoteItem, signal?: AbortSignal, expected?: NoteItem | null) => void | Promise<void>;
  onProgress: (status: StormPipelineStatus) => void;
}

/**
 * 一键执行 STORM 四步流水线。
 * 1) 联网取证；2) 创建 5 个空笔记占位；3) 带同一证据包逐步分析并写回。
 * 任一步失败抛出，已生成的笔记保留。
 */
export async function runStormPipeline(opts: RunStormPipelineOpts): Promise<NoteItem[]> {
  const { signal, onUpdateNote, onProgress } = opts;
  const session = opts.session || createStormPipelineSession(opts.parentProject, opts.subject);
  if (session.parentProject.id !== opts.parentProject.id || session.subject !== opts.subject) throw new Error('研究续作对象不一致，请重新选择');
  const ensureActive = () => { if (signal?.aborted) throw new DOMException('研究已停止', 'AbortError'); };
  const persist = async (note: NoteItem, expected: NoteItem | null) => { ensureActive(); await onUpdateNote(note, signal, expected); ensureActive(); };
  if (!session.webResearch) {
    onProgress({ current: 'multi-perspective', state: 'running', detail: '正在联网搜索近期资讯、研究论文与反向证据…' });
    try {
      const research = await collectStormResearch(session.subject, signal);
      ensureActive(); session.webResearch = research;
    } catch (error) {
      ensureActive();
      onProgress({ current: 'multi-perspective', state: 'error', error: error instanceof Error ? error.message : '联网取证失败' });
      throw error;
    }
  }
  const researchContext = stormResearchContext(session.webResearch);
  const appendix = stormSourceAppendix(session.webResearch);
  const report = session.tree[0];
  const initialNotes = [...(session.createRoot ? [session.parentProject] : []), ...session.tree];
  // Keep initialization separate from outputs so a failed save cannot create a second tree.
  for (const note of initialNotes) {
    if (session.persistedIds.has(note.id)) continue;
    await persist(note, null);
    session.persistedIds.add(note.id);
  }
  for (let index = 0; index < STORM_STEPS.length; index++) {
    const step = STORM_STEPS[index];
    ensureActive();
    if (session.completedSteps.has(step.key)) { onProgress({current: step.key, state: 'done'}); continue; }
    onProgress({current: step.key, state: 'running', detail: `使用 ${session.webResearch.sources.length} 个联网来源：${step.title}`});
    try {
      if (step.key === 'contradiction' && !session.abstractContent) {
        try {
          const abstract = await callLLM({providerId: '', model: '', workflow: 'storm-abstract',
            userInput: `请将以下多视角分析精简为结构化摘要，保留来源编号及证据局限：\n\n${session.outputs['multi-perspective']}${researchContext}`}, {signal});
          ensureActive();
          session.abstractContent = abstract.content?.trim();
        } catch (error) { ensureActive(); /* Non-critical abstract failure falls back to the original. */ }
        session.abstractContent ||= session.outputs['multi-perspective'];
      }
      const userInput = step.key === 'multi-perspective' ? `我需要研究 **${session.subject}**。`
        : step.key === 'contradiction' ? `基于上述多视角分析摘要，绘制矛盾图谱：\n\n${session.abstractContent}`
        : step.key === 'brief' ? `主题：${session.subject}\n\n多视角分析：\n${session.outputs['multi-perspective']}\n\n矛盾图谱：\n${session.outputs.contradiction}`
        : `请对以下综合研究简报进行评审：\n\n${session.outputs.brief}`;
      let content = session.outputs[step.key];
      for (let attempt = 0; !content && attempt < 2; attempt++) {
        ensureActive();
        const response = await callLLM({providerId: '', model: '', workflow: step.workflow, userInput: userInput + researchContext}, {signal});
        ensureActive();
        content = response.content?.trim();
      }
      if (!content) throw new Error(`${step.title}两次返回空内容，请重试该阶段`);
      checkStormCitations(content, session.webResearch);
      session.outputs[step.key] = content;
      const expected = session.tree[index + 1];
      const sourcedContent = content + appendix;
      const target = {...expected, content: sourcedContent, generatedContentBlocks: rememberGeneratedContent(expected, sourcedContent), updatedAt: new Date().toISOString()};
      await persist(target, expected);
      session.tree[index + 1] = target;
      session.completedSteps.add(step.key);
      onProgress({current: step.key, state: 'done'});
    } catch (error) {
      ensureActive();
      onProgress({current: step.key, state: 'error', error: error instanceof Error ? error.message : '研究阶段执行失败'});
      throw error;
    }
  }
  // Return the real identities and content, not a newly generated result tree.
  const content = `# ${session.subject} · STORM报告\n\n${session.tree.slice(1).map(note => `- [[${note.title}]]`).join('\n')}${appendix}`;
  const summary = {...report, content, generatedContentBlocks: rememberGeneratedContent(report, content), updatedAt: new Date().toISOString()};
  await persist(summary, report);
  session.tree[0] = summary;
  return session.tree.map(note => ({...note}));
}
