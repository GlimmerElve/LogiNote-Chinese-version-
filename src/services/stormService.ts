/**
 * STORM 学习法（第一步·拓宽视野）流水线编排。
 * 四步：多视角扫描 → 矛盾图谱 → 综合简报 → 同行评审。
 * 多视角分析后额外做一次内部摘要（不落盘），压缩长文本供矛盾图谱使用。
 */

import { NoteItem, LlmWorkflowId } from '../types';
import { callLLM } from './llmService';

/** STORM 四步标识 */
export type StormStep = 'multi-perspective' | 'contradiction' | 'brief' | 'peer-review';

/** 流水线进度状态 */
export interface StormPipelineStatus {
  current: StormStep;
  state: 'running' | 'done' | 'error';
  error?: string;
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
  const ts = Date.now();
  const stormReport = makeProjectNote(`note-${ts}-storm-report`, 'STORM报告', parentProject.id);
  const perspective = makeProjectNote(`note-${ts}-storm-perspective`, '多视角分析', stormReport.id);
  const contradiction = makeProjectNote(`note-${ts}-storm-contradiction`, '矛盾图谱', stormReport.id);
  const brief = makeProjectNote(`note-${ts}-storm-brief`, '综合简报', stormReport.id);
  const peerReview = makeProjectNote(`note-${ts}-storm-peer-review`, '同行评审', stormReport.id);
  return [stormReport, perspective, contradiction, brief, peerReview];
}

/** 新建根项目笔记（供 StormMode 用） */
export function makeRootProjectNote(title: string): NoteItem {
  return makeProjectNote(`note-${Date.now()}-storm-root`, title, undefined);
}

interface RunStormPipelineOpts {
  subject: string;
  parentProject: NoteItem;
  onUpdateNote: (note: NoteItem) => void;
  onProgress: (status: StormPipelineStatus) => void;
}

/**
 * 一键执行 STORM 四步流水线。
 * 1) 创建 5 个空笔记占位；2) 依次调用 LLM 并写回内容。
 * 任一步失败抛出，已生成的笔记保留。
 */
export async function runStormPipeline(opts: RunStormPipelineOpts): Promise<void> {
  const { subject, parentProject, onUpdateNote, onProgress } = opts;

  // 1) 创建占位笔记树（因笔记列表采用 unshift 头插，创建顺序需反转，
  //    使最终数组顺序为「STORM报告 → 多视角 → 矛盾 → 综合 → 同行评审」）
  const tree = buildStormNoteTree(parentProject);
  const [stormReport, perspective, contradiction, brief, peerReview] = tree;
  for (const note of [...tree].reverse()) {
    onUpdateNote(note);
  }

  // 步骤输出快照（用于下游拼接）
  let perspectiveContent = '';
  let contradictionContent = '';
  let briefContent = '';
  // 多视角分析的内部摘要（不落盘，仅用于矛盾图谱，压缩长文本以减轻推理负担）
  let abstractContent = '';

  const stepList = [
    { key: 'multi-perspective' as StormStep, workflow: 'storm-multi-perspective' as LlmWorkflowId, target: perspective },
    { key: 'contradiction' as StormStep, workflow: 'storm-contradiction' as LlmWorkflowId, target: contradiction },
    { key: 'brief' as StormStep, workflow: 'storm-brief' as LlmWorkflowId, target: brief },
    { key: 'peer-review' as StormStep, workflow: 'storm-peer-review' as LlmWorkflowId, target: peerReview },
  ];

  const inputs: Record<StormStep, string> = {
    'multi-perspective': `我需要研究 **${subject}**。`,
    'contradiction': '',
    'brief': '',
    'peer-review': '',
  };

  // 先执行多视角分析
  {
    const step = stepList[0];
    onProgress({ current: step.key, state: 'running' });
    const resp = await callLLM({
      providerId: '',
      model: '',
      workflow: step.workflow,
      userInput: inputs[step.key],
    });
    let rawContent = (resp.content || '').trim();
    if (!rawContent) {
      const retry = await callLLM({ providerId: '', model: '', workflow: step.workflow, userInput: inputs[step.key] });
      rawContent = (retry.content || '').trim();
      if (!rawContent) console.warn(`[STORM] ${step.key} 两次返回空结果`);
    }
    perspectiveContent = rawContent;
    onUpdateNote({ ...step.target, content: rawContent, updatedAt: new Date().toISOString() });
    onProgress({ current: step.key, state: 'done' });

    // 内部摘要：压缩多视角分析，供矛盾图谱使用（不落盘）
    try {
      const absResp = await callLLM({
        providerId: '',
        model: '',
        workflow: 'storm-abstract',
        userInput: `请将以下多视角分析精简为结构化摘要：\n\n${rawContent}`,
      });
      abstractContent = (absResp.content || '').trim();
    } catch {
      abstractContent = '';
    }
    if (!abstractContent) abstractContent = rawContent; // 摘要失败回退原文
  }

  // 再执行剩余三步
  for (let i = 1; i < stepList.length; i++) {
    const step = stepList[i];

    // 根据上游输出动态拼装 input
    if (step.key === 'contradiction') {
      inputs[step.key] = `基于上述多视角分析摘要，绘制矛盾图谱：\n\n${abstractContent}`;
    } else if (step.key === 'brief') {
      inputs[step.key] = `主题：${subject}\n\n多视角分析：\n${perspectiveContent}\n\n矛盾图谱：\n${contradictionContent}`;
    } else if (step.key === 'peer-review') {
      inputs[step.key] = `请对以下综合研究简报进行评审：\n\n${briefContent}`;
    }

    onProgress({ current: step.key, state: 'running' });

    const resp = await callLLM({
      providerId: '',
      model: '',
      workflow: step.workflow,
      userInput: inputs[step.key],
    });

    let rawContent = (resp.content || '').trim();

    // 空结果重试一次（偶发 LLM 返回空字符串，防御性兜底）
    if (!rawContent) {
      const retry = await callLLM({
        providerId: '',
        model: '',
        workflow: step.workflow,
        userInput: inputs[step.key],
      });
      rawContent = (retry.content || '').trim();
      if (!rawContent) console.warn(`[STORM] ${step.key} 两次返回空结果`);
    }

    // 缓存上游结果，供后续步骤使用
    if (step.key === 'contradiction') contradictionContent = rawContent;
    else if (step.key === 'brief') briefContent = rawContent;

    // 写入对应笔记
    onUpdateNote({
      ...step.target,
      content: rawContent,
      updatedAt: new Date().toISOString(),
    });

    onProgress({ current: step.key, state: 'done' });
  }
}