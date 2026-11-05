/** Pure, document-scoped mention indexing. No model, IO, entity merging or inferred coreference. */
export interface EntityIndexWindow { id: string; text: string; section?: string }
export interface EntityIndexSource { sentence: string; quote: string; start?: number; end?: number }
export interface EntityIndexEntity { id: string; name: string; type: string; source: EntityIndexSource[] }
export interface EntityIndexRelation {
  id: string; from: string; to: string; source: EntityIndexSource[];
  predicate?: string; qualifiers?: string[]; status?: string;
}
export interface EntityIndexNode { id: string; source: Array<{ window: string; quote: string }> }
export interface EntityOccurrence {
  entityId: string; documentId: string; window: string; start: number; end: number; quote: string;
  alias: string; basis: 'literal' | 'safe_layout_or_case'; declared: boolean;
}
export interface EntityAlias { text: string; basis: 'name' | 'parenthesis_prefix' | 'source_spelling' | 'source_acronym' }
const fail = (message: string): never => { throw new Error('entity_index_' + message); };
const asciiLower = (text: string) => text.replace(/[A-Z]/gu, ch => ch.toLowerCase());
const white = (ch: string) => /\s/u.test(ch);
const han = (ch: string) => /\p{Script=Han}/u.test(ch);
const identifier = (ch: string) => /[A-Za-z0-9_]/u.test(ch);
export const entityAliasKey = (text: string) => asciiLower(text).replace(/\s/gu, '');

function projection(text: string) {
  const positions: number[] = [], chars: string[] = [];
  for (let i = 0; i < text.length; i++) if (!white(text[i])) { positions.push(i); chars.push(asciiLower(text[i])); }
  return { text: chars.join(''), positions };
}

/** All occurrences, with original offsets. Whitespace cannot join Latin words or numbers. */
export function findEntityLiteralOccurrences(text: string, alias: string) {
  if (!alias.trim()) return [];
  const original = projection(text), proposed = projection(alias), found: Array<{start: number; end: number; quote: string}> = [];
  if (!proposed.text) return found;
  for (let at = original.text.indexOf(proposed.text); at >= 0; at = original.text.indexOf(proposed.text, at + 1)) {
    const start = original.positions[at], end = original.positions[at + proposed.text.length - 1] + 1;
    if (identifier(text[start]) && start > 0 && identifier(text[start - 1])) continue;
    if (identifier(text[end - 1]) && end < text.length && identifier(text[end])) continue;
    let safe = true;
    for (let i = 1; i < proposed.positions.length; i++) {
      const left = original.positions[at + i - 1], right = original.positions[at + i];
      const oldGap = text.slice(left + 1, right), newGap = alias.slice(proposed.positions[i - 1] + 1, proposed.positions[i]);
      if (oldGap !== newGap && !((oldGap.length && newGap.length) || (han(text[left]) && han(text[right])))) { safe = false; break; }
    }
    if (safe) found.push({ start, end, quote: text.slice(start, end) });
  }
  return found;
}

/** A source-backed spelling variation, not a synonym generator. */
function aliasesFor(entity: EntityIndexEntity): EntityAlias[] {
  const aliases: EntityAlias[] = [{ text: entity.name, basis: 'name' }];
  const supported = (alias: string) => entity.source.some(s => findEntityLiteralOccurrences(s.quote, alias).length);
  if (!supported(entity.name)) fail('name_without_source:' + entity.id);
  const prefix = entity.name.split(/[（(]/u)[0].trim();
  if (prefix.length >= 2 && prefix !== entity.name && supported(prefix)) aliases.push({ text: prefix, basis: 'parenthesis_prefix' });
  // Accept a single 的 spelling only when the entire supplied entity mention is
  // that spelling, e.g. 食物的渴望. Never remove 的 from arbitrary document prose.
  const name = entityAliasKey(entity.name);
  for (const s of entity.source) {
    const spelling = s.quote.trim(), compact = entityAliasKey(spelling);
    if (/^\p{Script=Han}{3,20}$/u.test(name) && compact.length === name.length + 1
      && [...compact].some((ch, i) => ch === '的' && i > 0 && i < compact.length - 1 && compact.slice(0, i) + compact.slice(i + 1) === name)) {
      aliases.push({ text: spelling, basis: 'source_spelling' });
    }
  }
  // Parenthetical acronyms must occur in the entity name AND its original evidence.
  for (const bracket of entity.name.matchAll(/[（(]([^）)]+)[）)]/gu)) {
    for (const acronym of bracket[1].matchAll(/\b[A-Z][A-Z0-9-]{1,11}\b/gu)) {
      if (supported(acronym[0])) aliases.push({ text: acronym[0], basis: 'source_acronym' });
    }
  }
  return [...new Map(aliases.map(a => [entityAliasKey(a.text), a])).values()].slice(0, 24);
}

const localObject = (entity: EntityIndexEntity) => entity.type === 'study' || entity.type === 'other'
  || /^(?:实验|试验|研究|情景|情境|方案|案例)\s*[A-Za-z一二三四五六七八九十\d]+$/u.test(entity.name)
  || /^(?:该|本|上述|前述|这个|这一)(?:实验|研究|结果|情景|方案|案例)$/u.test(entity.name);

export function buildEntityOccurrenceIndex(input: {
  documentId: string; windows: EntityIndexWindow[]; nodes: EntityIndexNode[];
  entities: EntityIndexEntity[]; entityRelations: EntityIndexRelation[]; sentenceWindows: Record<string, string>;
}) {
  if (!input.documentId.trim()) fail('document');
  const windows = new Map(input.windows.map(w => [w.id, w]));
  if (windows.size !== input.windows.length || new Set(input.nodes.map(n => n.id)).size !== input.nodes.length
    || new Set(input.entities.map(e => e.id)).size !== input.entities.length) fail('duplicate_identity');
  const ranges = (source: EntityIndexSource[]) => source.flatMap(s => {
    const window = input.sentenceWindows[s.sentence], w = windows.get(window);
    if (!w || !s.quote) return fail('source_window');
    if (s.start !== undefined || s.end !== undefined) {
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start! < 0 || s.end! <= s.start! || w.text.slice(s.start, s.end) !== s.quote) fail('source_offset');
      return [{ window, start: s.start!, end: s.end! }];
    }
    const hits: Array<{ window: string; start: number; end: number }> = [];
    for (let at = w.text.indexOf(s.quote); at >= 0; at = w.text.indexOf(s.quote, at + 1)) hits.push({ window, start: at, end: at + s.quote.length });
    if (!hits.length) fail('source_quote');
    return hits;
  });
  const profiles = input.entities.map(e => {
    if (!e.id || !e.name || !e.source.length) fail('entity_shape');
    return { id: e.id, name: e.name, type: e.type, aliases: aliasesFor(e), declaredRanges: ranges(e.source), localObject: localObject(e) };
  });
  const owners = new Map<string, Set<string>>();
  for (const p of profiles) for (const alias of p.aliases) {
    const key = entityAliasKey(alias.text); if (!owners.has(key)) owners.set(key, new Set()); owners.get(key)!.add(p.id);
  }
  const occurrences: EntityOccurrence[] = [], restricted: Array<{entityId: string; alias: string; windows: string[]; reason: string}> = [];
  for (const p of profiles) for (const alias of p.aliases) {
    const collision = owners.get(entityAliasKey(alias.text))!.size > 1;
    const allowed = new Set(p.declaredRanges.map(s => s.window));
    if (collision || p.localObject) restricted.push({ entityId: p.id, alias: alias.text, windows: [...allowed], reason: collision ? 'shared_alias_not_identity_merge' : 'local_object_needs_explicit_occurrence' });
    for (const w of input.windows) {
      if ((collision || p.localObject) && !allowed.has(w.id)) continue;
      for (const hit of findEntityLiteralOccurrences(w.text, alias.text)) {
        if (collision && !p.declaredRanges.some(s => s.window === w.id && s.start <= hit.start && s.end >= hit.end)) continue;
        occurrences.push({ entityId: p.id, documentId: input.documentId, window: w.id, ...hit, alias: alias.text,
          basis: hit.quote === alias.text ? 'literal' : 'safe_layout_or_case',
          declared: p.declaredRanges.some(s => s.window === w.id && s.start <= hit.start && s.end >= hit.end) });
        if (occurrences.length > 10000) fail('occurrence_budget');
      }
    }
  }
  const nodeRanges = new Map<string, Array<{window: string; start: number; end: number}>>(), issues: string[] = [];
  for (const n of input.nodes) {
    nodeRanges.set(n.id, n.source.flatMap(s => {
      const w = windows.get(s.window); if (!w || !s.quote) return fail('node_source');
      const at = w.text.indexOf(s.quote); if (at < 0) return fail('node_quote');
      if (w.text.indexOf(s.quote, at + 1) >= 0) { issues.push('ambiguous_node_source:' + n.id + ':' + s.window); return []; }
      return [{ window: s.window, start: at, end: at + s.quote.length }];
    }));
  }
  const relationRanges = new Map(input.entityRelations.map(r => {
    if (!profiles.some(p => p.id === r.from) || !profiles.some(p => p.id === r.to) || r.from === r.to) fail('relation_endpoint');
    return [r.id, ranges(r.source)] as const;
  }));
  const mapping = input.nodes.map(n => {
    const spans = nodeRanges.get(n.id)!;
    return { nodeId: n.id, entities: profiles.flatMap(p => {
      const hits = occurrences.filter(o => o.entityId === p.id && spans.some(s => s.window === o.window && s.start <= o.start && s.end >= o.end));
      if (!hits.length) return [];
      const matched = [...hits].sort((a, b) => b.alias.length - a.alias.length || a.start - b.start)[0];
      return [{ entityId: p.id, name: p.name, matchedAlias: matched.quote,
        basis: 'original_coordinate_occurrence' as const, occurrences: hits,
        aliases: [...new Set(hits.map(h => h.alias))] }];
    }), entityRelationIds: input.entityRelations.filter(r => relationRanges.get(r.id)!.some(q => spans.some(s => s.window === q.window && q.start < s.end && q.end > s.start))).map(r => r.id), pronounsResolved: false as const };
  });
  const references = input.nodes.filter(n => /上述|前述|该结果|这一结果|该实验|这个实验|两个情景/u.test(n.source.map(s => s.quote).join('\n')))
    .map(n => ({nodeId: n.id, status: 'not_resolved_by_literal_index', entityInheritanceApplied: false}));
  return { revision: 'entity-occurrence-index-v3', documentId: input.documentId, entities: profiles, occurrences, mapping, restricted, references, issues,
    aliasesMergedEntities: false, pronounsResolved: false, semanticEdgesCreated: 0, productionAdmission: false };
}

export type EntityOccurrenceIndex = ReturnType<typeof buildEntityOccurrenceIndex>;

/** Alias registry for rankers, not a claim that every alias literally occurs in every node. */
export function entityRankingMapping(index: EntityOccurrenceIndex, allowedIds = new Set(index.mapping.map(m => m.nodeId))) {
  const visible = index.mapping.filter(m => allowedIds.has(m.nodeId));
  return visible.map(m => ({ ...m, entities: m.entities.flatMap(hit => {
    const profile = index.entities.find(e => e.id === hit.entityId)!;
    const aliases = profile.aliases.filter(a => visible.some(v => v.entities.some(e => e.entityId === hit.entityId && e.occurrences.some(o => entityAliasKey(o.alias) === entityAliasKey(a.text)))));
    return aliases.map(a => ({ entityId: hit.entityId, name: hit.name, matchedAlias: a.text,
      sourceMatchedAlias: hit.matchedAlias, basis: 'registered_alias_for_ranking_not_literal_occurrence' }));
  }) }));
}
