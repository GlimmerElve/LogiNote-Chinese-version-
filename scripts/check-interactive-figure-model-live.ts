/** One opt-in synthetic request, no user notes/profile, no automatic retry. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { proxyLlmRequest } from '../src/electron/apiHandlers';
import { deserializeLlmState, USER_STATE_FILES } from '../src/services/userStateService';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import type { FigureArtifact } from '../src/electron/interactiveFigureStore';

if (!process.argv.includes('--execute')) {
  console.log('One optional DeepSeek request: synthetic square-function lesson only; no user notes, no retry.');
} else {
  try {
    const anchor = JSON.parse(await readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'), 'utf8'));
    const settings = deserializeLlmState(await readFile(path.join(path.resolve(anchor.dataRoot), 'user-state', USER_STATE_FILES.llm), 'utf8'));
    assert.ok(settings);
    const eligible = (value: typeof settings.providers[number]) => { try { return value.enabled && value.apiType === 'openai-compatible'
      && !!value.apiKey && new URL(value.baseUrl).origin === 'https://api.deepseek.com'; } catch { return false; } };
    const provider = settings.providers.find(p => p.id === (settings.workflowBinding['textbook-chapter'] || settings.defaultProviderId) && eligible(p)) || settings.providers.find(eligible);
    assert.ok(provider, 'DeepSeek configuration unavailable');
    const model = provider.selectedModel || provider.models[0]; assert.ok(model);
    const base = new URL(provider.baseUrl); assert.ok(!base.username && !base.password && !base.search && !base.hash);
    const originalFetch = globalThis.fetch, timeout = AbortSignal.timeout(150_000);
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      assert.equal(url.origin, 'https://api.deepseek.com'); assert.ok(/^\/(?:v1\/)?chat\/completions\/?$/u.test(url.pathname));
      assert.equal(init?.method, 'POST');
      return originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([timeout, ...(init?.signal ? [init.signal] : [])]) });
    };
    try {
      const iso = process.argv.includes('--iso'), threeD = process.argv.includes('--three-d'), shortSelection = process.argv.includes('--short-selection'), localFunction = process.argv.includes('--local-function') || shortSelection || process.argv.includes('--case=math') || process.argv.includes('--case=limit') || process.argv.includes('--case=motion'), latex = process.argv.includes('--latex') || localFunction;
      const scenario = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
      const mapping: Record<string,string> = {math:'math-symmetry',limit:'math-limit',threshold:'threshold',psychology:'psychology',physics:'gear-external',computing:'lru',coin:'coin-frequency',chemistry:'chemistry-electrolysis',motion:'spring'};
      const fixed = JSON.parse(await readFile('scripts/fixtures/teachable-acceptance-cases.json', 'utf8')) as {cases:Array<{id:string;goal:string;lesson:string}>};
      const cases: Record<string, { brief: string; source: string }> = {};
      for (const [name,id] of Object.entries(mapping)) { const item=fixed.cases.find(value=>value.id===id); assert.ok(item,`missing synthetic case ${id}`); cases[name]={brief:item.goal,source:item.lesson}; }
      if (scenario && !cases[scenario]) throw Error('unknown synthetic scenario');
      const brief = scenario ? cases[scenario].brief : threeD ? '旋转观察三维长方体，比较不同面的可见情况。' : iso ? '调整装置的开关观察状态。' : shortSelection ? '当 x 变化时，y 如何变化？' : '改变 x，预测并观察平方函数的输出。';
      const lesson = scenario ? `合成教材：${cases[scenario].source}\n\n> **交互探索**\n>\n> ${brief}` : threeD ? `合成示例：长方体有六个矩形面。旋转它时，不同侧面会进入或离开当前视野；视角改变不会改变物体形状。\n\n> **交互探索**\n>\n> ${brief}`
        : iso ? `合成示例：装置开关打开时指示灯亮，关闭时指示灯灭；只表示简化逻辑，不表示实际电路。\n\n> **交互探索**\n>\n> ${brief}`
        : latex ? `合成数学教材：平方函数的公式为 $y=x^2$，定义域取 $[-3,3]$。例如 $(-2)^2=4$，$0^2=0$，$2^2=4$。相反数的平方相等，图像关于 $y$ 轴对称。\n\n> **交互探索**\n>\n> ${brief}`
        : `合成示例：函数 y=x²，x 在 -3 到 3 之间。改变输入后输出等于输入的平方。\n\n> **交互探索**\n>\n> ${brief}`;
      const output = path.resolve(scenario ? `build/teachable-acceptance/${scenario}-${Date.now()}` : threeD ? 'build/interactive-figure-live-3d' : iso ? 'build/interactive-figure-live-iso' : shortSelection ? 'build/interactive-function-short-selection-live' : localFunction ? 'build/interactive-function-live' : latex ? 'build/interactive-figure-live-latex' : 'build/interactive-figure-live-synthetic'); await mkdir(output, { recursive: true });
      const repairFrom = process.argv.find(arg=>arg.startsWith('--repair-from='))?.slice('--repair-from='.length);
      const repair = process.argv.includes('--repair-existing') || Boolean(repairFrom);
      let draftPath = path.join(output, threeD ? 'figure-draft.html' : 'figure.html');
      if (repairFrom) {
        const base=path.resolve('build/teachable-acceptance'), source=path.resolve(repairFrom), relative=path.relative(base,source);
        if (!scenario || relative.startsWith('..') || path.isAbsolute(relative) || !['figure.html','figure-draft.html'].includes(path.basename(source)) || !path.basename(path.dirname(source)).startsWith(`${scenario}-`)) throw Error('invalid synthetic repair source');
        draftPath=source;
      }
      let artifact: FigureArtifact | null = repair ? { status: 'failed', error: threeD ? '交互图缺少三维绘图声明；预测和旋转须用独立控件，错误选项不可判正确。' : '交互图需要修复；教材正文已保存，可单独重试。', draftHtml: await readFile(draftPath, 'utf8') } : null;
      let calls = 0, usage: unknown;
      const api = { read: async () => artifact, write: async (_key: string, item: FigureArtifact) => { artifact = item;
        if (item.status === 'failed') { console.error(`合成验收检查：${item.error || '未完成'}`);
          if (item.draftHtml && (!provider.apiKey || !item.draftHtml.includes(provider.apiKey))) await writeFile(path.join(output, 'figure-draft.html'), item.draftHtml, 'utf8');
        }
      },
        open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} };
      const generate = async (request: any) => { calls++;
        let response;
        try { response = await proxyLlmRequest({ provider: { ...provider, selectedModel: model }, systemPrompt: request.systemPromptOverride,
          userInput: request.userInput, outputSchema: request.outputSchema, temperature: request.temperatureOverride, maxTokens: request.maxTokensOverride,
          thinkingMode: 'disabled', timeoutMs: 150_000 }, timeout); }
        catch (error) { const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
          const code = typeof e.cause?.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(e.cause.code) ? e.cause.code : '';
          const status = typeof e.message === 'string' ? e.message.match(/\b(?:HTTP\s*)?(4\d\d|5\d\d)\b/iu)?.[1] : undefined;
          console.error(`合成请求失败类型：${typeof e.name === 'string' && /^[A-Za-z]{1,40}$/u.test(e.name) ? e.name : 'Error'}${code ? `；网络代码 ${code}` : ''}${status ? `；HTTP ${status}` : ''}`); throw error; }
        usage = response.usage;
        if (localFunction && typeof response.content === 'string' && (!provider.apiKey || !response.content.includes(provider.apiKey))) await writeFile(path.join(output, 'model-response.json'), response.content, 'utf8');
        return response;
      };
      const key = await interactiveFigureKey('synthetic', lesson, brief);
      const html = await prepareInteractiveFigure(key, lesson, brief, repair, { api, generate }, undefined,
        shortSelection ? { before: '', after: '合成数学教材：平方函数的公式为 $y=x^2$，定义域取 $[-3,3]$。例如 $(-2)^2=4$，$0^2=0$，$2^2=4$。相反数的平方相等。' } : undefined);
      assert.equal(calls, 1); assert.ok(html.length > 50 && html.length <= 100_000);
      assert.ok(!provider.apiKey || !html.includes(provider.apiKey));
      await writeFile(path.join(output, 'figure.html'), html, 'utf8');
      const saved = artifact as FigureArtifact | null;
      if (saved?.status === 'ready' && saved.design) await writeFile(path.join(output, 'design.json'), JSON.stringify(saved.design, null, 2), 'utf8');
      console.log(JSON.stringify({ passed: true, model, usage, repair,
        output: path.join(output, 'figure.html'), actualUserData: false, requests: 1 }));
    } finally { globalThis.fetch = originalFetch; }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safe = /^(?:交互图[^；。]{0,80}|教材内容或原生成许可已变化|DeepSeek configuration unavailable)$/u.test(message) ? message : '请求或配置异常';
    console.error(`真实模型验收失败：${safe}；未输出凭据或模型原文，也未自动重试。`); process.exitCode = 1;
  }
}
