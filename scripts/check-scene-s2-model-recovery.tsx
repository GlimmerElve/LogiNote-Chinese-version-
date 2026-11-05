import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2ModelRequestDiagnostic } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession, type S2ModelTestLimits } from '../src/services/scene/sceneS2ModelTest';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import type { S2Document } from '../src/types/sceneS2';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

// Keep the exact installed model capability scope while testing the base recovery UI.
const restoreCanvasUi = useGenericS2CanvasUi();
const definition = importS2Workspace(readFileSync('scripts/fixtures/s2-model-recovery-workspace.json', 'utf8'));
const initial = JSON.stringify(definition), hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const diagnostic = (reason: S2ModelRequestDiagnostic['reason']): S2ModelRequestDiagnostic => ({ kind: 'model-request', reason });
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Model recovery uses only synthetic injected transports'); };
const defaultLimits = { maxRequests: 1, maxReservedOutputTokens: 1024, maxOutputTokens: 512 };
function hostFor(document = definition.initial) { const host = new S2PluginHost('SyntheticModelRecovery', definition); host.setDocument(document); hosts.push(host); return host; }
function sessionFor(host: S2PluginHost, limits = defaultLimits, invoke = async () => ({ content: '完整合成回复', diagnostics: { finishReason: 'stop' } })) {
  return new S2ModelTestSession({ sceneId: 'SyntheticModelRecovery', runId: host.runId, resourceId: `SyntheticResource-${crypto.randomUUID()}`,
    providerId: 'synthetic', providerLabel: '合成服务（不是真实模型）', model: 'synthetic-model', limits, invoke });
}
function enqueueError(host: S2PluginHost) { let error: unknown; try { host.enqueueWorkflow(['model']); } catch (caught) { error = caught; } assert.ok(error); return error; }
async function waitFor(test: () => boolean, render = () => {}) {
  for (let i = 0; i < 600; i++) { render(); if (test()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Synthetic model recovery did not settle');
}
try {
  const host = hostFor(), missing = enqueueError(host), gate = { nodeId: 'model', diagnostic: diagnostic('authorization-missing') };
  assert.deepEqual(host.readWorkflowPreflightDiagnostic(missing), gate); assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
  assert.equal(host.readWorkflowPreflightDiagnostic(new Error((missing as Error).message)), null);
  assert.equal(host.readWorkflowPreflightDiagnostic(structuredClone(missing)), null); assert.equal(hostFor().readWorkflowPreflightDiagnostic(missing), null);
  const gateClone = host.readWorkflowPreflightDiagnostic(missing)!; gateClone.nodeId = 'forged'; assert.deepEqual(host.readWorkflowPreflightDiagnostic(missing), gate);
  const newer = enqueueError(host); assert.equal(host.readWorkflowPreflightDiagnostic(missing), null);
  await host.enqueueWorkflow(['independent']).completion; assert.equal(host.readWorkflowPreflightDiagnostic(newer), null); assert.equal(host.remainingCalls, 63);
  const beforeApproval = enqueueError(host), session = sessionFor(host); host.approveModelTestSession(session); assert.equal(host.readWorkflowPreflightDiagnostic(beforeApproval), null);
  const first = host.enqueueWorkflow(['model']); await waitFor(() => host.waitingModelTests().length === 1);
  assert.equal(host.remainingCalls, 61); const firstWait = host.waitingModelTests()[0]; host.confirmModelTest(first.id, firstWait.id, false);
  const rejected = await first.completion; assert.equal(rejected.status, 'failed'); assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'model'), diagnostic('user-declined'));
  assert.equal(host.modelTestSummary()!.usedRequests, 0); assert.equal(host.modelTestSummary()!.reservedOutputTokens, 0);
  assert.equal(host.history().length, 3); assert.equal(rejected.nodes.find(node => node.nodeId === 'model')!.status, 'cancelled');
  const readArtifact = host.currentArtifact; host.currentArtifact = () => { throw new Error('Formatting may not resolve output data'); };
  assert.match(s2RuntimeIssue(definition, definition.initial, 'model', host.readWorkflowDiagnostic(first.id, 'model'))!.detail, /不是服务商报错/);
  host.currentArtifact = readArtifact;
  const second = host.enqueueWorkflow(['model']); assert.equal(host.readWorkflowDiagnostic(first.id, 'model'), null);
  await waitFor(() => host.waitingModelTests().length === 1); host.confirmModelTest(second.id, host.waitingModelTests()[0].id, true); assert.equal((await second.completion).status, 'succeeded');
  assert.equal(session.summary().usedRequests, 1); assert.equal(session.summary().reservedOutputTokens, 512);
  const third = await host.enqueueWorkflow(['model']).completion; assert.equal(third.status, 'failed');
  assert.deepEqual(host.readWorkflowDiagnostic(third.id, 'model'), diagnostic('budget-exhausted')); assert.equal(host.waitingModelTests().length, 0);
  let nativeBudgetError: unknown; try { session.preview('完整合成提示词'); } catch (error) { nativeBudgetError = error; }
  assert.ok(session.ownsBudgetFailure(nativeBudgetError)); assert.ok(!session.ownsBudgetFailure(new Error((nativeBudgetError as Error).message)));
  assert.ok(!sessionFor(host).ownsBudgetFailure(nativeBudgetError)); assert.ok(!session.ownsBudgetFailure(structuredClone(nativeBudgetError)));
  session.close(); const closed = enqueueError(host); assert.deepEqual(host.readWorkflowPreflightDiagnostic(closed), { nodeId: 'model', diagnostic: diagnostic('authorization-closed') });
  const changed = structuredClone(definition.initial); changed.nodes[0].values.content += '变更'; host.setDocument(changed); host.setDocument(definition.initial);
  assert.equal(host.readWorkflowPreflightDiagnostic(closed), null);
  // Both independent ceilings: remaining requests cannot compensate for insufficient full-output reservation.
  const tokenHost = hostFor(), tokenSession = sessionFor(tokenHost, { maxRequests: 3, maxReservedOutputTokens: 512, maxOutputTokens: 512 }); tokenHost.approveModelTestSession(tokenSession);
  const tokenFirst = tokenHost.enqueueWorkflow(['model']); await waitFor(() => tokenHost.waitingModelTests().length === 1);
  tokenHost.confirmModelTest(tokenFirst.id, tokenHost.waitingModelTests()[0].id, true); await tokenFirst.completion;
  const tokenBlocked = await tokenHost.enqueueWorkflow(['model']).completion; assert.deepEqual(tokenHost.readWorkflowDiagnostic(tokenBlocked.id, 'model'), diagnostic('budget-exhausted'));
  assert.equal(tokenSession.summary().usedRequests, 1); assert.equal(tokenSession.summary().reservedOutputTokens, 512);
  // Revocation retires waiting model requests while an independently queued local step can still run.
  const revoke = hostFor(), revokeSession = sessionFor(revoke); revoke.approveModelTestSession(revokeSession);
  const pending = revoke.enqueueWorkflow(['model']); await waitFor(() => revoke.waitingModelTests().length === 1); revoke.revokeModelTests();
  assert.equal((await pending.completion).status, 'failed'); assert.deepEqual(revoke.readWorkflowDiagnostic(pending.id, 'model'), diagnostic('authorization-closed'));
  assert.equal((await revoke.enqueueWorkflow(['independent']).completion).status, 'succeeded'); assert.equal(revokeSession.summary().usedRequests, 0);
  // Unsupported preparation errors and a provider imitating a budget message must not acquire local budget evidence.
  const invalid = structuredClone(definition.initial); invalid.nodes[0].values.content = ' ';
  const invalidHost = hostFor(invalid); invalidHost.approveModelTestSession(sessionFor(invalidHost));
  const invalidRun = await invalidHost.enqueueWorkflow(['model']).completion; assert.equal(invalidRun.status, 'failed'); assert.equal(invalidHost.readWorkflowDiagnostic(invalidRun.id, 'model'), null);
  const fakeHost = hostFor(); fakeHost.approveModelTestSession(sessionFor(fakeHost, defaultLimits, async () => { throw new Error('S2 模型测试本局请求或输出预留预算已用尽；失败和取消不退款'); }));
  const fakeJob = fakeHost.enqueueWorkflow(['model']); await waitFor(() => fakeHost.waitingModelTests().length === 1); fakeHost.confirmModelTest(fakeJob.id, fakeHost.waitingModelTests()[0].id, true);
  assert.equal((await fakeJob.completion).status, 'failed'); assert.equal(fakeHost.readWorkflowDiagnostic(fakeJob.id, 'model'), null);
  for (const value of ['authorization-missing', 'authorization-closed', 'budget-exhausted', 'user-declined'] as const) {
    const document = structuredClone(definition.initial); let reads = 0;
    Object.defineProperty(document.nodes[0].values, 'content', { enumerable: true, get() { reads++; throw new Error('No material reads'); } });
    const issue = s2RuntimeIssue(definition, document, 'model', diagnostic(value))!; assert.equal(reads, 0); assert.deepEqual(issue.nodeIds, ['model']);
    assert.ok(!JSON.stringify(issue).includes('{{literal}}')); assert.equal(s2RuntimeIssue(definition, document, 'input', diagnostic(value)), null);
    assert.equal(s2RuntimeIssue(definition, document, 'model', { ...diagnostic(value), prompt: 'not allowed' }), null);
  }

  for (const deferred of [false, true]) {
    const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: 'Synthetic model recovery', knowledgePoints: [], interactionPack: { id: 'prompt-lab', version: '0.1.0' } }); scene.canvasWorkspace = structuredClone(definition);
    let live!: S2PluginHost, preparations = 0, calls = 0;
    const ui = harness({ initialDraft: scene, deferStateUpdates: deferred, onHost: value => { live = value; }, modelProvider: async () => {
      preparations++; return { resourceId: 'SyntheticUiResource', providerLabel: '合成服务', model: 'synthetic-model', supportsImages: false, createSession(sceneId: string, runId: string, limits: S2ModelTestLimits) {
        return new S2ModelTestSession({ sceneId, runId, resourceId: 'SyntheticUiResource', providerId: 'synthetic', providerLabel: '合成服务', model: 'synthetic-model', limits,
          invoke: async request => { calls++; assert.equal(request.systemPromptOverride, definition.initial.nodes[0].values.content); return { content: '完整合成回复', diagnostics: { finishReason: 'stop' } }; } });
      } };
    } }); uis.push(ui); ui.button('开始试验').props.onClick(); ui.render();
    const settle = (test: () => boolean) => waitFor(test, ui.render);
    const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const panel = () => ui.elements().find(item => item.props['aria-label'] === '运行问题与恢复');
    const ledger = () => JSON.stringify([document(), live.history(), live.workflowHistory(), live.remainingCalls, live.modelTestSummary(), calls, preparations, ui.modelCalls(), ui.saved]);
    const queue = async () => { focus('model'); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)!.status === 'waiting'); return live.workflowHistory().at(-1)!; };
    focus('model'); ui.button('运行所选步骤').props.onClick(); ui.render(); assert.ok(panel()); assert.match(ui.text(panel()), /尚未单独批准/);
    assert.equal(live.workflowHistory().length, 0); assert.equal(live.remainingCalls, 64); assert.equal(preparations, 0);
    let authFocused = 0; ui.elements().find(item => item.props['aria-label'] === '模型测试授权与用量')!.props.ref.current = { focus() { authFocused++; }, scrollIntoView() {} };
    const beforeView = ledger(), oldView = ui.button('查看模型授权与用量（不发送）').props.onClick; oldView(); ui.render(); assert.equal(authFocused, 1); assert.equal(ledger(), beforeView);
    oldView(); ui.render(); assert.equal(authFocused, 1); assert.equal(preparations, 0);
    ui.button('准备本局模型测试（不发送）').props.onClick(); await settle(() => ui.text().includes('核对并批准本局预算'));
    for (const [label, value] of [['模型请求次数上限', '1'], ['单次输出 tokens 上限', '512'], ['总预留输出 tokens 上限', '512']]) { ui.labelControl(label, 'input').props.onChange({ target: { value } }); ui.render(); }
    const oldApprove = ui.button('批准本局模型测试预算（仍逐次确认）').props.onClick; oldApprove(); ui.render(); assert.equal(calls, 0);
    const first = await queue(), firstWait = live.waitingModelTests()[0];
    const firstForm = () => ui.elements().find(item => item.type === 'fieldset' && item.props['aria-label'] === `确认模型请求 ${s2ConnectionNodeLabel(definition, document(), 'model')} · 第 1 次运行`)!;
    let focused = 0; firstForm().props.ref({ focus() { focused++; }, scrollIntoView() {} });
    const firstLabel = `前往核对模型请求 · ${s2ConnectionNodeLabel(definition, document(), 'model')} · 第 1 次运行`;
    const oldSend = ui.button('确认发送本次模型请求').props.onClick, oldLocate = ui.button(firstLabel).props.onClick, beforeLocate = ledger();
    const read = live.currentArtifact; live.currentArtifact = () => { throw new Error('Request navigation cannot read artifacts'); }; oldLocate(); live.currentArtifact = read; ui.render();
    assert.equal(focused, 1); assert.equal(ledger(), beforeLocate); oldSend(); ui.render(); assert.equal(calls, 0);
    ui.button('拒绝本次模型请求').props.onClick(); await settle(() => live.workflowHistory().at(-1)!.status === 'failed');
    assert.match(ui.text(), /没有发送或新增模型用量/); assert.deepEqual(live.readWorkflowDiagnostic(first.id, 'model'), diagnostic('user-declined'));
    assert.throws(() => live.confirmModelTest(first.id, firstWait.id, true), /失效/); assert.equal(calls, 0);
    ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'model')}`).props.onClick(); ui.render(); assert.match(ui.text(panel()), /你已拒绝/);
    const second = await queue(); const third = await queue(); assert.equal(live.waitingModelTests().length, 2);
    const sends = ui.elements().filter(item => item.type === 'button' && ui.text(item) === '确认发送本次模型请求');
    const staleSecondSend = sends[1].props.onClick; sends[0].props.onClick();
    await settle(() => live.workflowHistory().find(run => run.id === second.id)!.status === 'succeeded'); staleSecondSend(); ui.render();
    assert.equal(calls, 1); assert.equal(live.modelTestSummary()!.usedRequests, 1); assert.equal(live.waitingModelTests().length, 1);
    assert.equal(ui.button('确认发送本次模型请求').props.disabled, true); assert.equal(ui.button('拒绝本次模型请求').props.disabled, false);
    assert.match(ui.text(), /这项请求尚未发送，但本局预算已不足/);
    ui.button('拒绝本次模型请求').props.onClick(); await settle(() => live.workflowHistory().find(run => run.id === third.id)!.status === 'failed');
    focus('model'); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)!.status === 'failed');
    ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'model')}`).props.onClick(); ui.render(); assert.match(ui.text(panel()), /预算不足一次完整模型请求/);
    const preEditView = ui.button('查看模型授权与用量（不发送）').props.onClick, original = JSON.stringify(document());
    ui.button('＋待测提示词').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); assert.equal(JSON.stringify(document()), original);
    const stable = ledger(); preEditView(); oldLocate(); ui.render(); assert.equal(ledger(), stable);
    ui.button('撤回模型测试权限').props.onClick(); ui.render(); assert.equal(live.modelTestSummary()!.active, false);
    focus('model'); ui.button('运行所选步骤').props.onClick(); ui.render(); assert.match(ui.text(panel()), /本局模型授权已关闭/);
    const beforeOld = ledger(); oldApprove(); ui.render(); assert.equal(ledger(), beforeOld);
    const endView = ui.button('查看模型授权与用量（不发送）').props.onClick; ui.button('结束试验').props.onClick(); endView(); ui.render();
    assert.equal(live.waitingModelTests().length, 0); assert.equal(calls, 1); assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0);
  }
  assert.equal(network, 0); assert.equal(JSON.stringify(definition), initial);
  console.log('S2 model recovery passed: host-branded current preflight and native budget evidence, distinct missing/closed/budget/user-declined reasons, zero-material formatting, exact read-only authorization/request navigation, full original per-call confirmation, stale/duplicate/edit-undo/end guards, simultaneous waits with exhausted send disabled but reject available, unchanged independent count/output ceilings and spent ledgers, preserved human waits, no automatic authorization, retries, real model or resource IO. Browser focus checked separately.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); restoreCanvasUi(); globalThis.fetch = oldFetch; }
