import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEXTBOOK_STEPS } from '../src/services/textbook/progress';
import { textbookProgressSnapshot } from '../src/services/textbook/progress';
import type { TextbookProgress } from '../src/services/textbook/generationTypes';
import type { TextbookJob } from '../src/services/textbook/generationTypes';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { cachedTextbookProgress, publishTextbookProgress, subscribeTextbookProgress } from '../src/services/textbook/progress';
import { textbookResumeCall } from '../src/services/textbook/resume';
import { backgroundWorkflowResumeCall } from '../src/services/agent/workflowToolNames';

if (!process.env.LOGINOTE_PROGRESS_TEST_BUNDLE) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cache = path.join(root, 'node_modules', '.cache'); await mkdir(cache, { recursive: true });
  const temp = await mkdtemp(path.join(cache, 'textbook-progress-ui-'));
  try {
    const outfile = path.join(temp, 'check.mjs');
    await build({ entryPoints: [fileURLToPath(import.meta.url)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
      loader: { '.css': 'empty' }, define: { 'process.env.LOGINOTE_PROGRESS_TEST_BUNDLE': '"1"', 'process.env.LOGINOTE_PROGRESS_TEST_ROOT': JSON.stringify(root) }, logLevel: 'silent' });
    await import(pathToFileURL(outfile).href);
  } finally { assert.ok(path.resolve(temp).startsWith(path.resolve(cache) + path.sep)); await rm(temp, { recursive: true, force: true }); }
} else {
  const { TextbookProgressCard } = await import('../src/components/textbook/TextbookProgressCard');
  const at = '2026-10-07T04:00:00.000Z';
  const value: TextbookProgress = { jobId: 'safe-ui-job', projectNoteId: 'project-ui', projectTitle: '心理账户', jobStage: 'failed', running: false,
    attempt: 2, updatedAt: at, startedAt: at, stageStartedAt: at, currentStage: 'chapters', label: '章节失败', chapterId: 'ch3', chapterTitle: '实践与判断', chapterIndex: 3,
    retry: 1, retryLimit: 1, completed: 2, total: 3, error: '第3章不允许的 HTML',
    steps: TEXTBOOK_STEPS.map(({ stage }, index) => ({ stage, status: index < 3 ? 'saved' : index === 3 ? 'failed' : 'pending' })),
    chapters: [{ id: 'ch1', title: '定义', status: 'saved' }, { id: 'ch2', title: '边界', status: 'saved' }, { id: 'ch3', title: '实践与判断', status: 'needs_repair' }],
    history: [{ at, stage: 'chapters', label: '第3章当前调用重试' }] };
  let checks = 0; const pass = (text: string) => { checks++; console.log(`PASS ${text}`); };
  const render = (progress = value, disabled = false) => renderToStaticMarkup(<TextbookProgressCard progress={progress} disabled={disabled} onResume={() => {}} />);
  const failed = render();
  for (const { title } of TEXTBOOK_STEPS) assert.ok(failed.includes(title));
  for (const text of ['已保存 2/3 章', '任务：safe-ui-job', '当前第 3/3 章', '实践与判断', '当前调用重试 1/1', '从检查点继续（需确认）', '查看章节检查点', '查看最近阶段记录', '第3章不允许的 HTML']) assert.ok(failed.includes(text), text);
  assert.ok(failed.includes('aria-live="polite"')); assert.ok(failed.includes('<button type="button"'));
  pass('实际生产组件展示六阶段、2/3 保存数、当前章节、重试、错误和历史；续跑按钮保留独立确认');
  assert.ok(render(value, true).includes('disabled=""')); assert.ok(!render({ ...value, running: true, jobStage: 'chapters' }).includes('从检查点继续'));
  assert.ok(render({ ...value, running: true, jobStage: 'chapters' }).includes('aria-current="step"'));
  pass('其他任务/待确认时禁用续跑；运行中不提供重复启动，当前阶段可供辅助技术识别');
  const reportFailure = render({ ...value, currentStage: 'validating', completed: 3,
    qualityReview: { status: 'needs_recheck', blockerCount: 0, warningCount: 0,
      reportIssues: [{ findingIndex: 2, field: 'basis[0].ref', chapterId: 'ch3', section: 'answer' }] } });
  for (const text of ['需要纠正的是复核报告的定位', '继续时只重新复核', '第 2 条意见', '实践与判断 · 参考答案', '第 1 个依据位置']) assert.ok(reportFailure.includes(text), text);
  assert.ok(render({ ...value, qualityReview: { status: 'passed', blockerCount: 0, warningCount: 0, ignoredAdviceCount: 2 } }).includes('已忽略 2 条无法定位的非阻断建议'));
  pass('报告失败显示意见编号及章/节/依据位置；非阻断建议明确忽略，不引导重写或额外调用');
  const completed = render({ ...value, jobStage: 'published', running: false, error: undefined, label: '完整教材已保存到项目笔记', completed: 3 });
  assert.ok(completed.includes('教材已写入')); assert.ok(!completed.includes('从检查点继续'));
  pass('历史详情仍可展示已发布的完成进度，不给重复生成入口；常驻卡可见性单独由 hook 控制');
  const exhausted = render({ ...value, requiresReprepare: true, modelDiagnostics: { stage: 'chapter', chapterId: 'ch3', truncations: 2,
    exhausted: true, maxTokens: 24000, outputChars: 30, completionTokens: 24000, reasoningTokens: 23000, hadReasoningContent: true } });
  for (const text of ['教材需要重新准备', '已达到截断重试上限', '对应额度：24000 tokens', '实际生成 24000 tokens', '思考 23000 tokens', '使用新版教材策略重新准备']) assert.ok(exhausted.includes(text), text);
  assert.ok(!exhausted.includes('从检查点继续'));
  pass('重复截断耗尽显示具体额度/思考用量与重新准备指引，不提供会重置额度的继续按钮');
  const budget = render({ ...value, cost: { promptTokens: 1234, completionTokens: 567, reservedTokens: 300, requests: 30, repairRounds: 2, reviewRechecks: 1,
    legacyUsageIncomplete: true, stopped: 'requests', limits: { maxTotalTokens: 600000, maxRequests: 30, maxRepairRounds: 2, maxReviewRechecks: 2 } } });
  for (const text of ['教材已达预算上限', '累计输入 1,234', '输出 567 tokens', '待确认用量估算 300', '请求 30/30 次', '内容修订 2/2 轮', '报告重检 1/2 次', '不是账单', '旧任务升级前仅能恢复部分']) assert.ok(budget.includes(text), text);
  assert.ok(!budget.includes('从检查点继续')); assert.ok(!budget.includes('已达到截断重试上限'));
  pass('累计用量、修订与重检次数可见；预算停止不误称截断、不提供盲目重试，也不泄露原文');
  const repairCost = { promptTokens: 1234, completionTokens: 567, reservedTokens: 0, requests: 10, repairRounds: 2, reviewRechecks: 0,
    legacyUsageIncomplete: false, stopped: 'repairs' as const, limits: { maxTotalTokens: 600000, maxRequests: 30, maxRepairRounds: 2, maxReviewRechecks: 2 } };
  const codeRecovered = render({ ...value, completed: 3, currentStage: 'validating', resumeAfterCodeFix: true, cost: repairCost });
  for (const text of ['已保存 3/3 章', '从原稿继续校验（需确认）', '旧类型错误已修复', '内容修订 2/2 轮', '上限继续生效']) assert.ok(codeRecovered.includes(text), text);
  assert.ok(!codeRecovered.includes('教材已达预算上限'));
  assert.ok(!render({ ...value, cost: repairCost }).includes('从原稿继续校验'));
  assert.ok(!render({ ...value, resumeAfterCodeFix: true, cost: { ...repairCost, stopped: 'tokens' } }).includes('从原稿继续校验（需确认）'));
  assert.ok(!render({ ...value, resumeAfterCodeFix: true, cost: repairCost }, true).includes('<button type="button"><'));
  pass('只有代码确认旧错误消除才提供原稿校验按钮；真实 token/请求停止仍阻断，修订2/2不清零，按钮仍需确认且忙时禁用');
  const archived = render({ ...value, archived: true });
  assert.ok(archived.includes('教材任务已归档') && archived.includes('不永久删除'));
  assert.ok(!archived.includes('从检查点继续（需确认）'));
  pass('归档草稿显示可恢复说明，不提供误启动或重复生成按钮');
  const legacy = render({ ...value, running: true, modelPolicyVersion: 1, thinkingModes: { blueprint: 'enabled', chapter: 'enabled' },
    requestMaxTokens: 16000, requestThinkingMode: 'enabled',
    history: [{ at: '2026-10-07T03:00:00.000Z', stage: 'chapters', label: '旧章节事件' }, { at, stage: 'blueprint', label: '新蓝图事件' }],
    modelDiagnostics: { stage: 'blueprint', truncations: 1, exhausted: false, maxTokens: 8000, outputChars: 409, completionTokens: 8001, reasoningTokens: 7799 } });
  for (const text of ['任务策略 v1', '蓝图思考启用', '章节思考启用', '仍按原批准策略执行', '本次发送额度：16000 tokens', '对应额度：8000 tokens', '此前执行：旧章节事件', '本轮：新蓝图事件']) assert.ok(legacy.includes(text), text);
  pass('截图场景明确旧版启用思考；当前16000请求与上一8000响应分开，历史轮次不冒充当前步骤');
  const hybrid = render({ ...value, running: true, modelPolicyVersion: 4, complexChapterThinkingLimit: 2,
    thinkingModes: { blueprint: 'enabled', chapter: 'disabled' }, requestMaxTokens: 12000, requestThinkingMode: 'enabled' });
  for (const text of ['任务策略 v4', '蓝图思考启用', '章节默认思考关闭', '复杂章节按需启用（最多 2 章）', '请求思考启用']) assert.ok(hybrid.includes(text), text);
  assert.ok(hybrid.includes('aria-live="polite"'));
  for (const modelPolicyVersion of [2, 3] as const) {
    const original = render({ ...value, modelPolicyVersion, thinkingModes: { blueprint: 'disabled', chapter: 'disabled' } });
    assert.ok(original.includes('保留原批准的关闭思考策略')); assert.ok(!original.includes('复杂章节按需启用'));
  }
  pass('v4 分开显示默认策略、复杂章上限与当前实际请求开关；v2/v3 明示原批准策略，不误报已升级');
  const job = { id: 'pending-repair-ui', spec: { projectNoteId: 'project-ui', projectTitle: '心理账户', modelPolicy: defaultTextbookModelPolicy() },
    stage: 'failed', attempt: 2, updatedAt: at,
    checkpoint: { progress: value, repair: { applied: false, findings: Array.from({ length: 6 }, (_, i) => ({ stage: 'blueprint', message: `来源问题${i}` })) } } } as unknown as TextbookJob;
  assert.equal(textbookProgressSnapshot(job, false).repairTargets!.length, 1);
  job.checkpoint.repair!.applied = true;
  assert.equal(textbookProgressSnapshot(job, true).repairTargets!.length, 0);
  assert.ok(!render(textbookProgressSnapshot(job, true)).includes('待修复：'));
  pass('同阶段六条意见只显示一个修复位置；已应用的历史意见不再显示为当前待修复');
  const root = process.env.LOGINOTE_PROGRESS_TEST_ROOT!;
  const panel = await readFile(path.join(root, 'src/components/AgentPanel.tsx'), 'utf8');
  const hook = await readFile(path.join(root, 'src/components/textbook/useTextbookProgress.ts'), 'utf8');
  assert.ok(panel.includes('<TextbookProgressCard'));
  const panelAst = ts.createSourceFile('AgentPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let resumeFactory: ts.Expression | undefined, multiAgent: ts.Expression | undefined, resumeCallback: ts.Expression | undefined;
  const inspectPanel = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      if (node.name.getText(panelAst) === 'callLlm' && node.initializer.getText(panelAst).includes('textbookResumeCall')) resumeFactory = node.initializer;
      if (node.name.getText(panelAst) === 'enableMultiAgent' && node.initializer.getText(panelAst).includes('textbookResumeJobId')) multiAgent = node.initializer;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(panelAst) === 'onResume' && node.initializer
      && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(panelAst).includes('继续教材任务')) resumeCallback = node.initializer.expression;
    ts.forEachChild(node, inspectPanel);
  };
  inspectPanel(panelAst);
  assert.ok(resumeFactory && multiAgent && resumeCallback, 'Production panel has the exact-task resume adapters');
  const expressionJs = (node: ts.Expression) => ts.transpileModule(`(${node.getText(panelAst)})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const [textbookResumeJobId, backgroundResumeJobId, expectedTool] of [
    ['stable-textbook-job', undefined, 'generate_project_textbook'],
    [undefined, 'workflow-stable-background-job', 'start_background_workflow'],
  ] as const) {
    const scope = { textbookResumeJobId, backgroundResumeJobId, textbookResumeCall, backgroundWorkflowResumeCall };
    const next = await runInNewContext(expressionJs(resumeFactory!), scope)();
    assert.equal(next.toolCalls.length, 1); assert.equal(next.toolCalls[0].name, expectedTool);
    assert.equal(next.toolCalls[0].arguments.jobId, textbookResumeJobId || backgroundResumeJobId);
    assert.equal(runInNewContext(expressionJs(multiAgent!), scope), false);
  }
  const sends: unknown[][] = [];
  runInNewContext(expressionJs(resumeCallback!), { sendText: (...args: unknown[]) => { sends.push(args); } })('stable-textbook-job');
  assert.equal(sends.length, 1); assert.equal(sends[0][3], 'personalized-textbook'); assert.equal(sends[0][8], 'stable-textbook-job');
  assert.ok(hook.includes('listTextbookJobs(projectNoteId)')); assert.ok(hook.includes('before === revision')); assert.ok(hook.includes('value?.projectNoteId === projectNoteId'));
  pass('真实 AgentPanel 已接入卡片与同任务续跑；恢复按稳定项目 ID 隔离，旧异步摘要不覆盖实时事件');

  // Execute the production hook with controlled React scheduling and IPC results,
  // rather than checking for a particular condition in its source alone.
  const hookJs = ts.transpileModule(hook, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  type Summary = { jobId: string; preferred?: boolean; progress?: TextbookProgress };
  const summary = (progress: TextbookProgress, preferred = false): Summary => ({ jobId: progress.jobId, preferred, progress });
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  function mountProgress(initial: TextbookProgress | null, list: () => Promise<Summary[]>) {
    const slots: any[] = [], effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
    let cursor = 0, dirty = false, disposed = false, lateUpdates = 0;
    let pending: Array<{ index: number; fn: () => void | (() => void) }> = [];
    let projectId: string | undefined = value.projectNoteId, open = true;
    let cached = initial, listener: ((value: TextbookProgress | null) => void) | undefined;
    const timers = new Map<number, () => void>(); let sequence = 0;
    const module = { exports: {} as { useTextbookProgress: (id: string | undefined, open: boolean) => { progress: TextbookProgress | null; restoreError: string } } };
    const hooks = {
      useState(initialValue: any) { const index = cursor++; if (!(index in slots)) slots[index] = initialValue;
        return [slots[index], (next: any) => { if (disposed) lateUpdates++; if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; } }]; },
      useEffect(fn: () => void | (() => void), deps: unknown[]) {
        const index = cursor++, previous = effects[index];
        if (!previous || previous.deps?.length !== deps.length || deps.some((item, i) => !Object.is(item, previous.deps?.[i]))) {
          effects[index] = { ...previous, deps }; pending.push({ index, fn });
        }
      },
    };
    runInNewContext(hookJs, { module, exports: module.exports, require(id: string) {
      if (id === 'react') return hooks;
      if (id === '../../services/textbook/jobClient') return { listTextbookJobs: list };
      if (id === '../../services/textbook/progress') return {
        cachedTextbookProgress: (id: string) => cached?.projectNoteId === id ? cached : null,
        subscribeTextbookProgress: (next: typeof listener) => { listener = next; if (cached) listener?.(cached); return () => { if (listener === next) listener = undefined; }; },
      };
      throw new Error(`Unexpected hook dependency: ${id}`);
    }, window: { setInterval(fn: () => void) { const id = ++sequence; timers.set(id, fn); return id; }, clearInterval(id: number) { timers.delete(id); } }, Error, Promise });
    let current: ReturnType<typeof module.exports.useTextbookProgress>;
    const render = () => {
      let passes = 0;
      do {
        dirty = false; cursor = 0; pending = [];
        current = module.exports.useTextbookProgress(projectId, open);
        for (const { index, fn } of pending) { effects[index].cleanup?.(); effects[index].cleanup = fn() || undefined; }
        assert.ok(++passes < 12, 'Hook renders converge');
      } while (dirty);
      return current!;
    };
    render();
    return { render, emit(next: TextbookProgress) { cached = next; listener?.(next); }, poll() { for (const fn of timers.values()) fn(); },
      focus(id: string | undefined) { projectId = id; return render(); }, setOpen(next: boolean) { open = next; return render(); },
      unmount() { disposed = true; for (const effect of effects) effect?.cleanup?.(); }, get lateUpdates() { return lateUpdates; } };
  }
  const publishedValue: TextbookProgress = { ...value, jobStage: 'published', completed: 3, label: '完整教材已保存到项目笔记', error: undefined };
  const liveValue: TextbookProgress = { ...value, jobStage: 'chapters', running: true, error: undefined };
  let restored: Summary[] = [summary(liveValue, true)];
  const live = mountProgress(liveValue, async () => restored);
  await tick(); assert.equal(live.render().progress?.jobId, liveValue.jobId);
  live.emit(publishedValue);
  assert.equal(live.render().progress, null);
  restored = [summary(publishedValue, true), summary({ ...value, jobId: 'obsolete-duplicate' })];
  live.poll(); await tick(); assert.equal(live.render().progress, null);
  live.setOpen(false); live.setOpen(true); await tick(); assert.equal(live.render().progress, null);
  live.unmount();
  const restarted = mountProgress(publishedValue, async () => restored);
  assert.equal(restarted.render().progress, null); await tick(); assert.equal(restarted.render().progress, null);
  restarted.unmount();
  pass('真实 hook：运行→发布即时移除常驻卡；轮询、重开助手和重启恢复不回弹，也不退回旧失败重复任务');

  for (const progress of [value, { ...value, jobStage: 'cancelled' as const }, { ...value, jobStage: 'prepared' as const },
    { ...value, archived: true }, { ...value, completed: 3, jobStage: 'publishing' as const }, { ...value, completed: 3 }]) {
    const pending = mountProgress(progress, async () => [summary(progress)]);
    await tick(); assert.equal(pending.render().progress?.jobStage, progress.jobStage); pending.unmount();
  }
  const empty = mountProgress(value, async () => []);
  await tick(); assert.equal(empty.render().progress, null); assert.equal(empty.focus(undefined).progress, null); empty.unmount();
  const noProject = mountProgress(null, async () => []);
  assert.equal(noProject.focus(undefined).progress, null); noProject.unmount();
  const unavailable = mountProgress(value, async () => { throw new Error('synthetic restore failure'); });
  await tick(); assert.equal(unavailable.render().progress?.jobId, value.jobId);
  assert.equal(unavailable.render().restoreError, 'synthetic restore failure'); unavailable.unmount();
  pass('失败/停止/待确认/发布前保存失败仍保留恢复卡；空任务列表清除旧显示，读取失败保留已知进度和诊断');

  let release!: (jobs: Summary[]) => void;
  const delayed = new Promise<Summary[]>(resolve => { release = resolve; });
  const raced = mountProgress(liveValue, () => delayed);
  raced.emit(publishedValue); assert.equal(raced.render().progress, null);
  release([summary(liveValue, true)]); await tick(); assert.equal(raced.render().progress, null);
  assert.equal(raced.focus('different-project').progress, null); raced.unmount();
  let releaseUnmounted!: (jobs: Summary[]) => void;
  const unmounted = mountProgress(null, () => new Promise(resolve => { releaseUnmounted = resolve; }));
  unmounted.unmount(); releaseUnmounted([summary(liveValue)]); await tick(); assert.equal(unmounted.lateUpdates, 0);
  pass('完成事件优先于迟到的旧轮询；切换项目不闪现旧卡，卸载后的返回不更新状态');

  const preserved = { ...publishedValue, projectNoteId: 'history-preserved-test', jobId: 'published-history-preserved' };
  const original = structuredClone(preserved);
  publishTextbookProgress(preserved);
  assert.deepEqual(cachedTextbookProgress(preserved.projectNoteId), original);
  let historical: TextbookProgress | null = null;
  const unsubscribe = subscribeTextbookProgress(next => { if (next?.projectNoteId === preserved.projectNoteId) historical = next; });
  unsubscribe(); assert.deepEqual(historical, original);
  assert.ok(render(preserved).includes('教材已写入')); assert.deepEqual(preserved, original);
  pass('仅改变常驻卡展示：完成快照、阶段/用量历史及历史详情原样保留，不归档、不删任务、不触发续跑');
  console.log(`textbook progress UI: ${checks} groups passed; production SSR + integration contracts, no user vault/network`);
}
