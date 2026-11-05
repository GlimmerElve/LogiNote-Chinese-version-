import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LlmSettings } from '../src/types.ts';
import { COMPARISON_DATASET, COMPARISON_LABELS } from './cognition-comparison-dataset.ts';
import { buildExperiment, evaluate, hash, PARAMETERS, type Attempt } from './cognition-comparison-evaluation.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--execute', '--allow-cloud'].includes(arg)) || new Set(args).size !== args.length
    || args.includes('--execute') !== args.includes('--allow-cloud')) throw new Error('Invalid flags');
  const requests = buildExperiment(COMPARISON_DATASET);
  if (COMPARISON_DATASET.length !== 36 || requests.length !== 18 || COMPARISON_DATASET.some((c) => c.origin !== 'synthetic')) throw new Error('Authorized scope changed');
  const preflight = { event: 'preflight', cases: 36, syntheticCases: 36, requests: 18, automaticRetries: 0,
    maxCompletionTokens: requests.length * PARAMETERS.max_tokens, datasetFingerprint: hash(COMPARISON_DATASET),
    promptFingerprints: Object.fromEntries(requests.slice(0, 2).map((r) => [r.strategy, hash(r.prompt)])),
    labels: COMPARISON_LABELS, productionModified: false, actualRetrievalEvaluated: false, annotationStatus: 'assistant_draft' };
  console.log(JSON.stringify(preflight));
  if (!args.includes('--execute')) return; // Dry run never reads credentials or contacts a provider.

  const anchor = JSON.parse(await readFile(path.join(os.homedir(), '.logi-note/storage-config.json'), 'utf8'));
  if (typeof anchor.dataRoot !== 'string' || !anchor.dataRoot) throw new Error('Missing configured data root');
  const settings: LlmSettings = JSON.parse(await readFile(path.join(anchor.dataRoot, 'user-state/llm.json'), 'utf8')).settings;
  const providerId = settings.workflowBinding['agent-personalized-qa'] || settings.defaultProviderId;
  const provider = settings.providers.find((p) => p.id === providerId && p.enabled);
  if (!provider || provider.apiType !== 'openai-compatible' || !provider.apiKey || provider.selectedModel !== 'deepseek-flash') throw new Error('Authorized model changed');
  const endpoint = new URL(provider.baseUrl);
  if (endpoint.origin !== 'https://api.deepseek.com' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['', '/', '/v1', '/v1/'].includes(endpoint.pathname)) throw new Error('Authorized endpoint changed');
  const parent = path.resolve('data/cognition-comparison-experiments');
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, 'run-'));
  const save = (name: string, value: unknown) => writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  await save('manifest.json', { ...preflight, startedAt: new Date().toISOString(), provider: 'DeepSeek', model: provider.selectedModel,
    parameters: PARAMETERS, cases: COMPARISON_DATASET, requests, limitations: ['Fixed provided context, not retrieval or full production QA.', 'Shared evaluation output schema differs from ordinary user-facing replies.', 'Assistant-authored labels require human review.', 'No automatic production promotion.'] });
  console.log(JSON.stringify({ event: 'started', outputDirectory: output }));
  const attempts: Attempt[] = [];
  for (const request of requests) {
    let attempt: Attempt = { request, content: '', finishReason: '', model: '' };
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: provider.selectedModel, ...PARAMETERS,
          messages: [{ role: 'system', content: request.prompt }, { role: 'user', content: request.userInput }] }),
      });
      if (!response.ok) throw new Error('HTTP failure');
      const raw = await response.json();
      const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      attempt = { request, content: typeof raw.choices?.[0]?.message?.content === 'string' ? raw.choices[0].message.content : '',
        finishReason: typeof raw.choices?.[0]?.finish_reason === 'string' ? raw.choices[0].finish_reason : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        usage: { prompt_tokens: number(raw.usage?.prompt_tokens), completion_tokens: number(raw.usage?.completion_tokens), total_tokens: number(raw.usage?.total_tokens) } };
    } catch { attempt.error = 'transport_or_provider_failure'; }
    attempts.push(attempt);
    await save(`response-${request.batch}-${request.strategy}.json`, attempt);
    console.log(JSON.stringify({ event: 'attempt', completed: attempts.length, total: requests.length, strategy: request.strategy, batch: request.batch, finishReason: attempt.finishReason, failed: !!attempt.error }));
    if (attempt.error) break; // No retry or fallback; preserve partial results and do not silently resubmit paid work.
  }
  const metrics = evaluate(COMPARISON_DATASET, attempts);
  const report = { finishedAt: new Date().toISOString(), datasetFingerprint: preflight.datasetFingerprint, completedRequests: attempts.length,
    transportComplete: attempts.length === requests.length && attempts.every((a) => !a.error),
    models: [...new Set(attempts.map((a) => a.model).filter(Boolean))], totalTokens: attempts.reduce((sum, a) => sum + (a.usage?.total_tokens || 0), 0), metrics };
  await save('report.json', report);
  console.log(JSON.stringify({ event: 'complete', outputDirectory: output, transportComplete: report.transportComplete,
    totalTokens: report.totalTokens, metrics: Object.fromEntries(Object.entries(metrics).map(([strategy, result]) => [strategy, { overall: result.overall, holdout: result.holdout, protocolErrors: result.protocolErrors, meetsPilotThreshold: result.meetsPilotThreshold }])) }));
  if (!report.transportComplete) process.exitCode = 1;
}
main().catch(() => { console.error('Comparison stopped. Check flags, configured provider and saved run files. No production data changed.'); process.exitCode = 1; });
