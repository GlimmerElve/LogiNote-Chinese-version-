import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ARGUMENT_RELATION_GOLDEN_SET } from './fixtures/argument-relation-golden.ts';
import { buildLocalArgumentAuditCases } from './fixtures/argument-relation-local-audit.ts';
import { ARGUMENT_RELATION_PROTOCOL_VERSION } from '../src/services/argumentRelation/contract.ts';
import { validateArgumentRelationCases } from '../src/services/argumentRelation/evaluation.ts';
import { relationFingerprint } from './argument-relation-hash.ts';
import { ARGUMENT_DIRECTION_CHALLENGE } from './fixtures/argument-direction-challenge.ts';
import { buildLocalPositiveCases, type LocalPositiveSelection } from './fixtures/argument-relation-local-positive.ts';

export { relationFingerprint } from './argument-relation-hash.ts';

export async function loadArgumentRelationDataset(localDirectory?: string, directionV2 = false) {
  const cases = structuredClone(ARGUMENT_RELATION_GOLDEN_SET);
  if (directionV2) cases.push(...structuredClone(ARGUMENT_DIRECTION_CHALLENGE));
  let localAudit: ReturnType<typeof buildLocalArgumentAuditCases>['audit'] | undefined;
  if (localDirectory) {
    const directory = path.resolve(localDirectory);
    const [review, candidates] = await Promise.all([
      readFile(path.join(directory, 'graph-review-v3.json'), 'utf8'),
      readFile(path.join(directory, 'graph-review-candidates-v3.json'), 'utf8'),
    ]);
    const local = buildLocalArgumentAuditCases(JSON.parse(review), JSON.parse(candidates));
    cases.push(...local.cases);
    localAudit = local.audit;
    if (directionV2) {
      const selections: LocalPositiveSelection[] = JSON.parse(await readFile(path.join(directory, 'argument-positive-selection-v1.json'), 'utf8'));
      cases.push(...buildLocalPositiveCases(JSON.parse(candidates), selections));
    }
  }
  validateArgumentRelationCases(cases);
  return { cases, localAudit,
    datasetFingerprint: relationFingerprint({ version: ARGUMENT_RELATION_PROTOCOL_VERSION, cases }) };
}
