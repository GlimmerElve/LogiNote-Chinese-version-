import assert from 'node:assert/strict';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { extractPdfDocument, setPdfExtractScript } from '../src/electron/pdf.ts';
import { buildStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { validateMaterialDocument } from '../src/electron/materialStore.ts';

const file = process.argv[2];
assert.ok(file && path.isAbsolute(file), 'usage: audit-pdf-preprocessing.ts <absolute-pdf-path>');
const previewPagesArg = process.argv.find((arg) => arg.startsWith('--preview-pages='));
const previewPages = new Set((previewPagesArg?.split('=')[1] || '')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0));
await access(file);
setPdfExtractScript(path.resolve(process.cwd(), 'python', 'pdf_extract.py'));
const document = await extractPdfDocument(file);
const structured = buildStructuredDocument('pdf-preprocessing-audit', document.blocks.map((block) => ({
  text: block.text,
  kind: block.kind,
  locator: block.sourceFragments[0]?.locator || {
    kind: 'pdf' as const, page: block.page, bbox: block.bbox, blockIndex: block.blockIndex,
  },
  sourceFragments: block.sourceFragments,
})), { preprocessing: document.preprocessing });
validateMaterialDocument(structured, structured.docId);
const byKind = Object.fromEntries([...new Set(document.blocks.map((block) => block.kind))]
  .sort().map((kind) => [kind, document.blocks.filter((block) => block.kind === kind).length]));
const bridged = document.blocks.filter((block) => block.kind === 'paragraph' && block.sourceFragments.length > 1);
const samples = (blocks: typeof document.blocks) => blocks.slice(0, 5).map((block) => ({
  page: block.page,
  kind: block.kind,
  text: block.text.slice(0, 240),
  sources: block.sourceFragments.map((fragment) => fragment.locator),
}));
console.log(JSON.stringify({
  file: path.basename(file),
  totalPages: document.totalPages,
  characters: document.text.length,
  structuredBlockCount: structured.blocks.length,
  preprocessing: document.preprocessing,
  byKind,
  bridgedCount: bridged.length,
  tableSamples: samples(document.blocks.filter((block) => block.kind === 'table')),
  bridgedSamples: samples(bridged),
  ...(previewPages.size ? {
    previewPages: [...previewPages].sort((a, b) => a - b).map((page) => ({
      page,
      blocks: document.blocks.filter((block) => block.page === page).map((block) => ({
        kind: block.kind,
        text: block.text,
        sources: block.sourceFragments.map((fragment) => fragment.locator),
      })),
    })),
  } : {}),
}, null, 2));
