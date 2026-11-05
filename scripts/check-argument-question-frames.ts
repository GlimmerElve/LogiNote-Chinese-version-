import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { NoteItem } from '../src/types.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentContextNode, ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentQuestionFrameSelectors, FrozenArgumentQuestionFrames } from '../src/services/argumentContext/questionBindingTypes.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { createPersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import type { ArgumentProjectionAuthorityHost } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';

// Contract/race checks with explicit synthetic review votes. No production vault, model or scores.
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in question frame checks');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-question-frames-'));
let checks = 0, fixtures = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const ROOT = 'synthetic-question-root';
function note(id: string, title: string, content: string): NoteItem {
  return { id, title, content, noteType: 'knowledge', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
    tags: [], links: [], backlinks: [], dueDates: [] };
}
async function rig(noteInputs: NoteItem[]) {
  const notes = new Map(noteInputs.map(item => [item.id, structuredClone(item)])), inputs = new Map<string, ArgumentProjectionBuildInput>();
  const allowed = new Set(notes.keys());
  const directory = path.join(temp, String(++fixtures));
  const host: ArgumentProjectionAuthorityHost = { rootScopeId: ROOT,
    async withSource(ref, action) {
      if (ref.kind !== 'knowledge-note' || !allowed.has(ref.entityId)) throw new Error('synthetic_scope_denied');
      return action(structuredClone(inputs.get(ref.entityId) ?? null));
    } };
  const store = createPersistentArgumentProjectionStore(directory, host);
  let notesReadHook: (() => void) | undefined;
  const readNotes = async () => { notesReadHook?.(); return structuredClone([...notes.values()]); };
  const service = createArgumentQuestionFrameService({ runtime: { host, store }, readReferenceNotes: readNotes });
  async function inputFor(saved: NoteItem, eligible = true) {
    const scope: ArgumentContextScope = { scopeId: `source-${saved.id}`, rootScopeId: ROOT, corpus: 'reference',
      allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [saved.id], allowedDocIds: [], allowedRecordIds: [] };
    const base = await adaptSavedKnowledgeNote({ note: saved, rootScopeId: ROOT, scope });
    const input = eligible ? await prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
      scope, chunks: base.chunks, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-qualified-v1', evidence: [base.quotes.at(-1)!.evidence] } }) : base;
    inputs.set(saved.id, input); return input;
  }
  async function publish(saved: NoteItem, makeDraft: (input: ArgumentProjectionBuildInput) => ArgumentProjectionDraft, eligible = true, idSuffix = '') {
    const input = await inputFor(saved, eligible), draft = makeDraft(input), reviewInput = await buildArgumentProjectionReviewInput(input, draft);
    const review = fixedAcceptProjectionReview(reviewInput), result = await finalizeArgumentProjectionBuild(input, draft, review);
    const before = await store.read({ kind: 'knowledge-note', entityId: saved.id });
    return store.publish({ publicationId: `synthetic-${saved.id}-${idSuffix || ++fixtures}`, result, proof: { input, draft, review },
      expectedActiveHash: before?.authority.structureHash ?? null });
  }
  return { notes, inputs, allowed, host, store, service, publish, inputFor, setReadHook: (hook?: () => void) => { notesReadHook = hook; } };
}
function draftFor(input: ArgumentProjectionBuildInput, task: 'definition' | 'fact' | 'reasoning', rows: [string, ArgumentContextNode['role']][],
  reasoning: boolean | 'condition' = false, operator: 'all' | 'any' = 'all'): ArgumentProjectionDraft {
  const nodes = rows.map(([fragment, role], index) => {
    const quote = input.quotes.find(q => q.evidence.quote.includes(fragment)); assert.ok(quote, fragment);
    return { id: `N${index + 1}`, role, quoteIds: [quote.quoteId] };
  });
  const relations: ArgumentProjectionDraft['relations'] = reasoning ? [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support', quoteIds: [...nodes[1].quoteIds] }] : [];
  if (reasoning === 'condition') relations.push({ id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition', quoteIds: [...nodes[2].quoteIds] });
  const groups: ArgumentProjectionDraft['groups'] = reasoning ? [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'],
    conditionNodeIds: reasoning === 'condition' ? ['N3'] : [], relationIds: relations.map(relation => relation.id), operator,
    quoteIds: relations.flatMap(relation => relation.quoteIds) }] : [];
  return { version: 1, buildId: input.buildId, nodes, relations, groups,
    scopes: [{ id: 'S1', seedNodeId: task === 'reasoning' ? 'N2' : 'N1', task, requiredNodeIds: nodes.map(node => node.id),
      requiredRelationIds: relations.map(relation => relation.id), requiredGroupIds: groups.map(group => group.id), quoteIds: nodes.flatMap(node => node.quoteIds) }] };
}
async function selectors(notes: NoteItem[], task: 'definition' | 'fact' | 'reasoning', selections: [string, string, string][]): Promise<ArgumentQuestionFrameSelectors> {
  const knowledgeTargets = notes.map(saved => saved.title), assessment = freezeReviewAssessment(task, knowledgeTargets);
  const catalog = await buildReviewReferenceCatalog(notes, knowledgeTargets, notes.map(saved => saved.id));
  const groups = new Map<string, string[]>();
  for (const [target, criterion, fragment] of selections) {
    const candidate = catalog.candidates.find(item => item.knowledgeTarget === target && item.quote.includes(fragment)); assert.ok(candidate, fragment);
    groups.set(criterion, [...(groups.get(criterion) ?? []), candidate.candidateId]);
  }
  const marker = [...groups].map(([criterion, ids]) => `${criterion}=${ids.join(',')}`).join(';');
  const referenceRubric = freezeReviewReferenceRubric(marker, assessment, catalog); assert.equal(referenceRubric.status, 'fixed');
  return { questionMessageId: 'question-original', knowledgeTargets, assessment, referenceRubric };
}
const definition = note('definition-A', '合成选择过载', '# 定义\r\n\r\n选择过载是选项🧠过多使决策困难。\r\n\r\n## 边界\r\n\r\n当选项超过可处理范围时才适用。');
const definitionRows: [string, ArgumentContextNode['role']][] = [['选择过载是', 'definition'], ['当选项超过', 'condition']];
const definitionSelections: [string, string, string][] = [[definition.title, 'concept_meaning', '选择过载是'], [definition.title, 'concept_boundary', '当选项超过']];

try {
  const a = await rig([definition]);
  assert.equal((await a.publish(definition, input => draftFor(input, 'definition', definitionRows))).status, 'published');
  const s = await selectors([definition], 'definition', definitionSelections), fixed = await a.service.prepare(s);
  assert.equal(fixed.status, 'fixed', JSON.stringify(fixed.reasons)); assert.equal(fixed.frames.length, 1); assert.equal(fixed.frames[0].pack.version, 2);
  assert.equal(fixed.frames[0].pack.readPolicy, 'reviewed-task-closure-v2'); assert.equal(fixed.originQuestionMessageId, 'question-original');
  assert.ok(Object.isFrozen(fixed) && Object.isFrozen(fixed.frames[0].items));
  assert.equal((await a.service.verify(structuredClone(fixed))).status, 'current');
  pass('题前固定完整定义/边界，v2 source scope及CRLF/emoji原始坐标，深冻结/序列化后原合同复核');

  const linkedDefinition = await rig([definition]);
  await linkedDefinition.publish(definition, input => {
    const draft = draftFor(input, 'definition', definitionRows);
    draft.relations.push({ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [...draft.nodes[1].quoteIds] });
    draft.scopes[0].requiredRelationIds.push('E1'); return draft;
  });
  const linkedSelectors = await selectors([definition], 'definition', definitionSelections);
  const linkedFrame = await linkedDefinition.service.prepare(linkedSelectors);
  assert.equal(linkedFrame.status, 'fixed', JSON.stringify(linkedFrame.reasons));
  assert.deepEqual(linkedFrame.frames[0].items.find(item => item.criterionId === 'concept_boundary')!.relationIds, ['E1']);
  assert.equal((await linkedDefinition.service.verify(linkedFrame)).status, 'current');
  pass('定义任务保留明确required条件边，原题两端和关系引文均覆盖，不再误held');

  const missingBoundary = structuredClone(linkedSelectors);
  missingBoundary.referenceRubric.items = missingBoundary.referenceRubric.items.filter(item => item.criterionId !== 'concept_boundary');
  await assert.rejects(linkedDefinition.service.prepare(missingBoundary));
  const wrongBoundaryRole = await rig([definition]);
  await wrongBoundaryRole.publish(definition, input => {
    const draft = draftFor(input, 'definition', [['选择过载是', 'definition'], ['当选项超过', 'fact']]);
    draft.relations.push({ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [...draft.nodes[1].quoteIds] });
    draft.scopes[0].requiredRelationIds.push('E1'); return draft;
  });
  assert.equal((await wrongBoundaryRole.service.prepare(linkedSelectors)).status, 'held');
  pass('新增非推理边映射仍拒绝缺边界或角色不匹配，不借连线补原题缺项');

  const wrongDefinitionLink = await rig([definition]);
  await wrongDefinitionLink.publish(definition, input => {
    const draft = draftFor(input, 'definition', definitionRows);
    draft.relations.push({ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'support', quoteIds: [...draft.nodes[1].quoteIds] });
    draft.scopes[0].requiredRelationIds.push('E1'); return draft;
  });
  assert.equal((await wrongDefinitionLink.service.prepare(linkedSelectors)).status, 'held');
  pass('定义/边界不能将support误当条件连线，不制造推理标准');

  const renewedLeaseService = createArgumentQuestionFrameService({ runtime: { host: a.host, store: a.store },
    readReferenceNotes: async () => structuredClone([...a.notes.values()]) });
  assert.equal((await renewedLeaseService.verify(fixed)).status, 'current');
  assert.ok(!Object.hasOwn(fixed, 'environmentId'));
  const otherRootService = createArgumentQuestionFrameService({ runtime: { host: { ...a.host, rootScopeId: 'different-root' }, store: a.store },
    readReferenceNotes: async () => structuredClone([...a.notes.values()]) });
  assert.equal((await otherRootService.verify(fixed)).status, 'held');
  pass('新问题的临时environment lease不绑定旧题快照；独立root切换仍拒绝原合同');

  s.questionMessageId = 'mutated-after-freeze'; s.referenceRubric.items[0].quote = '被修改的调用者草稿';
  assert.equal(fixed.originQuestionMessageId, 'question-original'); assert.notEqual(fixed.referenceRubric.items[0].quote, s.referenceRubric.items[0].quote);
  const repeated = await a.service.prepare(await selectors([definition], 'definition', definitionSelections));
  assert.equal(repeated.contractHash, fixed.contractHash); assert.equal(fixed.limitations.scoreWrite, 'disabled');
  pass('不受调用者对象修改影响，相同已保存来源确定性重放；不评答案或修改掌握度/认知');

  const unavailable = structuredClone(await selectors([definition], 'definition', definitionSelections));
  unavailable.referenceRubric = { ...unavailable.referenceRubric, status: 'unavailable', items: [], reason: 'missing_selection' };
  const heldBefore = await a.service.prepare(unavailable); assert.equal(heldBefore.status, 'held');
  assert.deepEqual(heldBefore.reasons, ['reference_unavailable']); assert.equal((await a.service.verify(heldBefore)).status, 'held');
  pass('未选核对项只held；后来结构完整也不自动将原题后合同升级');

  await assert.rejects(a.service.prepare({ ...await selectors([definition], 'definition', definitionSelections), authority: {} } as ArgumentQuestionFrameSelectors));
  const unknown = { ...structuredClone(fixed), environmentId: undefined };
  assert.deepEqual((await a.service.verify(unknown)).reasons, ['contract_invalid']);
  const nestedUnknown = structuredClone(fixed); (nestedUnknown.frames[0].items[0] as unknown as Record<string, unknown>).authority = undefined;
  assert.deepEqual((await a.service.verify(nestedUnknown)).reasons, ['contract_invalid']);
  pass('closed请求/合同，undefined额外字段不能绕过hash或自报authority');

  const partial = await selectors([definition], 'definition', definitionSelections);
  const item = partial.referenceRubric.items[0]; item.quote = item.quote.slice(1); item.start++;
  assert.deepEqual((await a.service.prepare(partial)).reasons, ['reference_membership_invalid']);
  pass('任意原文子串即使匹配保存正文也不能伪装native参考检验项');

  const ambiguous = await rig([definition, { ...definition, id: 'same-title' }]);
  await ambiguous.publish(definition, input => draftFor(input, 'definition', definitionRows));
  assert.deepEqual((await ambiguous.service.prepare(await selectors([definition], 'definition', definitionSelections))).reasons, ['ambiguous_target']);
  pass('host项目范围内同名知识点歧义拒绝，不借另一笔记回答');

  const noProjection = await rig([definition]); await noProjection.inputFor(definition);
  assert.deepEqual((await noProjection.service.prepare(await selectors([definition], 'definition', definitionSelections))).reasons, ['projection_unavailable']);
  const unqualified = await rig([definition]);
  assert.equal((await unqualified.publish(definition, input => draftFor(input, 'definition', definitionRows), false)).status, 'held');
  assert.equal((await unqualified.service.prepare(await selectors([definition], 'definition', definitionSelections))).status, 'held');
  pass('只有原文/未资格认证的合成全accept审核都不能产生fixed框架');

  const wrongRole = await rig([definition]);
  await wrongRole.publish(definition, input => draftFor(input, 'definition', [['选择过载是', 'fact'], ['当选项超过', 'condition']]));
  assert.ok((await wrongRole.service.prepare(await selectors([definition], 'definition', definitionSelections))).reasons.includes('item_structure_incomplete'));
  const wrongTask = await rig([definition]);
  await wrongTask.publish(definition, input => draftFor(input, 'fact', definitionRows));
  assert.ok((await wrongTask.service.prepare(await selectors([definition], 'definition', definitionSelections))).reasons.includes('task_scope_unavailable'));
  pass('字面覆盖不能代替已审角色或指定任务语义scope');

  const duplicate = note('duplicate', '重复事实', '本例样本数量为24。\n\n本例样本数量为24。');
  const duplicateRig = await rig([duplicate]);
  await duplicateRig.publish(duplicate, input => draftFor(input, 'fact', [['本例样本数量', 'fact']]));
  const dup = await selectors([duplicate], 'fact', [[duplicate.title, 'fact_scope', '本例样本数量']]);
  const secondCatalog = await buildReviewReferenceCatalog([duplicate], [duplicate.title], [duplicate.id]);
  const second = secondCatalog.candidates.filter(candidate => candidate.quote === '本例样本数量为24。').at(-1)!;
  assert.ok(second.start > dup.referenceRubric.items[0].start);
  dup.referenceRubric.items[0] = { ...second, itemId: 'I1', criterionId: 'fact_scope' };
  assert.ok((await duplicateRig.service.prepare(dup)).reasons.includes('item_structure_incomplete'));
  pass('重复原文只绑定所选UTF16出现位置，不借首次同文节点');

  const reasoning = note('reasoning', '合成传感器推理', '# 前提\n\n本传感器读数为30度。\n\n## 推理\n\n本传感器读数超过25度，所以指示灯亮起。\n\n## 条件\n\n传感器处于正常工作状态。');
  const reasoningRows: [string, ArgumentContextNode['role']][] = [['读数为30', 'premise'], ['所以指示灯', 'conclusion'], ['正常工作状态', 'condition']];
  const reasoningSelections: [string, string, string][] = [[reasoning.title, 'actual_premise', '读数为30'], [reasoning.title, 'actual_premise', '正常工作状态'],
    [reasoning.title, 'inference_link', '所以指示灯']];
  const reasonRig = await rig([reasoning]); await reasonRig.publish(reasoning, input => draftFor(input, 'reasoning', reasoningRows, 'condition'));
  const rs = await selectors([reasoning], 'reasoning', reasoningSelections), rf = await reasonRig.service.prepare(rs);
  assert.equal(rf.status, 'fixed'); assert.equal(rf.frames[0].pack.prerequisiteGroups[0].operator, 'all');
  assert.deepEqual(rf.frames[0].items.find(entry => entry.criterionId === 'inference_link')!.relationIds, ['E1', 'E2']);
  assert.equal(rf.frames[0].pack.relations[0].sourceNodeId, 'N1'); assert.equal(rf.frames[0].pack.relations[0].targetNodeId, 'N2');
  pass('真实stored推理边方向/显式条件连线与all必要前提全量保留，不以邻接代替因果');

  const anyNote = { ...reasoning, id: 'any-reasoning', title: '合成任一传感器', content: reasoning.content.replace('传感器处于正常工作状态。', '备用传感器读数为31度。') };
  const anyRig = await rig([anyNote]); await anyRig.publish(anyNote, input => {
    const draft = draftFor(input, 'reasoning', [['读数为30', 'premise'], ['所以指示灯', 'conclusion'], ['读数为31', 'premise']], true, 'any');
    draft.relations.push({ id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'support', quoteIds: [...draft.nodes[1].quoteIds] });
    draft.groups[0].premiseNodeIds.push('N3'); draft.groups[0].relationIds.push('E2'); draft.scopes[0].requiredRelationIds.push('E2');
    return draft;
  });
  const anySelectors = await selectors([anyNote], 'reasoning', [[anyNote.title, 'actual_premise', '读数为30'], [anyNote.title, 'actual_premise', '读数为31'], [anyNote.title, 'inference_link', '所以指示灯']]);
  const any = await anyRig.service.prepare(anySelectors); assert.equal(any.status, 'fixed', JSON.stringify(any.reasons)); assert.equal(any.frames[0].pack.prerequisiteGroups[0].operator, 'any');
  assert.deepEqual(any.frames[0].pack.prerequisiteGroups[0].premiseNodeIds, ['N1', 'N3']);
  pass('any组也保留所有存储成员，不删分支或篡改operator');

  const missingCondition = await selectors([reasoning], 'reasoning', reasoningSelections.filter(row => !row[2].includes('正常')));
  const incomplete = await reasonRig.service.prepare(missingCondition); assert.equal(incomplete.status, 'held');
  assert.ok(incomplete.reasons.includes('inference_relation_missing') || incomplete.reasons.includes('prerequisite_incomplete'));
  pass('未选择必要条件原文不能借整篇资料隐式补全标准');

  const disconnected = await rig([reasoning]);
  await disconnected.publish(reasoning, input => draftFor(input, 'reasoning', [['读数为30', 'fact'], ['所以指示灯', 'fact']]));
  const adjacent = await disconnected.service.prepare(await selectors([reasoning], 'reasoning', reasoningSelections.filter(row => !row[2].includes('正常'))));
  assert.ok(adjacent.reasons.includes('inference_relation_missing'));
  pass('两条有审核的相邻事实没有support/oppose仍拒绝推理标准');

  const b = note('definition-B', '合成注意限制', '# 定义\n\n注意限制是同时处理信息数量有限。\n\n## 边界\n\n对复杂信息才使用本例限制。');
  const multi = await rig([definition, b]);
  await multi.publish(definition, input => draftFor(input, 'definition', definitionRows));
  await multi.publish(b, input => draftFor(input, 'definition', [['注意限制是', 'definition'], ['复杂信息', 'condition']]));
  const ms = await selectors([definition, b], 'definition', [...definitionSelections, [b.title, 'concept_meaning', '注意限制是'], [b.title, 'concept_boundary', '复杂信息']]);
  const mf = await multi.service.prepare(ms); assert.equal(mf.status, 'fixed'); assert.equal(mf.frames.length, 2);
  assert.notEqual(mf.frames[0].sourceScopeHash, mf.frames[1].sourceScopeHash); assert.equal((await multi.service.verify(mf)).status, 'current');
  pass('双目标各自完整source frame，独立scope合成快照而不拼接残缺标准');

  const forgedCrossSource = structuredClone(ms); forgedCrossSource.referenceRubric.items[2] = {
    ...forgedCrossSource.referenceRubric.items[3], knowledgeTarget: definition.title, itemId: 'I3', candidateId: 'K40' };
  assert.equal((await multi.service.prepare(forgedCrossSource)).status, 'held');
  multi.allowed.delete(b.id); assert.equal((await multi.service.verify(mf)).status, 'held'); multi.allowed.add(b.id);
  pass('不能把另一来源边界拼给目标或用旧合同扩大当前host项目权限');

  const changed = { ...definition, content: definition.content.replace('决策困难', '可能减低满意度'), updatedAt: '2026-10-07T02:00:00.000Z' };
  a.notes.set(definition.id, changed); await a.inputFor(changed);
  assert.equal((await a.service.verify(fixed)).status, 'held');
  a.notes.set(definition.id, definition); await a.inputFor(definition);
  // The changed rubric rejected before the ledger read, so no tombstone is promised here.
  assert.equal((await a.service.verify(fixed)).status, 'current');
  pass('题后源变化hold原标准，不重新选新原文；未观察到ledger变更不虚称ABA检测');

  const tampered = structuredClone(rf); tampered.frames[0].items.find(entry => entry.criterionId === 'inference_link')!.relationIds.reverse();
  tampered.snapshotBindingHash = await argumentContextHash(tampered.frames.map(({ pack, ...frame }) => ({ ...frame, packHash: pack.packHash })));
  const { contractHash: _discard, ...tamperedBody } = tampered; tampered.contractHash = await argumentContextHash(tamperedBody);
  assert.equal((await reasonRig.service.verify(tampered)).status, 'held');
  const invalidHeld = { ...structuredClone(heldBefore), status: 'fixed' as const, reasons: [] };
  const { contractHash: _ignored, ...invalidBody } = invalidHeld; invalidHeld.contractHash = await argumentContextHash(invalidBody);
  assert.deepEqual((await a.service.verify(invalidHeld)).reasons, ['contract_invalid']);
  pass('重算自带hash仍不能改变冻结关系/升级held；真实receipt鉴权由main另管');

  let reads = 0;
  multi.setReadHook(() => { if (++reads === 2) multi.notes.set(b.id, { ...b, content: b.content + '\n新增约束。' }); });
  assert.equal((await multi.service.prepare(ms)).status, 'held'); multi.setReadHook();
  pass('多来源逐读后再次回核全部原文，过程中变化不返回fixed');

  reasonRig.inputs.delete(reasoning.id);
  assert.equal((await reasonRig.service.verify(rf)).status, 'held');
  assert.equal((await reasonRig.store.read({ kind: 'knowledge-note', entityId: reasoning.id })), null);
  pass('已发布结构来源删除后撤回active，不借冻结旧包答题');

  assert.ok(checks >= 20);
  console.log(`Argument question frame checks passed: ${checks} synthetic groups; no semantic accuracy claim.`);
} finally {
  globalThis.fetch = oldFetch;
  const absolute = path.resolve(temp), intended = path.resolve(os.tmpdir());
  assert.ok(path.dirname(absolute) === intended && path.basename(absolute).startsWith('loginote-question-frames-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
