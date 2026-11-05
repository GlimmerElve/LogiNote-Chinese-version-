/** Query-only spelling projection. Stored original quotes/offsets and entity identity stay unchanged. */
import {lookupReviewedReferentsV2} from './entityReferentBindingsV2.ts';
import {referentReadingProjectionV3} from './entityReferentUnitsV3.ts';
export function lookupReviewedReferentsV3(
  index: Parameters<typeof lookupReviewedReferentsV2>[0], input: Parameters<typeof lookupReviewedReferentsV2>[1],
) {
  const queryView = {...index, bindings: index.bindings.map(b => {
    const phrase = (b.mention as typeof b.mention & {phrase?: string}).phrase;
    if (phrase === undefined) return b;
    if (typeof phrase !== 'string' || referentReadingProjectionV3(b.mention.quote).text !== phrase) throw new Error('query_reference_projection_changed');
    return {...b, mention: {...b.mention, quote: phrase}};
  })};
  // This helper returns IDs only. The query spelling is never persisted as original evidence or an entity alias.
  return lookupReviewedReferentsV2(queryView, input);
}
