import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { SceneInitialRequest } from '../src/types';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Lifecycle checks forbid network/model calls');
const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '生命周期一', knowledgePoints: [], interactionPack: null };
function draft(input: SceneInitialRequest) {
  const scene = createS2Scene(input);
  scene.canvasWorkspace = readS2Definition({ ...scene.canvasWorkspace,
    blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins: [{ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' }],
    initial: { nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: '保留原文' } }], edges: [], execution: { version: 1,
      nodes: [{ id: 'material', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text', position: { x: 300, y: 0 }, bindings: {} }], links: [] } },
  });
  return scene;
}
const hosts: S2PluginHost[] = [];
const options = { initialRequest: request, initialDraft: draft(request), onHost(host: S2PluginHost) { hosts.push(host); } };
const ui = harness(options);
const file = () => new File(['本局资料'], 'local.txt', { type: 'text/plain' });
const facade = () => ui.resourceElement('material').props.host;
function ask(text: string) {
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: text } }); ui.render();
  ui.button('发送').props.onClick(); ui.render(); return ui.signal()!;
}
const expired = (error: any) => error?.code === 'RUN_ENDED';
try {
  const first = facade(); assert.equal(hosts.length, 0);
  first.approveTextFile(file()); ui.render(); assert.equal(hosts.length, 1);
  const signal = ask('只说明当前场景，不运行'); assert.equal(signal.aborted, false);
  const secondRequest = { ...request, subject: '生命周期二' };
  options.initialRequest = secondRequest; options.initialDraft = draft(secondRequest); ui.render();
  assert.equal(signal.aborted, true, 'Switching scenes cancels the outstanding assistant request');
  assert.deepEqual(hosts[0].textResourceSummary(), []); assert.deepEqual(first.textResourceSummary(), []);
  assert.throws(() => first.approveTextFile(file()), expired);
  assert.equal(hosts.length, 1, 'Loading the next scene never starts another session');
  ui.resolve({ understanding: '旧场景', plan: '只读', reply: 'LATE_OLD_SCENE_REPLY', commands: [] });
  await new Promise(resolve => setImmediate(resolve)); ui.render(); assert(!ui.text().includes('LATE_OLD_SCENE_REPLY'));
  const second = facade(); second.approveTextFile(file()); ui.render();
  assert.equal(hosts.length, 2); assert.notEqual(hosts[1].runId, hosts[0].runId);
  const secondSignal = ask('第二个场景的请求');
  // Re-entering even the exact same draft object must not revive an earlier resource facade.
  options.initialRequest = { ...secondRequest, subject: '同一草稿的新本局' }; ui.render();
  assert.equal(secondSignal.aborted, true); assert.deepEqual(hosts[1].textResourceSummary(), []);
  assert.throws(() => second.approveTextFile(file()), expired);
  ui.resolve({ understanding: '旧本局', plan: '只读', reply: 'LATE_SAME_DRAFT_REPLY', commands: [] });
  await new Promise(resolve => setImmediate(resolve)); ui.render(); assert(!ui.text().includes('LATE_SAME_DRAFT_REPLY'));
  const third = facade(); third.approveTextFile(file()); ui.render(); assert.equal(hosts.length, 3);
  const thirdSignal = ask('卸载前的请求'); ui.dispose();
  assert.equal(thirdSignal.aborted, true, 'Direct unmount also cancels without a Return/End action');
  assert.equal(ui.statuses.at(-1), 'finished', 'Local lifecycle observers see the automatic end');
  assert.deepEqual(hosts[2].textResourceSummary(), []); assert.throws(() => third.approveTextFile(file()), expired);
  ui.dispose(); assert.throws(() => third.approveTextFile(file()), expired, 'Repeated cleanup is safe');
  const appLine = readFileSync('src/App.tsx', 'utf8').split('\n').find(line => line.includes('React.createElement(SceneS2CanvasTrial,'));
  assert(appLine); assert(!appLine.includes('sceneGuard.updateStatus'), 'S2 activity must not activate the teaching-flow navigation lock');
  console.log('S2 lifecycle passed: scene switching and same-draft reentry automatically cancel assistant requests, revoke session resources and invalidate retained facades; late responses stay out of the next scene; direct/repeated unmount cleans safely; App leaves S2 navigation unlocked. Synthetic offline handlers only.');
} finally { ui.dispose(); globalThis.fetch = previousFetch; }
