import assert from 'node:assert/strict';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry, s2CapabilityKey } from '../src/services/scene/sceneS2PluginRegistry';
import { s2LocalAdapterSamples } from './scene-s2-adapter-fixtures';
import { checkS2LocalAdapterConformance } from './scene-s2-adapter-conformance';

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Adapter conformance forbids network, models and private resources'); };
try {
  const installation = s2BuiltinPluginInstallation();
  const bindings = s2BuiltinPluginRegistry().catalog().flatMap(plugin => plugin.capabilities.map(capability => ({
    pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: capability.id,
  }))).filter(binding => installation.descriptor(binding).kind === 'local');
  const samples = new Set(Object.keys(s2LocalAdapterSamples));
  assert.equal(bindings.length, 13);
  for (const binding of bindings) {
    assert.ok(samples.delete(`${binding.pluginId}/${binding.capabilityId}`), `Missing fixture for ${s2CapabilityKey(binding)}`);
  }
  assert.equal(samples.size, 0, 'Retired/renamed adapters must not leave orphan fixtures');
  // All fixtures settle before restoring globals; one failing case must not abandon the others.
  const results = await Promise.allSettled(bindings.map(binding => checkS2LocalAdapterConformance({ binding,
    inputs: structuredClone(s2LocalAdapterSamples[`${binding.pluginId}/${binding.capabilityId}`]),
  })));
  const failures = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'S2 adapter conformance failed');
  const reports = results.map(item => { assert.equal(item.status, 'fulfilled'); return item.value; });
  assert.equal(networkAttempts, 0);
  console.log(`S2 reusable adapter conformance passed: ${reports.length} installed local capabilities, ${reports.reduce((sum, item) => sum + item.cases.length, 0)} lifecycle cases; complete native data/snapshots, grants, atomic invalid-output rejection, exceptions, cancel/timeout/revision/close with late returns, direct guards/idempotency and independent branch isolation. Actual handlers + production host, synthetic data; no network/model/resource access.`);
} finally { globalThis.fetch = previousFetch; }
