import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCognition, mutateCognition, COGNITION_FILE_NAME, COGNITION_INDEX_FILE_NAME } from '../src/electron/cognitionStore';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval';
import { extractStructuredDocument } from '../src/electron/documentParsers';
import { setDataRoot, setModelsDir, getDocumentsDir, vectorizeDocument, writeChunksFile, writeStructuredDocumentFile,
  writeManifest, searchDocuments, CURRENT_INDEX_SCHEMA_VERSION } from '../src/electron/ragIndex';
import { setKnowledgeDataRoot } from '../src/electron/rag/knowledgeStore';
import type { CognitionMutation } from '../src/services/cognition/types';

/** One fixture per process: production RAG services have process-scoped roots. */
export async function createCognitionAcceptanceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-acceptance-'));
  const directory = path.join(root, 'user-state');
  const sourcePath = path.join(directory, COGNITION_FILE_NAME), indexPath = path.join(directory, COGNITION_INDEX_FILE_NAME);
  setDataRoot(root); setKnowledgeDataRoot(root); setModelsDir(path.resolve('models'));
  const stats = { privateReads: 0, privateSearches: 0, documentSearches: 0, mutations: 0, mutationKinds: [] as string[] };
  const close = () => fs.rm(root, { recursive: true, force: true }); // Exact mkdtemp path, not a configured vault.
  try {
    const docId = 'acceptance-document';
    const imported = path.join(await getDocumentsDir(), `${docId}.txt`);
    await fs.copyFile(path.resolve('scripts/fixtures/cognition-acceptance-material.txt'), imported);
    const structured = await extractStructuredDocument(imported, 'txt', docId);
    const chunks = await vectorizeDocument(docId, '合成机械资料.txt', structured.normalizedText, structured);
    await writeStructuredDocumentFile(structured); await writeChunksFile(docId, chunks);
    await writeManifest([{ id: docId, fileName: '合成机械资料.txt', fileType: 'txt', extension: '.txt', indexable: true,
      size: (await fs.stat(imported)).size, status: 'ready', chunkCount: chunks.length, totalChars: structured.normalizedText.length,
      indexSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION, uploadAt: '2026-10-04T00:00:00.000Z' }]);
    return { root, directory, sourcePath, indexPath, stats, close,
      load: async () => { stats.privateReads++; return loadCognition(directory); },
      mutate: async (input: CognitionMutation) => { const next = await mutateCognition(directory, input); stats.mutations++; stats.mutationKinds.push(input.kind); return next; },
      search: async (query: string) => { stats.privateSearches++; return searchPersonalCognition(directory, query); },
      searchDocuments: async (query: string) => { stats.documentSearches++; return searchDocuments(query, 4, { mode: 'passage' }); },
      sourceText: async () => fs.readFile(sourcePath, 'utf8'),
    };
  } catch (error) { await close(); throw error; }
}
