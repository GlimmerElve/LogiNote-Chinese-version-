/** Source-located reading units, not new semantic chunks. No inferred objects or relations. */
import type {ReferentContext} from './entityReferentBindings.ts';
export interface ReferentSelectionV3 {unitId: string; phrase: string | null; occurrence: number}
export interface ReferentReadingUnitV3 {
  id: string; nodeId: string; window: string; sourceIndex: number; start: number; end: number;
  raw: string; text: string; positions: number[]; type: string | null;
}
export interface ReferentUnitCatalogV3 {
  revision: string; documentId: string; snapshotId: string; units: ReferentReadingUnitV3[];
  graphEdgesCreated: number; semanticCertified: boolean;
}
const check = (ok: unknown, msg: string) => {if (!ok) throw new Error(msg);};
/** Only whitespace is changed. Latin word/number separators are never removed. */
export function referentReadingProjectionV3(raw: string) {
  const chars: string[] = [], positions: number[] = [];
  for (let i = 0; i < raw.length;) {
    if (!/\s/u.test(raw[i])) {chars.push(raw[i]); positions.push(i++); continue;}
    const start = i; while (i < raw.length && /\s/u.test(raw[i])) i++;
    const han = (c: string) => /\p{Script=Han}/u.test(c);
    if (start > 0 && i < raw.length && !(han(raw[start - 1]) && han(raw[i]))) {chars.push(' '); positions.push(start);}
  }
  return {text: chars.join(''), positions};
}
export function buildReferentUnitCatalogV3(ctx: ReferentContext): ReferentUnitCatalogV3 {
  check(!!ctx.documentId && !!ctx.snapshotId, 'unit_context_identity');
  const windows = new Map(ctx.windows.map(w => [w.id, w]));
  check(windows.size === ctx.windows.length && new Set(ctx.nodes.map(n => n.id)).size === ctx.nodes.length, 'unit_duplicate_identity');
  const units = ctx.nodes.flatMap(n => n.source.map((s, i) => {
    const w = windows.get(s.window); check(w && s.quote.trim(), 'unit_source_identity');
    const start = w!.text.indexOf(s.quote);
    check(start >= 0 && w!.text.indexOf(s.quote, start + 1) < 0, 'unit_source_not_unique');
    const p = referentReadingProjectionV3(s.quote);
    check(p.text.length > 0, 'unit_empty');
    return {id: n.id + '.S' + (i + 1), nodeId: n.id, window: s.window, sourceIndex: i, start,
      end: start + s.quote.length, raw: s.quote, ...p, type: typeof (n as any).type === 'string' ? (n as any).type : null};
  }));
  check(new Set(units.map(u => u.id)).size === units.length, 'unit_duplicate_id');
  return {revision: 'referent-reading-units-v3', documentId: ctx.documentId, snapshotId: ctx.snapshotId, units,
    graphEdgesCreated: 0, semanticCertified: false};
}
export function assertReferentUnitCatalogV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3) {
  check(JSON.stringify(catalog) === JSON.stringify(buildReferentUnitCatalogV3(ctx)), 'unit_catalog_changed');
}
/** Ordinal is required even when the phrase occurs only once. No first-hit fallback. */
export function resolveReferentSelectionV3(catalog: ReferentUnitCatalogV3, value: unknown, allowWholeUnit = false) {
  const s = value as ReferentSelectionV3;
  check(s && !Array.isArray(s) && Object.keys(s).sort().join('|') === 'occurrence|phrase|unitId', 'selection_fields');
  check(typeof s.unitId === 'string', 'selection_unit');
  const u = catalog.units.find(u => u.id === s.unitId); check(u, 'unknown_unit');
  check(Number.isInteger(s.occurrence) && s.occurrence > 0 && s.occurrence <= 10000, 'selection_occurrence');
  if (s.phrase === null) {
    check(allowWholeUnit && s.occurrence === 1, 'whole_unit_not_allowed');
    return {nodeId: u!.nodeId, window: u!.window, quote: u!.raw, start: u!.start, end: u!.end,
      unitId: u!.id, phrase: null, occurrence: 1};
  }
  check(typeof s.phrase === 'string' && s.phrase.trim() === s.phrase && s.phrase.length > 0 && s.phrase.length <= 240, 'selection_phrase');
  const hits: number[] = [];
  for (let at = u!.text.indexOf(s.phrase); at >= 0; at = u!.text.indexOf(s.phrase, at + 1)) hits.push(at);
  check(hits.length >= s.occurrence, 'selection_occurrence_missing');
  const at = hits[s.occurrence - 1], relativeStart = u!.positions[at], relativeEnd = u!.positions[at + s.phrase.length - 1] + 1;
  return {nodeId: u!.nodeId, window: u!.window, quote: u!.raw.slice(relativeStart, relativeEnd),
    start: u!.start + relativeStart, end: u!.start + relativeEnd, unitId: u!.id, phrase: s.phrase, occurrence: s.occurrence};
}
export type LocatedReferentV3 = ReturnType<typeof resolveReferentSelectionV3>;

/** One ordered reading view; uncovered source remains visible but is not a selectable graph node. */
export function referentReadingInputV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3) {
  assertReferentUnitCatalogV3(ctx, catalog);
  return {windows: ctx.windows.map(w => {
    const units = catalog.units.filter(u => u.window === w.id).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    const segments: Array<{kind: string; unitId?: string; nodeId?: string; type?: string | null; text: string}> = [];
    let cursor = 0;
    for (const u of units) {
      if (u.start > cursor) {
        const gap = referentReadingProjectionV3(w.text.slice(cursor, u.start)).text;
        if (gap) segments.push({kind: 'context', text: gap});
      }
      segments.push({kind: 'node', unitId: u.id, nodeId: u.nodeId, type: u.type, text: u.text});
      cursor = Math.max(cursor, u.end);
    }
    if (cursor < w.text.length) {
      const gap = referentReadingProjectionV3(w.text.slice(cursor)).text;
      if (gap) segments.push({kind: 'context', text: gap});
    }
    return {id: w.id, section: w.section ?? '', segments};
  })};
}
