import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DueDateItem, NoteItem, SceneRunState, SceneSpec } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { registerUiTools } from '../src/services/agent/tools/uiTools';
import { clearToolRegistryForTests, executeTool, getTool } from '../src/services/agent/toolRegistry';
import { getLearningCompletionTarget } from '../src/services/learningCompletion';
import { sceneAllowsExit, sceneAllowsNavigation } from '../src/components/useSceneGuard';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

clearToolRegistryForTests();
registerUiTools();
const captured: Parameters<AgentRuntimeContext['enterLearningMode']>[0][] = [];
const context = {
  enterLearningMode: (request: Parameters<AgentRuntimeContext['enterLearningMode']>[0]) => {
    captured.push(request);
    return true;
  },
} as AgentRuntimeContext;
const sceneRequest = {
  source: 'auto', subject: 'A title also used by a scheduled project',
  knowledgePoints: [], sceneSkill: 'S1', customTitle: 'A different scene title',
};
const subjectOnly = await executeTool('enter_learning_mode', { mode: 'scene', sceneRequest }, context);
assert.equal(subjectOnly.ok, true);
assert.equal(captured[0].taskBinding, undefined);
assert.equal(captured[0].sceneRequest?.taskBinding, undefined, 'a matching subject never invents a task identity');
assert.equal(captured[0].sceneRequest?.customTitle, sceneRequest.customTitle);

const recurringBinding = { noteId: 'root', taskId: 'daily-practice', occurrenceDate: '2026-10-06' };
const explicit = await executeTool('enter_learning_mode', {
  mode: 'scene', sceneRequest: { ...sceneRequest, taskBinding: recurringBinding },
}, context);
assert.equal(explicit.ok, true);
assert.deepEqual(captured.at(-1)?.sceneRequest?.taskBinding, recurringBinding);
const topLevel = await executeTool('enter_learning_mode', {
  mode: 'scene', sceneRequest, taskBinding: recurringBinding,
}, context);
assert.equal(topLevel.ok, true);
assert.deepEqual(captured.at(-1)?.taskBinding, recurringBinding);

const toolSchema = getTool('enter_learning_mode')!.parameters as {
  properties: { taskBinding: unknown; sceneRequest: { properties: { taskBinding: unknown } } };
};
assert.deepEqual(toolSchema.properties.taskBinding, toolSchema.properties.sceneRequest.properties.taskBinding);
for (const malformed of [
  { noteId: 'leaf', taskId: 42 },
  { noteId: 'leaf', taskId: '' },
  { noteId: 'leaf', taskId: '   ' },
  { noteId: 'root', taskId: 'daily-practice', occurrenceDate: 20261006 },
  { noteId: 'root', taskId: 'daily-practice', occurrenceDate: '' },
]) {
  const before = captured.length;
  const result = await executeTool('enter_learning_mode', { mode: 'scene', sceneRequest, taskBinding: malformed }, context);
  assert.equal(result.ok, false, `malformed identity must not silently become a different task: ${JSON.stringify(malformed)}`);
  assert.equal(captured.length, before, 'malformed identity must be rejected before scene entry');
}

const task: DueDateItem = {
  id: 'daily-practice', noteId: 'root', noteTitle: 'Root', taskText: 'Daily practice',
  startDate: '2026-10-01', dueDate: '2026-10-31', completed: false, priority: 'medium',
  recurrence: { frequency: 'daily' }, completedOccurrenceDates: ['2026-10-05'],
};
const root: NoteItem = {
  id: 'root', title: 'Root', noteType: 'project', content: '', tags: [], links: [], backlinks: [],
  dueDates: [task], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const normalized = getLearningCompletionTarget([root], { noteId: root.id, taskId: task.id });
assert.ok(normalized?.binding.occurrenceDate, 'entry resolves and captures the exact recurring occurrence');
assert.deepEqual(getLearningCompletionTarget([root], normalized.binding)?.binding, normalized.binding,
  'subsequent rendering must use the captured date, not reselect another occurrence');
assert.equal(sceneAllowsNavigation('running'), false);
assert.equal(sceneAllowsNavigation('finished'), false, 'confirming completion must not leave the result page');
assert.equal(sceneAllowsExit('finished'), true, 'only the separate explicit Exit unlocks the result page');

const app = source('App.tsx');
const agentEntry = app.slice(app.indexOf('enterLearningMode: ('), app.indexOf('createKnowledgeNote: async'));
assert.match(agentEntry, /explicitBinding\s*=\s*sceneRequest\?\.taskBinding\s*\|\|\s*taskBinding/);
assert.match(agentEntry, /selectedBinding\s*=\s*explicitBinding\s*\|\|\s*\(\(!sceneRequest\s*\|\|\s*noteTitle\)/,
  'scene subject lookup may enrich context but cannot authorize project completion');
assert.match(app, /getLearningCompletionTarget\(notesRef\.current,\s*request\.taskBinding\)[\s\S]*?setSceneRequest\(\{\s*\.\.\.request,\s*taskBinding:\s*task\?\.binding\s*\}\)/,
  'scene entry stores the normalized binding including a frozen recurrence date');
assert.match(source('components/scene/SceneBuilderPanel.tsx'),
  /taskBinding:\s*selectedProject\?\.noteType\s*===\s*'project'\s*\?\s*\{\s*noteId:\s*selectedProject\.id\s*\}/,
  'a custom title cannot discard the explicitly selected project identity');
assert.equal((source('components/SceneMode.tsx').match(/completionContent=\{completionContent\}/g) || []).length, 2,
  'only the active S1 or S4 branch receives one result slot');

// Node SSR does not need stylesheet execution; retain the runtime module loader for TSX.
const require = createRequire(import.meta.url);
require.extensions['.css'] = () => {};
const { SceneChatView } = require('../src/components/scene/SceneChatView') as typeof import('../src/components/scene/SceneChatView');
const { SceneDerivationView } = require('../src/components/scene/SceneDerivationView') as typeof import('../src/components/scene/SceneDerivationView');
const { LearningCompletionCard } = require('../src/components/LearningCompletionCard') as typeof import('../src/components/LearningCompletionCard');
const spec = {
  sceneId: 'completion-wiring-only', version: '1.0',
  meta: { name: 'Read-only test', knowledgePoints: [] }, situation: '', task: 'Test',
  role: { name: 'Tutor' }, userRole: 'Student', resources: [], metrics: [],
  completion: { maxTurns: 3 }, events: [],
  compute: { given: [], symbols: [], expected_steps: [{ display: 'Reference solution' }] },
} as SceneSpec;
const run = {
  runId: 'test-run', sceneId: spec.sceneId, messages: [], metrics: [], events: [], status: 'running',
  canvas: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, helpUsed: 0, maxHelp: 2, independenceScore: 1 },
} as SceneRunState;
let writes = 0;
const completionContent = React.createElement(LearningCompletionCard, {
  target: { ...normalized, title: 'A long leaf-project title '.repeat(8) },
  onSetCompleted: async () => { writes += 1; }, context: 'scene', variant: 'result',
});
const common = {
  spec, run, onEnd: () => {}, onExit: () => {}, onRerun: () => {}, hasPrevRun: false, completionContent,
};
const chatProps = { ...common, sending: false, onSend: () => {}, onInjectEvent: () => {} };
const s4Props = { ...common, busy: false, onRunChange: () => {}, previewMode: true };
for (const [component, props] of [[SceneChatView, chatProps], [SceneDerivationView, s4Props]] as const) {
  const running = renderToStaticMarkup(React.createElement(component as React.ComponentType<typeof props>, props));
  assert.doesNotMatch(running, /class="learning-completion-card/);
  for (const status of ['success', 'failure'] as const) {
    const ended = renderToStaticMarkup(React.createElement(component as React.ComponentType<typeof props>, {
      ...props, run: { ...run, status },
    }));
    assert.equal((ended.match(/class="learning-completion-card /g) || []).length, 1, `${status} contains one completion card`);
    assert.match(ended, /完成本次待办/);
    assert.match(ended, /退出场景/);
    if (component === SceneChatView) {
      assert.doesNotMatch(ended, /scene-chat-textarea/);
      assert.match(ended, /min-height:min\(120px, 25%\)/, 'the message list keeps a visible share of low-height layouts');
      assert.match(ended, /max-height:55%;min-height:0;flex-shrink:1;overflow-y:auto/,
        'a long completion card scrolls instead of clipping the action');
    } else {
      assert.ok(ended.indexOf('learning-completion-card') < ended.indexOf('scene-s4-solution'));
      assert.ok(ended.indexOf('learning-completion-card') < ended.indexOf('scene-s4-side-helper'),
        'ended S4 prioritizes the completion entry rather than placing it below the helper');
      assert.match(ended, /class="scene-s4-side"[^>]*style="display:block;overflow-y:auto/,
        'the completed S4 rail scrolls as a whole at low height');
    }
  }
}
assert.equal(writes, 0, 'rendering results and scores must never complete a task');
assert.match(source('components/LearningCompletionCard.css'), /\.learning-completion-card\.is-result\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/,
  'a narrow result rail retains a flexible text column');
assert.match(source('components/LearningCompletionCard.css'), /\.learning-completion-card\.is-result\s+\.learning-completion-actions\s*\{\s*grid-column:\s*1\s*\/\s*-1/,
  'the completion action uses its own row on a narrow result rail');
console.log('Scene completion wiring checks passed: explicit identity, frozen occurrence, locked results, single result-only slots and no automatic writes.');
