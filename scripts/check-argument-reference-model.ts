import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readArgumentReferenceModel, invokeArgumentReferenceModel } from '../src/electron/rag/argumentReferenceModel.ts';
import { serializeLlmState, USER_STATE_FILES } from '../src/services/userStateService.ts';
import type { LlmProvider, LlmSettings } from '../src/types.ts';

// Synthetic settings in one isolated temporary directory; no real saved configuration,
// source materials, model calls, credentials, production indexes or scores are touched.
const previousFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; return assert.fail('Network forbidden in reference model checks'); };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-reference-model-'));
const roots = { dataRoot: temporary, vaultRoot: path.join(temporary, 'vault'), userStateDir: path.join(temporary, 'user-state') };
const target = path.join(roots.userStateDir, USER_STATE_FILES.llm);
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const provider = (id: string, extra: Partial<LlmProvider> = {}): LlmProvider => ({ id, name: `Synthetic ${id}`,
  apiType: 'openai-compatible', baseUrl: 'https://example.org/synthetic-v1', apiKey: 'synthetic-key-not-real',
  models: ['synthetic-fallback'], selectedModel: 'synthetic-selected', enabled: true, createdAt: '2026-10-07T00:00:00.000Z', ...extra });
const base = (): LlmSettings => ({ providers: [provider('default'), provider('bound')], defaultProviderId: 'default',
  workflowBinding: { 'document-knowledge-extract': 'bound' } });
const save = async (settings: LlmSettings) => fs.writeFile(target, serializeLlmState(settings), 'utf8');
const invalid = async (settings: LlmSettings) => { await save(settings); await assert.rejects(readArgumentReferenceModel(roots), /^Error: argument_reference_model_unavailable$/u); };
try {
  await fs.mkdir(roots.userStateDir);
  await assert.rejects(readArgumentReferenceModel(roots), /argument_reference_model_unavailable/u);
  pass('missing saved model never uses a built-in or renderer fallback');
  assert.equal(USER_STATE_FILES.llm, 'llm.json');
  await fs.writeFile(path.join(roots.userStateDir, 'llm-settings.json'), serializeLlmState(base()), 'utf8');
  await assert.rejects(readArgumentReferenceModel(roots), /argument_reference_model_unavailable/u);
  pass('actual user-state filename is llm.json, not a guessed alternate');
  await save(base());
  const configured = await readArgumentReferenceModel(roots);
  assert.equal(configured.providerLabel, 'Synthetic bound'); assert.equal(configured.modelName, 'synthetic-selected');
  assert.equal(configured.provider.apiKey, 'synthetic-key-not-real'); assert.equal(configured.isRemote, true);
  assert.match(configured.fingerprint, /^[a-f0-9]{64}$/u);
  pass('exact saved workflow binding and selected model are captured host-side');
  const unbound = base(); unbound.workflowBinding = {}; await save(unbound);
  assert.equal((await readArgumentReferenceModel(roots)).providerLabel, 'Synthetic default');
  delete unbound.defaultProviderId; await save(unbound);
  assert.equal((await readArgumentReferenceModel(roots)).providerLabel, 'Synthetic default');
  pass('only an absent binding/default permits the saved first-enabled fallback');
  const disabled = base(); disabled.providers[1].enabled = false; await invalid(disabled);
  await assert.rejects(invokeArgumentReferenceModel(configured, { stage: 'extract', bindingId: 'synthetic', systemPrompt: 'synthetic',
    userInput: '{}', skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' }, new AbortController().signal), /argument_reference_model_unavailable/u);
  assert.equal(calls, 0, 'a previously captured host model cannot run after its saved supplier is disabled');
  const absent = base(); absent.workflowBinding['document-knowledge-extract'] = 'missing'; await invalid(absent);
  const empty = base(); empty.workflowBinding['document-knowledge-extract'] = ''; await invalid(empty);
  pass('disabled, missing and empty explicit bindings cannot silently switch providers');
  const duplicate = base(); duplicate.providers[1].id = 'default'; await invalid(duplicate);
  pass('duplicate provider IDs are ambiguous and held');
  await save(base()); const before = await readArgumentReferenceModel(roots);
  const credential = base(); credential.providers[1].apiKey = 'other-synthetic-not-real'; await save(credential);
  assert.notEqual((await readArgumentReferenceModel(roots)).fingerprint, before.fingerprint);
  await save(base()); await fs.appendFile(target, '\n');
  assert.notEqual((await readArgumentReferenceModel(roots)).fingerprint, before.fingerprint);
  pass('credentials and complete exact saved bytes both participate in the private fingerprint');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const local = base(); local.providers[1].baseUrl = `http://${host}:11434`; local.providers[1].apiType = 'ollama'; local.providers[1].apiKey = '';
    await save(local); assert.equal((await readArgumentReferenceModel(roots)).isRemote, false);
  }
  const remote = base(); remote.providers[1].apiType = 'ollama'; remote.providers[1].baseUrl = 'http://192.0.2.1:11434'; remote.providers[1].apiKey = '';
  await save(remote); assert.equal((await readArgumentReferenceModel(roots)).isRemote, true);
  pass('only exact loopback endpoints are labelled local, not all Ollama providers');
  for (const baseUrl of ['file:///synthetic', 'https://user:password@example.org/v1', 'https://example.org/v1?key=synthetic', 'https://example.org/v1#fragment']) {
    const malformed = base(); malformed.providers[1].baseUrl = baseUrl; await invalid(malformed);
  }
  const linebreak = base(); linebreak.providers[1].apiKey = 'synthetic\r\nheader'; await invalid(linebreak);
  pass('non-HTTP, embedded credentials/query, fragment and header injection are held');
  const missingModel = base(); missingModel.providers[1].selectedModel = undefined; missingModel.providers[1].models = []; await invalid(missingModel);
  const fallback = base(); fallback.providers[1].selectedModel = undefined; await save(fallback);
  assert.equal((await readArgumentReferenceModel(roots)).modelName, 'synthetic-fallback');
  pass('model comes from a saved selectedModel or saved model list, never a transport default');
  const privateLabel = base(); privateLabel.providers[1].name = 'C:\\private\\secret'; await invalid(privateLabel);
  const controlLabel = base(); controlLabel.providers[1].name = 'synthetic\nlabel'; await invalid(controlLabel);
  pass('public model labels cannot be host paths or control-bearing strings');
  await fs.writeFile(target, '{not-json', 'utf8'); await assert.rejects(readArgumentReferenceModel(roots), /argument_reference_model_unavailable/u);
  await fs.writeFile(target, JSON.stringify({ version: 2, settings: base() }), 'utf8'); await assert.rejects(readArgumentReferenceModel(roots), /argument_reference_model_unavailable/u);
  pass('corrupt or unsupported saved settings are not repaired through provider fallback');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(invokeArgumentReferenceModel(configured, { stage: 'extract', bindingId: 'synthetic', systemPrompt: 'synthetic',
    userInput: '{}', skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' }, aborted.signal), /argument_reference_cancelled/u);
  assert.equal(calls, 0);
  pass('an already cancelled invocation never reaches the provider transport');
  console.log(`Argument reference model checks passed (${checks} groups; zero network calls).`);
} finally {
  globalThis.fetch = previousFetch;
  const resolved = path.resolve(temporary), prefix = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(resolved.startsWith(prefix) && path.basename(resolved).startsWith('loginote-reference-model-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
