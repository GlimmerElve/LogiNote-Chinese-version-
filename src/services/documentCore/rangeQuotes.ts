import { ArgumentQuoteLocationError, locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import { parseCoreQuoteEnvelope } from './quoteEnvelope';
import { parseCoreDirectQuotes } from './directQuote';
import { parseCoreDerivations, type CoreDerivationResult } from './derivation';
import { prepareCoreInputPacket } from './runner';
import type { CoreArgumentInput } from './types';

export interface CoreLayoutExclusion {
  passageId: string; exactText: string; kind: 'page_header' | 'page_footer' | 'page_number'; reason: string;
}
export interface CoreRangeFragment { passageId: string; start: number; end: number; quote: string }
export interface CoreRangeBinding {
  aliasId: string; originalReference: { passageId: string; quote: string };
  fragments: CoreRangeFragment[]; skippedLayout: CoreLayoutExclusion[];
}
export interface CoreRangeQuoteResult extends CoreDerivationResult {
  rangeProtocol: {
    version: 'core-exact-adjacent-ranges-v1'; rawResponse: string;
    bindings: CoreRangeBinding[]; layoutExclusions: CoreLayoutExclusion[];
    annotations: Array<{ id: string; reason: string; nodeId?: string; fragments: CoreRangeFragment[] }>;
    semanticRewriting: false; originalInputChanged: false;
  };
}

/** Opt-in adapter, NOT a change to the frozen single-passage parser. Only exact
 * adjacent tail/head matches; layout exclusions must be declared explicitly. */
export function parseCoreRangeQuotes(raw: string, source: CoreArgumentInput,
  exclusions: CoreLayoutExclusion[] = []): CoreRangeQuoteResult {
  prepareCoreInputPacket(source);
  const input = structuredClone(source), byId = new Map(input.passages.map((p, i) => [p.id, { ...p, order: i }]));
  const layout = new Map<string, CoreLayoutExclusion>();
  for (const entry of exclusions) {
    const original = byId.get(entry.passageId);
    if (!original || layout.has(entry.passageId) || original.text !== entry.exactText || entry.exactText.length > 120
      || !entry.reason?.trim() || !['page_header', 'page_footer', 'page_number'].includes(entry.kind)) throw new Error('排版排除项身份、正文或声明无效');
    layout.set(entry.passageId, structuredClone(entry));
  }
  const envelope = parseCoreQuoteEnvelope(raw);
  // Preserve the old malformed-optional-section diagnosis without rewriting it.
  const wire = structuredClone(envelope.value), bindings: CoreRangeBinding[] = [];
  const aliases = new Map<string, CoreRangeBinding>();
  const body = input.passages.filter(p => !layout.has(p.id));
  function adapt(ref: any) {
    if (!ref || Object.keys(ref).sort().join('|') !== 'passageId|quote' || typeof ref.quote !== 'string'
      || !ref.quote.trim() || ref.quote.length > 5000 || !byId.has(ref.passageId) || envelope.unresolvedIsolation) return;
    const anchor = byId.get(ref.passageId)!;
    try { locateDocumentArgumentQuote(anchor.text, ref.quote); return; }
    catch (error) { if (!(error instanceof ArgumentQuoteLocationError) || error.reason !== 'not_found') return; }
    const matches: CoreRangeBinding[] = [];
    for (let i = 0; i < body.length - 1; i++) {
      const left = byId.get(body[i].id)!, right = byId.get(body[i + 1].id)!;
      if (![left.id, right.id].includes(anchor.id) || right.order - left.order > 4) continue;
      // Do not cross a complete sentence, heading or list boundary.
      if (/^\s*#/u.test(left.text) || /[。.!！?？;；:]\s*$/u.test(left.text) || /^\s*#|^\s*\d+[.、)]/u.test(right.text)) continue;
      const text = left.text + right.text, start = text.indexOf(ref.quote), end = start + ref.quote.length;
      if (start < 0 || text.indexOf(ref.quote, start + 1) >= 0 || start >= left.text.length || end <= left.text.length) continue;
      const skipped = input.passages.slice(left.order + 1, right.order).map(p => layout.get(p.id));
      if (skipped.some(p => !p)) continue;
      const fragments = [
        { passageId: left.id, start, end: left.text.length, quote: left.text.slice(start) },
        { passageId: right.id, start: 0, end: end - left.text.length, quote: right.text.slice(0, end - left.text.length) },
      ];
      // Fragment quotes must themselves remain uniquely locatable by projection.
      try { for (const part of fragments) {
        const located = locateDocumentArgumentQuote(byId.get(part.passageId)!.text, part.quote);
        if (located.start !== part.start || located.end !== part.end) throw new Error('片段位置不唯一');
      } } catch { continue; }
      matches.push({ aliasId: '', originalReference: structuredClone(ref), fragments, skippedLayout: skipped as CoreLayoutExclusion[] });
    }
    if (matches.length !== 1) return; // No nearest/first-match guessing.
    const match = matches[0], key = JSON.stringify(match.fragments);
    let binding = aliases.get(key);
    if (!binding) {
      let ordinal = bindings.length + 1, aliasId = `@core-range:${ordinal}`;
      while (byId.has(aliasId) || input.passages.some(p => p.id === aliasId)) aliasId = `@core-range:${++ordinal}`;
      binding = { ...match, aliasId }; aliases.set(key, binding); bindings.push(binding);
      input.passages.push({ id: aliasId, section: '', text: match.fragments.map(p => p.quote).join('') });
    }
    ref.passageId = binding.aliasId;
  }
  if (Array.isArray(wire.steps)) for (const step of wire.steps) {
    adapt(step?.target); if (Array.isArray(step?.premises)) step.premises.forEach(adapt);
  }
  if (Array.isArray(wire.conclusions)) for (const conclusion of wire.conclusions) {
    adapt(conclusion?.target);
    for (const key of ['conditions', 'limitations', 'methods', 'context']) if (Array.isArray(conclusion?.[key])) conclusion[key].forEach(adapt);
  }
  if (Array.isArray(wire.unresolved)) for (const item of wire.unresolved) adapt(item?.target);
  const parsed = parseCoreDirectQuotes(bindings.length ? JSON.stringify(wire) : raw, input);
  const rangeMap = new Map(bindings.map(b => [b.aliasId, b]));
  const fragments = (ref: { passageId: string; quote: string }): CoreRangeFragment[] => {
    const binding = rangeMap.get(ref.passageId);
    if (binding) return structuredClone(binding.fragments);
    const passage = byId.get(ref.passageId)!;
    const { start, end } = locateDocumentArgumentQuote(passage.text, ref.quote);
    return [{ passageId: passage.id, start, end, quote: passage.text.slice(start, end) }];
  };
  const physical = parsed.derivation.materials.map(m => ({ ...m, parts: m.source.flatMap(fragments) }));
  physical.sort((a, b) => byId.get(a.parts[0].passageId)!.order - byId.get(b.parts[0].passageId)!.order
    || a.parts[0].start - b.parts[0].start || a.parts[0].end - b.parts[0].end);
  const ids = new Map(physical.map((m, i) => [m.id, `N${i + 1}`]));
  const id = (value: string) => { const found = ids.get(value); if (!found) throw new Error('跨段投影引用不存在'); return found; };
  const annotations = parsed.quoteProtocol.annotations.map(a => ({ id: a.id, reason: a.reason,
    ...(a.nodeId ? { nodeId: id(a.nodeId) } : {}), fragments: a.source ? fragments(a.source) : [] }));
  let result: CoreDerivationResult = parsed;
  if (bindings.length) {
    const rewritten = {
      materials: physical.map(m => ({ id: id(m.id), source: m.parts.map(p => ({ passageId: p.passageId, quote: p.quote })) })),
      steps: parsed.derivation.steps.map(s => ({ ...s, conclusion: id(s.conclusion), premises: s.premises.map(id) })),
      conclusions: parsed.derivation.conclusions.map(c => ({ ...c, nodeId: id(c.nodeId), conditions: c.conditions.map(id),
        limitations: c.limitations.map(id), methods: c.methods.map(id), context: c.context.map(id) })),
      unresolved: annotations.map(a => ({ reason: a.reason, ...(a.nodeId ? { nodeId: a.nodeId } : {}) })),
    };
    result = parseCoreDerivations(JSON.stringify(rewritten), source);
    // Preserve rejected proposals, and bind failures to the new source-order IDs.
    result.quarantined.unshift(...structuredClone(parsed.quarantined));
    const mapIssueId = (value: string) => value.replace(/^N\d+(?=:|$)/u, old => ids.get(old) || old);
    result.issues.unshift(...parsed.issues.filter(i => i.code.endsWith('_quarantined') || i.code === 'identical_duplicate_key_coalesced')
      .map(i => ({ ...i, id: mapIssueId(i.id) })));
    for (const old of parsed.graph.arguments.filter(a => a.status === 'incomplete')) {
      for (const a of result.graph.arguments.filter(a => a.claim === id(old.claim))) a.status = 'incomplete';
      for (const c of result.chains.filter(c => c.claimId === id(old.claim))) c.modelStatus = 'incomplete';
    }
    for (const entry of envelope.coalesced) result.issues.push({ id: `JSON:${entry.position}`, code: 'identical_duplicate_key_coalesced', reason: `原始回复同值重复字段留痕：${entry.path}` });
  }
  if (result.issues.length) for (const chain of result.chains) chain.state = 'source_review_required';
  return { ...result, rangeProtocol: { version: 'core-exact-adjacent-ranges-v1', rawResponse: raw,
    bindings, layoutExclusions: structuredClone(exclusions), annotations, semanticRewriting: false, originalInputChanged: false } };
}
