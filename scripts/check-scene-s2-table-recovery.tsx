import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2LocalAdapter } from '../src/services/scene/sceneS2PluginHost';
import { recordsToS2Table, type S2StructuredFailureDiagnostic } from '../src/services/scene/sceneS2Structured';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import type { SceneInitialRequest } from '../src/types';
import { harness } from './scene-s2-ui-harness';

const definition = importS2Workspace(readFileSync('scripts/fixtures/s2-table-recovery-workspace.json', 'utf8'));
const initialKey = JSON.stringify(definition), hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const reason = (value: S2StructuredFailureDiagnostic['reason']): S2StructuredFailureDiagnostic => ({ kind: 'structured-transform', reason: value, inputPortIds: ['value'] });
const recordMessage = '转表格需要最多100行的记录数组；请先用 select 提取数组', columnMessage = '表格最多24列，列名最多120字';
function directDocument(value: S2Json) {
  const table = structuredClone(definition.initial.execution!.nodes[2]), view = structuredClone(definition.initial.execution!.nodes[3]);
  table.bindings.value = literal(value);
  return readS2Document({ nodes: [], edges: [], execution: { version: 1, nodes: [table, view], links: [definition.initial.execution!.links[2]] } }, definition);
}
function makeHost(document: S2Document, adapter?: S2LocalAdapter) {
  const host = new S2PluginHost('table-recovery-synthetic', definition, adapter); hosts.push(host); host.setDocument(document); return host;
}
const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Local table recovery must not access external IO'); };
try {
  const cases: Array<[S2Json, S2StructuredFailureDiagnostic['reason'], string]> = [
    [{ rows: [{ name: 'PRIVATE_MATERIAL' }] }, 'table-records-required', recordMessage],
    [[null, false, 0], 'table-records-required', recordMessage],
    [Array.from({ length: 101 }, () => ({})), 'table-row-limit', recordMessage],
    // Keep native check precedence when more than one problem exists.
    [Array(101).fill(false), 'table-row-limit', recordMessage],
    [[Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`a${i}`, 0])), Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`b${i}`, false]))], 'table-column-limit', columnMessage],
    [[{ ['x'.repeat(121)]: 0 }], 'table-column-name-limit', columnMessage],
    [[{ ['😀'.repeat(61)]: null }], 'table-column-name-limit', columnMessage],
    [[{ PRIVATE_COLUMN: { nested: true } }], 'table-nested-cell', '列 PRIVATE_COLUMN 包含嵌套值；请显式提取或转换，不能自动压平'],
    [[{ PRIVATE_COLUMN: [] }], 'table-nested-cell', '列 PRIVATE_COLUMN 包含嵌套值；请显式提取或转换，不能自动压平'],
  ];
  for (const [value, expected, message] of cases) {
    const document = directDocument(value), original = JSON.stringify(document), host = makeHost(document), run = await host.enqueueWorkflow(['view']).completion;
    assert.equal(run.status, 'failed'); assert.equal(run.nodes[0].status, 'failed'); assert.equal(run.nodes[1].status, 'blocked');
    assert.deepEqual(host.readWorkflowDiagnostic(run.id, 'table'), reason(expected)); assert.equal(host.remainingCalls, 63); assert.equal(host.history().length, 1);
    assert.deepEqual(host.history()[0].receipt.error, { code: 'TRANSFORM_REJECTED', message });
    assert.deepEqual(run.nodes[0].artifactIds, []); assert.equal(JSON.stringify(document), original);
    assert.throws(() => recordsToS2Table(value), error => error instanceof Error && error.name === 'Error' && error.message === message);
    const before = JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]);
    const actualRead = host.currentArtifact; host.currentArtifact = () => { throw new Error('Diagnostic cannot read data'); };
    const issue = s2RuntimeIssue(definition, document, 'table', host.readWorkflowDiagnostic(run.id, 'table'))!;
    host.currentArtifact = actualRead;
    assert.equal(issue.kind, 'structured-transform'); assert.deepEqual(issue.nodeIds, ['table']); assert.ok(!JSON.stringify(issue).includes('PRIVATE_'));
    assert.match(issue.detail, /待整理的数据/); assert.equal(JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]), before);
    // A diagnostic does not inspect the fixed material, even if the caller gives a hostile value property.
    const guarded = structuredClone(document); let reads = 0;
    Object.defineProperty(guarded.execution!.nodes[0].bindings.value, 'value', { enumerable: true, get: () => { reads++; throw new Error('No material reads'); } });
    assert.ok(s2RuntimeIssue(definition, guarded, 'table', reason(expected))); assert.equal(reads, 0);
    assert.equal(s2RuntimeIssue(definition, document, 'table', { ...reason(expected), inputPortIds: ['text'] }), null);
    assert.equal(s2RuntimeIssue(definition, document, 'table', { ...reason(expected), column: 'PRIVATE_COLUMN' }), null);
    const clone = host.readWorkflowDiagnostic(run.id, 'table'); if (clone?.kind === 'structured-transform') clone.inputPortIds.push('fake');
    assert.deepEqual(host.readWorkflowDiagnostic(run.id, 'table'), reason(expected));
    host.setDocument(directDocument([])); assert.equal(host.readWorkflowDiagnostic(run.id, 'table'), null); assert.equal(host.remainingCalls, 63);
    assert.equal((await host.enqueueWorkflow(['view']).completion).status, 'succeeded');
    host.setDocument(document); assert.equal(host.readWorkflowDiagnostic(run.id, 'table'), null);
  }
  const records = [{ name: '', score: 0, ready: false, memo: null }, { name: '合成乙' }];
  for (const value of [[], records, Array.from({ length: 100 }, () => ({})), [Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`c${i}`, i]))], [{ ['x'.repeat(120)]: 0 }], [{ ['😀'.repeat(60)]: null }], [{ note: 'x'.repeat(1998) }]]) {
    const host = makeHost(directDocument(value)), run = await host.enqueueWorkflow(['view']).completion;
    assert.equal(run.status, 'succeeded'); assert.equal(host.readWorkflowDiagnostic(run.id, 'table'), null); assert.equal(host.remainingCalls, 63);
    const artifact = host.currentArtifact(run.nodes[0].artifactIds[0]); assert.equal(artifact.payload.kind, 'inline');
    if (artifact.payload.kind === 'inline') assert.deepEqual(artifact.payload.value, recordsToS2Table(value) as unknown as S2Json);
  }
  // Conversion shape is legal, but publishing a cell still has its original 2,000-byte JSON bound.
  // Do not mislabel a later artifact rejection as one of the converter's native failure categories.
  const longCell = [{ note: 'x'.repeat(1999) }], oversized = makeHost(directDocument(longCell));
  assert.equal(recordsToS2Table(longCell).rows[0][0].value, longCell[0].note);
  const oversizedRun = await oversized.enqueueWorkflow(['view']).completion;
  assert.equal(oversizedRun.status, 'failed'); assert.equal(oversizedRun.nodes[0].status, 'failed');
  assert.equal(oversizedRun.nodes[1].status, 'blocked'); assert.equal(oversized.readWorkflowDiagnostic(oversizedRun.id, 'table'), null);
  assert.equal(oversized.history()[0].receipt.error!.code, 'TRANSFORM_REJECTED');
  assert.match(oversized.history()[0].receipt.error!.message, /完整载荷限制/); assert.deepEqual(oversizedRun.nodes[0].artifactIds, []);
  assert.equal(oversized.remainingCalls, 63);
  const exactTable = recordsToS2Table(records);
  assert.deepEqual(exactTable.rows[0].map(cell => cell.value), ['', 0, false, null]);
  assert.deepEqual(exactTable.rows[1].slice(1), Array.from({ length: 3 }, () => ({ present: false, value: null })));
  const noSelect = structuredClone(definition); noSelect.plugins = noSelect.plugins!.filter(plugin => plugin.capabilityId !== 'select'); noSelect.initial = directDocument({});
  const noSelectIssue = s2RuntimeIssue(readS2Definition(noSelect), noSelect.initial, 'table', reason('table-records-required'))!;
  assert.ok(!noSelectIssue.detail.includes('自行添加')); assert.match(noSelectIssue.detail, /当前不会自动添加/);
  const fake = makeHost(directDocument({}), async () => ({ status: 'failed', outputs: {}, error: { code: 'TRANSFORM_REJECTED', message: recordMessage } }));
  const fakeRun = await fake.enqueueWorkflow(['table']).completion; assert.equal(fake.readWorkflowDiagnostic(fakeRun.id, 'table'), null);

  // Actual production handlers: a wrapped record collection fails until the user deliberately selects its records field.
  const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成表格恢复', knowledgePoints: [] };
  function makeUi(deferred: boolean, value: S2CanvasDefinition = definition) {
    const draft = createS2Scene(request); draft.canvasWorkspace = structuredClone(value); let host!: S2PluginHost;
    const ui = harness({ initialRequest: request, initialDraft: draft, deferStateUpdates: deferred, onHost: current => { host = current; } }); uis.push(ui);
    ui.button('开始试验').props.onClick(); ui.render();
    const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
    const panel = () => ui.elements().find(item => item.type === 'section' && item.props['aria-label'] === '运行问题与恢复');
    const label = (id: string) => s2ConnectionNodeLabel(value, document(), id);
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const action = (text: string) => { const button = ui.elements().filter(item => item.type === 'button' && ui.text(item) === text && !item.props.disabled).at(-1); assert.ok(button, text); return button.props.onClick; };
    const ledger = () => JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls, ui.modelCalls(), ui.saved]);
    return { ui, host: () => host, document, panel, label, focus, action, ledger };
  }
  async function run(trial: ReturnType<typeof makeUi>) {
    trial.focus('view'); const count = trial.host().workflowHistory().length;
    trial.ui.button('运行所选步骤').props.onClick(); trial.ui.render();
    for (let i = 0; i < 300 && (trial.host().workflowHistory().length === count || ['running', 'queued'].includes(trial.host().workflowHistory().at(-1)!.status)); i++) {
      await new Promise(resolve => setImmediate(resolve)); trial.ui.render();
    }
    assert.equal(trial.host().workflowHistory().length, count + 1); return trial.host().workflowHistory().at(-1)!;
  }
  for (const deferred of [false, true]) {
    const trial = makeUi(deferred), first = await run(trial); assert.equal(first.nodes.find(node => node.nodeId === 'table')!.status, 'failed');
    assert.equal(trial.host().remainingCalls, 61); trial.action(`查看运行问题 · ${trial.label('table')}`)(); trial.ui.render();
    assert.ok(trial.panel()); assert.ok(trial.ui.text(trial.panel()).includes(trial.label('extract')));
    const original = JSON.stringify(trial.document()), ledger = trial.ledger();
    const locate = trial.action(`查看相关步骤 · ${trial.label('extract')}`); locate(); locate(); trial.ui.render();
    assert.equal(trial.ui.labelControl('选择执行节点', 'select').props.value, 'extract'); assert.equal(trial.panel(), undefined);
    assert.equal(JSON.stringify(trial.document()), original); assert.equal(trial.ledger(), ledger);
    assert.ok(!trial.ui.flow().props.nodes.some((node: any) => node.id === 'table-inner'));
    assert.ok(!trial.ui.elements().some(item => item.type === 'form' && item.props['aria-label'] === '设置提取字段'), 'Locating does not read the source');
    trial.ui.button('查看当前材料的字段（不运行）').props.onClick(); trial.ui.render();
    trial.ui.labelControl('要提取哪一部分', 'select').props.onChange({ target: { value: JSON.stringify('/rows') } }); trial.ui.render();
    const form = trial.ui.elements().find(item => item.type === 'form' && item.props['aria-label'] === '设置提取字段'); assert.ok(form);
    assert.equal(trial.ledger(), ledger); form.props.onSubmit({ preventDefault() {} }); trial.ui.render();
    assert.equal(trial.host().remainingCalls, 61); assert.equal(trial.host().workflowHistory().length, 1);
    assert.deepEqual(trial.document().nodes, definition.initial.nodes); assert.equal(trial.host().readWorkflowDiagnostic(first.id, 'table'), null);
    const successful = await run(trial); assert.equal(successful.status, 'succeeded'); assert.equal(trial.host().remainingCalls, 59);
    const artifact = trial.host().currentArtifact(successful.nodes.find(node => node.nodeId === 'table')!.artifactIds[0]);
    assert.equal(artifact.payload.kind, 'inline'); if (artifact.payload.kind === 'inline') {
      const source = JSON.parse(definition.initial.nodes[0].values.content).rows;
      assert.deepEqual(artifact.payload.value, recordsToS2Table(source) as unknown as S2Json);
    }
    const beforeOld = JSON.stringify(trial.document()), afterLedger = trial.ledger(); locate(); trial.ui.render();
    assert.equal(JSON.stringify(trial.document()), beforeOld); assert.equal(trial.ledger(), afterLedger);
    assert.equal(trial.ui.modelCalls(), 0); assert.equal(trial.ui.saved.length, 0);
  }
  // Nested cells have a different explanation and remain untouched until the user edits their actual source.
  const nested = structuredClone(definition); nested.initial.nodes[0].values.content = '{"rows":[{"PRIVATE_COLUMN":{"level":1}}]}';
  nested.initial.execution!.nodes[1].bindings.pointer = literal('/rows');
  const trial = makeUi(true, readS2Definition(nested)), failed = await run(trial);
  trial.action(`查看运行问题 · ${trial.label('table')}`)(); trial.ui.render(); assert.ok(trial.panel()); assert.match(trial.ui.text(trial.panel()), /对象或列表/);
  const before = JSON.stringify(trial.document()), ledger = trial.ledger(), oldLocation = trial.action(`查看相关步骤 · ${trial.label('table')}`);
  trial.ui.button('＋练习材料').props.onClick(); trial.ui.render(); trial.ui.keyShortcut('undo'); trial.ui.render();
  assert.equal(JSON.stringify(trial.document()), before); assert.equal(trial.panel(), undefined); assert.equal(trial.host().readWorkflowDiagnostic(failed.id, 'table'), null);
  oldLocation(); trial.ui.render(); assert.equal(trial.ui.labelControl('选择执行节点', 'select').props.value, 'view');
  assert.equal(trial.host().remainingCalls, JSON.parse(ledger)[2]); assert.equal(network, 0); assert.equal(JSON.stringify(definition), initialKey);
  console.log('S2 table recovery passed: native shape/row/union-column/name/nested reasons with original rejection messages, exact limits/falsy/missing preservation, metadata-only sources and forgery rejection, production nested source navigation plus deliberate field selection/application and separate successful execution, stale edit/undo callback retirement, no automatic data loss, model or resource IO.');
} finally { hosts.forEach(host => host.close()); uis.forEach(ui => ui.dispose()); globalThis.fetch = priorFetch; }
