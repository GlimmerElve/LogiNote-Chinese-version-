import type { NoteItem, SourceBlock, SourceBlockKind, SourceLocator, StructuredDocument, UploadedDocument } from '../../types';
import { argumentCanonicalTextHash, argumentContextHash } from '../../services/argumentContext/hash';
import { prepareArgumentProjectionBuild } from '../../services/argumentContext/construction';
import { ARGUMENT_PROJECTION_BUILD_VERSION, type ArgumentProjectionBuildInput } from '../../services/argumentContext/buildTypes';
import type { ArgumentContextHierarchy, ArgumentContextScope } from '../../services/argumentContext/types';
import { sentenceRanges, TEXT_SEGMENTATION_VERSION } from './sentenceBoundaries';

/** These source containers are NOT L1 vector/retrieval chunks or completed argument structures. */
export const ARGUMENT_PHYSICAL_SOURCE_VERSION = 'argument-physical-source-v1';
// materialStore's currently saved parser contract. Do not import its filesystem runtime here.
const SUPPORTED_MATERIAL_PARSER_VERSIONS = new Set([1, 2, 3]);
const fail = (code: string): never => { throw new Error(`argument_source_${code}`); };
const BLOCK_KINDS: SourceBlockKind[] = ['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes'];
const EXTENSIONS: Partial<Record<UploadedDocument['fileType'], string[]>> = {
  txt: ['.txt'], md: ['.md', '.markdown'], pdf: ['.pdf'], docx: ['.docx'], pptx: ['.pptx'],
};
const LOCATOR_KIND: Partial<Record<UploadedDocument['fileType'], SourceLocator['kind']>> = {
  txt: 'text', md: 'text', pdf: 'pdf', docx: 'docx', pptx: 'pptx',
};
function object(value: unknown, keys: string[], optional: string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key) && !optional.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(item, key))) fail('invalid_shape');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 300
    || /[\u0000-\u001f\u007f\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) fail('invalid_identity');
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) fail('unsaved_timestamp');
}
function metadataText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_metadata');
}
function sourceReferences(note: NoteItem): NoteItem['referenceSources'] {
  if (note.referenceSources === undefined) return undefined;
  if (!Array.isArray(note.referenceSources) || note.referenceSources.length > 100) fail('reference_metadata_budget');
  for (const source of note.referenceSources) {
    object(source, ['title'], ['sourceId', 'type', 'url', 'entityId', 'sectionPath', 'snippet']);
    metadataText(source.title, 2000);
    if (source.type !== undefined && !['web', 'document', 'note'].includes(source.type)) fail('invalid_reference_metadata');
    for (const key of ['sourceId', 'url', 'entityId', 'sectionPath', 'snippet'] as const) {
      if (source[key] !== undefined && (typeof source[key] !== 'string' || source[key].length > 10000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source[key]))) fail('invalid_reference_metadata');
    }
  }
  return structuredClone(note.referenceSources);
}

type PhysicalBlock = { id: string; kind: SourceBlockKind; start: number; end: number; sectionId: string | null; locator: SourceLocator };
function finishHierarchy(canonicalText: string, sections: ArgumentContextHierarchy['sections'], blocks: PhysicalBlock[]): ArgumentContextHierarchy {
  if (!blocks.length || blocks.length > 512) fail('physical_container_budget');
  const hierarchy: ArgumentContextHierarchy = { sections, blocks: blocks.map((block, index) => ({ ...block,
    previousId: blocks[index - 1]?.id ?? null, nextId: blocks[index + 1]?.id ?? null })), sentences: [] };
  for (const block of blocks) {
    for (const range of sentenceRanges(canonicalText.slice(block.start, block.end), false)) {
      const start = block.start + range.start, end = block.start + range.end;
      hierarchy.sentences.push({ id: `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:S${hierarchy.sentences.length + 1}`,
        blockId: block.id, start, end, quote: canonicalText.slice(start, end) });
    }
  }
  return hierarchy;
}
function sourceContainers(canonicalText: string, hierarchy: ArgumentContextHierarchy) {
  return hierarchy.blocks.map((block, index) => ({ id: `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:C${index + 1}`,
    start: block.start, end: block.end, content: canonicalText.slice(block.start, block.end),
    sentenceIds: hierarchy.sentences.filter((sentence) => sentence.blockId === block.id).map((sentence) => sentence.id), forcedSplit: false }));
}

/** Markdown physical scanning never normalizes saved characters or infers argument duties. */
function savedNoteHierarchy(canonicalText: string): ArgumentContextHierarchy {
  const sections: ArgumentContextHierarchy['sections'] = [], blocks: PhysicalBlock[] = [];
  const headings: { level: number; id: string; title: string }[] = [];
  let paragraphStart: number | null = null, paragraphEnd = 0;
  let fence: { char: string; length: number } | null = null;
  const addBlock = (start: number, end: number, kind: SourceBlockKind) => {
    if (end > start && canonicalText.slice(start, end).trim()) blocks.push({ id: `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:B${blocks.length + 1}`,
      start, end, kind, sectionId: headings.at(-1)?.id ?? null, locator: { kind: 'text', charStart: start, charEnd: end } });
  };
  const flush = (kind?: SourceBlockKind) => {
    if (paragraphStart === null) return;
    const content = canonicalText.slice(paragraphStart, paragraphEnd);
    const inferredKind: SourceBlockKind = kind ?? (/^ {0,3}(?:`{3,}|~{3,})/u.test(content) ? 'code'
      : /^\s*\|?.+\|.+\r?\n\s*\|?\s*:?-{3,}/mu.test(content) ? 'table'
        : /^\s*(?:[-*+]\s|\d+[.)]\s)/u.test(content) ? 'list' : 'paragraph');
    addBlock(paragraphStart, paragraphEnd, inferredKind); paragraphStart = null;
  };
  for (const match of canonicalText.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0].length) continue;
    const line = match[0].replace(/[\r\n]+$/u, ''), start = match.index, end = start + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      paragraphEnd = end;
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        flush('code'); fence = null;
      }
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      flush(); paragraphStart = start; paragraphEnd = end;
      fence = { char: marker[1][0], length: marker[1].length }; continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      const title = heading[2].replace(/\s+#+\s*$/u, '').trim();
      if (!title) fail('invalid_heading');
      const id = `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:H${sections.length + 1}`;
      sections.push({ id, path: [...headings.map((parent) => parent.title), title].join(' > '), parentId: headings.at(-1)?.id ?? null });
      headings.push({ level, id, title }); addBlock(start, end, 'heading');
    } else if (!line.trim()) flush();
    else { if (paragraphStart === null) paragraphStart = start; paragraphEnd = end; }
  }
  flush(fence ? 'code' : undefined);
  return finishHierarchy(canonicalText, sections, blocks);
}

/** Saved knowledge content stays a reference source, not a personal belief or a qualified fact. */
export async function adaptSavedKnowledgeNote(input: { note: NoteItem; rootScopeId: string; scope: ArgumentContextScope }): Promise<ArgumentProjectionBuildInput> {
  const { note, rootScopeId, scope } = structuredClone(input);
  identifier(note?.id); identifier(rootScopeId);
  if (note.noteType !== 'knowledge' || scope?.corpus !== 'reference' || scope.rootScopeId !== rootScopeId) fail('reference_only');
  metadataText(note.title, 2000); timestamp(note.createdAt); timestamp(note.updatedAt);
  if (typeof note.content !== 'string' || !note.content.trim() || note.content.length > 500000) fail('empty_or_large_note');
  const prose = note.content.replace(/^ {0,3}#{1,6}\s+.*$/gmu, '').replace(/<[^>]*>/gu, '').replace(/data:image\/[^)\s]+/gu, '')
    .replace(/[#>*_`\s]/gu, '').trim();
  if (!prose || prose === '请对该知识点进行定义描述') fail('placeholder_note');
  const references = sourceReferences(note), canonicalText = note.content, hierarchy = savedNoteHierarchy(canonicalText);
  const contentHash = await argumentCanonicalTextHash(canonicalText);
  // updatedAt is also touched by legacy personal activity writers. It cannot be
  // the version of a reference original: bind the actual content/provenance instead.
  // The explicit identity contract makes old admissions require a new review.
  const version = await argumentContextHash({ contract: 'saved-note-content-identity-v2', noteId: note.id, noteType: note.noteType,
    title: note.title, canonicalText, createdAt: note.createdAt, referenceSources: references ?? [] });
  return prepareArgumentProjectionBuild({ canonicalText, hierarchy, scope,
    source: { kind: 'knowledge-note', entityId: note.id, rootScopeId, version, contentHash, coordinateSpace: 'saved-note-utf16',
      parserVersion: `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:saved-note`, segmentationVersion: `sentence-boundaries-${TEXT_SEGMENTATION_VERSION}:block-local-v1`,
      extractorVersion: ARGUMENT_PROJECTION_BUILD_VERSION, validatorVersion: ARGUMENT_PROJECTION_BUILD_VERSION },
    chunks: sourceContainers(canonicalText, hierarchy),
    sourceQualification: { status: 'unassessed', policyVersion: 'saved-reference-unassessed-v1', evidence: [] } });
}

function uploadedHierarchy(document: StructuredDocument, metadata: UploadedDocument): ArgumentContextHierarchy {
  const sections: ArgumentContextHierarchy['sections'] = [], blocks: PhysicalBlock[] = [];
  const sectionByPath = new Map<string, string>(), headingStack: { level: number; id: string; title: string }[] = [];
  let previousEnd = 0;
  for (const raw of document.blocks) {
    const block: SourceBlock = raw;
    object(block, ['id', 'textStart', 'textEnd', 'kind', 'sectionPath', 'locator'], ['sourceFragments']);
    if (typeof block.id !== 'string' || !block.id.startsWith(`${document.docId}:block:`)
      || !BLOCK_KINDS.includes(block.kind) || typeof block.sectionPath !== 'string' || block.sectionPath.length > 4000
      || !Number.isSafeInteger(block.textStart) || !Number.isSafeInteger(block.textEnd) || block.textStart < previousEnd
      || block.textEnd <= block.textStart || block.textEnd > document.normalizedText.length
      || block.locator?.kind !== LOCATOR_KIND[metadata.fileType]) fail('invalid_document_block');
    if (block.sourceFragments !== undefined && (!Array.isArray(block.sourceFragments)
      || !block.sourceFragments.length || block.sourceFragments.length > 100
      || block.sourceFragments.some((fragment) => !fragment || typeof fragment.rawText !== 'string'
        || fragment.rawText.length > 2_000_000 || fragment.locator?.kind !== LOCATOR_KIND[metadata.fileType]))) {
      fail('invalid_document_fragments');
    }
    previousEnd = block.textEnd;
    const text = document.normalizedText.slice(block.textStart, block.textEnd);
    let sectionId: string | null = null;
    if (block.kind === 'heading') {
      const marker = /^ {0,3}(#{1,6})\s+(.+?)\s*$/u.exec(text);
      const level = marker ? marker[1].length : 1, title = marker?.[2]?.trim() ?? text.trim();
      while (headingStack.length && headingStack.at(-1)!.level >= level) headingStack.pop();
      const declaredPath = block.sectionPath;
      const calculatedPath = [...headingStack.map((parent) => parent.title), title].join(' > ');
      if (!title || declaredPath !== calculatedPath) fail('ambiguous_document_section');
      sectionId = `${ARGUMENT_PHYSICAL_SOURCE_VERSION}:H${sections.length + 1}`;
      sections.push({ id: sectionId, path: declaredPath, parentId: headingStack.at(-1)?.id ?? null });
      headingStack.push({ level, id: sectionId, title }); sectionByPath.set(declaredPath, sectionId);
    } else if (block.sectionPath) {
      sectionId = sectionByPath.get(block.sectionPath) ?? null;
      if (!sectionId) fail('unlocated_document_section');
    }
    blocks.push({ id: block.id, start: block.textStart, end: block.textEnd, kind: block.kind,
      sectionId, locator: structuredClone(block.locator) });
  }
  return finishHierarchy(document.normalizedText, sections, blocks);
}

/** The caller must supply a separately loaded, saved parse snapshot; this function never parses files. */
export async function adaptSavedUploadedDocument(input: { document: StructuredDocument; metadata: UploadedDocument;
  rootScopeId: string; scope: ArgumentContextScope }): Promise<ArgumentProjectionBuildInput> {
  const { document, metadata, rootScopeId, scope } = structuredClone(input);
  identifier(metadata?.id); identifier(rootScopeId);
  if (scope?.corpus !== 'reference' || scope.rootScopeId !== rootScopeId) fail('reference_only');
  object(document, ['schemaVersion', 'docId', 'normalizedText', 'blocks', 'sourceHash', 'materialParserVersion'], ['preprocessing']);
  if (document.docId !== metadata.id || document.schemaVersion !== 1 || typeof document.normalizedText !== 'string'
    || !document.normalizedText.trim() || document.normalizedText.length > 500000 || !Array.isArray(document.blocks)
    || !document.blocks.length || document.blocks.length > 512) fail('invalid_saved_document');
  if (metadata.indexable !== true || metadata.parseStatus !== 'ready'
    || !SUPPORTED_MATERIAL_PARSER_VERSIONS.has(document.materialParserVersion || -1)
    || typeof document.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(document.sourceHash)) fail('unversioned_or_unparsed_document');
  const extensions = Object.prototype.hasOwnProperty.call(EXTENSIONS, metadata.fileType) ? EXTENSIONS[metadata.fileType] : undefined;
  if (!extensions || typeof metadata.extension !== 'string' || !extensions.includes(metadata.extension.toLowerCase())
    || !['stored', 'pending', 'processing', 'ready', 'failed'].includes(metadata.status)) fail('unsupported_document_type');
  metadataText(metadata.fileName, 2000);
  if (/[\\/]/u.test(metadata.fileName) || /^[A-Za-z]:/u.test(metadata.fileName)
    || !metadata.fileName.toLowerCase().endsWith(metadata.extension.toLowerCase())) fail('invalid_document_name');
  timestamp(metadata.uploadAt); timestamp(metadata.parsedAt);
  if (metadata.sourceUrl !== undefined) {
    metadataText(metadata.sourceUrl, 10000);
    let url: URL; try { url = new URL(metadata.sourceUrl); } catch { return fail('invalid_source_url'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('invalid_source_url');
  }
  const canonicalText = document.normalizedText, hierarchy = uploadedHierarchy(document, metadata);
  const contentHash = await argumentCanonicalTextHash(canonicalText);
  // Bind relevant saved parse/provenance metadata, never the on-disk file location or vector state.
  const version = await argumentContextHash({ contract: ARGUMENT_PHYSICAL_SOURCE_VERSION, document,
    metadata: { id: metadata.id, fileName: metadata.fileName, fileType: metadata.fileType, extension: metadata.extension,
      indexable: metadata.indexable, uploadAt: metadata.uploadAt, parsedAt: metadata.parsedAt, sourceUrl: metadata.sourceUrl } });
  return prepareArgumentProjectionBuild({ canonicalText, hierarchy, scope,
    source: { kind: 'uploaded-document', entityId: metadata.id, rootScopeId, version, contentHash, coordinateSpace: 'parsed-text-utf16',
      parserVersion: `material-parser-${document.materialParserVersion}:structured-document-${document.schemaVersion}`,
      segmentationVersion: `sentence-boundaries-${TEXT_SEGMENTATION_VERSION}:block-local-v1`,
      extractorVersion: ARGUMENT_PROJECTION_BUILD_VERSION, validatorVersion: ARGUMENT_PROJECTION_BUILD_VERSION },
    chunks: sourceContainers(canonicalText, hierarchy),
    sourceQualification: { status: 'unassessed', policyVersion: 'saved-reference-unassessed-v1', evidence: [] } });
}
