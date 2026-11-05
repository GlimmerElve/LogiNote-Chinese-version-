import type { TeachingBlueprint, TeachingVisualPlan, TextbookChapter } from './generationTypes';

export const TEACHING_VISUAL_FORMATS = ['mindmap', 'flowchart', 'sequenceDiagram', 'timeline', 'table', 'chart', 'function-plot', 'science-diagram', 'molecule', 'textbook-image'] as const;
export const TEACHING_VISUAL_SECTIONS = ['explanation', 'boundaries', 'workedExample', 'practice', 'summary'] as const;

export interface TextbookVisualGuidance {
  version: 1;
  origin: 'blueprint' | 'default';
  mode: 'chapter' | 'section_repair';
  targets: TeachingVisualPlan[];
  preserveOtherSections: boolean;
  nonBlocking: true;
  limits: { maxPlannedVisuals: 2; maxDiagramNodes: 12; maxDiagramEdges: 16; preferredDiagramChars: 800 };
}

/** Reading scaffolds only. No inferred domain facts, measurements, personal labels
 * or new material access. Old blueprints stay byte-for-byte unchanged. */
function defaultsForChapter(index: number, count: number): TeachingVisualPlan[] {
  const result: TeachingVisualPlan[] = [];
  if (index === 0) result.push({ format: 'mindmap', section: 'explanation',
    purpose: '把本章定义、关键条件和概念区别组织成入门框架；分组连线不表示因果。',
    readingQuestion: '读图前先找：核心概念是什么，理解它需要分清哪些条件和区别？' });
  if (count >= 3 && index === Math.floor(count / 2)) result.push({ format: 'flowchart', section: 'boundaries',
    purpose: '把已讲过的适用条件转成逐项核对路径；条件缺失时保留“信息不足”，不补造结论。',
    readingQuestion: '遇到新情境时，先核对什么？缺少哪些信息就不能继续判断？' });
  if (index === (count >= 3 ? Math.floor(count / 2) : count - 1)) result.push({ format: 'table', section: 'workedExample',
    purpose: '按同一比较维度对照本章例子与反例，指出已知条件、差异和可得结论，不把假设当实证。',
    readingQuestion: '两个案例真正差在哪个条件？这个差异允许得出什么，仍不能得出什么？' });
  if (index === count - 1) result.push({ format: 'flowchart', section: 'practice',
    purpose: '给出完成本章迁移任务的操作顺序和检查点；只指导解题步骤，不泄露当前练习答案。',
    readingQuestion: '开始练习前，能否沿这条路径说出下一步要做的操作和核对依据？' });
  return result;
}

/** Used by BOTH full chapter generation and bounded section repair. Presentation
 * planning adds no model call, hard quota or checkpoint invalidation. */
export function textbookVisualGuidance(blueprint: TeachingBlueprint, chapterId: string,
  repairSections?: Array<keyof TextbookChapter['sections']>): TextbookVisualGuidance {
  const index = blueprint.chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) throw new Error('可视化引导的章节不属于教学蓝图');
  const chapter = blueprint.chapters[index];
  // An explicitly empty plan may reflect a text-only task or insufficient
  // evidence. Do not override that choice with legacy fallback scaffolds.
  const planned = blueprint.chapters.some((item) => item.visuals !== undefined);
  const targets = planned ? chapter.visuals || [] : defaultsForChapter(index, blueprint.chapters.length);
  return { version: 1, origin: planned ? 'blueprint' : 'default', mode: repairSections ? 'section_repair' : 'chapter',
    targets: structuredClone(repairSections ? targets.filter((item) => repairSections.includes(item.section)) : targets),
    preserveOtherSections: !!repairSections, nonBlocking: true,
    limits: { maxPlannedVisuals: 2, maxDiagramNodes: 12, maxDiagramEdges: 16, preferredDiagramChars: 800 } };
}
