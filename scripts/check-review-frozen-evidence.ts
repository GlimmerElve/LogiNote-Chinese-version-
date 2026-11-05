import assert from 'node:assert/strict';
import { buildArgumentReferenceDisclosure, type ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import { exactUniqueSpan, referenceNodeAnchor, validateFrozenOutcomeWitness,
  validateFrozenReferencePropositionAnchor } from '../src/services/reviewComparison/frozenReferenceEvidence.ts';
import type { FrozenReferenceShadowInput } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';

const network = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Frozen evidence checks forbid all network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const rejects = (call: () => unknown, code: string) => assert.throws(call, error => error instanceof Error && error.message === code);
const sourceFail = (call: () => unknown) => rejects(call, 'invalid_exact_evidence');
const anchorFail = (call: () => unknown) => rejects(call, 'invalid_reference_node_anchor');
const outcomeFail = (call: () => unknown) => rejects(call, 'invalid_opposition_witness');

try {
  assert.deepEqual(exactUniqueSpan('前🧠后：会报警。', '会报警'), { start: 5, end: 8, quote: '会报警' });
  assert.deepEqual(exactUniqueSpan('🧠', '🧠'), { start: 0, end: 2, quote: '🧠' });
  pass('中文及合法 surrogate pair 按 UTF-16 原坐标回核，不按字符数猜测');

  assert.deepEqual(exactUniqueSpan('A， B', '， '), { start: 1, end: 3, quote: '， ' });
  assert.deepEqual(exactUniqueSpan('整段原文。', '整段原文。'), { start: 0, end: 5, quote: '整段原文。' });
  pass('引用不 trim、不剪标点；完整原文可以是合法唯一锚点');

  for (const quote of ['', ' ', '\r\n', null, 3, {}, []]) sourceFail(() => exactUniqueSpan('文本', quote));
  pass('空白、非字符串和空片段全部拒绝');

  sourceFail(() => exactUniqueSpan('会报警，不会报警。', '会报警'));
  sourceFail(() => exactUniqueSpan('aaa', 'aa'));
  pass('重复及重叠出现都拒绝，不能偷取第一处');

  sourceFail(() => exactUniqueSpan('不会报警。', '不报警'));
  sourceFail(() => exactUniqueSpan('A B', 'AB'));
  sourceFail(() => exactUniqueSpan('Ａ', 'A'));
  pass('不存在、拼接及 Unicode 归一化后的相似片段不冒充原话');

  sourceFail(() => exactUniqueSpan('🧠', '\ud83e'));
  sourceFail(() => exactUniqueSpan('🧠', '\udde0'));
  sourceFail(() => exactUniqueSpan('坏\ud83e原文', '原文'));
  pass('拆 surrogate 与已损坏的 UTF-16 输入拒绝');

  assert.equal(exactUniqueSpan('x'.repeat(1600), 'x'.repeat(1600)).end, 1600);
  sourceFail(() => exactUniqueSpan('x'.repeat(1601), 'x'.repeat(1601)));
  sourceFail(() => exactUniqueSpan('x'.repeat(60001), 'x'));
  for (const maximum of [0, -1, 1.5, Number.NaN, 60001]) sourceFail(() => exactUniqueSpan('x', 'x', maximum));
  pass('原文、锚点及自定义预算有严格上限');

  const fixture = await createReferenceDisclosureFixture({ task: 'reasoning' });
  const reply = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.equal(reply.status, 'ready');
  if (reply.status !== 'ready') throw new Error('synthetic_reference_not_ready');
  const context = reply.context, frame = context.frames[0], node = frame.nodes.find(node => node.id === 'N2')!;
  const quoteId = node.quoteIds[0], whole = context.quotes.find(quote => quote.quoteId === quoteId)!;
  const selection = { frameId: frame.frameId, nodeId: node.id, quoteId, referenceQuote: '本次合成设备会报警', role: node.role };
  const before = structuredClone(context), anchor = validateFrozenReferencePropositionAnchor(context, selection);
  assert.equal(anchor.quote, selection.referenceQuote);
  assert.equal(anchor.start, whole.start + whole.text.indexOf(selection.referenceQuote));
  assert.equal(anchor.end - anchor.start, selection.referenceQuote.length);
  assert.equal(fixture.notes[0].content.slice(anchor.start, anchor.end), anchor.quote);
  assert.deepEqual(anchor.context, { start: whole.start, end: whole.end, text: whole.text });
  assert.deepEqual(anchor.source, frame.source); assert.equal(anchor.sourceKey, whole.sourceKey);
  assert.equal(anchor.semanticTruth, 'not_certified'); assert.deepEqual(context, before);
  pass('真实合成构建→准入→freeze→disclosure 回核结论子句，并保留整句规则上下文');

  const input: FrozenReferenceShadowInput = { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: 'synthetic',
    answer: { text: '用户原话', hintLevel: 0, consultedMaterialCount: 0 },
    taskContext: { questionText: '合成提问', usage: 'question_context_only' }, graph: { claims: [], edges: [] }, reference: context };
  assert.deepEqual(referenceNodeAnchor(input, selection.frameId, selection.nodeId, selection.quoteId, selection.referenceQuote, selection.role), anchor);
  assert.deepEqual(referenceNodeAnchor(input, selection.frameId, selection.nodeId, selection.quoteId, selection.referenceQuote), anchor);
  pass('canonical input 便捷 API 结果一致；无需模型重声明节点职责');

  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, role: 'premise' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, role: undefined }));
  pass('显式职责必须等于宿主保存的职责，undefined 不能绕过');

  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, frameId: 'reference/target-1' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, nodeId: 'reference/target-1/node/N2' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, frameId: 'target-2' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, nodeId: 'N99' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, quoteId: 'Q999' }));
  pass('未知与模型命名空间 ID 不作为宿主 canonical ID 使用');

  const foreign = frame.nodes.find(node => node.id === 'N1')!.quoteIds[0];
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, quoteId: foreign,
    referenceQuote: context.quotes.find(quote => quote.quoteId === foreign)!.text }));
  pass('即使引文存在，也必须属于选定节点，不能借另一节点原话');

  const mutate = (change: (value: ArgumentReferenceDisclosureContext) => void) => {
    const changed = structuredClone(context); change(changed);
    anchorFail(() => validateFrozenReferencePropositionAnchor(changed, selection));
  };
  mutate(value => value.frames.push(structuredClone(value.frames[0])));
  mutate(value => value.frames[0].nodes.push(structuredClone(node)));
  mutate(value => value.quotes.push(structuredClone(whole)));
  mutate(value => value.frames[0].nodes.find(node => node.id === 'N2')!.quoteIds.push(quoteId));
  pass('重复 frame、node、quote 和引用名单不会制造模糊身份');

  mutate(value => { value.coverage = 'frame_subset'; });
  mutate(value => { value.quotes.find(quote => quote.quoteId === quoteId)!.start = -1; });
  mutate(value => { value.quotes.find(quote => quote.quoteId === quoteId)!.end += 1; });
  mutate(value => { value.quotes.find(quote => quote.quoteId === quoteId)!.sourceKey = ''; });
  pass('不完整标准、非法源坐标与缺失源绑定拒绝');

  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, referenceQuote: '本次设备不会报警' }));
  anchorFail(() => validateFrozenReferencePropositionAnchor(context, { ...selection, extra: true } as typeof selection));
  pass('锚点不能改写原话或附加宿主未定义字段');

  const rule = validateFrozenReferencePropositionAnchor(context, { ...selection, referenceQuote: '读数超过阈值会报警' });
  assert.equal(rule.role, 'conclusion'); assert.equal(rule.semanticTruth, 'not_certified');
  assert.equal(rule.context.text, whole.text);
  pass('引用来源检查不是命题职责认证：整段含规则时不擅自剪句或迁移原节点');

  const direct = validateFrozenOutcomeWitness('维护时会按该规则报警。', '维护时不按该规则报警。', '会按该规则报警', '不按该规则报警');
  assert.equal(direct.user.quote, '会按该规则报警'); assert.equal(direct.reference.quote, '不按该规则报警');
  assert.equal(direct.user.context, '维护时会按该规则报警。'); assert.equal(direct.reference.context, '维护时不按该规则报警。');
  assert.equal(direct.comparison, 'different_literal_values_only'); assert.equal(direct.semanticTruth, 'not_certified');
  pass('不同结果必须来自双方唯一原话，保留完整条件语境，仍不认证相反为真');

  outcomeFail(() => validateFrozenOutcomeWitness('会报警。', '会报警。', '会报警', '会报警'));
  outcomeFail(() => validateFrozenOutcomeWitness('会报警。', '会 报警。', '会报警', '会 报警'));
  outcomeFail(() => validateFrozenOutcomeWitness('ALARM', 'ａｌａｒｍ', 'ALARM', 'ａｌａｒｍ'));
  pass('相同结果、空白、大小写与 NFKC 变体不能伪造矛盾见证');

  for (const punctuation of ['。', '.', '…', '...', '！', '？', '；', '，', '。）']) {
    outcomeFail(() => validateFrozenOutcomeWitness('会报警', `会报警${punctuation}`, '会报警', `会报警${punctuation}`));
  }
  outcomeFail(() => validateFrozenOutcomeWitness('会报警', '...“会报警。”...', '会报警', '...“会报警。”...'));
  for (const quotes of [['“', '”'], ['「', '」'], ['(', ')'], ['［', '］'], ['《', '》']]) {
    const alternate = `${quotes[0]}会报警${quotes[1]}`;
    outcomeFail(() => validateFrozenOutcomeWitness('会报警', alternate, '会报警', alternate));
  }
  pass('外围句读、引号、括号及全角包裹不能绕过同结果拒绝');

  for (const [left, right] of [['-5', '5'], ['+5', '-5'], ['1.0', '10'], ['.5', '5'], ['1%', '1'], ['A-B', 'AB']]) {
    const witness = validateFrozenOutcomeWitness(left, right, left, right);
    assert.equal(witness.user.quote, left); assert.equal(witness.reference.quote, right);
    assert.equal(witness.semanticTruth, 'not_certified');
  }
  pass('数字符号、小数、内部连接符和单位原样保留；文字不同不等于语义相反');

  outcomeFail(() => validateFrozenOutcomeWitness('。', '!', '。', '!'));
  outcomeFail(() => validateFrozenOutcomeWitness('.', '!', '.', '!'));
  outcomeFail(() => validateFrozenOutcomeWitness('x', 'y', '不存在', 'y'));
  outcomeFail(() => validateFrozenOutcomeWitness('会报警会报警', '不会报警', '会报警', '不会报警'));
  outcomeFail(() => validateFrozenOutcomeWitness('x'.repeat(321), 'y', 'x'.repeat(321), 'y'));
  outcomeFail(() => validateFrozenOutcomeWitness('🧠', 'y', '\ud83e', 'y'));
  pass('见证必须有非空结果、唯一位置、合法 UTF-16 且在独立 320 字预算内');

  const synonyms = validateFrozenOutcomeWitness('会报警', '将触发警报', '会报警', '将触发警报');
  assert.equal(synonyms.semanticTruth, 'not_certified');
  assert.equal(synonyms.comparison, 'different_literal_values_only');
  pass('同义结果无法由字符串检查认证为相反，明确留下语义审核责任');

  const qualifiedSame = validateFrozenOutcomeWitness('本次包裹会进入二号通道', '本次合成包裹会进入二号通道',
    '本次包裹会进入二号通道', '本次合成包裹会进入二号通道');
  assert.equal(qualifiedSame.semanticTruth, 'not_certified');
  assert.equal(qualifiedSame.comparison, 'different_literal_values_only');
  outcomeFail(() => validateFrozenOutcomeWitness('本次包裹会进入二号通道', '本次合成包裹会进入二号通道',
    '会进入二号通道', '会进入二号通道'));
  pass('含对象修饰语的同义结果仍不能由宿主认证相反，不删词修历史见证；相同结果值拒绝');

  anchor.source.entityId = 'changed-return-only'; direct.user.context = 'changed-return-only';
  assert.deepEqual(context, before);
  assert.equal(fixture.notes[0].content.includes('维护时'), false);
  pass('返回对象独立，纯读、不修改冻结合同、源内容或生产储存');
  console.log(`Frozen reference evidence: ${checks} synthetic offline groups passed; no model requests or production writes.`);
} finally { globalThis.fetch = network; }
