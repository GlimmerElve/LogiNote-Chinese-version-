import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LlmSettings } from '../src/types.ts';
import { loadArgumentRelationDataset } from './argument-relation-dataset.ts';
import { buildRelationExperiment, RELATION_EXPERIMENT_PARAMETERS, runRelationComparison, type RelationModelResponse } from './argument-relation-comparison.ts';

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--execute', '--allow-cloud', '--include-local', '--direction-v2']);
  if (args.some((arg) => !known.has(arg)) || new Set(args).size !== args.length) throw new Error('Invalid experiment options');
  const execute = args.includes('--execute');
  if (execute !== args.includes('--allow-cloud')) throw new Error('Execution requires both --execute and --allow-cloud');
  const directionV2 = args.includes('--direction-v2');
  const dataset = await loadArgumentRelationDataset(args.includes('--include-local') ? 'data/rag-evaluation' : undefined, directionV2);
  const experiment = buildRelationExperiment(dataset.cases, { directionV2 });
  const preflight = {
    event: 'preflight', cases: dataset.cases.length,
    localCases: dataset.cases.filter((item) => item.origin === 'local_review').length,
    requests: experiment.requests.length, automaticRetries: 0,
    maxCompletionTokens: experiment.requests.length * RELATION_EXPERIMENT_PARAMETERS.max_tokens,
    datasetFingerprint: dataset.datasetFingerprint, directionV2, productionModified: false,
  };
  console.log(JSON.stringify(preflight));
  if (!execute) return; // Dry-run does not even read credentials.

  const anchor = JSON.parse(await readFile(path.join(os.homedir(), '.logi-note/storage-config.json'), 'utf8'));
  if (typeof anchor.dataRoot !== 'string' || !anchor.dataRoot) throw new Error('Missing configured data root');
  const settings: LlmSettings = JSON.parse(await readFile(path.join(anchor.dataRoot, 'user-state/llm.json'), 'utf8')).settings;
  const providerId = settings.workflowBinding['document-knowledge-extract'] || settings.defaultProviderId;
  const provider = settings.providers.find((item) => item.id === providerId && item.enabled);
  // The current user authorization names this exact provider/model, with no fallback or redirects.
  if (!provider || provider.apiType !== 'openai-compatible' || !provider.apiKey || provider.selectedModel !== 'deepseek-flash') {
    throw new Error('Configured provider/model changed; request authorization again');
  }
  const baseUrl = new URL(provider.baseUrl);
  if (baseUrl.origin !== 'https://api.deepseek.com' || baseUrl.username || baseUrl.password
    || baseUrl.search || baseUrl.hash || !['', '/', '/v1', '/v1/'].includes(baseUrl.pathname)) {
    throw new Error('Provider endpoint outside authorized scope');
  }
  const parent = path.resolve('data/argument-relation-experiments');
  await mkdir(parent, { recursive: true });
  const outputDirectory = await mkdtemp(path.join(parent, 'run-'));
  const save = (name: string, value: unknown) => writeFile(path.join(outputDirectory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const manifest = {
    ...preflight, startedAt: new Date().toISOString(), provider: 'DeepSeek', requestedModel: provider.selectedModel,
    origin: baseUrl.origin, parameters: RELATION_EXPERIMENT_PARAMETERS,
    annotationStatus: 'assistant_draft', cases: dataset.cases,
    requests: experiment.requests, productionReferencePromptHash: experiment.productionReferencePromptHash,
  };
  await save('manifest.json', manifest);
  console.log(JSON.stringify({ event: 'started', outputDirectory, provider: manifest.provider, model: provider.selectedModel }));
  const report = await runRelationComparison(dataset.cases, async (request) => {
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: provider.selectedModel, ...RELATION_EXPERIMENT_PARAMETERS,
          messages: [{ role: 'system', content: request.prompt }, { role: 'user', content: request.userInput }] }),
      });
    } catch { throw new Error('Provider transport failed'); }
    if (!response.ok) throw new Error('Provider HTTP failure');
    const value = await response.json();
    const result: RelationModelResponse = {
      content: typeof value.choices?.[0]?.message?.content === 'string' ? value.choices[0].message.content : '',
      model: typeof value.model === 'string' ? value.model : '',
      finishReason: typeof value.choices?.[0]?.finish_reason === 'string' ? value.choices[0].finish_reason : '',
      usage: value.usage ? {
        prompt_tokens: typeof value.usage.prompt_tokens === 'number' ? value.usage.prompt_tokens : undefined,
        completion_tokens: typeof value.usage.completion_tokens === 'number' ? value.usage.completion_tokens : undefined,
        total_tokens: typeof value.usage.total_tokens === 'number' ? value.usage.total_tokens : undefined,
      } : undefined,
    };
    await save(`response-${request.batch}-${request.strategy}.json`, result);
    return result;
  }, async (attempt) => { console.log(JSON.stringify({ event: 'attempt', ...attempt })); }, { directionV2 });
  await save('report.json', { ...report, datasetFingerprint: dataset.datasetFingerprint, finishedAt: new Date().toISOString() });
  for (const [strategy, predictions] of Object.entries(report.predictions)) {
    await save(`predictions-${strategy}.json`, { datasetFingerprint: dataset.datasetFingerprint, predictions });
  }
  console.log(JSON.stringify({ event: 'complete', outputDirectory, comparisonComplete: report.comparisonComplete,
    commonMetrics: Object.fromEntries(Object.entries(report.metrics).map(([name, value]) => [name, value.common])),
    apiUsage: report.apiUsage, modelVersions: report.modelVersions }));
  if (!report.comparisonComplete) process.exitCode = 1;
}

// Do not print arbitrary errors from credential parsing or transport implementations.
main().catch(() => { console.error('Experiment stopped; check configuration/arguments and saved local run files. No production data changed.'); process.exitCode = 1; });
