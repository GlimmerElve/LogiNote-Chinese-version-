import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { extractStructuredDocument } from '../src/electron/documentParsers.ts';
import { setPdfExtractScript } from '../src/electron/pdf.ts';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  readManifest,
  setDataRoot,
  setModelsDir,
  vectorizeDocument,
} from '../src/electron/ragIndex.ts';
import { captureRebuildSnapshot, commitPreparedRebuild } from './rag-rebuild-transaction.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function resolveDataRoot(): Promise<string> {
  const explicit = argument('--data-root');
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const anchor = path.join(os.homedir(), '.logi-note', 'storage-config.json');
  try {
    const parsed = JSON.parse(await fs.readFile(anchor, 'utf-8')) as { dataRoot?: unknown };
    if (typeof parsed.dataRoot === 'string' && parsed.dataRoot.trim()) return path.resolve(parsed.dataRoot.trim());
  } catch {
    // 使用 Electron 默认 userData 目录。
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'react-example');
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const rebuildAll = hasFlag('--all');
  const dataRoot = await resolveDataRoot();
  const indexRoot = path.join(dataRoot, 'rag-index');
  const documentRoot = path.join(dataRoot, 'documents');
  const modelsDir = path.resolve(argument('--models-dir') || path.join(process.cwd(), 'models'));
  setDataRoot(dataRoot);
  setModelsDir(modelsDir);
  setPdfExtractScript(path.resolve(process.cwd(), 'python', 'pdf_extract.py'));

  const manifest = await readManifest();
  const candidates = manifest.filter((document) => (
    document.indexable
    && document.status === 'ready'
    && (rebuildAll || document.needsReindex)
  ));
  if (candidates.length === 0) {
    console.log(JSON.stringify({ status: 'nothing_to_rebuild', apply, rebuildAll }, null, 2));
    return;
  }
  const snapshot = await captureRebuildSnapshot(indexRoot, candidates.map((document) => document.id));

  const prepared: Array<{
    document: (typeof candidates)[number];
    structured: Awaited<ReturnType<typeof extractStructuredDocument>>;
    chunks: Awaited<ReturnType<typeof vectorizeDocument>>;
  }> = [];
  for (const document of candidates) {
    const storedPath = path.join(documentRoot, `${document.id}${document.extension}`);
    await fs.access(storedPath);
    const structured = await extractStructuredDocument(storedPath, document.fileType, document.id);
    const chunks = await vectorizeDocument(
      document.id,
      document.fileName,
      structured.normalizedText,
      structured,
    );
    if (!structured.normalizedText.trim() || chunks.length === 0) {
      throw new Error(`第 ${prepared.length + 1} 份资料未产生有效结构化文本或分块`);
    }
    const covered = new Uint8Array(structured.normalizedText.length);
    for (const chunk of chunks) {
      assert.equal(chunk.schemaVersion, CURRENT_INDEX_SCHEMA_VERSION);
      assert.ok(chunk.sourceLocators?.length && chunk.sentenceSpans?.length);
      assert.equal(structured.normalizedText.slice(chunk.textStart!, chunk.textEnd!), chunk.content);
      assert.ok(chunk.embedding.length === 384 && chunk.embedding.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...chunk.embedding) - 1) < 0.01);
      for (let i = chunk.textStart!; i < chunk.textEnd!; i += 1) assert.equal(covered[i]++, 0, 'Canonical chunks overlap');
    }
    for (const block of structured.blocks.filter((item) => item.kind !== 'heading')) {
      for (let i = block.textStart; i < block.textEnd; i += 1) {
        if (!/\s/u.test(structured.normalizedText[i])) assert.equal(covered[i], 1, 'Source character lost');
      }
    }
    prepared.push({ document, structured, chunks });
  }

  let backupCreated = false;
  let backupRoot: string | undefined;
  let quarantined = 0;
  if (apply) {
    const result = await commitPreparedRebuild(dataRoot, prepared, snapshot);
    backupRoot = result.backupRoot;
    quarantined = result.quarantined;
    backupCreated = true;
  }

  console.log(JSON.stringify({
    status: apply ? 'rebuilt' : 'dry_run',
    apply,
    rebuildAll,
    documentCount: prepared.length,
    chunkCount: prepared.reduce((sum, item) => sum + item.chunks.length, 0),
    normalizedChars: prepared.reduce((sum, item) => sum + item.structured.normalizedText.length, 0),
    sourceLocatorCoverage: prepared.length
      ? Math.round((prepared.flatMap((item) => item.chunks).filter((chunk) => chunk.sourceLocators?.length).length
        / prepared.flatMap((item) => item.chunks).length) * 10_000) / 10_000
      : 0,
    backupCreated,
    backupRoot,
    quarantined,
    originalDocumentsChanged: false,
    vectorAndSourceValidation: 'passed',
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '真实资料索引重建失败');
  process.exitCode = 1;
});
