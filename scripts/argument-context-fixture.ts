import type { ArgumentContextAuthority, ArgumentContextProjection, ArgumentContextScope, ArgumentEvidenceSpan, ArgumentSourceIdentity } from '../src/services/argumentContext/types';
import { argumentCanonicalTextHash, argumentContextHash } from '../src/services/argumentContext/hash';

/** Synthetic stored reviewer decisions only. These flags do not establish real-world truth. */
export async function argumentContextFixture(kind: ArgumentSourceIdentity['kind'] = 'knowledge-note') {
  const lines = [
    '# 合成设备实验',
    '设备甲已经供电。',
    '传感器甲正常工作。',
    '本次传感器读数是12，超过阈值10。',
    '本实验约定：已供电且传感器正常，读数超过阈值时会报警。',
    '所以，本次设备甲会报警。',
    '这一规则仅用于本实验的设备甲。',
    '例如读数为11且其余条件满足时，本实验设备甲会报警。',
    '维护模式会禁止报警，本次不在维护模式。',
    '😀同句前提已经成立，因此同句结论成立。',
    '此段是无关账户信息，不应该随相关结构包输出。',
  ];
  const canonicalText = lines.join('\r\n');
  let offset = 0;
  const sentences = lines.map((quote, i) => {
    const item = { id: `s${i}`, blockId: `b${i}`, start: offset, end: offset + quote.length, quote };
    offset += quote.length + 2;
    return item;
  });
  const source: ArgumentSourceIdentity = {
    kind, entityId: kind === 'personal-cognition' ? 'record-test' : kind === 'uploaded-document' ? 'doc-test' : 'note-test',
    rootScopeId: 'vault-token-test', version: 'generation-test', contentHash: await argumentCanonicalTextHash(canonicalText),
    coordinateSpace: kind === 'personal-cognition' ? 'personal-expression-utf16' : kind === 'uploaded-document' ? 'parsed-text-utf16' : 'saved-note-utf16',
    parserVersion: 'test-parser-1', segmentationVersion: 'test-segments-1', extractorVersion: 'test-extractor-1', validatorVersion: 'test-validator-1',
    ...(kind === 'personal-cognition' ? { personal: { recordId: 'record-test', revisionId: 'generation-test', branchId: 'branch-test' } } : {}),
  };
  const evidence = (n: number): ArgumentEvidenceSpan => ({ sentenceId: `s${n}`, start: sentences[n].start, end: sentences[n].end, quote: lines[n] });
  const node = (id: string, role: ArgumentContextProjection['nodes'][number]['role'], n: number) => ({
    id, role, evidence: [evidence(n)], admission: 'admitted' as const, semanticStatus: 'reviewed' as const,
  });
  const edge = (id: string, sourceNodeId: string, targetNodeId: string, kind: ArgumentContextProjection['relations'][number]['kind'], n: number) => ({
    id, sourceNodeId, targetNodeId, kind, evidence: [evidence(n)], admission: 'admitted' as const, semanticStatus: 'reviewed' as const,
  });
  const projection: ArgumentContextProjection = {
    version: 1, source,
    hierarchy: {
      sections: [{ id: 'section-test', path: '合成设备实验', parentId: null }],
      blocks: sentences.map((s, i) => ({ id: s.blockId, kind: i === 0 ? 'heading' : 'paragraph', sectionId: 'section-test',
        start: s.start, end: s.end, previousId: i ? `b${i - 1}` : null, nextId: i + 1 < lines.length ? `b${i + 1}` : null,
        locator: { kind: 'text', charStart: s.start, charEnd: s.end } })),
      sentences,
    },
    nodes: [node('p1', 'premise', 1), node('p2', 'premise', 2), node('threshold', 'condition', 3),
      node('rule', 'definition', 4), node('result', 'conclusion', 5), node('law', 'condition', 6),
      node('example', 'example', 7), node('exception', 'exception', 8), node('unrelated', 'fact', 10)],
    relations: [edge('e1', 'p1', 'result', 'support', 4), edge('e2', 'p2', 'result', 'support', 4),
      edge('e3', 'threshold', 'result', 'requires_condition', 4), edge('e4', 'rule', 'result', 'support', 4),
      edge('e5', 'law', 'rule', 'requires_condition', 6), edge('e6', 'example', 'rule', 'illustrates', 7),
      edge('e7', 'exception', 'result', 'exception_of', 8)],
    prerequisiteGroups: [
      { id: 'g-main', conclusionNodeId: 'result', premiseNodeIds: ['p1', 'p2', 'rule'], conditionNodeIds: ['threshold'],
        relationIds: ['e1', 'e2', 'e3', 'e4'], operator: 'all', admission: 'admitted', semanticStatus: 'reviewed' },
      { id: 'g-rule', conclusionNodeId: 'rule', premiseNodeIds: [], conditionNodeIds: ['law'],
        relationIds: ['e5'], operator: 'all', admission: 'admitted', semanticStatus: 'reviewed' },
    ],
    quality: { status: kind === 'personal-cognition' ? 'not_applicable' : 'eligible' },
    build: { origin: 'validated-projection', gaps: [], scopes: ['reasoning', 'fact', 'definition', 'general'].map((task) => ({
      seedNodeId: 'result', task: task as 'reasoning' | 'fact' | 'definition' | 'general',
      requiredNodeIds: ['result', 'p1', 'p2', 'threshold', 'rule', 'law'],
      requiredRelationIds: ['e1', 'e2', 'e3', 'e4', 'e5'], requiredGroupIds: ['g-main', 'g-rule'], status: 'reviewed_for_scope',
    })) },
  };
  const scope: ArgumentContextScope = { scopeId: 'scope-test', rootScopeId: source.rootScopeId,
    corpus: kind === 'personal-cognition' ? 'personal' : 'reference', allowedSourceKinds: [kind],
    allowedNoteIds: kind === 'knowledge-note' ? [source.entityId] : [],
    allowedDocIds: kind === 'uploaded-document' ? [source.entityId] : [],
    allowedRecordIds: kind === 'personal-cognition' ? [source.entityId] : [] };
  const authority: ArgumentContextAuthority = { source: structuredClone(source), canonicalText, structureHash: await argumentContextHash(projection) };
  return { projection, scope, authority, lines, evidence };
}

export async function rebindArgumentFixture(f: Awaited<ReturnType<typeof argumentContextFixture>>) {
  f.authority.source = structuredClone(f.projection.source);
  f.authority.structureHash = await argumentContextHash(f.projection);
  return f;
}
