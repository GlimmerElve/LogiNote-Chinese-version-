/** Source-window and durable-resume regression. Synthetic text, zero network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { entryFigureLesson } from '../src/services/textbook/interactiveFigureSourceContext';
import { findInteractiveFigureEntries } from '../src/services/textbook/interactiveFigureMarker';
import { figureLesson, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import { InteractiveFigureStore } from '../src/electron/interactiveFigureStore';
import { selectEntryTeachingModelType } from '../src/services/textbook/teachingModelProtocol';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Source context tests must not call a model or the network');
const root = await fs.mkdtemp(path.resolve('build/interactive-source-context-'));
const checks: string[] = [], observations: any[] = [];
const key = (letter: string) => letter.repeat(64);
let store = new InteractiveFigureStore(root), fakeCalls = 0;
const selection = { before: '污染的KaTeX前文 x x² x^2 与另一处例子', after: '污染的KaTeX后文和重复读数' };
const brief = '这里的操作应揭示同一输入在两种条件下的不同结果。';
const body = '# 合成教材\n\n## 无关前节\n前节专门介绍 LRU，不能借用。\n\n## 本节条件\n本节保持同一输入，比较约束不同的两种结果。\n\n'
  + brief + '\n\n本节的规则与边界就在这段原文中。\n\n## 无关后节\n后节介绍另一种算法，不是本节的目标。';
const fallback = figureLesson(body, brief, selection);
const expected = '## 本节条件\n本节保持同一输入，比较约束不同的两种结果。\n\n' + brief + '\n\n本节的规则与边界就在这段原文中。\n\n';
const purposeHtml = '<section data-figure-mode="contrast"><button data-figure="reset">重置</button><button>改变条件</button><div data-figure="visual"><div data-figure="case">条件甲</div><div data-figure="case">条件乙</div></div><output data-figure="result">初始对照</output></section>';
const legacyHtml = '<input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">另一个条件会怎样？</p>';
const design = { anchor: brief, goal: '观察同一输入下条件的作用', action: '改变条件', observation: '比较两种结果',
  model: '合成材料给出的条件规则', prediction: '先想一想', caveat: '仅为定性教学示意', transfer: '换一种条件会发生什么？' };
const api = () => ({ read: (id: string) => store.read(id), write: (id: string, value: any) => store.write(id, value),
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} });
const requestRecord = (request: any) => ({ systemPrompt: request.systemPromptOverride, userInput: request.userInput,
  maxTokens: request.maxTokensOverride, thinkingMode: request.thinkingMode });

try {
  assert.equal(entryFigureLesson(body, brief, fallback, selection), expected);
  assert.ok(!expected.includes('LRU') && !expected.includes('KaTeX'));
  assert.equal(selectEntryTeachingModelType(brief, expected, false, true), undefined);
  checks.push('原句唯一时由原Markdown回取同H2片段，去掉KaTeX上下文污染；跨H2前后内容不借用');

  const duplicate = '# 当前章\n' + brief + '\n另一处又说：' + brief;
  assert.equal(entryFigureLesson(duplicate, brief, fallback, selection), fallback, 'Repeated passages cannot choose an origin by guessing');
  const overlap = '重复重复重复', overlapBrief = '重复重复';
  assert.equal(entryFigureLesson(overlap, overlapBrief, 'captured overlap scope', selection), 'captured overlap scope', 'Overlapping occurrences are still ambiguous');
  assert.equal(entryFigureLesson('原Markdown只含 $x^2$。', 'x²', fallback, selection), fallback, 'Markup-spanning or normalized formulas retain their captured scope');
  checks.push('重复与重叠同文不猜来源；格式化公式未精确匹配时保持原捕获范围');

  const fenced = '# 正文\n## 真正小节\n本节的参数仍属于此处。\n```text\n## LRU是假标题\n```\n' + brief + '\n本节结尾。\n## 下一节\n缓存内容不属于当前节。';
  const fencedContext = entryFigureLesson(fenced, brief, fallback, selection);
  assert.ok(fencedContext.startsWith('## 真正小节'), 'A heading inside a code fence cannot cut the source region');
  assert.ok(fencedContext.includes('```text\n## LRU是假标题\n```'));
  assert.equal(selectEntryTeachingModelType(brief, fencedContext, false, true), undefined);
  const longFenceBody = '# 正文\n## 当前小节\n```text\n' + '代码说明。'.repeat(1800)
    + '\nLRU缓存命中与淘汰的代码例子\n```\n' + brief + '\n这里的正文没有给出缓存模型。';
  const longFenceContext = entryFigureLesson(longFenceBody, brief, '安全捕获：' + brief, selection);
  assert.equal(selectEntryTeachingModelType(brief, longFenceContext, false, true), undefined,
    'A source-window boundary inside a long fence cannot turn its tail into prose evidence');
  const longCommentBody = '# 正文\n## 当前小节\n<!--' + '内部说明。'.repeat(1800)
    + '\nLRU缓存命中与淘汰仅是隐藏注释\n-->\n' + brief + '\n这里的正文没有给出缓存模型。';
  assert.equal(selectEntryTeachingModelType(brief, entryFigureLesson(longCommentBody, brief, '安全捕获：' + brief, selection), false, true), undefined,
    'A source-window boundary inside a long comment cannot turn its tail into prose evidence');
  checks.push('围栏/注释中的伪标题不切断真实小节，长块裁切不会把代码示例或隐藏注释当正文路由');

  const firstMarker = '> **交互探索**\n>\n> 逐步观察缓存的命中。\n';
  const lateMarker = '> **交互探索**\n>\n> 动态演示本节对象的变化，\n> 暂停后观察中间状态。\n';
  const markerBody = '# 前一章\nLRU 前章内容不能混入。\n' + firstMarker + '\n# 目标章\n此处是唯一的弹簧振子模型。\n'
    + lateMarker + '\n该目标章说明振子的回复力关系。\n# 后一章\n后章的0/1背包不能混入。';
  const markerBrief = findInteractiveFigureEntries(markerBody).find(entry => entry.brief.includes('中间状态'))!.brief;
  const markerContext = entryFigureLesson(markerBody, markerBrief, 'WRONG FIRST MARKER FALLBACK');
  assert.ok(markerContext.startsWith('# 目标章')); assert.ok(markerContext.includes(lateMarker));
  assert.ok(!markerContext.includes('LRU') && !markerContext.includes('0/1背包'));
  assert.equal(selectEntryTeachingModelType(markerBrief, markerContext), 'oscillator');
  const sameChapter = '# 同一章\n## 前半段\n这里讲LRU缓存的命中与淘汰。\n' + firstMarker
    + '\n' + '背景说明。'.repeat(900) + '\n## 后半段\n此处只讲弹簧振子的运动关系。\n' + lateMarker;
  const sameChapterContext = entryFigureLesson(sameChapter, markerBrief, 'wrong first marker');
  assert.ok(sameChapterContext.includes(firstMarker) && sameChapterContext.includes(lateMarker), 'The chapter context deliberately retains both markers');
  assert.equal(selectEntryTeachingModelType(markerBrief, sameChapterContext), 'oscillator', 'Routing must anchor the matching multiline marker, not the first marker in the chapter');
  const repeatedMarkerBody = '# 一章\n' + lateMarker + '\n重复一次\n' + lateMarker;
  assert.equal(entryFigureLesson(repeatedMarkerBody, markerBrief, 'ambiguous marker'), 'ambiguous marker');
  assert.ok(entryFigureLesson('# 一章\n' + '前'.repeat(20_000) + lateMarker + '后'.repeat(20_000), markerBrief, 'fallback').length <= 16000);
  assert.equal(entryFigureLesson('整'.repeat(17_000), '', 'fallback', { before: '', after: '', wholePage: true }).length, 16000);
  checks.push('后段多行marker按真实span定位同H1章节与正确路由，跨章不借、同章不锚到首个marker；重复marker保留fallback且上下文不超过16k');

  let firstRequest: any;
  await assert.rejects(prepareInteractiveFigure(key('a'), body, brief, false, { api: api(), generate: async request => {
    fakeCalls++; firstRequest = requestRecord(request); assert.equal(JSON.parse(request.userInput).lesson, expected); throw Error('synthetic interruption');
  } }, { projectId: 'synthetic', legacy: false, teachingPolicy: 2 }, selection));
  const failed = await store.read(key('a')); assert.equal(failed?.status, 'failed');
  assert.equal((failed as any).lessonContext, expected);
  // Simulate an application that closed while the same reservation was pending.
  await store.write(key('a'), { status: 'pending', teachingMode: 'contrast', lessonContext: expected });
  store = new InteractiveFigureStore(root);
  let resumedRequest: any;
  await prepareInteractiveFigure(key('a'), body, brief, true, { api: api(), generate: async request => {
    fakeCalls++; resumedRequest = requestRecord(request); assert.equal(JSON.parse(request.userInput).lesson, expected);
    return { content: JSON.stringify({ design, html: purposeHtml }) };
  } }, { projectId: 'synthetic', legacy: false, teachingPolicy: 2 }, { before: '重启后另一份渲染污染', after: '不得改变已冻结原文' });
  assert.deepEqual(resumedRequest, firstRequest, 'The saved lesson, route and full prompt remain byte-for-byte frozen');
  const readyFile = path.join(root, 'interactive-figures', key('a') + '.json');
  const readyBefore = await fs.readFile(readyFile, 'utf8');
  assert.ok(!readyBefore.includes('lessonContext'), 'Ready shape/digest does not acquire a context field');
  await prepareInteractiveFigure(key('a'), body, brief, false, { api: api(), generate: async () => assert.fail('Ready reopen must not generate') }, { projectId: 'synthetic', legacy: false, teachingPolicy: 2 }, selection);
  assert.equal(await fs.readFile(readyFile, 'utf8'), readyBefore);
  checks.push('新pending关闭重启后原文、路由与完整请求逐字冻结；ready重开不生成、不添加上下文或改写摘要');

  await store.write(key('b'), { status: 'pending', lessonContext: expected });
  const contextFile = path.join(root, 'interactive-figures', key('b') + '.json');
  const tampered = JSON.parse(await fs.readFile(contextFile, 'utf8')); tampered.lessonContext += '被篡改的内容';
  await fs.writeFile(contextFile, JSON.stringify(tampered));
  await assert.rejects(store.read(key('b')), /上下文校验失败/u);
  await store.write(key('b'), { status: 'failed', lessonContext: expected });
  await store.clearUnfinished(key('b')); assert.deepEqual(await store.read(key('b')), { status: 'dismissed' });
  assert.ok(!(await fs.readFile(contextFile, 'utf8')).includes('lessonContext'));
  await store.write(key('b'), { status: 'failed', lessonContext: expected, previousHtml: legacyHtml });
  await store.clearUnfinished(key('b')); assert.deepEqual(await store.read(key('b')), { status: 'ready', html: legacyHtml });
  assert.ok(!(await fs.readFile(contextFile, 'utf8')).includes('lessonContext'));
  checks.push('上下文摘要篡改拒绝；清除失败任务/恢复上一版后上下文字段与摘要均移除');

  let oldFreshRequest: any, oldResumedRequest: any;
  await prepareInteractiveFigure(key('c'), body, brief, false, { api: api(), generate: async request => {
    fakeCalls++; oldFreshRequest = requestRecord(request); return { content: JSON.stringify({ design, html: legacyHtml }) };
  } }, undefined, selection);
  await store.write(key('d'), { status: 'pending' }); store = new InteractiveFigureStore(root);
  await prepareInteractiveFigure(key('d'), body, brief, true, { api: api(), generate: async request => {
    fakeCalls++; oldResumedRequest = requestRecord(request); return { content: JSON.stringify({ design, html: legacyHtml }) };
  } }, { projectId: 'synthetic', legacy: false, teachingPolicy: 2 }, selection);
  assert.deepEqual(oldResumedRequest, oldFreshRequest);
  assert.equal(JSON.parse(oldResumedRequest.userInput).lesson, fallback);
  checks.push('旧无上下文、无策略的pending即使从新policy2入口恢复，也逐字使用原figureLesson和完整旧请求');

  await store.write(key('e'), { status: 'pending', lessonContext: '原'.repeat(16000) });
  assert.equal((await store.read(key('e')) as any).lessonContext.length, 16000);
  await assert.rejects(store.write(key('e'), { status: 'pending', lessonContext: '原'.repeat(16001) }), /上下文无效/u);
  await assert.rejects(store.write(key('e'), { status: 'pending', lessonContext: '\u0001' }), /上下文无效/u);
  const previousHtml = '<button>' + '"'.repeat(99_000) + '</button>', draftHtml = '<div>' + '\\'.repeat(99_000) + '</div>';
  await store.write(key('f'), { status: 'failed', previousHtml, draftHtml, lessonContext: '\\'.repeat(8000) });
  const largeFile = path.join(root, 'interactive-figures', key('f') + '.json'), before = await fs.readFile(largeFile, 'utf8');
  assert.ok(before.length > 400_000 && before.length <= 425_000);
  await assert.rejects(store.write(key('f'), { status: 'failed', previousHtml, draftHtml, lessonContext: '\\'.repeat(16000) }), /序列化后过大/u);
  assert.equal(await fs.readFile(largeFile, 'utf8'), before, 'Overflow cannot overwrite the last valid artifact');
  assert.deepEqual((await new InteractiveFigureStore(root).read(key('f')) as any).lessonContext, '\\'.repeat(8000));
  observations.push({ maximumAcceptedContextCharacters: 16000, boundedEscapedArtifactCharacters: before.length, serializedLimit: 425000 });
  checks.push('16k上下文边界与425k转义序列化总边界受控；超限写入不覆盖上一份有效附件');

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', root, modelRequests: 0, networkRequests: 0,
    fakeGenerationCalls: fakeCalls, checks, observations }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, modelRequests: 0, fakeGenerationCalls: fakeCalls, checks: checks.length, observations }));
} finally { globalThis.fetch = originalFetch; }
