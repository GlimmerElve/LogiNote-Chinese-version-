import assert from 'node:assert/strict';
import { argumentContextFixture, rebindArgumentFixture } from './argument-context-fixture';
import { argumentContextHash } from '../src/services/argumentContext/hash';
import { createArgumentContextPointer } from '../src/services/argumentContext/reader';
import { validateArgumentContextPack } from '../src/services/argumentContext/validator';
import { readTaskScopedArgumentContextPack, validateTaskScopedArgumentContextPack } from '../src/services/argumentContext/taskScopedReader';
import type { ArgumentTaskScopedPack, ArgumentTaskScopedTask } from '../src/services/argumentContext/taskScopedTypes';
import type { ArgumentContextBudget, ArgumentReviewedScope } from '../src/services/argumentContext/types';

// Pure synthetic authorities only: no vault, filesystem, network, model, index or score writes.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network is forbidden in task-scoped context checks');
let checks = 0;
const pass = (name: string) => { checks += 1; console.log(`PASS ${name}`); };
type Fixture = Awaited<ReturnType<typeof argumentContextFixture>>;
const cloneFixture = (f: Fixture): Fixture => ({ ...f, projection: structuredClone(f.projection),
  authority: structuredClone(f.authority), scope: structuredClone(f.scope), lines: [...f.lines] });
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
const codes = (pack: ArgumentTaskScopedPack) => pack.completeness.gaps.map((gap) => gap.code);
function declared(seedNodeId: string, task: ArgumentTaskScopedTask, requiredNodeIds: string[],
  requiredRelationIds: string[] = [], requiredGroupIds: string[] = []): ArgumentReviewedScope {
  return { seedNodeId, task, requiredNodeIds, requiredRelationIds, requiredGroupIds, status: 'reviewed_for_scope' };
}
async function read(f: Fixture, task: ArgumentTaskScopedTask = 'reasoning', seeds = ['result'], budget?: Partial<ArgumentContextBudget>) {
  const pointer = await createArgumentContextPointer(f.projection, f.authority, f.scope, seeds);
  const pack = await readTaskScopedArgumentContextPack(f.projection, f.authority, { pointer, scope: f.scope, task, ...(budget ? { budget } : {}) });
  await validateTaskScopedArgumentContextPack(pack, f.authority, f.scope, f.projection);
  return pack;
}
async function changed(action: (f: Fixture) => void) {
  const f = await argumentContextFixture(); action(f); return rebindArgumentFixture(f);
}
async function rehash(pack: ArgumentTaskScopedPack) {
  const { packHash: _old, ...body } = pack;
  pack.packHash = await argumentContextHash(body);
  return pack;
}

try {
  const f = await argumentContextFixture();
  const pack = await read(f);
  assert.equal(pack.version, 2); assert.equal(pack.readPolicy, 'reviewed-task-closure-v2');
  assert.equal(pack.completeness.status, 'complete_for_scope');
  assert.deepEqual(ids(pack.nodes), ['law', 'p1', 'p2', 'result', 'rule', 'threshold']);
  assert.deepEqual(ids(pack.relations), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(ids(pack.prerequisiteGroups), ['g-main', 'g-rule']);
  assert.ok(!JSON.stringify(pack).includes(f.lines[10]));
  assert.ok(!ids(pack.nodes).includes('example')); assert.ok(!ids(pack.nodes).includes('exception'));
  assert.equal(pack.limitations.semanticTruth, 'not_certified');
  assert.equal(pack.limitations.questionCoverage, 'not_assessed');
  assert.equal(pack.limitations.writes, 'disabled');
  assert.deepEqual(pack, await read(f));
  pass('v2只读取明确审核任务范围及组义务，不沿邻接扩展举例/例外/无关正文，确定性回放不等于真理');

  const definition = await changed((x) => {
    x.projection.build.scopes.push(declared('rule', 'definition', ['rule']));
    x.projection.nodes.find((node) => node.id === 'unrelated')!.admission = 'audit_only';
    x.projection.build.gaps.push({ code: 'unadmitted_node', targetId: 'unrelated' });
  });
  const definitionPack = await read(definition, 'definition', ['rule']);
  assert.equal(definitionPack.completeness.status, 'complete_for_scope');
  assert.deepEqual(ids(definitionPack.nodes), ['rule']);
  assert.deepEqual(ids(definitionPack.relations), []); assert.deepEqual(ids(definitionPack.prerequisiteGroups), []);
  assert.ok(!JSON.stringify(definitionPack).includes(definition.lines[7]));
  pass('定义任务不会被相邻证明组、举例支线或已定位的无关审核失败污染');

  const anotherTask = await changed((x) => {
    x.projection.build.scopes = [declared('result', 'fact', ['result']),
      { ...declared('result', 'reasoning', ['result', 'p1']), status: 'partial' }];
    x.projection.build.gaps.push({ code: 'scope_not_reviewed', targetId: 'result' });
  });
  assert.equal((await read(anotherTask, 'fact')).completeness.status, 'complete_for_scope');
  assert.notEqual((await read(anotherTask, 'reasoning')).completeness.status, 'complete_for_scope');
  pass('相同seed的别任务复核缺口不污染已审核fact，当前partial任务仍不升级');

  const scopedException = await changed((x) => {
    x.projection.build.scopes.push(declared('result', 'condition', ['result'], ['e7']));
  });
  const conditionPack = await read(scopedException, 'condition');
  assert.deepEqual(ids(conditionPack.nodes), ['exception', 'result']);
  assert.deepEqual(ids(conditionPack.relations), ['e7']);
  assert.equal(conditionPack.relations[0].sourceNodeId, 'exception');
  assert.equal(conditionPack.relations[0].targetNodeId, 'result');
  assert.equal(conditionPack.completeness.status, 'complete_for_scope');
  pass('显式条件/例外边闭包原端点且不反向推理，不自行补邻边');

  const groupOnly = await changed((x) => {
    x.projection.build.scopes = [declared('result', 'reasoning', ['result'], [], ['g-main'])];
  });
  const groupOnlyPack = await read(groupOnly);
  assert.deepEqual(ids(groupOnlyPack.nodes), ['p1', 'p2', 'result', 'rule', 'threshold']);
  assert.deepEqual(ids(groupOnlyPack.relations), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(ids(groupOnlyPack.prerequisiteGroups), ['g-main']);
  assert.equal(groupOnlyPack.prerequisiteGroups[0].operator, 'all');
  assert.ok(!groupOnlyPack.completeness.requiredGroupIds.includes('g-rule'));
  pass('显式必要组闭包全部前提/条件/关系，但不自动把其他组当本题义务');

  const any = await changed((x) => {
    const group = x.projection.prerequisiteGroups[0];
    group.premiseNodeIds = ['p1', 'p2']; group.conditionNodeIds = []; group.relationIds = ['e1', 'e2']; group.operator = 'any';
    x.projection.build.scopes = [declared('result', 'reasoning', ['result'], [], ['g-main'])];
  });
  const anyPack = await read(any);
  assert.equal(anyPack.completeness.status, 'complete_for_scope');
  assert.equal(anyPack.prerequisiteGroups[0].operator, 'any');
  assert.deepEqual(ids(anyPack.nodes), ['p1', 'p2', 'result']);
  assert.deepEqual(anyPack.completeness.requiredNodeIds, ['p1', 'p2', 'result']);
  const anyBudget = await read(any, 'reasoning', ['result'], { maxNodes: 2 });
  assert.equal(anyBudget.completeness.status, 'partial');
  assert.deepEqual(anyBudget.completeness.omittedGroupIds, ['g-main']);
  assert.ok(anyBudget.completeness.omittedNodeIds.length);
  pass('any保留整组备选项与operator，不能挑一个成员伪称范围完整');

  for (const operator of ['unknown', 'mixed-any'] as const) {
    const unknown = await changed((x) => {
      x.projection.prerequisiteGroups[0].operator = operator === 'unknown' ? 'unknown' : 'any';
    });
    const unknownPack = await read(unknown);
    assert.equal(unknownPack.completeness.status, 'partial');
    assert.ok(codes(unknownPack).includes('unknown_prerequisite_operator'));
    assert.ok(unknownPack.completeness.omittedGroupIds.includes('g-main'));
  }
  pass('unknown以及平面any混合条件不臆造嵌套解释，也不升级完整');

  const missing = await changed((x) => {
    x.projection.prerequisiteGroups[0].premiseNodeIds.push('absent-premise');
    x.projection.build.scopes[0].requiredGroupIds.push('absent-group');
    x.projection.build.scopes[0].requiredRelationIds.push('absent-relation');
  });
  const missingPack = await read(missing);
  assert.equal(missingPack.completeness.status, 'partial');
  assert.ok(codes(missingPack).includes('missing_node')); assert.ok(codes(missingPack).includes('missing_group'));
  assert.ok(codes(missingPack).includes('missing_relation')); assert.ok(codes(missingPack).includes('missing_prerequisite'));
  assert.ok(missingPack.completeness.requiredNodeIds.includes('absent-premise'));
  assert.ok(missingPack.completeness.omittedNodeIds.includes('absent-premise'));
  pass('缺失的已点名前提/组/边始终列出义务与未读项，不静默删减');

  for (const budget of [{ maxNodes: 1 }, { maxRelations: 0 }, { maxCharacters: 0 }, { maxDepth: 0 }, { maxDepth: 1 }]) {
    const bounded = await read(f, 'reasoning', ['result'], budget);
    assert.equal(bounded.completeness.status, 'partial');
    assert.ok(bounded.completeness.omittedNodeIds.length || bounded.completeness.omittedRelationIds.length || bounded.completeness.omittedGroupIds.length);
    assert.ok(bounded.relations.every((edge) => ids(bounded.nodes).includes(edge.sourceNodeId) && ids(bounded.nodes).includes(edge.targetNodeId)));
  }
  const depthOne = await read(f, 'reasoning', ['result'], { maxDepth: 1 });
  assert.ok(depthOne.completeness.omittedNodeIds.includes('law'));
  for (const budget of [{ maxNodes: -1 }, { maxDepth: 1.5 }, { maxCharacters: NaN }, { maxRelations: Infinity }, { unknown: 1 }] as any[]) {
    await assert.rejects(() => read(f, 'reasoning', ['result'], budget));
  }
  pass('四类预算及真实选中路径深度都显式partial，无孤边；坏预算被拒绝');

  const cycle = await changed((x) => {
    x.projection.relations.push({ ...x.projection.relations[0], id: 'cycle', sourceNodeId: 'result', targetNodeId: 'rule' });
    x.projection.build.scopes[0].requiredRelationIds.push('cycle');
  });
  const cyclePack = await read(cycle);
  assert.equal(cyclePack.completeness.status, 'complete_for_scope');
  assert.equal(cyclePack.relations.find((edge) => edge.id === 'cycle')!.sourceNodeId, 'result');
  assert.equal(cyclePack.relations.find((edge) => edge.id === 'e4')!.sourceNodeId, 'rule');
  pass('显式循环读有限闭包并保留两条原方向，读取不声称逻辑可证');

  for (const gap of [{ code: 'incomplete_extraction' as const }, { code: 'incomplete_extraction' as const, targetId: 'unrelated' },
    { code: 'hierarchy_incomplete' as const, targetId: 'unrelated' }, { code: 'missing_node' as const, targetId: 'unlocated-source-gap' }]) {
    const globallyGapped = await changed((x) => { x.projection.build.scopes.push(declared('rule', 'definition', ['rule'])); x.projection.build.gaps.push(gap); });
    const result = await read(globallyGapped, 'definition', ['rule']);
    assert.notEqual(result.completeness.status, 'complete_for_scope'); assert.ok(codes(result).includes(gap.code));
  }
  const localizedMissing = await changed((x) => {
    x.projection.build.scopes.push(declared('rule', 'definition', ['rule']));
    x.projection.prerequisiteGroups[0].premiseNodeIds.push('other-branch-missing');
    x.projection.build.gaps.push({ code: 'missing_node', targetId: 'other-branch-missing' });
  });
  assert.equal((await read(localizedMissing, 'definition', ['rule'])).completeness.status, 'complete_for_scope');
  pass('全局提取/层级及无法定位缺口不丢，确定位于别支线的局部缺口不污染定义题');

  const undeclared = await changed((x) => { x.projection.build.scopes = []; });
  const undeclaredPack = await read(undeclared);
  assert.deepEqual(ids(undeclaredPack.nodes), ['result']); assert.equal(undeclaredPack.relations.length, 0);
  assert.equal(undeclaredPack.completeness.status, 'unknown'); assert.ok(codes(undeclaredPack).includes('scope_not_reviewed'));
  const pointer = await createArgumentContextPointer(f.projection, f.authority, f.scope, ['result']);
  await assert.rejects(() => readTaskScopedArgumentContextPack(f.projection, f.authority, { pointer, scope: f.scope, task: 'general' } as any), /unsupported_task/);
  pass('未声明任务范围仅可读seed且unknown，不邻接补全；未支持任务不借壳评分');

  for (const mutate of [(x: Fixture) => { x.authority.canonicalText += 'x'; }, (x: Fixture) => { x.scope.allowedNoteIds = []; },
    (x: Fixture) => { x.projection.nodes[0].evidence[0].quote += '改写'; },
    (x: Fixture) => { x.projection.relations[0].sourceNodeId = 'unrelated'; }]) {
    const snapshot = cloneFixture(f); mutate(snapshot);
    await assert.rejects(() => read(snapshot));
  }
  pass('全文版本/权限/原文坐标/方向仍由完整独立authority门验证，不被task政策放宽');

  for (const mutate of [(x: any) => { x.nodes.splice(0, 1); }, (x: any) => { x.completeness.requiredNodeIds = ['result']; },
    (x: any) => { x.quality.status = 'unassessed'; }, (x: any) => { x.unexpected = undefined; },
    (x: any) => { x.completeness.unexpected = undefined; }, (x: any) => { x.prerequisiteGroups[0].operator = 'any'; }]) {
    const forged = structuredClone(pack); mutate(forged); await rehash(forged);
    await assert.rejects(() => validateTaskScopedArgumentContextPack(forged, f.authority, f.scope, f.projection), /pack_projection_mismatch/);
  }
  await assert.rejects(() => validateArgumentContextPack(pack as any, f.authority, f.scope, f.projection));
  await assert.rejects(() => validateTaskScopedArgumentContextPack({ ...pack, version: 1 } as any, f.authority, f.scope, f.projection), /invalid_read_policy/);
  await assert.rejects(() => validateTaskScopedArgumentContextPack({ ...pack, readPolicy: 'neighborhood' } as any, f.authority, f.scope, f.projection), /invalid_read_policy/);
  pass('自行重算hash也不能缩小义务或修改operator/资格/闭schema；v1/v2政策不能伪装互用');

  const emoji = await changed((x) => {
    x.projection.nodes.push({ id: 'emoji', role: 'fact', evidence: [x.evidence(9)], admission: 'admitted', semanticStatus: 'reviewed' });
    x.projection.build.scopes.push(declared('emoji', 'fact', ['emoji']));
  });
  const emojiPack = await read(emoji, 'fact', ['emoji']);
  assert.equal(emojiPack.nodes[0].evidence[0].quote, emoji.lines[9]);
  const split = cloneFixture(emoji);
  split.projection.nodes.find((node) => node.id === 'emoji')!.evidence[0].start += 1;
  split.projection.nodes.find((node) => node.id === 'emoji')!.evidence[0].quote = split.authority.canonicalText.slice(
    split.projection.nodes.find((node) => node.id === 'emoji')!.evidence[0].start,
    split.projection.nodes.find((node) => node.id === 'emoji')!.evidence[0].end);
  await rebindArgumentFixture(split);
  await assert.rejects(() => read(split, 'fact', ['emoji']), /invalid_span/);
  pass('CRLF及UTF16原句保持，半个代理对即使改hash仍拒绝');

  console.log(`PASS ${checks} task-scoped argument context check groups (synthetic, no model or writes)`);
} finally { globalThis.fetch = fetchBefore; }
