import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createS2Scene, readS2Definition, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import { S2HumanInput } from '../src/components/scene/S2HumanInput';
import { renderS2TextTemplate } from '../src/interaction-packs/prompt-lab/textTemplate';
import { s2DesignEvidenceCatalog, s2DesignEvidencePaths } from '../src/services/scene/sceneS2Design';
import { s2DiscussionPluginCatalog, s2RuntimePluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import type { S2Artifact } from '../src/types/sceneS2Plugin';
import { reviewTaskDefinition, reviewTaskRequest, reviewTaskSource, reviewTaskState, reviewTaskText } from './fixtures/s2-review-task';
import { harness } from './scene-s2-ui-harness';
import { addS2PackCapability, submitS2InlineContent } from './fixtures/s2-canvas-ui-actions';

const definition = readS2Definition(reviewTaskDefinition, { requireBusiness: true }), original = JSON.stringify(definition);
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Review acceptance is synthetic and local only'); };
async function settle(test: () => boolean, render = () => {}) {
  for (let i = 0; i < 800; i++) { render(); if (test()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Synthetic review task did not settle');
}
const expected = (template: string) => renderS2TextTemplate(template, { ...Object.fromEntries(['role', 'task', 'constraints'].map(id =>
  [id, definition.initial.nodes.find(node => node.id === id)!.values.content])), reference: reviewTaskText });
try {
  const catalog = s2DesignEvidenceCatalog(definition); assert.ok(!Array.isArray(catalog));
  const unpack = (tree: Record<string, any>, prefix = ''): string[] => Object.entries(tree).flatMap(([key, children]) => {
    const path = `${prefix}/${key}`; return [path, ...unpack(children, path)];
  });
  if (!Array.isArray(catalog)) {
    assert.deepEqual(new Set(unpack(catalog.paths)), new Set(s2DesignEvidencePaths(definition)));
    assert.ok(JSON.stringify(catalog).length < JSON.stringify(s2DesignEvidencePaths(definition)).length / 2);
  }
  const escaped = structuredClone(definition);
  escaped.initial.execution!.nodes[0].bindings.variables = { kind: 'literal', value: { 'a/b~c': '完整文字', '': '空名称' } };
  const escapedCatalog = s2DesignEvidenceCatalog(escaped); assert.ok(!Array.isArray(escapedCatalog));
  if (!Array.isArray(escapedCatalog)) assert.deepEqual(new Set(unpack(escapedCatalog.paths)), new Set(s2DesignEvidencePaths(escaped)));
  assert.ok(s2DesignEvidencePaths(escaped).some(path => path.endsWith('/a~1b~0c')));
  const small = { instructions: { response: '仅解释' } } as typeof definition;
  assert.deepEqual(s2DesignEvidenceCatalog(small), s2DesignEvidencePaths(small), 'Small legacy catalogs remain ordinary path arrays');
  const fullCatalog = s2RuntimePluginCatalog(definition.plugins), discussionCatalog = s2DiscussionPluginCatalog(definition.plugins);
  assert.equal(discussionCatalog.representation, 'discussion-capability-index');
  assert.deepEqual(discussionCatalog.plugins.map(plugin => [plugin.id, plugin.version, plugin.label, plugin.meaning]),
    fullCatalog.plugins.map(plugin => [plugin.id, plugin.version, plugin.label, plugin.meaning]));
  for (const plugin of discussionCatalog.plugins) {
    const native = fullCatalog.plugins.find(item => item.id === plugin.id)!;
    for (const cap of plugin.capabilities) {
      const { retry: _, timeoutMs: __, ...expected } = native.capabilities.find(item => item.id === cap.id)!;
      assert.deepEqual(cap, expected, 'Reply index preserves exact approved capabilities, effects, confirmations, and complete typed port meanings');
    }
    assert.equal('dataTypes' in plugin, false); assert.equal('dependencies' in plugin, false);
  }
  reviewTaskState.reads = 0;
  // All three entry routes use actual production handlers. Legacy lacks presentation aliases,
  // while manual adds an installed capability through its ordinary user-facing library.
  for (const route of ['prebuilt', 'manual', 'legacy'] as const) for (const deferStateUpdates of [false, true]) {
    const local = structuredClone(definition);
    if (route === 'legacy') for (const node of local.initial.execution!.nodes) delete node.presentation;
    const scene = createS2Scene(reviewTaskRequest); scene.canvasWorkspace = local;
    let host!: S2PluginHost;
    const ui = harness({ initialRequest: reviewTaskRequest, initialDraft: scene, projectNoteSource: reviewTaskSource, deferStateUpdates, onHost(value) { host = value; } });
    try {
      const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
      const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
      ui.button('开始试验').props.onClick(); ui.render();
      const reads = reviewTaskState.reads;
      focus('render'); ui.button('运行所选步骤').props.onClick(); ui.render();
      assert.equal(host.workflowHistory().length, 0); assert.equal(reviewTaskState.reads, reads); assert.equal(host.remainingCalls, 64);
      ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'reference-note' } }); ui.render();
      assert.equal(reviewTaskState.reads, reads); assert.equal(host.workflowHistory().length, 0);
      focus('readReference'); const handle = host.projectNoteSummary()[0].id;
      ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: handle } }); ui.render();
      assert.equal(reviewTaskState.reads, reads); assert.equal(host.remainingCalls, 64);
      focus('render');
      const inline = () => ui.inline('render');
      assert.ok(inline().elements().some(element => element.props['aria-label'] === '提示词排版来源'));
      assert.ok(!inline().elements().some(element => element.type === 'form'), 'A field-backed render owns no duplicate source form');
      const oldTemplate = document().nodes.find((node: any) => node.id === 'template').values.content;
      assert.equal(oldTemplate, local.initial.nodes.find(node => node.id === 'template')!.values.content);
      inline().button('编辑原内容').props.onClick(); ui.render();
      const source = ui.flow().props.nodes.find((node: any) => node.id === 'template');
      assert.equal(source.selected, true); assert.equal(source.data.fields[0].editor.props.variant, 'inline');
      submitS2InlineContent(ui, 'template', oldTemplate.replace('# 提示词草稿', '# 核对草稿')); focus('render');
      const applied = document().nodes.find((node: any) => node.id === 'template').values.content;
      assert.equal(applied, oldTemplate.replace('# 提示词草稿', '# 核对草稿')); assert.equal(reviewTaskState.reads, reads);
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64);
      let addedId: string | undefined;
      if (route === 'manual') {
        addS2PackCapability(ui, 'text-template@1.0.0/render');
        const added = document().execution.nodes.find((node: any) => !definition.initial.execution!.nodes.some(item => item.id === node.id));
        assert.ok(added); addedId = added.id; assert.equal(added.capabilityId, 'render'); assert.equal(host.remainingCalls, 64);
        // Complete the ordinary material pickers; no generated presentation or protocol editor needed.
        ui.labelControl('为提示词排版模板选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['field', 'template', 'content']) } }); ui.render();
        ui.labelControl('为已汇集的内容选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['output', 'bindReference', 'variables']) } }); ui.render();
        assert.ok(ui.inline(added.id).elements().some(e => e.props['aria-label'] === '提示词排版来源'));
        assert.deepEqual(added.bindings.template, undefined, 'Adding does not implicitly copy template parameters');
        assert.deepEqual(document().execution.nodes.find((node: any) => node.id === added.id).bindings.template, { kind: 'field', nodeId: 'template', fieldId: 'content' });
      }
      // First assembly is deliberately separate from running the confirmation path.
      ui.button('运行所选步骤').props.onClick(); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      assert.equal(reviewTaskState.reads, reads + 1); assert.equal(host.remainingCalls, 58);
      const text = expected(applied), first = host.workflowHistory().at(-1)!;
      const output = host.currentArtifact(first.nodes.find(node => node.nodeId === (addedId ?? 'render'))!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.equal(output.payload.value, text);
      assert.equal(host.waitingHumanInputs().length, 0);
      if (addedId) {
        // Undo only the two connections and manual addition; prior material/template edits remain.
        for (let i = 0; i < 3; i++) { ui.keyShortcut('undo'); ui.render(); }
        assert.ok(!document().execution.nodes.some((node: any) => node.id === addedId)); assert.equal(host.remainingCalls, 58);
      }
      focus('confirmText'); ui.button('运行所选步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      let human = ui.elements().find(e => e.type === 'human-input')!;
      const reviewRemaining = route === 'manual' ? 55 : 56;
      assert.equal(host.remainingCalls, reviewRemaining); assert.equal(reviewTaskState.reads, reads + 2);
      assert.equal(ui.labelControl('向 Agent 提出要求', 'textarea').props.disabled, false);
      assert.deepEqual(human.props.wait.artifacts[0].payload.value, { review: text });
      const { key: unusedKey, ...humanProps } = human.props;
      const markup = renderToStaticMarkup(<S2HumanInput {...humanProps as React.ComponentProps<typeof S2HumanInput>} />);
      assert.ok(markup.includes('完整参考文字')); assert.ok(markup.includes('原始数据（高级）'));
      assert.ok(markup.includes(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')));
      const stale = human.props.onSubmit;
      // Any source edit retires the old wait; undo cannot resurrect it or refund calls.
      submitS2InlineContent(ui, 'role', '新的原文');
      assert.equal(host.waitingHumanInputs().length, 0); assert.throws(() => stale(true), /失效/);
      ui.keyShortcut('undo'); ui.render(); assert.equal(host.waitingHumanInputs().length, 0); assert.equal(host.remainingCalls, reviewRemaining);
      assert.equal(document().nodes.find((node: any) => node.id === 'role').values.content,
        local.initial.nodes.find(node => node.id === 'role')!.values.content, 'Undo restores the exact source, never the retired wait');
      // Continue with both explicit branch targets (or the preserved approval target in the manual route).
      ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      human = ui.elements().find(e => e.type === 'human-input')!;
      const before = host.remainingCalls, readBefore = reviewTaskState.reads;
      human.props.onSubmit(false); assert.throws(() => human.props.onSubmit(true), /失效|提交/);
      await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      const rejected = host.workflowHistory().at(-1)!;
      assert.equal(rejected.nodes.find(node => node.nodeId === 'acceptedText')!.status, 'skipped');
      {
        const result = rejected.nodes.find(node => node.nodeId === 'declinedText')!; assert.equal(result.status, 'succeeded');
        const artifact = host.currentArtifact(result.artifactIds[0]); assert.ok(artifact.payload.kind === 'inline');
        if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, '暂不确认，仅保留待修改文本：\n' + text);
        assert.equal(host.remainingCalls, before - 1);
      }
      assert.equal(reviewTaskState.reads, readBefore, 'Submitting a decision never replays the already-read material');
      ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      const approve = ui.elements().find(e => e.type === 'human-input')!, preApproval = host.remainingCalls;
      approve.props.onSubmit(true); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      const approved = host.workflowHistory().at(-1)!, result = approved.nodes.find(node => node.nodeId === 'acceptedText')!;
      assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, preApproval - 1);
      const artifact = host.currentArtifact(result.artifactIds[0]); if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, text);
      const restored = importS2Workspace(exportS2Workspace(local, document()));
      const reopened = new S2PluginHost('ReopenedReview', restored.plugins); reopened.bindProjectNotes(reviewTaskSource); reopened.setDocument(restored.initial);
      try { assert.equal((await reopened.enqueueWorkflow(['acceptedText']).completion).status, 'failed'); assert.equal(reopened.waitingHumanInputs().length, 0); }
      finally { reopened.close(); }
      ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      const cancelled = ui.elements().find(e => e.type === 'human-input')!; cancelled.props.onCancel(); ui.render();
      await settle(() => host.workflowHistory().at(-1)?.status === 'cancelled', ui.render);
      assert.throws(() => cancelled.props.onSubmit(true), /失效/);
      const spent = host.remainingCalls; ui.button('结束试验').props.onClick(); ui.render();
      assert.equal(ui.labelControl('向 Agent 提出要求', 'textarea').props.disabled, true); assert.equal(host.remainingCalls, spent);
      assert.equal(ui.modelCalls(), 0); assert.equal(document().execution.nodes.find((node: any) => node.id === 'render').bindings.template.kind, 'field');
    } finally { ui.dispose(); }
  }
  // Full readable strings only. Mixed/nested/empty/large dictionaries keep exact raw JSON,
  // without confusing a view projection with data conversion or truncating stored artifacts.
  const artifact: S2Artifact = { protocolVersion: 1, id: 'readable', type: { id: 'structured-data.value', version: 1 }, complete: true,
    source: { kind: 'user', sceneId: 'synthetic', runId: 'run', nodeId: 'source', revision: 1 }, payload: { kind: 'inline', value: '' } };
  for (const value of ['  中文\r\n$& {{literal}} <script>原文</script>  ', { a: '中文\n换行', b: '' }, { a: '字'.repeat(6000) }]) {
    artifact.payload = { kind: 'inline', value }; const raw = JSON.stringify(artifact);
    const html = renderToStaticMarkup(<S2ArtifactView artifact={artifact} presentation="reading" />);
    assert.ok(html.includes('完整参考文字')); assert.ok(html.includes('原始数据（高级）')); assert.ok(!html.includes('<script>'));
    assert.equal(JSON.stringify(artifact), raw);
  }
  for (const value of [{}, [], { a: 0 }, { a: { x: 'text' } }, Array.from({ length: 2 }, () => '文字'), Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x${i}`, 'text']))]) {
    artifact.payload = { kind: 'inline', value };
    const html = renderToStaticMarkup(<S2ArtifactView artifact={artifact} presentation="reading" />);
    assert.ok(!html.includes('完整参考文字')); assert.ok(html.includes('<pre'));
  }
  assert.equal(JSON.stringify(definition), original); assert.equal(network, 0);
  console.log('S2 combined review task passed: prebuilt/manual-library/legacy-alias-free routes under ordinary/deferred hooks, separate allow/select/apply/assembly/review, exact full source text, reading/raw view preservation, explicit approval/refusal branches, stale edit/undo/cancel/end and inert import guards. Real local production handlers with synthetic notes only; zero model/network, not live semantic or ordinary-user usability acceptance.');
} finally { globalThis.fetch = previous; }
