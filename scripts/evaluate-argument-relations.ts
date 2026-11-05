import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadArgumentRelationDataset } from './argument-relation-dataset.ts';
import { ARGUMENT_RELATION_PROTOCOL_VERSION, argumentRelationInput } from '../src/services/argumentRelation/contract.ts';
import { evaluateArgumentRelations } from '../src/services/argumentRelation/evaluation.ts';
import { ARGUMENT_RELATION_CLASSIFY_PROMPT } from '../src/workflows/argumentRelationClassifyPrompt.ts';
import { ARGUMENT_RELATION_DIRECTION_PROMPT } from '../src/workflows/argumentRelationDirectionPrompt.ts';

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (options.has(name)) throw new Error(`Duplicate option: ${name}`);
    if (name === '--export-inputs' || name === '--direction-v2') options.set(name, true);
    else if (name === '--local-dir' || name === '--predictions') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${name}`);
      options.set(name, value);
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (options.has('--export-inputs') && options.has('--predictions')) throw new Error('Choose export or evaluation, not both');
  const { cases, localAudit, datasetFingerprint } = await loadArgumentRelationDataset(options.get('--local-dir') as string | undefined, options.has('--direction-v2'));
  if (options.has('--export-inputs')) {
    // Explicit export only. No network, credentials, writes, gold labels or review explanations.
    console.log(JSON.stringify({ protocolVersion: ARGUMENT_RELATION_PROTOCOL_VERSION, datasetFingerprint,
      prompt: options.has('--direction-v2') ? ARGUMENT_RELATION_DIRECTION_PROMPT : ARGUMENT_RELATION_CLASSIFY_PROMPT,
      inputs: cases.map(argumentRelationInput) }, null, 2));
    return;
  }
  let report: ReturnType<typeof evaluateArgumentRelations> | undefined;
  if (options.has('--predictions')) {
    const result = JSON.parse(await readFile(path.resolve(options.get('--predictions') as string), 'utf8'));
    if (result?.datasetFingerprint !== datasetFingerprint) throw new Error('Dataset fingerprint mismatch; predictions require re-evaluation');
    report = evaluateArgumentRelations(cases, result.predictions);
  }
  console.log(JSON.stringify({
    protocolVersion: ARGUMENT_RELATION_PROTOCOL_VERSION,
    datasetFingerprint,
    mode: report ? 'offline-prediction-evaluation' : 'dataset-inventory-only',
    cases: cases.length,
    byLabel: Object.fromEntries([...new Set(cases.map((item) => item.expectedLabel))]
      .map((label) => [label, cases.filter((item) => item.expectedLabel === label).length])),
    annotationStatus: 'assistant_draft; independent human review pending',
    localAudit,
    report,
    productionModified: false,
    modelCalled: false,
    note: 'No model quality claim without prediction results. This command never changes indexes, settings or AgentSkill.',
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; });
