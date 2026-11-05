import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput,
  finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareSourcePropositionContext, prepareSourcePropositionReviewInput, SOURCE_PROPOSITION_LIMITS,
  type SourcePropositionContext } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { buildSourcePropositionSelectionParentChoices, prepareSourcePropositionSelection,
  readSourcePropositionSelection, SourcePropositionSelectionError, SOURCE_PROPOSITION_SELECTION_PROTOCOL,
  type SourcePropositionSelection, type SourcePropositionSelectionInput } from '../src/services/reviewComparison/sourcePropositionSelection.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { NoteItem } from '../src/types.ts';

// Pure synthetic fixed-review fixtures. No filesystem/configuration/provider reads,
// semantic-truth certification, model requests or production writes.
const oldFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('selection checks forbid network');
const clone = <T>(value: T): T => structuredClone(value);
let groups = 0; const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const reject = (work: () => Promise<unknown>, code?: string) => assert.rejects(work,
  (error: unknown) => error instanceof SourcePropositionSelectionError && (!code || error.message === code));
function selectAll(menu: SourcePropositionSelectionInput): SourcePropositionSelection {
  const nodes = new Set<string>();
  return { version: 2, protocol: SOURCE_PROPOSITION_SELECTION_PROTOCOL, contextHash: menu.contextHash,
    anchors: menu.parentChoices.filter(choice => {
      if (nodes.has(choice.nodeId)) return false; nodes.add(choice.nodeId); return true;
    }).map(choice => ({ parentChoiceId: choice.parentChoiceId, text: choice.text })) };
}
async function fixture() {
  const source = await createReferenceDisclosureFixture({ task: 'definition' });
  const key = [...source.inputs.keys()][0], input = source.inputs.get(key)!, result = source.results.get(key)!;
  const context = await prepareSourcePropositionContext(input, result), menu = await prepareSourcePropositionSelection(context);
  return { context, menu, selected: selectAll(menu) };
}
async function multiParentContext(texts: string[], splitFirst = false, nodeCopies = texts.length): Promise<SourcePropositionContext> {
  const note: NoteItem = { id: 'selection-synthetic-source', title: '纯合成选择表', noteType: 'knowledge',
    content: texts.join('\r\n\r\n'), createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
    tags: [], links: [], backlinks: [], dueDates: [] };
  const rootScopeId = 'selection-synthetic-root', scope = { scopeId: 'selection-synthetic-scope', rootScopeId, corpus: 'reference' as const,
    allowedSourceKinds: ['knowledge-note' as const], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] };
  const physical = await adaptSavedKnowledgeNote({ note, rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: physical.source, canonicalText: physical.canonicalText,
    hierarchy: physical.hierarchy, scope, chunks: physical.chunks,
    sourceQualification: { status: 'eligible', policyVersion: 'synthetic-fixed-selection', evidence: [physical.quotes[0].evidence] } });
  const complete = input.quotes.filter(quote => quote.completeSentence);
  assert.equal(complete.length, texts.length);
  const nodes: ArgumentProjectionDraft['nodes'] = Array.from({ length: nodeCopies }, (_unused, index) => ({ id: `N${index + 1}`, role: 'fact',
    quoteIds: input.quotes.filter(quote => quote.evidence.sentenceId === complete[index % texts.length].evidence.sentenceId
      && (!splitFirst || index !== 0 || !quote.completeSentence)).map(quote => quote.quoteId) }));
  const scopes: ArgumentProjectionDraft['scopes'] = [];
  for (let index = 0; index < nodes.length; index += 16) {
    const subset = nodes.slice(index, index + 16);
    scopes.push({ id: `S${scopes.length + 1}`, seedNodeId: subset[0].id, task: 'fact', requiredNodeIds: subset.map(node => node.id),
      requiredRelationIds: [], requiredGroupIds: [],
      quoteIds: [...new Set(subset.map((_node, offset) => complete[(index + offset) % texts.length].quoteId))] });
  }
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId, nodes, relations: [], groups: [], scopes };
  const result = await finalizeArgumentProjectionBuild(input, draft,
    fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)));
  assert.equal(result.status, 'reviewed_complete');
  return prepareSourcePropositionContext(input, result);
}
try {
  const base = await fixture();
  assert.deepEqual(buildSourcePropositionSelectionParentChoices(base.context), base.menu.parentChoices);
  assert.equal(base.menu.version, 2); assert.equal(base.menu.protocol, 'review-source-proposition-selection-input-v2');
  assert.equal(base.menu.contextHash, await argumentContextHash(base.context));
  assert.deepEqual(base.menu.parentChoices.map(choice => choice.parentChoiceId), ['PC1', 'PC2', 'PC3', 'PC4']);
  for (const choice of base.menu.parentChoices) {
    const node = base.context.projection.nodes.find(node => node.id === choice.nodeId)!, quote = base.context.quotes.find(quote => quote.quoteId === choice.quoteId)!;
    assert.ok(node.evidence.some(span => JSON.stringify(span) === JSON.stringify(quote.evidence)));
    assert.equal(choice.text, quote.evidence.quote);
  }
  pass('同步菜单只枚举真实node-owned父Q，异步完整context验证并绑定全context hash，无模型/语义授权');

  const draft = await readSourcePropositionSelection(JSON.stringify(base.selected), base.context);
  assert.equal(draft.version, 1); assert.equal(draft.protocol, 'review-source-proposition-draft-v1');
  assert.deepEqual(draft.anchors.map(anchor => anchor.id), ['P1', 'P2', 'P3', 'P4']);
  const original = await prepareSourcePropositionReviewInput(base.context, draft);
  assert.deepEqual(original.draft, draft);
  for (const anchor of draft.anchors) assert.equal(base.context.canonicalText.slice(anchor.start, anchor.end), anchor.text);
  assert.equal(Object.hasOwn(draft, 'review'), false); assert.equal(Object.hasOwn(draft, 'decision'), false);
  pass('模型只选parentChoiceId/原话；程序铸P1…及绝对UTF16坐标，canonical v1再经原严格preparer，不补审核票');

  const astral = clone(base.selected); astral.anchors[0].text = '🧠';
  const emoji = (await readSourcePropositionSelection(astral, base.context)).anchors[0];
  assert.equal(emoji.start, base.context.canonicalText.indexOf('🧠')); assert.equal(emoji.end - emoji.start, 2);
  const half = clone(astral); half.anchors[0].text = '🧠'.slice(0, 1); await reject(() => readSourcePropositionSelection(half, base.context));
  pass('唯一精确子串按JavaScript UTF16计数，emoji占2单位；断代理对严格拒绝');

  const split = await multiParentContext(['合成系统已联网，蓝印规则可执行。', '人工模式是例外，蓝印规则不能执行。'], true);
  const splitMenu = await prepareSourcePropositionSelection(split), splitAll = selectAll(splitMenu);
  const whole = split.quotes.find(quote => quote.completeSentence)!;
  assert.ok(!splitMenu.parentChoices.some(choice => choice.nodeId === 'N1' && choice.quoteId === whole.quoteId));
  await reject(() => readSourcePropositionSelection({ ...splitAll, anchors: [{ ...splitAll.anchors[0], text: whole.evidence.quote }, ...splitAll.anchors.slice(1)] }, split),
    'source_proposition_selection_text_missing');
  assert.equal((await readSourcePropositionSelection(splitAll, split)).anchors[0].quoteId, splitMenu.parentChoices[0].quoteId);
  pass('拆句node不能借全局真实但未owned的整句Q；不跨两个父Q拼接补成一条命题');

  const repeated = await multiParentContext(['同段出现蓝印又出现蓝印，只检验歧义。', '重叠片段aaaa只检验歧义。']);
  const repeatedMenu = await prepareSourcePropositionSelection(repeated), repeatedAll = selectAll(repeatedMenu);
  repeatedAll.anchors[0].text = '蓝印'; await reject(() => readSourcePropositionSelection(repeatedAll, repeated), 'source_proposition_selection_text_ambiguous');
  const overlap = selectAll(repeatedMenu); overlap.anchors[1].text = 'aa';
  await reject(() => readSourcePropositionSelection(overlap, repeated), 'source_proposition_selection_text_ambiguous');
  pass('父Q内相同/重叠子串出现多次整体held，不猜第一个位置或让模型给坐标绕过');

  for (const text of ['改写后的定义', '选择过载是指选项 🧠', '   ']) {
    const changed = clone(base.selected); changed.anchors[0].text = text; await reject(() => readSourcePropositionSelection(changed, base.context));
  }
  const missing = clone(base.selected); missing.anchors.pop();
  await reject(() => readSourcePropositionSelection(missing, base.context), 'source_proposition_selection_required_nodes_missing');
  const empty = clone(base.selected); empty.anchors = []; await reject(() => readSourcePropositionSelection(empty, base.context));
  const duplicate = clone(base.selected); duplicate.anchors.push(clone(duplicate.anchors[0]));
  await reject(() => readSourcePropositionSelection(duplicate, base.context), 'source_proposition_selection_anchor_duplicate');
  pass('不改写/纠正原话、不补遗漏节点，不接受空包或同父同坐标重复项');

  const changedHash = clone(base.selected); changedHash.contextHash = 'f'.repeat(64);
  await reject(() => readSourcePropositionSelection(changedHash, base.context), 'source_proposition_selection_context_changed');
  const changedContext = clone(base.context); changedContext.resultHash = 'f'.repeat(64);
  await reject(() => readSourcePropositionSelection(base.selected, changedContext), 'source_proposition_selection_context_changed');
  for (const choiceId of ['PC96', 'PC1024']) {
    const unknown = clone(base.selected); unknown.anchors[0].parentChoiceId = choiceId;
    await reject(() => readSourcePropositionSelection(unknown, base.context), 'source_proposition_selection_parent_unknown');
  }
  pass('绑定完整context而非菜单/正文部分hash；旧hash及未知choice不换绑');

  const returnedMenu = clone(base.menu); returnedMenu.parentChoices[0].text = '外部菜单自授权';
  const forgedMenu = clone(base.selected); forgedMenu.anchors[0].text = returnedMenu.parentChoices[0].text;
  await reject(() => readSourcePropositionSelection(forgedMenu, base.context), 'source_proposition_selection_text_missing');
  await reject(() => readSourcePropositionSelection({ ...base.selected, parentChoices: returnedMenu.parentChoices }, base.context));
  await reject(() => readSourcePropositionSelection(base.selected, { ...base.context, parentChoices: returnedMenu.parentChoices } as any));
  pass('修改已返回菜单无效，reader重新从host context生成真实归属；响应/上下文不能塞菜单授予父Q权限');

  await reject(() => readSourcePropositionSelection(draft, base.context));
  for (const key of ['id', 'nodeId', 'quoteId', 'start', 'end', 'decision']) {
    const injected = clone(base.selected); (injected.anchors[0] as any)[key] = key === 'start' ? 0 : 'injected';
    await reject(() => readSourcePropositionSelection(injected, base.context));
  }
  await reject(() => readSourcePropositionSelection({ ...base.selected, version: 1 }, base.context));
  await reject(() => readSourcePropositionSelection({ ...base.selected, protocol: 'review-source-proposition-draft-v1' }, base.context));
  pass('v2新路径明确拒绝旧v1、模型ID/坐标/归属/审核额外字段，无回退和结构修复');

  let getters = 0;
  const rawGetter = clone(base.selected); Object.defineProperty(rawGetter.anchors[0], 'text', { enumerable: true, get() { getters++; return 'unsafe'; } });
  await reject(() => readSourcePropositionSelection(rawGetter, base.context));
  const contextGetter = clone(base.context); Object.defineProperty(contextGetter, 'canonicalText', { enumerable: true, get() { getters++; return 'unsafe'; } });
  assert.throws(() => buildSourcePropositionSelectionParentChoices(contextGetter), SourcePropositionSelectionError);
  await reject(() => prepareSourcePropositionSelection(contextGetter));
  const toJson = clone(base.selected); Object.defineProperty(toJson, 'toJSON', { enumerable: true, get() { getters++; return () => base.selected; } });
  await reject(() => readSourcePropositionSelection(toJson, base.context));
  const hidden = clone(base.selected); Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  await reject(() => readSourcePropositionSelection(hidden, base.context));
  const symbol = clone(base.selected); (symbol as any)[Symbol('authority')] = true;
  await reject(() => readSourcePropositionSelection(symbol, base.context));
  const sparse = clone(base.selected); delete sparse.anchors[0]; await reject(() => readSourcePropositionSelection(sparse, base.context));
  const cycle: any = clone(base.selected); cycle.anchors[0].text = cycle; await reject(() => readSourcePropositionSelection(cycle, base.context));
  assert.equal(getters, 0);
  pass('首await前检查纯data/描述符，getter/toJSON不执行；隐藏字段/symbol/稀疏数组/循环严格拒绝');

  for (const malformed of ['not-json', '```json\n' + JSON.stringify(base.selected) + '\n```', JSON.stringify(base.selected) + ' trailing']) {
    await reject(() => readSourcePropositionSelection(malformed, base.context));
  }
  const duplicateJson = JSON.stringify(base.selected).replace('"version":2', '"version":2,"version":2');
  await reject(() => readSourcePropositionSelection(duplicateJson, base.context));
  const escapedDuplicate = JSON.stringify(base.selected).replace('"version":2', '"version":2,"ver\\u0073ion":2');
  await reject(() => readSourcePropositionSelection(escapedDuplicate, base.context));
  pass('严格JSON，不salvage Markdown/尾随垃圾；重复键及转义同名键也拒绝');

  const counted = clone(base.selected), choice = base.menu.parentChoices[0];
  const characters = [...choice.text], seen = new Set(counted.anchors.map(anchor => anchor.parentChoiceId + '|' + anchor.text));
  for (let length = 1; length <= characters.length && counted.anchors.length < SOURCE_PROPOSITION_LIMITS.anchors; length++) {
    for (let offset = 0; offset + length <= characters.length && counted.anchors.length < SOURCE_PROPOSITION_LIMITS.anchors; offset++) {
      const text = characters.slice(offset, offset + length).join(''), location = choice.parentChoiceId + '|' + text;
      const first = choice.text.indexOf(text);
      if (!text.trim() || seen.has(location) || choice.text.indexOf(text, first + 1) >= 0) continue;
      counted.anchors.push({ parentChoiceId: choice.parentChoiceId, text }); seen.add(location);
    }
  }
  assert.equal(counted.anchors.length, 96); assert.equal((await readSourcePropositionSelection(counted, base.context)).anchors.length, 96);
  const extra = clone(counted); extra.anchors.push(clone(extra.anchors[0])); await reject(() => readSourcePropositionSelection(extra, base.context));
  const huge = clone(base.selected); huge.anchors[0].text = 'x'.repeat(SOURCE_PROPOSITION_LIMITS.text + 1);
  await reject(() => readSourcePropositionSelection(huge, base.context));
  await reject(() => readSourcePropositionSelection(' '.repeat(SOURCE_PROPOSITION_LIMITS.draft + 1), base.context));
  pass('96条完整候选边界可用，97条/过长原话/超JSON预算整体拒绝，不截断成通过');

  const largeMenu = await multiParentContext(['合成段落，一号事实成立，二号事实成立。'], false, 30);
  const completeLargeMenu = await prepareSourcePropositionSelection(largeMenu);
  assert.ok(completeLargeMenu.parentChoices.length > 96);
  assert.deepEqual(completeLargeMenu.parentChoices, buildSourcePropositionSelectionParentChoices(largeMenu));
  assert.equal((await readSourcePropositionSelection(selectAll(completeLargeMenu), largeMenu)).anchors.length, 30);
  pass('父菜单与候选预算分离：超过96真实父选择完整披露，选择30条合法；不截菜单、不放宽96候选上限');

  const overRequest = await multiParentContext([`合成头部${'甲'.repeat(62)}，${'乙'.repeat(62)}，${'丙'.repeat(62)}。`], false, 64);
  assert.ok(JSON.stringify(overRequest).length <= SOURCE_PROPOSITION_LIMITS.context);
  const overRequestChoices = buildSourcePropositionSelectionParentChoices(overRequest);
  assert.ok(overRequestChoices.length <= 1024 && overRequestChoices.length > 96);
  await reject(() => prepareSourcePropositionSelection(overRequest), 'source_proposition_selection_budget_exceeded');
  pass('完整合法context与完整父菜单合并超96k请求预算时整体暂停，不截context或菜单冒称完整');

  for (const mutate of [
    (context: SourcePropositionContext) => { context.qualification.status = 'unassessed'; },
    (context: SourcePropositionContext) => { context.projection.nodes[0].admission = 'audit_only'; },
    (context: SourcePropositionContext) => { context.projection.build.scopes[0].status = 'partial'; },
    (context: SourcePropositionContext) => { context.structureHash = 'f'.repeat(64); },
  ]) {
    const context = clone(base.context); mutate(context);
    if (context.qualification.status === 'unassessed') assert.deepEqual(buildSourcePropositionSelectionParentChoices(context), base.menu.parentChoices);
    await reject(() => prepareSourcePropositionSelection(context), 'source_proposition_selection_context_invalid');
    await reject(() => readSourcePropositionSelection(base.selected, context), 'source_proposition_selection_context_invalid');
  }
  pass('异步入口重用旧完整context validator，不因机械菜单合法放行无资格/未审scope或改图');

  const savedContext = clone(base.context), savedRaw = clone(base.selected);
  const pending = readSourcePropositionSelection(savedRaw, savedContext);
  savedRaw.anchors[0].text = 'after-first-await'; savedContext.canonicalText = 'after-first-await';
  assert.deepEqual(await pending, draft);
  const prepareContext = clone(base.context), menuPending = prepareSourcePropositionSelection(prepareContext);
  prepareContext.projection.nodes[0].evidence[0].quote = 'changed after first await';
  assert.deepEqual(await menuPending, base.menu);
  pass('两异步入口在首await前快照所有原输入，后续调用方修改不换绑；全程零网络');
  console.log(`SOURCE PROPOSITION SELECTION CHECKS PASSED ${groups} groups`);
} finally { globalThis.fetch = oldFetch; }
