import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { findInteractiveFigure } from '../src/services/textbook/interactiveFigureMarker';
import { interactiveFigureKey, prepareInteractiveFigure, withInteractiveFigureCleanup } from '../src/services/textbook/interactiveFigure';
import { interactiveFigureTitle } from '../src/services/textbook/interactiveFigureTitle';
import { sharedTeachingBody } from '../src/services/progressiveLearning/share';
import type { FigureArtifact } from '../src/electron/interactiveFigureStore';
import { selectFigureKind, loadFigureGuidance, selectFigureRenderer, loadFigureRendererGuidance, selectFigureMechanism, selectPageFigureMechanism, loadFigureMechanismGuidance } from '../src/services/textbook/interactiveFigureDesign';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const brief = '改变输入并观察输出的变化。';
const body = `# 合成教材\n\n已知 $y=x^2$。\n\n> **交互探索**\n>\n> ${brief}\n\n继续阅读。`;
assert.equal(findInteractiveFigure(body), brief);
assert.equal(findInteractiveFigure('```md\n> **交互探索**\n>\n> 不应执行\n```'), null);
assert.equal(findInteractiveFigure('> ```md\n> **交互探索**\n>\n> 不应执行\n> ```'), null);
const key = await interactiveFigureKey('synthetic', body, brief);
assert.notEqual(key, await interactiveFigureKey('synthetic', body + '修改', brief));
const records = new Map<string, FigureArtifact>(); let calls = 0, fail = true;
const design = { anchor: brief, goal: '理解平方函数', action: '调整输入', observation: '观察输出', model: 'y=x²', prediction: '预测输出', caveat: '教材示例', transfer: '换个输入' };
const validHtml = '<input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换个输入</p>';
const api = { read: async (id: string) => records.get(id) || null, write: async (id: string, value: FigureArtifact) => { records.set(id, value); },
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} };
const generate = async (request: any) => { calls++; assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
  assert.ok(request.userInput.includes(brief)); if (fail) throw Error('synthetic failure');
  return { content: JSON.stringify({ design, html: validHtml }) }; };
const deps = { api, generate };
const groupGoal = '比较预测选项';
const groupHtml = validHtml.replace('<input data-figure="prediction">', '<fieldset data-figure="prediction"><label><input type="radio" name="p" value="a">甲</label><label><input type="radio" name="p" value="b">乙</label></fieldset>');
assert.equal(await prepareInteractiveFigure(await interactiveFigureKey('group', groupGoal, groupGoal), groupGoal, groupGoal, false, {api, generate:async()=>({content:JSON.stringify({design:{...design,anchor:groupGoal},html:groupHtml})})}), groupHtml);
assert.equal(interactiveFigureTitle('观察 $y=x^2$ 的对称性', '根据本页教材的核心内容生成交互图。', '数学'), '观察 y=x^2 的对称性');
assert.equal(interactiveFigureTitle(undefined, '根据本页教材的核心内容生成交互图。', '心理账户'), '心理账户交互图');
const dismissedKey = await interactiveFigureKey('dismissed', body, brief);
records.set(dismissedKey, { status: 'dismissed' });
await assert.rejects(prepareInteractiveFigure(dismissedKey, body, brief, false, deps));
assert.equal(calls, 0, 'a cleared planned figure must not request the model');
let releaseCleanup: () => void = () => {};
const cleaning = withInteractiveFigureCleanup('locked', () => new Promise<void>(resolve => { releaseCleanup = resolve; }));
await assert.rejects(prepareInteractiveFigure('locked', body, brief, false, deps), /正在清理/u);
await assert.rejects(withInteractiveFigureCleanup('locked', async () => {}), /清理/u);
releaseCleanup(); await cleaning;
let releaseGeneration: () => void = () => {}, markStarted: () => void = () => {};
const generationStarted = new Promise<void>(resolve => { markStarted = resolve; });
const running = prepareInteractiveFigure('running', body, brief, false, { api, generate: async () => {
  markStarted();
  await new Promise<void>(resolve => { releaseGeneration = resolve; });
  return { content: JSON.stringify({ design, html: validHtml }) };
} });
await generationStarted;
await assert.rejects(withInteractiveFigureCleanup('running', async () => {}), /生成/u);
releaseGeneration(); await running;
const selectedText = '定义域说明允许输入的范围';
const selectedKey = await interactiveFigureKey('synthetic', body, selectedText);
await prepareInteractiveFigure(selectedKey, body, selectedText, false, { api, generate: async request => {
  const input = JSON.parse(request.userInput);
  assert.ok(input.lesson.includes(`上一句\n${selectedText}\n下一句`));
  return { content: JSON.stringify({ design: { ...design, anchor: selectedText }, html: validHtml }) };
} }, undefined, { before: '上一句', after: '下一句' });
const pageGoal = '根据本页教材的核心内容生成交互图。';
await prepareInteractiveFigure(await interactiveFigureKey('synthetic', body, pageGoal), body, pageGoal, false, { api, generate: async request => {
  const input = JSON.parse(request.userInput);
  assert.equal(input.lesson, body);
  return { content: JSON.stringify({ design: { ...design, anchor: '模型改写的原文' }, html: validHtml }) };
} }, undefined, { before: '', after: '', wholePage: true });
await assert.rejects(prepareInteractiveFigure(key, body, brief, false, deps));
assert.equal(records.get(key)?.status, 'failed'); assert.equal(calls, 1);
await assert.rejects(prepareInteractiveFigure(key, body, brief, false, deps));
assert.equal(calls, 1, 'reopening a failure cannot silently spend another request');
fail = false;
const [first, second] = await Promise.all([prepareInteractiveFigure(key, body, brief, true, deps), prepareInteractiveFigure(key, body, brief, true, deps)]);
assert.equal(first, validHtml); assert.equal(first, second); assert.equal(calls, 2, 'concurrent retries share one request');
assert.equal(await prepareInteractiveFigure(key, body, brief, false, deps), first); assert.equal(calls, 2, 'ready attachment is reused');
fail = true;
await assert.rejects(prepareInteractiveFigure(key, body, brief, true, deps));
assert.equal(records.get(key)?.status, 'failed');
assert.equal((records.get(key) as { previousHtml?: string }).previousHtml, first, 'a failed regeneration retains the previous artifact');
assert.equal((records.get(key) as { previousDesign?: { kind: string } }).previousDesign?.kind, 'general', 'a failed regeneration retains its teaching design');
fail = false;
assert.equal(await prepareInteractiveFigure(key, body, brief, true, deps), first); assert.equal(calls, 4, 'explicit regeneration may replace a bad ready artifact');
assert.equal((records.get(key) as { design?: { kind: string } }).design?.kind, 'general');
assert.equal(selectFigureKind('改变输入并观察平方函数的变化'), 'quantitative');
assert.equal(selectFigureKind('比较不同条件下的选择结果'), 'comparison');
assert.equal(selectFigureKind('观察流程中的状态变化'), 'process');
assert.equal(selectFigureKind('探索结构'), 'general');
assert.ok((await loadFigureGuidance('quantitative')).includes('自变量'));
assert.ok((await loadFigureGuidance('quantitative')).includes('不凭空加入时间或速率'));
assert.ok((await loadFigureGuidance('comparison')).includes('预测问题必须能由交互观察或依据资料判断'));
assert.ok(!(await loadFigureGuidance('quantitative')).includes('状态转移'));
assert.equal(selectFigureMechanism('用掷骰实验观察随机样本和概率分布'), 'stochastic');
assert.equal(selectFigureMechanism('通过拆解观察装置内部结构'), 'structure');
assert.equal(selectFigureMechanism('观察齿轮如何传动'), 'mechanical');
assert.equal(selectFigureMechanism('追踪缓存命中后的数据流转'), 'computation');
assert.equal(selectFigureMechanism('比较心理账户和消费选择'), undefined);
assert.equal(selectPageFigureMechanism('# 掷骰和随机样本\n\n示例\n```md\n# 齿轮传动\n```'), 'stochastic');
assert.equal(selectPageFigureMechanism('# 掷骰和齿轮传动'), undefined, 'ambiguous page topics do not select an arbitrary mechanism');
assert.equal(selectPageFigureMechanism('# 流程示例\n\n举例提及齿轮和掷骰'), undefined, 'body examples cannot determine the page mechanism');
assert.ok((await loadFigureMechanismGuidance('stochastic')).includes('一次随机结果不能证明'));
assert.ok((await loadFigureMechanismGuidance('structure')).includes('不为交互编造因果'));
assert.ok((await loadFigureMechanismGuidance('mechanical')).includes('作用方向'));
assert.ok((await loadFigureMechanismGuidance('computation')).includes('不能编造权重'));
assert.equal(await loadFigureMechanismGuidance(undefined), '');
for (const [goal, expected] of [['观察掷骰实验的随机样本', '一次随机结果不能证明'], ['拆解观察内部结构', '视角变化不应改变结构事实'], ['观察齿轮传动', '作用方向'], ['追踪缓存命中的数据流', '不能编造权重']] as const) {
  const lesson = `# 示例\n\n${goal}`;
  await prepareInteractiveFigure(await interactiveFigureKey('specialized', lesson, goal), lesson, goal, false, { api, generate: async request => {
    assert.ok(request.systemPromptOverride?.includes(expected), 'specialized guidance must reach the model');
    return { content: JSON.stringify({ design: { ...design, anchor: goal }, html: validHtml }) };
  } });
}
const genericGoal = '观察改变输入之后的输出';
await prepareInteractiveFigure(await interactiveFigureKey('no-specialized', genericGoal, genericGoal), genericGoal, genericGoal, false, { api, generate: async request => {
  assert.ok(request.systemPromptOverride?.includes('初始图形和读数不要直接显示预测答案'));
  assert.ok(!request.systemPromptOverride?.includes('一次随机结果不能证明'));
  assert.ok(!request.systemPromptOverride?.includes('视角变化不应改变结构事实'));
  return { content: JSON.stringify({ design: { ...design, anchor: genericGoal }, html: validHtml }) };
} });
const chemistryGoal = '比较电解水产生的气体体积';
const chemistryLesson = `# 合成化学\n${chemistryGoal}`;
let chemistryPreflights = 0;
const chemistryResult = await prepareInteractiveFigure(await interactiveFigureKey('chemistry-gate', chemistryLesson, chemistryGoal), chemistryLesson, chemistryGoal, false,
  { api: { ...api, preflight: async () => { chemistryPreflights++; } }, generate: async () => ({ content: JSON.stringify({ design: { ...design, anchor: chemistryGoal, prediction: '体积比是多少？' }, html: validHtml }) }) });
assert.ok(chemistryResult.includes('data-local-prediction-disclosure'));
assert.ok(chemistryResult.includes('体积比是多少？'));
assert.equal(chemistryPreflights, 2, 'both the original figure and the prediction gate are checked');
const oldChemicalKey = await interactiveFigureKey('old-chemistry', chemistryLesson, chemistryGoal);
records.set(oldChemicalKey, {status:'ready',html:validHtml,design:{...design,kind:'quantitative',anchor:chemistryGoal}});
let oldCalls=0;
const oldResult=await prepareInteractiveFigure(oldChemicalKey,chemistryLesson,chemistryGoal,false,{api,generate:async()=>{oldCalls++;throw Error('must not regenerate')}});
assert.ok(oldResult.includes('data-local-prediction-disclosure'));
assert.equal(oldCalls,0);assert.equal((records.get(oldChemicalKey) as {html:string}).html,validHtml,'display upgrade does not rewrite saved figures');
const wholePageGoal = '根据本页教材的核心内容生成交互图。';
const stochasticPage = '# 随机样本与掷骰\n\n观察各次结果。';
await prepareInteractiveFigure(await interactiveFigureKey('specialized-page', stochasticPage, wholePageGoal), stochasticPage, wholePageGoal, false, { api, generate: async request => {
  assert.ok(request.systemPromptOverride?.includes('一次随机结果不能证明'));
  return { content: JSON.stringify({ design: { ...design, anchor: '观察各次结果。' }, html: validHtml }) };
} }, undefined, { before: '', after: '', wholePage: true });
assert.equal(selectFigureRenderer('调整装置的开关观察状态'), 'anatomy-iso');
assert.equal(selectFigureRenderer('观察三维装置旋转'), 'anatomy-3d');
assert.equal(selectFigureRenderer('用简单线图解释装置的齿轮传动'), 'svg-2d');
assert.equal(selectFigureRenderer('用简单线图并旋转观察三维装置'), 'anatomy-3d');
assert.equal(selectFigureRenderer('观察三维人体解剖'), 'svg-2d', 'the rigid-part kit is not a reference anatomy mesh');
const anatomyBrief = '旋转观察三维人体解剖';
const anatomyBody = `# 合成\n\n> **交互探索**\n>\n> ${anatomyBrief}`;
const anatomyKey = await interactiveFigureKey('unsupported-anatomy', anatomyBody, anatomyBrief); let anatomyCalls = 0;
await assert.rejects(prepareInteractiveFigure(anatomyKey, anatomyBody, anatomyBrief, false, { api, generate: async () => { anatomyCalls++; throw Error('must not run'); } }), /几何/u);
assert.equal(anatomyCalls, 0, 'a rigid toolkit must not invent anatomy when source geometry is missing');
assert.ok((await loadFigureRendererGuidance('anatomy-iso')).includes('window.TeachingIso'));
assert.equal(await loadFigureRendererGuidance('svg-2d'), '');
assert.ok((await loadFigureRendererGuidance('anatomy-3d')).includes('window.Teaching3D'));
const isoBrief = '调整装置的开关观察状态';
const isoBody = `# 合成装置\n\n> **交互探索**\n>\n> ${isoBrief}`;
const isoKey = await interactiveFigureKey('iso', isoBody, isoBrief);
const isoHtml = `<div data-figure-renderer="anatomy-iso">${validHtml}<script>const k=window.TeachingIso;</script></div>`;
const isoResult = await prepareInteractiveFigure(isoKey, isoBody, isoBrief, false, { api, generate: async (request: any) => {
  assert.ok(request.systemPromptOverride.includes('window.TeachingIso'));
  return { content: JSON.stringify({ design: { ...design, anchor: isoBrief }, html: isoHtml }) };
} });
assert.equal(isoResult, isoHtml);
assert.equal((records.get(isoKey) as { design?: { renderer?: string } }).design?.renderer, 'anatomy-iso');
const preflightKey = await interactiveFigureKey('preflight', body, brief); let preflights = 0, preflightCalls = 0;
const preflightApi = { ...api, preflight: async () => { preflights++; if (preflights === 1) throw Error('synthetic runtime error'); } };
const preflightDeps = { api: preflightApi, generate: async () => { preflightCalls++; return { content: JSON.stringify({ design, html: validHtml }) }; } };
await assert.rejects(prepareInteractiveFigure(preflightKey, body, brief, false, preflightDeps), /运行检查/u);
assert.equal((records.get(preflightKey) as { draftHtml?: string }).draftHtml, validHtml);
assert.equal(await prepareInteractiveFigure(preflightKey, body, brief, true, preflightDeps), validHtml);
assert.equal(preflights, 2); assert.equal(preflightCalls, 2);
const repairKey = await interactiveFigureKey('repair', body, brief); let repairCalls = 0;
const repairGenerate = async (request: any) => {
  repairCalls++; const input = JSON.parse(request.userInput);
  if (repairCalls === 1) return { content: JSON.stringify({ design, html: '<div>没有控件</div>' }) };
  assert.equal(input.repair.html, '<div>没有控件</div>');
  assert.ok(request.systemPromptOverride.includes('请基于待修复HTML修复'));
  return { content: JSON.stringify({ design, html: `\`\`\`html\n${validHtml}\n\`\`\`` }) };
};
const repairDeps = { api, generate: repairGenerate };
await assert.rejects(prepareInteractiveFigure(repairKey, body, brief, false, repairDeps), /控件/u);
assert.equal((records.get(repairKey) as { draftHtml?: string }).draftHtml, '<div>没有控件</div>');
await assert.rejects(prepareInteractiveFigure(repairKey, body, brief, false, repairDeps));
assert.equal(repairCalls, 1, 'failed figures never silently generate again');
assert.equal(await prepareInteractiveFigure(repairKey, body, brief, true, repairDeps), validHtml);
assert.equal(repairCalls, 2, 'only explicit local figure retry calls the model');
const flakyKey = await interactiveFigureKey('flaky-repair', body, brief); let flakyCalls = 0;
const flakyDeps = { api, generate: async (request: any) => {
  flakyCalls++;
  if (flakyCalls === 1) return { content: JSON.stringify({ design, html: '<div>待修复草稿</div>' }) };
  assert.equal(JSON.parse(request.userInput).repair.html, '<div>待修复草稿</div>');
  if (flakyCalls === 2) throw Error('synthetic network outage');
  return { content: JSON.stringify({ design, html: validHtml }) };
} };
await assert.rejects(prepareInteractiveFigure(flakyKey, body, brief, false, flakyDeps));
await assert.rejects(prepareInteractiveFigure(flakyKey, body, brief, true, flakyDeps));
assert.equal((records.get(flakyKey) as { draftHtml?: string }).draftHtml, '<div>待修复草稿</div>', 'a failed repair retains its draft');
assert.equal(await prepareInteractiveFigure(flakyKey, body, brief, true, flakyDeps), validHtml);
const interruptedKey = await interactiveFigureKey('interrupted-repair', body, brief);
records.set(interruptedKey, { status: 'pending', draftHtml: '<div>崩溃前草稿</div>' });
assert.equal(await prepareInteractiveFigure(interruptedKey, body, brief, true, { api, generate: async (request: any) => {
  assert.equal(JSON.parse(request.userInput).repair.html, '<div>崩溃前草稿</div>');
  return { content: JSON.stringify({ design, html: validHtml }) };
} }), validHtml, 'an explicit retry after a restart reuses the reserved repair draft');
const largeKey = await interactiveFigureKey('large-repair', body, brief);
const largePrevious = `<button>${'"'.repeat(99_000)}</button>`;
records.set(largeKey, { status: 'ready', html: largePrevious });
let largePending: FigureArtifact | undefined;
const largeApi = { ...api, write: async (id: string, value: FigureArtifact) => {
  if (value.status === 'pending') { largePending = value; assert.ok(JSON.stringify(value).length < 320_000, 'do not duplicate a large previous artifact'); }
  records.set(id, value);
} };
await assert.rejects(prepareInteractiveFigure(largeKey, body, brief, true, { api: largeApi, generate: async () => { throw Error('offline'); } }));
assert.ok(largePending && largePending.status === 'pending' && !largePending.draftHtml);
assert.equal((records.get(largeKey) as { previousHtml?: string }).previousHtml, largePrevious);
const fallbackKey = await interactiveFigureKey('save-fallback', body, brief);
records.set(fallbackKey, { status: 'ready', html: validHtml });
const fallbackApi = { ...api, write: async (id: string, value: FigureArtifact) => {
  if (value.status === 'failed' && value.draftHtml) throw Error('synthetic draft write failure');
  records.set(id, value);
} };
await assert.rejects(prepareInteractiveFigure(fallbackKey, body, brief, true, { api: fallbackApi, generate: async () => ({ content: JSON.stringify({ design, html: '<div>新草稿无控件</div>' }) }) }));
assert.equal(records.get(fallbackKey)?.status, 'failed');
assert.equal((records.get(fallbackKey) as { previousHtml?: string }).previousHtml, validHtml, 'draft write failure must not strand a pending reservation or lose the previous figure');
const fallbackAnchorKey = await interactiveFigureKey('anchor-fallback', body, brief);
await prepareInteractiveFigure(fallbackAnchorKey, body, brief, false, { api, generate: async () => ({ content: JSON.stringify({ design: { ...design, anchor: '教材不存在的断言' }, html: validHtml }) }) });
assert.deepEqual([(records.get(fallbackAnchorKey) as { design: { anchor: string; anchorFallback?: boolean } }).design.anchor,
  (records.get(fallbackAnchorKey) as { design: { anchorFallback?: boolean } }).design.anchorFallback], [brief, true]);
for (const [id, response, expected] of [
  ['bad-design', { design: { ...design, model: '' }, html: validHtml }, /教学设计/u],
  ['bad-script', { design, html: `${validHtml}<script>const x=1` }, /脚本标签/u],
  ['no-predict', { design, html: '<button>交互</button>' }, /预测输入/u],
  ['commented-controls', { design, html: `<!--${validHtml}--><button>普通按钮</button>` }, /预测输入/u],
  ['script-controls', { design, html: `<script>const example = '${validHtml}'</script><button>普通按钮</button>` }, /预测输入/u],
] as const) {
  const idKey = await interactiveFigureKey(id, body, brief);
  await assert.rejects(prepareInteractiveFigure(idKey, body, brief, false, { api, generate: async () => ({ content: JSON.stringify(response) }) }), expected);
  assert.equal(records.get(idKey)?.status, 'failed');
  assert.ok((records.get(idKey) as { draftHtml?: string }).draftHtml);
}
const pendingKey = await interactiveFigureKey('other', body, brief);
records.set(pendingKey, { status: 'pending' });
await assert.rejects(prepareInteractiveFigure(pendingKey, body, brief, false, deps)); assert.equal(calls, 4, 'interrupted attempt does not restart itself');
const shared = sharedTeachingBody(body);
assert.ok(shared.includes(brief) && shared.includes('交互图附件未随 Markdown 导出'));
assert.ok(!shared.includes('<button>') && !shared.includes(key));
Object.defineProperty(globalThis, 'window', { value: { electronAPI: { textbook: { figureApproval: async () => { throw Error('教材内容或原生成许可已变化'); } } } }, configurable: true });
const unauthorized = await interactiveFigureKey('unapproved', body, brief);
await assert.rejects(prepareInteractiveFigure(unauthorized, body, brief, false, deps, { projectId: 'unapproved', legacy: true }), /许可/u);
assert.equal(calls, 4, 'a missing legacy permission cannot make a model call');
assert.equal(records.has(unauthorized), false, 'rejected permission does not consume an attempt');
await assert.rejects(prepareInteractiveFigure(unauthorized, body, brief, false, deps, { projectId: 'unapproved', legacy: true, jobId: 'job' }), /许可/u);
assert.equal(calls, 4, 'a different textbook job cannot authorize this lesson');
Object.defineProperty(globalThis, 'window', { value: { electronAPI: { textbook: { figureApproval: async () => { throw Error('原教材任务未包含交互图请求许可'); } } } }, configurable: true });
await assert.rejects(prepareInteractiveFigure(unauthorized, body, brief, false, deps, { projectId: 'unapproved', legacy: true, jobId: 'job' }), /未包含交互图请求许可/u);
assert.equal(calls, 4, 'old approvals cannot silently gain an extra model call');
console.log('PASS figure pipeline: marker, version keys, concurrent generation, failure/interruption, explicit retry and Markdown fallback');
