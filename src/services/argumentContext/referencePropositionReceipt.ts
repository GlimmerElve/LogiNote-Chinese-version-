import type { ArgumentReferenceDisclosureContext } from './referenceDisclosure';
import type { ReviewedReferencePropositionBundle } from '../reviewComparison/sourcePropositionAnchors';

/** Host-retained pre-answer anchor disclosure, never a renderer proof or a
 * publication capability. Review votes remain fallible, not factual truth;
 * the context/bundle keep writes disabled and cannot authorize scoring. */
export type ArgumentReferencePropositionDisclosureReply =
  | { status: 'ready'; context: ArgumentReferenceDisclosureContext; bundle: ReviewedReferencePropositionBundle;
    binding: { freezeId: string; contractHash: string; contextHash: string; bundleHash: string } }
  | { status: 'held'; reasons: string[] };
