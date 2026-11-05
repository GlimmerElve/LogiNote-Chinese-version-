import path from 'node:path';
import type { ArgumentReferenceDisclosureContext } from '../../services/argumentContext/referenceDisclosure.ts';
import type { ArgumentQuestionPropositionHost } from './argumentQuestionRuntime.ts';
import { createPersistentSourcePropositionStore } from './referenceSourcePropositionStore.ts';
import { createCurrentSourcePropositionReader, createReferenceSourcePropositionProvider } from './referenceSourcePropositionProvider.ts';

/** Default pre-question integration is read-only. No model, config read, source
 * selection, missing-asset construction, score write or cognition update. */
export async function prepareStoredReferencePropositions(context: ArgumentReferenceDisclosureContext, host: ArgumentQuestionPropositionHost) {
  const signal = host.signal, assertHost = host.assertCurrent.bind(host), read = createCurrentSourcePropositionReader(host.store);
  const guard = () => { if (signal.aborted) throw new Error('proposition_read_aborted'); assertHost(); };
  guard();
  const persistent = createPersistentSourcePropositionStore(path.join(host.dataRoot, 'argument-propositions'), host.store, host.rootScopeId);
  const provider = createReferenceSourcePropositionProvider({
    readCurrent: async ref => { guard(); const result = await read(ref); guard(); return result; },
    storage: {
      read: async (ref, check) => {
        guard(); const result = await persistent.read(ref, () => { guard(); check?.(); }); guard(); return result;
      },
      publish: async () => { throw new Error('question_loader_is_read_only'); },
    },
  });
  try { const result = await provider.preparePropositions(context); guard(); return result; }
  finally { provider.revoke(); }
}
