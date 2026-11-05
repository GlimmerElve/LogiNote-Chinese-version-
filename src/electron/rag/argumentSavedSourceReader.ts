import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NoteItem, StructuredDocument, UploadedDocument, DocumentChunk } from '../../types.ts';
import type { ArgumentContextScope } from '../../services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput } from '../../services/argumentContext/buildTypes.ts';
import { adaptSavedKnowledgeNote, adaptSavedUploadedDocument } from './argumentSourceAdapter.ts';
import { validateArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import { documentArgumentSourceBlocks, isStructuredArgumentSource } from './documentArgumentV5Sources.ts';

export interface SavedArgumentSourceReaderOptions {
  dataRoot: string; vaultRoot: string; userStateDir: string;
  /** Independently issued host scope, not the candidate's own claimed allowlist. */
  scope: ArgumentContextScope;
}
const fail = (code: string): never => { throw new Error(`argument_saved_source_${code}`); };
const MAX_METADATA_BYTES = 4 * 1024 * 1024, MAX_PARSE_BYTES = 8 * 1024 * 1024, MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;

async function readFile(file: string, maximum: number): Promise<Buffer | null> {
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail('invalid_file');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum || stat.ino !== before.ino || stat.dev !== before.dev) fail('source_changed');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length > maximum || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('source_changed');
      return bytes;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function json(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid_utf8');
  try { return JSON.parse(text); } catch { return fail('corrupt_json'); }
}
async function directory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_directory');
}
async function noPendingSnapshot(userStateDir: string): Promise<void> {
  try { await fs.lstat(path.join(userStateDir, 'vault-pending-snapshot.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  // Do not silently recover or read an intermediate multi-file save as an authoritative source.
  fail('save_in_progress');
}
async function unchanged(file: string, bytes: Buffer, maximum: number): Promise<void> {
  const after = await readFile(file, maximum);
  if (!after || !after.equals(bytes)) fail('source_changed');
}

/** Captured-root raw read for callbacks ALREADY in a source transaction; never takes a nested lock. */
export async function readSavedArgumentReferenceNote(options: SavedArgumentSourceReaderOptions, noteId: string): Promise<NoteItem | null> {
  const ref = { kind: 'knowledge-note' as const, entityId: noteId }; validateArgumentProjectionSourceRef(ref);
  if (options.scope.corpus !== 'reference' || !options.scope.allowedNoteIds.includes(noteId) || !options.scope.allowedSourceKinds.includes(ref.kind)) fail('scope_denied');
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(noteId) || ['.', '..'].includes(noteId)) fail('invalid_id');
  await directory(options.vaultRoot); await directory(options.userStateDir); await noPendingSnapshot(options.userStateDir);
  const metadataFile = path.join(options.vaultRoot, 'metadata.json'), metadata = await readFile(metadataFile, MAX_METADATA_BYTES);
  if (!metadata) return null;
  const parsed = json(metadata) as { version: number; notesMeta: Record<string, Omit<NoteItem, 'content'>> };
  if (!parsed || parsed.version !== 1 || !parsed.notesMeta || typeof parsed.notesMeta !== 'object' || Array.isArray(parsed.notesMeta)) fail('invalid_metadata');
  const saved = Object.hasOwn(parsed.notesMeta, noteId) ? parsed.notesMeta[noteId] : undefined;
  if (!saved || saved.noteType !== 'knowledge') return null;
  if (saved.id !== noteId) fail('invalid_identity');
  await directory(path.join(options.vaultRoot, 'notes'));
  const bodyFile = path.join(options.vaultRoot, 'notes', `${noteId}.md`), body = await readFile(bodyFile, MAX_PARSE_BYTES);
  if (!body) return null;
  const content = body.toString('utf8'); if (!Buffer.from(content, 'utf8').equals(body)) fail('invalid_utf8');
  await unchanged(bodyFile, body, MAX_PARSE_BYTES); await unchanged(metadataFile, metadata, MAX_METADATA_BYTES);
  await noPendingSnapshot(options.userStateDir); return { ...saved, content };
}

/** Short, bounded saved-reference catalog read. Targets cannot extend the host scope. */
export async function readSavedArgumentReferenceNotes(options: SavedArgumentSourceReaderOptions, targets: string[]): Promise<NoteItem[]> {
  if (!Array.isArray(targets) || targets.length > 20 || targets.some(t => typeof t !== 'string' || t.length > 1000)) fail('invalid_targets');
  await noPendingSnapshot(options.userStateDir);
  const file = path.join(options.vaultRoot, 'metadata.json'), bytes = await readFile(file, MAX_METADATA_BYTES);
  if (!bytes) return [];
  const parsed = json(bytes) as {version:number;notesMeta:Record<string, Omit<NoteItem,'content'>>};
  if (!parsed || parsed.version !== 1 || !parsed.notesMeta || typeof parsed.notesMeta !== 'object' || Array.isArray(parsed.notesMeta)) fail('invalid_metadata');
  const ids = options.scope.allowedNoteIds.filter(id => {
    const n = parsed.notesMeta[id];
    return n?.noteType === 'knowledge' && targets.some(t => n.title === t || Array.isArray(n.aliases) && n.aliases.includes(t));
  });
  if (ids.length > 40) fail('reference_budget');
  const notes: NoteItem[] = []; let characters = 0;
  for (const id of ids) {
    const note = await readSavedArgumentReferenceNote(options, id);
    if (note) { characters += note.content.length; if (characters > 1000000) fail('reference_budget'); notes.push(note); }
  }
  await unchanged(file, bytes, MAX_METADATA_BYTES); await noPendingSnapshot(options.userStateDir); return notes;
}

/** Current saved L1 only, not a claim that old L1 files carry original-version proof. */
export async function readSavedArgumentDocumentChunk(dataRoot: string, docId: string, chunkId: string): Promise<DocumentChunk | null> {
  validateArgumentProjectionSourceRef({ kind: 'uploaded-document', entityId: docId });
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(docId) || ['.', '..'].includes(docId)) fail('invalid_id');
  const dir = path.join(dataRoot, 'rag-index'); await directory(dir);
  if(chunkId.startsWith(`${docId}:argument:`)){
    const {readSavedDocumentArgumentV5}=await import('./documentArgumentV5Store.ts');
    const {resolveDocumentArgumentV5Sources}=await import('./documentArgumentV5Sources.ts');
    const {documentArgumentV5TextChunks}=await import('./documentArgumentV5Retrieval.ts');
    const passageBytes=await readFile(path.join(dir,`chunks-${docId}.json`),32*1024*1024);
    const passageRows=passageBytes?json(passageBytes):[];
    if(!Array.isArray(passageRows)||passageRows.length>20000)fail('invalid_chunks');
    const passages=passageRows as DocumentChunk[];
    const graph=await readSavedDocumentArgumentV5(dir,docId,passages);
    if(!graph)return null;
    const sources=await resolveDocumentArgumentV5Sources(dir,graph,passages);
    return documentArgumentV5TextChunks([graph],sources).find(c=>c.id===chunkId)||null;
  }
  if (isStructuredArgumentSource(docId, chunkId)) {
    const sourceFile = path.join(dir, `structured-${docId}.json`), manifestFile = path.join(dir, 'manifest.json');
    const source = await readFile(sourceFile, MAX_PARSE_BYTES), manifest = await readFile(manifestFile, MAX_METADATA_BYTES);
    if (!source || !manifest) return null;
    const rows = json(manifest);
    if (!Array.isArray(rows)) return fail('invalid_manifest');
    const document = rows.find(d => d?.id === docId);
    if (!document) return null;
    const structured = json(source) as StructuredDocument;
    if (structured.docId !== docId) fail('invalid_chunks');
    const chunk = documentArgumentSourceBlocks(structured, document.fileName).find(c => c.id === chunkId) || null;
    await unchanged(sourceFile, source, MAX_PARSE_BYTES); await unchanged(manifestFile, manifest, MAX_METADATA_BYTES);
    return chunk;
  }
  const file = path.join(dir, `chunks-${docId}.json`), bytes = await readFile(file, 32 * 1024 * 1024);
  if (!bytes) return null;
  const rows = json(bytes); if (!Array.isArray(rows) || rows.length > 20000) fail('invalid_chunks');
  const selected = (rows as DocumentChunk[]).filter(row => row && row.id === chunkId && row.docId === docId);
  if (selected.length > 1) fail('duplicate_identity');
  await unchanged(file, bytes, 32 * 1024 * 1024); return selected[0] ?? null;
}

/**
 * Explicit saved-source snapshot reader only. No parse, embedding, recovery, model or write.
 * Before/after file checks fail closed on observed changes. This is NOT withSource's atomic
 * mutation lock: a production publication host must also coordinate every application writer,
 * and handle external edits. This reader is not registered in production IPC in S3a.
 */
export async function readSavedArgumentProjectionSource(optionsValue: SavedArgumentSourceReaderOptions,
  refValue: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null> {
  const options = structuredClone(optionsValue), ref = structuredClone(refValue);
  validateArgumentProjectionSourceRef(ref);
  for (const root of [options.dataRoot, options.vaultRoot, options.userStateDir]) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('absolute_root_required');
  }
  // Stable identifiers can select records, never filesystem traversal or arbitrary paths.
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(ref.entityId) || ref.entityId === '.' || ref.entityId === '..') fail('invalid_id');
  const scope = options.scope;
  if (!scope || scope.corpus !== 'reference' || !scope.allowedSourceKinds.includes(ref.kind)
    || !(ref.kind === 'knowledge-note' ? scope.allowedNoteIds : scope.allowedDocIds).includes(ref.entityId)) fail('scope_denied');
  if (ref.kind === 'knowledge-note') {
    const note = await readSavedArgumentReferenceNote(options, ref.entityId);
    if (note === null) return null;
    const input = await adaptSavedKnowledgeNote({ note, rootScopeId: scope.rootScopeId, scope });
    // Hashing/preparing is asynchronous too: do not return an original that was
    // observed to change after the raw read but during source adaptation.
    const after = await readSavedArgumentReferenceNote(options, ref.entityId);
    if (JSON.stringify(after) !== JSON.stringify(note)) fail('source_changed');
    return input;
  }
  await directory(options.dataRoot);
  const indexDirectory = path.join(options.dataRoot, 'rag-index'); await directory(indexDirectory);
  const manifestFile = path.join(indexDirectory, 'manifest.json');
  const manifest = await readFile(manifestFile, MAX_METADATA_BYTES); if (!manifest) return null;
  const rows = json(manifest);
  if (!Array.isArray(rows)) return fail('invalid_manifest');
  if (rows.length > 10000) fail('invalid_manifest');
  const selected = rows.filter((row) => row && row.id === ref.entityId);
  if (selected.length > 1) fail('duplicate_identity');
  const metadata = selected[0] as UploadedDocument | undefined;
  if (!metadata) return null;
  if (!/^\.[a-z0-9]{1,10}$/u.test(metadata.extension)) fail('invalid_extension');
  const parseFile = path.join(indexDirectory, `structured-${ref.entityId}.json`);
  const parse = await readFile(parseFile, MAX_PARSE_BYTES); if (!parse) return null;
  const document = json(parse) as StructuredDocument;
  const documentsDirectory = path.join(options.dataRoot, 'documents'); await directory(documentsDirectory);
  const originalFile = path.join(documentsDirectory, `${ref.entityId}${metadata.extension}`);
  const original = await readFile(originalFile, MAX_ORIGINAL_BYTES); if (!original) return null;
  if (createHash('sha256').update(original).digest('hex') !== document.sourceHash) fail('source_changed');
  const input = await adaptSavedUploadedDocument({ document, metadata, rootScopeId: scope.rootScopeId, scope });
  await unchanged(parseFile, parse, MAX_PARSE_BYTES); await unchanged(manifestFile, manifest, MAX_METADATA_BYTES);
  await unchanged(originalFile, original, MAX_ORIGINAL_BYTES); return input;
}
