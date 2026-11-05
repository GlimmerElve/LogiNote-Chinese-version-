import assert from 'node:assert/strict';
import { AGENT_ROLES } from '../src/services/agent/agentEngine';
import { AGENT_CAPABILITY_DOMAINS } from '../src/services/agent/capabilities';
import { inferContextualAgentSkill } from '../src/services/agent/intentRouter';
import { applyAgentSkill, getAgentSkill, QUICK_CHECK_INTENT, selectAgentSkill } from '../src/services/agent/skillRegistry';
import { clearToolRegistryForTests, executeTool, getTool, listToolsForRole, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { registerUiTools } from '../src/services/agent/tools/uiTools';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { MASTERY_SHADOW_CRITERIA } from '../src/services/masteryShadow/rubric';
import type { NoteItem } from '../src/types';

// Synthetic contexts only. No vault, browser, cloud generation or mastery writes.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network is forbidden in quick-check entry checks'); };
let checks = 0;
function pass(label: string) { checks++; console.log(`PASS ${label}`); }

try {
  clearToolRegistryForTests();
  registerUiTools();
  const notes = [
    { id: 'knowledge-fixture', title: '等差数列', noteType: 'knowledge', content: '合成参考内容' },
    { id: 'project-fixture', title: '数列项目', noteType: 'project', content: '' },
  ] as NoteItem[];
  const originalNotes = JSON.stringify(notes);
  const entered: Parameters<AgentRuntimeContext['enterLearningMode']>[0][] = [];
  let allowOpen = true;
  const ctx = {
    getNotes: () => notes,
    enterLearningMode: (input) => { entered.push(input); return allowOpen; },
  } as AgentRuntimeContext;
  const tool = getTool('enter_learning_mode')!;
  const schema = tool.parameters as {
    additionalProperties: boolean;
    properties: { mode: { enum: string[] }; quickCheckRequest: {
      additionalProperties: boolean;
      properties: { noteId: { maxLength: number }; criterionIds: { maxItems: number; uniqueItems: boolean; items: { enum: string[] } } };
    } };
  };
  assert.equal(tool.permission, 'navigation');
  assert.equal(tool.location, 'renderer');
  assert.equal(toolRequiresApproval(tool, { mode: 'quick_check' }, ctx), false);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.mode.enum.includes('quick_check'));
  assert.equal(schema.properties.quickCheckRequest.additionalProperties, false);
  assert.equal(schema.properties.quickCheckRequest.properties.criterionIds.maxItems, 3);
  assert.equal(schema.properties.quickCheckRequest.properties.criterionIds.uniqueItems, true);
  assert.deepEqual(schema.properties.quickCheckRequest.properties.criterionIds.items.enum, MASTERY_SHADOW_CRITERIA.map(row => row.id));
  pass('共享学习工具保留导航权限，schema 只开放知识点和封闭判据');

  assert.ok(AGENT_ROLES.default.allowedTools.includes(tool.name));
  assert.ok(AGENT_ROLES.default.skillToolCeiling?.includes(tool.name));
  assert.ok(AGENT_CAPABILITY_DOMAINS.learning.tools.includes(tool.name as 'enter_learning_mode'));
  const skill = getAgentSkill('socratic-review')!;
  assert.ok(listToolsForRole(applyAgentSkill(AGENT_ROLES.default, skill)).some(row => row.name === tool.name));
  assert.match(skill.systemPrompt, /简测优先[\s\S]*mode=quick_check/u);
  assert.match(skill.systemPrompt, /先建议，等用户同意/u);
  assert.match(skill.systemPrompt, /不重复确认/u);
  assert.match(skill.systemPrompt, /正在准备题目/u);
  pass('角色、权限上限和复习 skill 可调出卡片，不添加写状态能力');

  for (const text of ['帮我简测等差数列', '给当前知识点来三道题', '用 3 题定向检测概念边界', '先复习一下，用三题简测而非场景练习']) {
    assert.equal(QUICK_CHECK_INTENT.test(text), true, text);
    assert.equal(selectAgentSkill(text)?.id, 'socratic-review', text);
    assert.equal(inferContextualAgentSkill(text, []), 'socratic-review', text);
  }
  for (const text of ['考考我', '开始苏格拉底式复习等差数列']) {
    assert.equal(QUICK_CHECK_INTENT.test(text), false, text);
    assert.equal(selectAgentSkill(text)?.id, 'socratic-review', text);
  }
  for (const text of ['简测卡片是什么', '怎么打开简测卡片', '简测卡片如何评分', '不要简测，解释一下等差数列']) {
    assert.notEqual(selectAgentSkill(text)?.id, 'socratic-review', text);
  }
  pass('明确简测与三题路由到同一复习 skill，旧复习、说明和否定意图不被抢占');

  const args = { mode: 'quick_check', quickCheckRequest: { noteId: 'knowledge-fixture', criterionIds: ['concept_boundary', 'concept_application'] } };
  const originalArgs = JSON.stringify(args);
  const opened = await executeTool(tool.name, args, ctx);
  assert.equal(opened.ok, true);
  assert.deepEqual(entered.at(-1), args);
  assert.deepEqual(opened.result, { entered: true, mode: 'quick_check', status: 'opened', generationStatus: 'pending', masteryUpdated: false });
  assert.equal(JSON.stringify(args), originalArgs);
  assert.equal(JSON.stringify(notes), originalNotes);
  pass('稳定 ID 与定向判据只转交调出入口，成功仅代表 opened/pending');
  const refresh = { mode: 'quick_check', quickCheckRequest: { noteId: 'knowledge-fixture', regenerate: true } };
  assert.equal((await executeTool(tool.name, refresh, ctx)).ok, true);
  assert.deepEqual(entered.at(-1), refresh, 'Agent regeneration is forwarded to the guarded card, not a mastery write');
  assert.match(skill.systemPrompt, /regenerate=true/u);
  pass('Agent 仅请求指定卡片重新出题，未完成作答仍由卡片确认');

  for (const args of [
    { mode: 'quick_check', noteTitle: '等差数列' },
    { mode: 'quick_check' },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: ['concept_boundary'] } },
  ]) {
    assert.equal((await executeTool(tool.name, args, ctx)).ok, true);
    assert.deepEqual(entered.at(-1), args);
  }
  pass('标题和当前知识点入口交由 App 统一解析，不强迫再次确认');

  const invalid: Record<string, unknown>[] = [
    { mode: 'quick_check', quickCheckRequest: { regenerate: 'true' } },
    { mode: 'quick_check', quickCheckRequest: { regenerate: 1 } },
    { mode: 'quick_check', quickCheckRequest: { regenerate: null } },
    { mode: 'quick_check', quickCheckRequest: { noteId: 'missing' } },
    { mode: 'quick_check', quickCheckRequest: { noteId: 'project-fixture' } },
    { mode: 'quick_check', quickCheckRequest: { noteId: '' } },
    { mode: 'quick_check', quickCheckRequest: { noteId: [] } },
    { mode: 'quick_check', quickCheckRequest: { noteId: '\n' } },
    { mode: 'quick_check', quickCheckRequest: { noteId: 'x'.repeat(257) } },
    { mode: 'quick_check', quickCheckRequest: null },
    { mode: 'quick_check', quickCheckRequest: [] },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: ['not_a_criterion'] } },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: ['concept_accuracy', 'concept_boundary', 'concept_application', 'judgment_accuracy'] } },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: ['concept_accuracy', 'concept_accuracy'] } },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: [] } },
    { mode: 'quick_check', quickCheckRequest: { criterionIds: 'concept_accuracy' } },
    { mode: 'quick_check', quickCheckRequest: { answer: '代答内容' } },
    { mode: 'quick_check', quickCheckRequest: { score: 100 } },
    { mode: 'quick_check', quickCheckRequest: { state: 'confirmed' } },
    { mode: 'quick_check', score: 100 },
    { mode: 'quick_check', noteTitle: '等差数列', quickCheckRequest: { noteId: 'knowledge-fixture' } },
    { mode: 'quick_check', noteTitle: [] },
    { mode: 'quick_check', question: '不能传入自定题目' },
    { mode: 'quick_check', reviewRequest: { scope: 'knowledge', strategy: 'smart' } },
    { mode: 'quick_check', sceneRequest: {} },
    { mode: 'quick_check', taskBinding: { noteId: 'project-fixture' } },
    { mode: 'review', quickCheckRequest: { noteId: 'knowledge-fixture' } },
    { mode: 'scene', quickCheckRequest: {} },
    { mode: ['quick_check'] },
    { mode: 'unknown' },
  ];
  for (const args of invalid) {
    const before = entered.length;
    const response = await executeTool(tool.name, args, ctx);
    assert.equal(response.ok, false, JSON.stringify(args));
    assert.equal(entered.length, before, '非法请求不能触发入口或回退到当前笔记');
  }
  pass(`${invalid.length} 种非法 ID、判据、混用、代答和状态写入参数均关闭失败`);

  allowOpen = false;
  const denied = await executeTool(tool.name, { mode: 'quick_check', quickCheckRequest: { noteId: 'knowledge-fixture' } }, ctx);
  assert.equal(denied.ok, false);
  assert.match(denied.error || '', /未打开/u);
  assert.equal(JSON.stringify(notes), originalNotes);
  pass('页面离开保护或不可用目标拒绝时不能声称已打开，输入状态始终不变');
  console.log(`Agent quick-check entry checks passed: ${checks}`);
} finally {
  clearToolRegistryForTests();
  globalThis.fetch = originalFetch;
}
