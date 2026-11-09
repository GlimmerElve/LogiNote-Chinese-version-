/** Real store + controller + agent tools; no provider, private vault or DOM. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { registerProgressiveDiagramTools } from '../src/services/agent/tools/progressiveDiagramTools';
import { getTool, executeTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { AGENT_ROLES } from '../src/services/agent/agentEngine';
import { getAgentSkill, applyAgentSkill } from '../src/services/agent/skillRegistry';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { ProgressiveCourse, ProgressiveBeginReply } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';

const root = await fs.mkdtemp(path.resolve('build/progressive-diagram-tools-'));
const originalFetch = globalThis.fetch, originalWindow = (globalThis as any).window;
globalThis.fetch = async () => assert.fail('No model or external request is authorized by this test');
const listeners = new Set<(id: string) => void>();
(globalThis as any).window = { electronAPI: { progressiveLearning: { onChange: (callback: (id: string) => void) => {
  listeners.add(callback); return () => listeners.delete(callback);
} } } };
const at = '2026-11-07T00:00:00Z';
const note: NoteItem = { id: 'diagram-project', title: '函数判断', noteType: 'project', content: '', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const store = new ProgressiveLearningStore(root, { readTarget: async () => ({ note, root: note, isLeaf: true }),
  pageChanged: id => { for (const callback of listeners) callback(id); } });
const command = (input: any) => store.command(input, 1) as Promise<any>;
const diagram = 'flowchart TD\nA[输入] --> B{每个输入有输出吗}\nB --> C[成立]';
const body = '先检查定义域中每个输入在陪域内都有唯一输出。\n\n' + '原有解释保持完整。'.repeat(220)
  + '\n\n```mermaid\n' + diagram + '\n```\n\n末尾说明与公式 $x^2$ 保留。';
const plan = { title: note.title, objectives: ['判断条件'], pages: [{ id: 'main-1', title: '判断条件', objectives: ['检查陪域'] }] };
let controller: ReturnType<typeof createProgressiveController> | undefined;
try {
  const seed = await command({ op: 'begin', projectNoteId: note.id }) as ProgressiveBeginReply;
  const published = await command({ op: 'publish', lease: seed.lease, teaching: { sequence: 1, plan, title: '判断条件', body,
    hook: { id: 'hook', kind: 'reflection', prompt: '为什么要检查陪域？' } } }) as ProgressiveCourse;
  const adapter: ProgressiveStorageAdapter = {
    load: id => command({ op: 'load', projectNoteId: id }), begin: id => command({ op: 'begin', projectNoteId: id }),
    checkpoint: (lease, checkpoint) => command({ op: 'checkpoint', lease, checkpoint }),
    publish: (lease, teaching) => command({ op: 'publish', lease, teaching }),
    saveProgress: (projectNoteId, progress) => command({ op: 'save-progress', projectNoteId, progress }),
    interrupt: (lease, error) => command({ op: 'interrupt', lease, error }),
  };
  controller = createProgressiveController({ note, allNotes: [note] }, { storage: adapter,
    stream: async () => assert.fail('Diagram edits must not invoke generation'),
    loadMaterials: async () => assert.fail('Saved pages must not reload materials'), registerFlush: () => () => {} });
  await controller.start();
  controller.saveProgress({ restatementDraft: 'UNSAVED_LEARNER_TEXT', scrollTop: 731 });
  const ctx = { getNotes: () => [note], getActiveNote: () => note } as AgentRuntimeContext;
  let renders = 0, saves = 0, renderFailure = false;
  registerProgressiveDiagramTools({ load: adapter.load, read: async (id, pageId) => command({ op: 'read-page', projectNoteId: id, pageId }),
    patch: async input => { saves++; return command(input); }, preflight: async (_code, signal) => {
      renders++; assert.ok(signal && !signal.aborted); if (renderFailure) throw Error('Injected render failure');
    } });
  const role = applyAgentSkill(AGENT_ROLES.default, getAgentSkill('personalized-textbook')!);
  assert.ok(role.allowedTools.includes('read_progressive_diagram') && role.allowedTools.includes('edit_progressive_diagram'));
  assert.ok(!AGENT_ROLES.default.allowedTools.includes('read_progressive_diagram'), 'specialist repair tools are disclosed on demand');
  const read = await executeTool('read_progressive_diagram', { projectNoteId: note.id }, ctx);
  assert.equal(read.ok, true); const packet = read.result as any;
  assert.equal(packet.code, diagram); assert.ok(packet.before.length <= 600 && packet.after.length <= 600);
  assert.ok(!JSON.stringify(packet).includes('UNSAVED_LEARNER_TEXT')); assert.ok(!JSON.stringify(packet).includes('sourcePackets'));
  assert.equal(packet.body, undefined); assert.equal(packet.maxPatches, 4);
  const args = { projectNoteId: note.id, environmentId: packet.environmentId, courseId: packet.courseId, pageId: packet.pageId,
    expectedHash: packet.expectedHash, diagramIndex: packet.diagramIndex, issue: '成功分支遗漏陪域限制',
    replacements: [{ oldText: '每个输入有输出吗', newText: '每个输入在陪域内都有输出吗' }] };
  const edit = getTool('edit_progressive_diagram')!;
  assert.equal(toolRequiresApproval(edit, args, ctx), true);
  await edit.approvalSnapshot!(args, ctx); assert.equal(renders, 0, 'approval binding does not render or call a model');
  renderFailure = true;
  const failed = await executeTool(edit.name, args, ctx, { userApproved: true });
  assert.equal(failed.ok, false); assert.equal(saves, 0); assert.equal(renders, 1);
  assert.equal((await adapter.load(note.id))!.page!.body, body);
  renderFailure = false;
  const fixed = await executeTool(edit.name, args, ctx, { userApproved: true });
  assert.equal(fixed.ok, true); assert.equal((fixed.result as any).saved, true);
  assert.equal((fixed.result as any).wholePageRegenerated, false); assert.equal((fixed.result as any).extraModelRequests, 0);
  assert.equal(saves, 1); assert.equal(renders, 2);
  for (let i = 0; i < 100 && !controller.getSnapshot().page?.body.includes('每个输入在陪域内都有输出吗'); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const visible = controller.getSnapshot();
  assert.ok(visible.page!.body.includes('每个输入在陪域内都有输出吗'), 'existing course-change event refreshes the reader');
  assert.equal(visible.course!.progress.restatementDraft, 'UNSAVED_LEARNER_TEXT'); assert.equal(visible.course!.progress.scrollTop, 731);
  assert.equal(visible.phase, 'ready');
  const repeated = await executeTool(edit.name, args, ctx, { userApproved: true });
  assert.equal(repeated.ok, false); assert.equal(renders, 2); assert.equal(saves, 1, 'stale repair cannot repeat or restart generation');
  await controller.flush();
  const saved = await adapter.load(note.id);
  assert.equal(saved!.progress.restatementDraft, 'UNSAVED_LEARNER_TEXT'); assert.equal(saved!.progress.scrollTop, 731);
  assert.deepEqual(saved!.generation, JSON.parse(JSON.stringify(published.generation)));
  const receipt = { status: 'passed', root, remoteCalls: 0, boundedRead: true, targetedRenderOnly: true,
    rendererFailurePreservesOriginal: true, staleEditRejected: true, readerRefreshedWithoutGeneration: true,
    pendingDraftAndPositionPreserved: true, specialistToolsLazy: true };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { controller?.dispose(); globalThis.fetch = originalFetch; (globalThis as any).window = originalWindow; }
