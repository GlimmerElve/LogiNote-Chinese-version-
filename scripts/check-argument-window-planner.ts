import assert from 'node:assert/strict';
import { argumentSentenceRanges, planArgumentWindows, readArgumentWindowText } from '../src/electron/rag/argumentWindowPlanner.ts';
import type { StructuredDocument, SourceBlockKind } from '../src/types.ts';

export function fixtureSource(rows: [SourceBlockKind, string, string?][], docId = 'synthetic-window-test'): StructuredDocument {
  let text = '';
  const blocks = rows.map(([kind, content, sectionPath = '测试']) => {
    if (text) text += '\n\n';
    const start = text.length; text += content;
    return { id: `B${start}`, kind, sectionPath, textStart: start, textEnd: text.length,
      locator: { kind: 'text' as const, charStart: start, charEnd: text.length } };
  });
  return { schemaVersion: 1, docId, normalizedText: text, blocks };
}
const options = { targetCoreTokens: 70, maxCoreTokens: 110, maxContextTokens: 90, maxBodyTokens: 200 };
let checks = 0;
const check = (name: string, action: () => void) => { action(); checks++; console.log(`PASS ${name}`); };
check('分号和引号不拆语义', () => {
  for (const text of ['只有网络可用；客户端才会同步。', '名称为“稳健；可回退”，不是两种方案。', '在 B 下，A 可能导致 C，也可能导致 D。', 'The value is 0.180, according to Dr. Wang.']) {
    assert.equal(argumentSentenceRanges(text).length, 1);
  }
});
check('完整句界可切，原话不重写', () => {
  const text = '第一条完整陈述。第二条完整陈述！';
  assert.deepEqual(argumentSentenceRanges(text).map(s => text.slice(s.start, s.end)), ['第一条完整陈述。', '第二条完整陈述！']);
});
check('跨物理行的条件保持同读', () => {
  const source = fixtureSource([['paragraph', '只有网络可用'], ['paragraph', '且设备已授权时；客户端才会同步。']]);
  const plan = planArgumentWindows(source, options);
  assert.equal(plan.units.length, 1); assert.equal(plan.units[0].blockIds.length, 2);
});
check('短资料不机械拆成多次请求', () => {
  const source = fixtureSource([['paragraph', '当选项难比较时，增加选项可能降低购买意愿。实验中两组购买比例不同。因此作者提出比较成本解释。但对熟悉产品者未必适用。']]);
  assert.equal(planArgumentWindows(source).windows.length, 1);
});
check('章节边界不拼接，短章节不凑满', () => {
  const source = fixtureSource([['heading', '甲'], ['paragraph', '甲的定义。', '甲'], ['heading', '乙'], ['paragraph', '乙的定义。', '乙']]);
  const plan = planArgumentWindows(source);
  assert.equal(plan.windows.length, 2); assert.equal(plan.checks.sourceCoverage, 1);
});
check('条件与否定词不遗失', () => {
  const source = fixtureSource([['paragraph', '在 B 条件下，A 可能导致 C，也可能导致 D。但不能因此认定必然发生 C。']]);
  const plan = planArgumentWindows(source, options);
  assert.match(readArgumentWindowText(source, plan.windows[0]).core, /在 B 条件下.*可能/u);
  assert.match(readArgumentWindowText(source, plan.windows[0]).core, /不能/u);
});
check('同核心覆盖一次，上下文允许重复', () => {
  const source = fixtureSource(Array.from({ length: 24 }, (_, i) => ['paragraph', `第${i}项研究采用独立样本，比较两种条件下的结果，记录原始观察而不作普遍因果断言。`]));
  const plan = planArgumentWindows(source, options);
  assert.ok(plan.windows.length > 3); assert.ok(plan.windows.some(w => w.before.length || w.after.length));
  assert.equal(plan.checks.sourceCoverage, 1); assert.equal(plan.checks.duplicateCoreCharacters, 0); assert.ok(plan.checks.budgetPassed);
  assert.deepEqual(plan, planArgumentWindows(source, options));
});
check('超长句保留共同父句与警告', () => {
  const source = fixtureSource([['paragraph', '在特定条件下' + '仅表示原始观察而不是无条件断言'.repeat(40) + '。']]);
  const plan = planArgumentWindows(source, options);
  assert.ok(plan.windows.length > 1); assert.ok(plan.units.every(u => u.continuation));
  assert.equal(new Set(plan.units.map(u => u.parentId)).size, 1);
  assert.ok(plan.windows.every(w => w.gaps.includes('requires_complete_parent_sentence')));
  assert.equal(plan.checks.sourceCoverage, 1); assert.ok(plan.checks.budgetPassed);
});
check('表格列表不假装已恢复共享语义', () => {
  const source = fixtureSource([['paragraph', '只有满足 B 时，下列条目才适用：'], ['list', '- 方案一\n- 方案二'], ['table', '| 条件 | 比例（%） |\n| B | 12 |']]);
  const plan = planArgumentWindows(source, options);
  assert.ok(plan.windows.filter(w => w.kind !== 'paragraph').every(w => w.gaps.includes('shared_header_or_intro_not_semantically_bound')));
  assert.equal(plan.checks.sourceCoverage, 1);
});
check('长文不再受整源256物理块限制', () => {
  const source = fixtureSource(Array.from({ length: 300 }, () => ['paragraph', '这是完整的资料陈述。']));
  assert.equal(planArgumentWindows(source, options).checks.sourceCoverage, 1);
});
check('缺正文、重叠块和非法预算拒绝', () => {
  const source = fixtureSource([['paragraph', '完整正文。']]);
  assert.throws(() => planArgumentWindows({ ...source, blocks: [] }), /unmapped_source/);
  assert.throws(() => planArgumentWindows({ ...source, blocks: [...source.blocks, ...source.blocks] }), /invalid_block/);
  assert.throws(() => planArgumentWindows(source, { maxCoreTokens: 0 }), /invalid_budget/);
  assert.throws(() => planArgumentWindows(source, { tokenBudgetKind: 'tokenizer' }), /invalid_budget/);
});
check('调用方真实计数器计入预算', () => {
  const source = fixtureSource([['paragraph', '完整句子。'.repeat(12)]]);
  const plan = planArgumentWindows(source, { ...options, measureTokens: t => [...t].length,
    tokenBudgetKind: 'tokenizer', tokenCounterId: 'test-only-codepoint-counter' });
  assert.equal(plan.budget.kind, 'tokenizer'); assert.ok(plan.checks.budgetPassed);
});
check('不冒称语义验收、无副作用', () => {
  const source = fixtureSource([['paragraph', '这是一个未验证的主张。']]);
  const before = JSON.stringify(source), plan = planArgumentWindows(source);
  assert.equal(JSON.stringify(source), before); assert.equal(plan.checks.semanticCompleteness, 'not_assessed');
  assert.ok(plan.windows.every(w => w.semanticReview === 'not_performed'));
});
check('跨页续句排除重复页眉，来源片段不漂移', () => {
  const source = fixtureSource([['heading', '# JOURNAL'], ['paragraph', '只有网络可用且设备'],
    ['heading', '# JOURNAL'], ['paragraph', '已授权时，客户端才会同步。']]);
  source.blocks.forEach((b, i) => { b.locator = { kind: 'pdf', page: i < 2 ? 1 : 2, bbox: [20, i % 2 ? 100 : 10, 200, i % 2 ? 120 : 30] }; });
  const plan = planArgumentWindows(source, options);
  assert.equal(plan.metadata.length, 2); assert.equal(plan.units.length, 1);
  const unit = plan.units[0]; assert.equal(unit.segments.length, 2);
  assert.equal(readArgumentWindowText(source, plan.windows[0]).core, '只有网络可用且设备已授权时，客户端才会同步。');
  assert.ok(unit.segments.every(s => source.normalizedText.slice(s.start, s.end).trim()));
  assert.equal(plan.checks.sourceCoverage, 1); assert.equal(plan.checks.duplicateCoreCharacters, 0);
});
check('不把普通重复正文误归为页眉', () => {
  const source = fixtureSource([['paragraph', '页首正文完整说明。'], ['paragraph', '这是需要保留的实验条件。'], ['paragraph', '页尾正文完整说明。'],
    ['paragraph', '另页首正文完整说明。'], ['paragraph', '这是需要保留的实验条件。'], ['paragraph', '另页尾正文完整说明。']]);
  source.blocks.forEach((b, i) => { const y = [10, 300, 700][i % 3]; b.locator = { kind: 'pdf', page: i < 3 ? 1 : 2, bbox: [20, y, 200, y + 10] }; });
  const plan = planArgumentWindows(source); assert.equal(plan.metadata.length, 0);
  assert.equal(plan.checks.sourceCoverage, 1);
});
check('未闭合引号和残句不冒充完整', () => {
  const source = fixtureSource([['paragraph', '作者说“这是未闭合引用。']]);
  const plan = planArgumentWindows(source);
  assert.equal(plan.windows[0].boundaryStatus, 'needs_context');
  assert.ok(plan.windows[0].gaps.includes('unclosed_quote_or_bracket'));
  assert.equal(planArgumentWindows(fixtureSource([['paragraph', '仅当设备已经授权']])).windows[0].boundaryStatus, 'needs_context');
});
check('跨栏疑点可读但不得静默认证顺序', () => {
  const source = fixtureSource([['paragraph', '在条件'], ['paragraph', 'B 下可能成立。']]);
  source.blocks[0].locator = { kind: 'pdf', page: 1, bbox: [10, 500, 200, 520] };
  source.blocks[1].locator = { kind: 'pdf', page: 1, bbox: [300, 100, 500, 120] };
  const plan = planArgumentWindows(source);
  assert.equal(plan.units.length, 1); assert.equal(plan.windows[0].boundaryStatus, 'needs_context');
  assert.ok(plan.windows[0].gaps.some(g => g.startsWith('layout_order_uncertain:')));
});
check('来源换版拒绝沿用旧窗口', () => {
  const source = fixtureSource([['paragraph', '在条件 B 下可能成立。']]), w = planArgumentWindows(source).windows[0];
  assert.throws(() => readArgumentWindowText({ ...source, docId: 'other' }, w), /version_mismatch/);
  assert.throws(() => readArgumentWindowText({ ...source, normalizedText: source.normalizedText + '变更' }, w), /version_mismatch/);
});
check('正文与参考文献分开验收', () => {
  const source = fixtureSource([['paragraph', '正文观点。'], ['heading', '# References'], ['paragraph', 'Author (2020). Study.']]);
  const plan = planArgumentWindows(source);
  assert.equal(plan.windows.length, 2); assert.equal(plan.windows[0].core[0].contentRole, 'body');
  assert.equal(plan.windows[1].core[0].contentRole, 'bibliography');
  assert.equal(plan.windows[1].boundaryStatus, 'unstructured');
  assert.equal(plan.checks.sourceCoverage, 1);
});
check('复合DOI页脚不插入跨页句，参考文献编号不变章节', () => {
  const source = fixtureSource([['paragraph', '仅在条件 B 下提供理'], ['paragraph', 'DOI: 10.123/a\n312\n社会科学前沿'],
    ['paragraph', '论依据。'], ['paragraph', '参考文献'], ['paragraph', '14 Sheldon K. Study title:'], ['paragraph', 'Journal (2020).']]);
  source.blocks.forEach((b, i) => { b.locator = { kind: 'pdf', page: i < 2 ? 1 : 2, bbox: [20, i === 1 ? 750 : 100 + i * 20, 200, i === 1 ? 790 : 115 + i * 20] }; });
  const plan = planArgumentWindows(source);
  assert.equal(plan.metadata.length, 1);
  assert.equal(readArgumentWindowText(source, plan.windows[0]).core, '仅在条件 B 下提供理论依据。');
  assert.ok(plan.windows.slice(1).every(w => w.core[0].contentRole === 'bibliography'));
  assert.equal(plan.checks.sourceCoverage, 1);
});
check('跨节指代必须报告缺口，不猜连线', () => {
  const source = fixtureSource([['heading', '甲'], ['paragraph', '甲方案。', '甲'], ['heading', '乙'], ['paragraph', '以上方案在条件 B 下才成立。', '乙']]);
  const plan = planArgumentWindows(source);
  assert.equal(plan.windows[1].boundaryStatus, 'needs_context');
  assert.ok(plan.windows[1].gaps.includes('unresolved_previous_context'));
});
check('重复的页首条件句保守保留，双语参考文献标题识别', () => {
  const source = fixtureSource([['paragraph', '只有网络可用时，才会同步。'], ['paragraph', '正文甲。'],
    ['paragraph', '只有网络可用时，才会同步。'], ['paragraph', '正文乙。'], ['heading', '参考文献 (References)'], ['paragraph', 'Author (2020). Study.']]);
  source.blocks.forEach((b, i) => { b.locator = { kind: 'pdf', page: i < 2 ? 1 : 2, bbox: [20, i % 2 ? 200 : 10, 200, i % 2 ? 220 : 30] }; });
  const plan = planArgumentWindows(source); assert.equal(plan.metadata.length, 0);
  assert.equal(plan.windows.at(-1)!.core[0].contentRole, 'bibliography');
  assert.equal(plan.checks.sourceCoverage, 1);
});
check('通讯脚注隔离后，跨栏原句仍可回读', () => {
  const source = fixtureSource([['paragraph', '此领域的研究'], ['paragraph', '收稿日期:2007-12-10'], ['paragraph', '通讯作者:某某,E-mail: test@example.invalid'], ['paragraph', '者们关注不同目标类型。']]);
  source.blocks.forEach((b, i) => { b.locator = { kind: 'pdf', page: 1, bbox: i === 3 ? [300, 100, 500, 120] : [20, 500 + i * 50, 200, 520 + i * 50] }; });
  const plan = planArgumentWindows(source);
  assert.equal(readArgumentWindowText(source, plan.windows[0]).core, '此领域的研究者们关注不同目标类型。');
  assert.equal(plan.metadata.length, 2); assert.equal(plan.checks.sourceCoverage, 1);
  assert.ok(plan.windows[0].gaps.some(g => g.startsWith('layout_order_uncertain:')));
});
console.log(JSON.stringify({ checks, modelRequests: 0, productionWrites: 0 }));
