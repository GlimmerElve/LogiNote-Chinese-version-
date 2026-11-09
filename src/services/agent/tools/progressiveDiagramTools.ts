import { registerTool } from '../toolRegistry';
import type { AgentRuntimeContext } from '../types';
import { loadProgressiveCourse, readProgressivePage, patchProgressiveDiagramPage } from '../../progressiveLearning/client';
import { readProgressiveDiagram, patchProgressiveDiagram } from '../../progressiveLearning/diagramEditing';

export function registerProgressiveDiagramTools(deps = {
  load: loadProgressiveCourse, read: readProgressivePage, patch: patchProgressiveDiagramPage,
  preflight: async (code: string, signal: AbortSignal = AbortSignal.timeout(25000)) => {
    const [{ renderMermaidInFrame }, { textbookVisualRenderQueue }] = await Promise.all([
      import('../../ui/mermaidFrameRenderer'), import('../../ui/textbookVisualQueue'),
    ]);
    signal.throwIfAborted();
    const task = textbookVisualRenderQueue.enqueue(context => renderMermaidInFrame({ id: `diagram-patch-${crypto.randomUUID()}`,
      code, dark: false, signal: AbortSignal.any([signal, context.signal]) }), 25000);
    const cancel = () => task.cancel(); signal.addEventListener('abort', cancel, { once: true });
    try { await task.result; } finally { signal.removeEventListener('abort', cancel); }
  },
}) {
  const project = (args: Record<string, unknown>, ctx: AgentRuntimeContext) => {
    const id = args.projectNoteId ?? ctx.getActiveNote?.()?.id;
    if (typeof id !== 'string' || !ctx.getNotes().some(note => note.id === id && note.noteType === 'project')) throw Error('需要实际项目ID');
    return id;
  };
  const locate = async (args: Record<string, unknown>, ctx: AgentRuntimeContext) => {
    const projectNoteId = project(args, ctx);
    const course = typeof args.pageId === 'string' ? await deps.read(projectNoteId, args.pageId) : await deps.load(projectNoteId);
    const page = course?.page || course?.firstPage;
    if (!course || !page) throw Error('该项目没有已保存的渐进教材页；旧完整教材使用read_project_textbook');
    if (course.generation.status !== 'ready') throw Error('当前页生成尚未结束，请保留任务并待完成后修图');
    const descriptor = course.pages?.find(value => value.id === page.id);
    if (!descriptor) throw Error('该教材页版本不可读取');
    const diagramIndex = args.diagramIndex === undefined ? 0 : args.diagramIndex as number;
    return { course, page, diagramIndex, expectedHash: descriptor.contentHash, ...readProgressiveDiagram(page.body, diagramIndex) };
  };
  const check = async (args: Record<string, unknown>, ctx: AgentRuntimeContext) => {
    const value = await locate(args, ctx);
    if (value.course.environmentId !== args.environmentId || value.course.id !== args.courseId || value.page.id !== args.pageId
      || value.expectedHash !== args.expectedHash) throw Error('教材页版本已变化，请重新读取目标图示');
    if (typeof args.issue !== 'string' || !args.issue.trim() || args.issue.length > 300) throw Error('请说明已定位的具体图文不一致');
    const body = patchProgressiveDiagram(value.page.body, value.diagramIndex, args.replacements as any);
    return { ...value, repaired: readProgressiveDiagram(body, value.diagramIndex).code };
  };
  const base = { projectNoteId: { type: 'string' }, pageId: { type: 'string' }, diagramIndex: { type: 'integer', minimum: 0, maximum: 15 } };
  registerTool({ name: 'read_progressive_diagram',
    description: '读取渐进教材单个Mermaid图示及前后各最多600字符，不取整页或私人作答。diagramIndex从0开始；返回页版本和源码。已有明确图文矛盾时才定向检查，语法通过不代表教学正确；上下文不足不猜测。旧完整教材用read_project_textbook。',
    parameters: { type: 'object', additionalProperties: false, properties: base }, location: 'renderer', permission: 'readonly',
    execute: async (args, ctx) => {
      const value = await locate(args, ctx);
      return { projectNoteId: value.course.projectNoteId, environmentId: value.course.environmentId, courseId: value.course.id,
        pageId: value.page.id, expectedHash: value.expectedHash, diagramIndex: value.diagramIndex, diagramCount: value.diagramCount,
        code: value.code, before: value.before, after: value.after, maxPatches: 4, regenerationRequired: false };
    },
  });
  registerTool({ name: 'edit_progressive_diagram',
    description: '只修已读渐进页的一个Mermaid图示，最多4处唯一锚点小补丁；不发送或重写整页，不额外调用模型。必须绑定读取返回的版本并说明具体问题。保存前仅渲染目标图，失败保留原图；成功保留其它正文/题目/阅读记录及生成检查点。无新问题不反复修图。',
    parameters: { type: 'object', additionalProperties: false,
      required: ['projectNoteId', 'pageId', 'diagramIndex', 'environmentId', 'courseId', 'expectedHash', 'issue', 'replacements'],
      properties: { ...base, environmentId: { type: 'string' }, courseId: { type: 'string' }, expectedHash: { type: 'string' },
        issue: { type: 'string', maxLength: 300 }, replacements: { type: 'array', minItems: 1, maxItems: 4, items: {
          type: 'object', additionalProperties: false, required: ['oldText', 'newText'],
          properties: { oldText: { type: 'string', minLength: 1, maxLength: 500 }, newText: { type: 'string', maxLength: 800 } },
        } } },
    }, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const value = await check(args, ctx);
      return { environmentId: value.course.environmentId, courseId: value.course.id, pageId: value.page.id,
        pageHash: value.expectedHash, diagramIndex: value.diagramIndex, code: value.code };
    },
    confirmation: args => ({ title: '定向修复教材图示', description: String(args.issue || '只修改当前图示'),
      impacts: (Array.isArray(args.replacements) ? args.replacements : []).map(item => `“${String(item.oldText).slice(0, 100)}” → “${String(item.newText).slice(0, 160)}”`) }),
    execute: async (args, ctx, execution) => {
      const value = await check(args, ctx); execution?.signal?.throwIfAborted();
      const signal = AbortSignal.any([AbortSignal.timeout(25000), ...(execution?.signal ? [execution.signal] : [])]);
      await deps.preflight(value.repaired, signal); signal.throwIfAborted();
      const saved = await deps.patch({ op: 'patch-diagram', projectNoteId: value.course.projectNoteId, environmentId: value.course.environmentId,
        courseId: value.course.id, pageId: value.page.id, expectedHash: value.expectedHash, diagramIndex: value.diagramIndex,
        replacements: args.replacements as any });
      return { saved: true, projectNoteId: saved.projectNoteId, pageId: value.page.id,
        pageHash: saved.pages!.find(page => page.id === value.page.id)!.contentHash, previousHash: value.expectedHash,
        diagramIndex: value.diagramIndex, patched: (args.replacements as any[]).length, wholePageRegenerated: false, extraModelRequests: 0 };
    },
  });
}
