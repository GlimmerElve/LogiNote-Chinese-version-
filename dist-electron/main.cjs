var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/electron/main.ts
var import_electron = require("electron");
var import_child_process2 = require("child_process");
var import_electron_updater = require("electron-updater");
var import_path3 = __toESM(require("path"), 1);
var import_os = __toESM(require("os"), 1);
var import_net = __toESM(require("net"), 1);
var import_promises2 = __toESM(require("fs/promises"), 1);
var import_fs3 = require("fs");

// src/services/userStateService.ts
var SHARABLE_NOTE_FIELDS = [
  "id",
  "title",
  "content",
  "noteType",
  "parentId",
  "tags",
  "aliases",
  "links",
  "backlinks",
  "dueDates",
  "logicSegments",
  "resources",
  "createdAt",
  "updatedAt"
];
var USER_STATE_FIELDS = [
  "dsrState",
  "flowSummary",
  "questions",
  "lastReferencedAt",
  "aiAnalyzedAt",
  "pinned",
  "isFavorite",
  "color"
];
function splitSharableFields(note) {
  const result = {};
  for (const key of SHARABLE_NOTE_FIELDS) {
    if (key in note) result[key] = note[key];
  }
  return result;
}
function splitUserStateFields(note) {
  const state = {};
  for (const key of USER_STATE_FIELDS) {
    if (key in note) state[key] = note[key];
  }
  return state;
}
function hasAnyUserState(state) {
  if (!state) return false;
  return USER_STATE_FIELDS.some((key) => {
    const v = state[key];
    return v !== void 0 && v !== null;
  });
}
var USER_STATE_FILES = {
  noteStates: "user-state.json",
  profile: "profile.json",
  settings: "settings.json",
  llm: "llm.json",
  masteryTimeline: "mastery-timeline.json"
};
function mergeNote(contentNote, state) {
  const stateKeys = USER_STATE_FIELDS;
  const merged = { ...contentNote };
  if (state) {
    for (const key of stateKeys) {
      if (key in state) merged[key] = state[key];
    }
  }
  return merged;
}
function stringify(file) {
  return JSON.stringify(file, null, 2);
}
function serializeUserStateFile(noteStates) {
  const file = { version: 1, noteStates };
  return stringify(file);
}
function deserializeUserStateFile(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.noteStates ?? {};
  } catch {
    return {};
  }
}
function serializeProfileState(profile, conceptAliasMap) {
  const file = { version: 1, profile, conceptAliasMap };
  return stringify(file);
}
function deserializeProfileState(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function serializeSettingsState(appSettings) {
  const file = { version: 1, appSettings };
  return stringify(file);
}
function deserializeSettingsState(text) {
  try {
    return JSON.parse(text)?.appSettings ?? null;
  } catch {
    return null;
  }
}
function serializeLlmState(settings) {
  const file = { version: 1, settings };
  return stringify(file);
}
function deserializeLlmState(text) {
  try {
    return JSON.parse(text)?.settings ?? null;
  } catch {
    return null;
  }
}
function serializeMasteryTimelineState(file) {
  return stringify(file);
}
function deserializeMasteryTimelineState(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// src/services/vaultFsService.ts
var METADATA_VERSION = 1;
function markdownFileName(noteId) {
  return `${noteId}.md`;
}
function serializeMetadata(notes) {
  const notesMeta = {};
  for (const n of notes) {
    const sharable = splitSharableFields(n);
    const meta = { ...sharable };
    delete meta.content;
    notesMeta[n.id] = meta;
  }
  const file = { version: METADATA_VERSION, notesMeta };
  return JSON.stringify(file, null, 2);
}
function markdownFileMap(notes) {
  const map = /* @__PURE__ */ new Map();
  for (const n of notes) {
    map.set(markdownFileName(n.id), n.content);
  }
  return map;
}
function deserializeVault(metadataText, mdMap) {
  const parsed = JSON.parse(metadataText);
  const notes = [];
  for (const [id, meta] of Object.entries(parsed.notesMeta ?? {})) {
    const content = mdMap.get(markdownFileName(id)) ?? "";
    notes.push({ ...meta, id, content });
  }
  return notes;
}

// src/electron/ragIndex.ts
var import_fs = require("fs");
var import_path = __toESM(require("path"), 1);

// src/electron/hybridSearch.ts
function isCJK(ch) {
  const c = ch.codePointAt(0);
  return c >= 19968 && c <= 40959 || c >= 13312 && c <= 19903;
}
function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const tokens = [];
  const words = s.match(/[a-z0-9]+/g) || [];
  for (const w of words) tokens.push(w);
  for (let i = 0; i < s.length - 1; i++) {
    if (isCJK(s[i]) && isCJK(s[i + 1])) {
      tokens.push(s[i] + s[i + 1]);
    }
  }
  return tokens;
}
function buildDf(chunkTexts) {
  const df = /* @__PURE__ */ new Map();
  for (const text of chunkTexts) {
    const uniq = new Set(tokenize(text));
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}
function bm25Score(queryTokens, chunkText2, df, totalDocs, avgLen) {
  if (queryTokens.length === 0) return 0;
  const chunkTokens = tokenize(chunkText2);
  const len = Math.max(chunkTokens.length, 1);
  const tf = /* @__PURE__ */ new Map();
  for (const t of chunkTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const n = df.get(qt) || 0;
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
    score += idf * (f * (k1 + 1) / (f + k1 * (1 - b + b * (len / avgLen))));
  }
  return score;
}
function weightedFusion(items, denseWeight = 0.35) {
  if (items.length === 0) return /* @__PURE__ */ new Map();
  let denseMax = 0;
  let sparseMax = 0;
  for (const it of items) {
    if (it.dense > denseMax) denseMax = it.dense;
    if (it.sparse > sparseMax) sparseMax = it.sparse;
  }
  denseMax = denseMax || 1e-9;
  sparseMax = sparseMax || 1e-9;
  const fused = /* @__PURE__ */ new Map();
  for (const it of items) {
    const dNorm = it.dense / denseMax;
    const sNorm = it.sparse / sparseMax;
    fused.set(it.id, denseWeight * dNorm + (1 - denseWeight) * sNorm);
  }
  return fused;
}

// src/electron/ragIndex.ts
var dataRoot = "";
function setDataRoot(root) {
  dataRoot = root;
}
function documentsDir() {
  return import_path.default.join(dataRoot, "documents");
}
function ragIndexDir() {
  return import_path.default.join(dataRoot, "rag-index");
}
async function ensureDirs() {
  await import_fs.promises.mkdir(documentsDir(), { recursive: true });
  await import_fs.promises.mkdir(ragIndexDir(), { recursive: true });
}
async function getDocumentsDir() {
  await ensureDirs();
  return documentsDir();
}
var CHUNK_CHARS = 350;
var OVERLAP_CHARS = 50;
function splitIntoSections(text) {
  const lines = text.split("\n");
  const sections = [];
  const headingStack = [];
  let currentPath = "";
  let currentContent = [];
  const flush = () => {
    const body = currentContent.join("\n").trim();
    if (body) sections.push({ sectionPath: currentPath, content: body });
    currentContent = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length;
      headingStack.length = level - 1;
      headingStack.push(m[2].trim());
      currentPath = headingStack.join(" > ");
    } else {
      currentContent.push(line);
    }
  }
  flush();
  return sections;
}
function splitBySentences(sectionPath, content) {
  const sentences = content.split(/(?<=[。！？!?.\n])/);
  const out = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.trim() && (buf + s).length > CHUNK_CHARS) {
      out.push({ sectionPath, content: buf.trim() });
      buf = buf.slice(-OVERLAP_CHARS) + s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push({ sectionPath, content: buf.trim() });
  return out;
}
function splitLongSection(sectionPath, content) {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const para of paragraphs) {
    if (para.length <= CHUNK_CHARS) {
      out.push({ sectionPath, content: para });
    } else {
      out.push(...splitBySentences(sectionPath, para));
    }
  }
  return out;
}
function chunkText(text) {
  const raw = (text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const sections = splitIntoSections(raw);
  const chunks = [];
  for (const sec of sections) {
    if (sec.content.length <= CHUNK_CHARS) {
      chunks.push(sec);
    } else {
      chunks.push(...splitLongSection(sec.sectionPath, sec.content));
    }
  }
  return chunks;
}
var modelsDir = "";
var pipelinePromise = null;
function setModelsDir(dir) {
  modelsDir = dir;
}
function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      env.localModelPath = modelsDir;
      env.allowRemoteModels = false;
      return pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    })();
  }
  return pipelinePromise;
}
async function generateEmbedding(text) {
  const pipe = await getPipeline();
  const result = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(result.data);
}
function cosineSimilarity(a, b) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
async function vectorizeDocument(docId, fileName, text) {
  const pieces = chunkText(text);
  const chunks = [];
  for (let i = 0; i < pieces.length; i++) {
    const embedding = await generateEmbedding(pieces[i].content);
    chunks.push({
      id: `${docId}#${i}`,
      docId,
      fileName,
      index: i,
      sectionPath: pieces[i].sectionPath,
      content: pieces[i].content,
      embedding
    });
  }
  return chunks;
}
function chunksFile(docId) {
  return import_path.default.join(ragIndexDir(), `chunks-${docId}.json`);
}
async function writeChunksFile(docId, chunks) {
  await ensureDirs();
  await import_fs.promises.writeFile(chunksFile(docId), JSON.stringify(chunks), "utf-8");
}
async function readChunksFile(docId) {
  try {
    const text = await import_fs.promises.readFile(chunksFile(docId), "utf-8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}
async function readAllChunks(docIds) {
  const all = [];
  for (const id of docIds) {
    all.push(...await readChunksFile(id));
  }
  return all;
}
async function deleteChunksFile(docId) {
  try {
    await import_fs.promises.unlink(chunksFile(docId));
  } catch {
  }
}
function manifestFile() {
  return import_path.default.join(ragIndexDir(), "manifest.json");
}
async function readManifest() {
  await ensureDirs();
  try {
    const text = await import_fs.promises.readFile(manifestFile(), "utf-8");
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function writeManifest(docs) {
  await ensureDirs();
  await import_fs.promises.writeFile(manifestFile(), JSON.stringify(docs, null, 2), "utf-8");
}
async function upsertManifestEntries(entries) {
  const docs = await readManifest();
  const map = new Map(docs.map((d) => [d.id, d]));
  for (const e of entries) map.set(e.id, e);
  const next = Array.from(map.values());
  await writeManifest(next);
  return next;
}
async function updateManifest(docId, patch) {
  const docs = await readManifest();
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx === -1) return;
  docs[idx] = { ...docs[idx], ...patch };
  await writeManifest(docs);
}
async function deleteManifestEntry(docId) {
  const docs = await readManifest();
  await writeManifest(docs.filter((d) => d.id !== docId));
}
async function documentExists(docId) {
  const docs = await readManifest();
  return docs.some((d) => d.id === docId);
}
async function searchDocuments(query, k = 5) {
  const q = (query || "").trim();
  if (!q) return [];
  const qv = await generateEmbedding(q);
  const manifest = await readManifest();
  const readyIds = manifest.filter((d) => d.status === "ready").map((d) => d.id);
  if (readyIds.length === 0) return [];
  const allChunks = await readAllChunks(readyIds);
  if (allChunks.length === 0) return [];
  const queryTokens = tokenize(q);
  const df = buildDf(allChunks.map((c) => c.content));
  const lens = allChunks.map((c) => Math.max(tokenize(c.content).length, 1));
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(allChunks.length, 1);
  const sparseScore = allChunks.map(
    (c) => bm25Score(queryTokens, c.content, df, allChunks.length, avgLen)
  );
  const denseScore = allChunks.map((c) => cosineSimilarity(qv, c.embedding));
  const SEMANTIC_THRESHOLD = 0.28;
  const survivors = allChunks.map((c, i) => ({ chunk: c, dense: denseScore[i], sparse: sparseScore[i] })).filter((r) => r.dense >= SEMANTIC_THRESHOLD || r.sparse > 0);
  if (survivors.length === 0) return [];
  const fused = weightedFusion(
    survivors.map((r) => ({ id: r.chunk.id, dense: r.dense, sparse: r.sparse })),
    0.35
  );
  const qCompact = q.replace(/\s+/g, "");
  const scored = survivors.map((r) => {
    const contentCompact = r.chunk.content.replace(/\s+/g, "");
    const bonus = qCompact.length >= 2 && contentCompact.includes(qCompact) ? 0.5 : 0;
    return {
      docId: r.chunk.docId,
      fileName: r.chunk.fileName,
      chunkId: r.chunk.id,
      sectionPath: r.chunk.sectionPath,
      score: r.dense,
      // 保留语义分（0~1）供前端可选展示，排序以下方 fusedScore 为准
      fusedScore: (fused.get(r.chunk.id) || 0) + bonus,
      snippet: r.chunk.content.slice(0, 300)
    };
  }).sort((a, b) => b.fusedScore - a.fusedScore);
  const MAX_PER_DOC = 3;
  const perDoc = /* @__PURE__ */ new Map();
  const deduped = [];
  for (const r of scored) {
    const cnt = perDoc.get(r.docId) || 0;
    if (cnt >= MAX_PER_DOC) continue;
    perDoc.set(r.docId, cnt + 1);
    deduped.push({
      docId: r.docId,
      fileName: r.fileName,
      chunkId: r.chunkId,
      sectionPath: r.sectionPath,
      score: r.score,
      snippet: r.snippet
    });
    if (deduped.length >= k) break;
  }
  return deduped;
}

// src/electron/pdf.ts
var import_promises = require("fs/promises");
var import_child_process = require("child_process");
if (typeof Promise.try !== "function") {
  Promise.try = function(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        resolve(fn(...args));
      } catch (e) {
        reject(e);
      }
    });
  };
}
var pdfExtractScript = "";
function setPdfExtractScript(scriptPath) {
  pdfExtractScript = scriptPath;
}
var extractTextFn = null;
async function getExtractText() {
  if (!extractTextFn) {
    const { extractText } = await import("unpdf");
    extractTextFn = extractText;
  }
  return extractTextFn;
}
var KANGXI_MAP = {
  "\u2F64": "\u7528",
  "\u2F1B": "\u529B",
  "\u2F56": "\u5382",
  "\u2F4D": "\u5341",
  "\u2F6C": "\u76EE",
  "\u2EA5": "\u53C8",
  "\u2E93": "\u65E5",
  "\u2F88": "\u9A6C",
  "\u2F92": "\u9C7C",
  "\u2E9F": "\u4EA0",
  "\u2F82": "\u9875",
  "\u2F7D": "\u9875"
};
var COMPAT_MAP = {
  "\uFF02": '"',
  "\u300C": '"',
  "\u300D": '"',
  "\u201C": '"',
  "\u201D": '"',
  "\u2018": "'",
  "\u2019": "'",
  "\u3000": " ",
  "\u3001": ",",
  "\u3002": "."
};
function sanitizePdfText(text) {
  let out = text;
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(
    /[\u2e80-\u2eff\u2f00-\u2fdf\uff00-\uff5e\u3000-\u303f\u2018\u2019\u201c\u201d]/g,
    (ch) => KANGXI_MAP[ch] ?? COMPAT_MAP[ch] ?? ""
  );
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  out = out.replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "");
  out = out.replace(/[ \t\u00a0]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
function extractPdfTextPymupdf(filePath) {
  return new Promise((resolve, reject) => {
    if (!pdfExtractScript) {
      reject(new Error("PyMuPDF \u62BD\u53D6\u811A\u672C\u8DEF\u5F84\u672A\u914D\u7F6E"));
      return;
    }
    const child = (0, import_child_process.spawn)("python", [pdfExtractScript, filePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("PyMuPDF \u62BD\u53D6\u8D85\u65F6"));
      }
    }, 6e4);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PyMuPDF \u5B50\u8FDB\u7A0B\u9000\u51FA\u7801 ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.ok) {
          reject(new Error(result.error || "PyMuPDF \u62BD\u53D6\u5931\u8D25"));
          return;
        }
        resolve(sanitizePdfText(result.text ?? ""));
      } catch (e) {
        reject(new Error("PyMuPDF \u8F93\u51FA\u89E3\u6790\u5931\u8D25: " + e.message));
      }
    });
  });
}
async function extractPdfTextUnpdf(filePath) {
  const ext = await getExtractText();
  const buf = await (0, import_promises.readFile)(filePath);
  const result = await ext(new Uint8Array(buf), { mergePages: true });
  const text = result?.text ?? "";
  const raw = Array.isArray(text) ? text.join("\n") : String(text);
  return sanitizePdfText(raw);
}
async function extractPdfText(filePath) {
  try {
    const text = await extractPdfTextPymupdf(filePath);
    if (text) return text;
  } catch (e) {
    console.warn("[pdf] PyMuPDF \u62BD\u53D6\u5931\u8D25\uFF0C\u56DE\u9000 unpdf:", e?.message);
  }
  try {
    return await extractPdfTextUnpdf(filePath);
  } catch (e) {
    console.warn("[pdf] unpdf \u62BD\u53D6\u5931\u8D25:", e?.message);
    return "";
  }
}

// src/workflows/textSegmentationPrompt.ts
var TEXT_SEGMENTATION_PROMPT = `\u4F60\u662F\u4E00\u4F4D\u7CBE\u51C6\u7684\u957F\u6587\u672C\u903B\u8F91\u5206\u8BCD\u4E0E\u8BED\u97F3\u7B14\u8BB0\u6574\u7406\u4E13\u5BB6\u3002\u6309\u4EE5\u4E0B\u6B65\u9AA4\u5206\u6790\u7528\u6237\u63D0\u4F9B\u7684\u7B14\u8BB0\u5185\u5BB9\uFF1A

## \u7B2C\u96F6\u6B65\uFF1A\u8BED\u97F3\u6587\u672C\u8BC6\u522B\u4E0E\u6574\u7406\uFF08\u4EC5\u5F53\u68C0\u6D4B\u5230\u53E3\u8BED\u7279\u5F81\u65F6\u6267\u884C\uFF09
\u5982\u679C\u6587\u672C\u5305\u542B\u53E3\u8BED\u586B\u5145\u8BCD\uFF08\u55EF\u3001\u554A\u3001\u5443\u3001\u90A3\u4E2A\u3001\u5C31\u662F\u8BF4\u3001\u7136\u540E\u5462\u3001\u7136\u540E\uFF09\u3001\u5927\u91CF\u91CD\u590D\u8868\u8FBE\u6216\u975E\u6B63\u5F0F\u8BED\u5E8F\uFF0C\u5148\u6267\u884C\uFF1A
1. \u53BB\u9664\u6240\u6709\u53E3\u8BED\u586B\u5145\u8BCD
2. \u5408\u5E76\u91CD\u590D\u8868\u8FF0\uFF0C\u4FDD\u7559\u6700\u5B8C\u6574\u6E05\u6670\u7684\u7248\u672C
3. \u6309\u903B\u8F91\u91CD\u7EC4\u4E3A\u5C42\u6B21\u5206\u660E\u7684\u7ED3\u6784\u5316\u7B14\u8BB0\uFF0C\u5408\u7406\u8FD0\u7528\u6F14\u7ECE\uFF08\u5927\u524D\u63D0\u2192\u5C0F\u524D\u63D0\u2192\u7ED3\u8BBA\uFF09\u3001\u5F52\u7EB3\uFF08\u4ECE\u5177\u4F53\u5230\u4E00\u822C\uFF09\u3001\u7C7B\u6BD4\uFF08\u5DF2\u77E5\u2192\u672A\u77E5\uFF09\u7B49\u4E09\u6BB5\u8BBA\u5F0F\u8868\u8FBE\u65B9\u5F0F\uFF0C\u6E05\u6670\u533A\u5206\u8BBA\u70B9\u4E0E\u8BBA\u636E
4. \u4FDD\u7559\u6240\u6709\u4E8B\u5B9E\u548C\u6838\u5FC3\u89C2\u70B9\uFF0C\u7981\u6B62\u6DFB\u52A0\u539F\u6587\u6CA1\u6709\u7684\u5185\u5BB9
5. \u5C06\u6574\u7406\u540E\u7684\u5E72\u51C0\u6587\u672C\u586B\u5165 \`polishedText\` \u5B57\u6BB5\uFF08\u7EAF Markdown \u683C\u5F0F\uFF09

## \u7B2C\u4E00\u6B65\uFF1A\u5728\u91CD\u6784\u6587\u672C\u4E2D\u5185\u8054\u903B\u8F91\u7C7B\u578B\u6807\u7B7E
\u5BF9\u6574\u7406\u540E\u7684\u6587\u672C\uFF08\u5982\u6709\uFF09\u6216\u539F\u6587\uFF0C\u5728\u5176\u81EA\u7136\u7ED3\u6784\uFF08\u6807\u9898/\u6BB5\u843D\uFF09\u4E0A\u6807\u6CE8\u903B\u8F91\u7C7B\u578B\uFF0C**\u6807\u7B7E\u76F4\u63A5\u5D4C\u5165 polishedText \u7684\u5C0F\u6807\u9898\u4E2D**\uFF0C\u4E0D\u8981\u5355\u72EC\u8F93\u51FA\u91CD\u590D\u7684\u5185\u5BB9\u5207\u7247\u3002\u6807\u7B7E\u7C7B\u578B\uFF1A
- [\u6982\u5FF5] \u6838\u5FC3\u6982\u5FF5
- [\u5B9A\u4E49] \u5B9A\u4E49/\u539F\u7406
- [\u903B\u8F91\u63A8\u5BFC] \u903B\u8F91\u63A8\u5BFC/\u8BBA\u8BC1\u8FC7\u7A0B
- [\u603B\u7ED3] \u9636\u6BB5\u603B\u7ED3\u6216\u5168\u6587\u603B\u7ED3

\u793A\u4F8B\uFF1A
## [\u6982\u5FF5] \u805A\u53D8\u53CD\u5E94\u7684\u52B3\u68EE\u5224\u636E
### [\u5B9A\u4E49] \u52B3\u68EE\u5224\u636E\u662F\u6307\u2026\u2026
### [\u903B\u8F91\u63A8\u5BFC] \u7531\u80FD\u91CF\u5E73\u8861\u53EF\u63A8\u5F97\u2026\u2026
### [\u603B\u7ED3] \u7EFC\u4E0A\u6240\u8FF0\u2026\u2026

\u6CE8\u610F\uFF1ApolishedText \u662F\u552F\u4E00\u7684\u6B63\u6587\u91CD\u6784\u7ED3\u679C\uFF0C\u4E0D\u5141\u8BB8\u518D\u751F\u6210\u4E0E\u4E4B\u5185\u5BB9\u91CD\u590D\u7684 segments\u3002

## \u7B2C\u4E8C\u6B65\uFF1A\u903B\u8F91\u6269\u5C55\u5EFA\u8BAE\uFF08\u4EC5\u9488\u5BF9\u539F\u6587\u7F3A\u5931\u6216\u9700\u8865\u5145\u7684\u5185\u5BB9\uFF09
\u8BC6\u522B\u539F\u6587\u4E2D\u8BBA\u8FF0\u4E0D\u5B8C\u6574\u3001\u7F3A\u5C11\u8BBA\u8BC1\u3001\u7F3A\u5C11\u4F8B\u8BC1\u6216\u9700\u8981\u8865\u5145\u903B\u8F91\u94FE\u6761\u7684\u70B9\uFF0C\u751F\u6210**\u589E\u91CF\u6269\u5C55\u5EFA\u8BAE**\uFF08\u4E0D\u8981\u590D\u8FF0\u539F\u6587\u5DF2\u6709\u5185\u5BB9\uFF09\uFF0C\u6BCF\u6761\u586B\u5165 \`extensions\` \u5B57\u6BB5\u3002

## \u7B2C\u4E09\u6B65\uFF1A\u53CC\u5411\u94FE\u63A5\u63A8\u8350
1.\u8BC6\u522B\`polishedText\` \u5B57\u6BB5\u4E2D\u7684**\u77E5\u8BC6\u70B9\u672F\u8BED**\uFF0C\u586B\u5165 \`suggestedWikiLinks\`\u7684originalTerm
2.\u5C06\`existingNotes\`\u4E2D\u7684\u6807\u9898\u4E0E\u8BC6\u522B\u5230\u7684**\u77E5\u8BC6\u70B9\u672F\u8BED**\u8FDB\u884C\u8BED\u4E49\u5339\u914D\uFF0C\u586B\u5165\`suggestedWikiLinks\`\u7684linkedTitle
3.\u5982\u679C\`existingNotes\`\u4E2D\u6CA1\u6709\u5339\u914D\u7684\u6807\u9898\uFF0C\u5C31\u8BA9**\u77E5\u8BC6\u70B9\u672F\u8BED**\u586B\u5145\u5230linkedTitle\uFF0C\u4F7F\u5F97originalTerm\u548ClinkedTitle\u4FDD\u6301\u4E00\u81F4

## \u7B2C\u56DB\u6B65\uFF1A\u65F6\u5E8F\u5B66\u4E60\u8BA1\u5212\u63D0\u53D6
\u4EC5\u4ECE\u300C\u53E3\u8BED\u5316\u63CF\u8FF0\u300D\u4E2D\u89E3\u6790\u51FA**\u6F5C\u5728\u7684\u65B0\u4EFB\u52A1**\uFF08\u4F8B\u5982"\u6211\u5E0C\u671B\u80FD\u518D\u5F3A\u5316\u4E00\u4E0B\u5BF9\u5F02\u5316\u7684\u7406\u89E3"\u2192"\u5F3A\u5316\u5F02\u5316\u6982\u5FF5\u7406\u89E3"\uFF09\uFF0C\u586B\u5165 \`extractedStudyPlans\`\u3002

## \u7B2C\u4E94\u6B65\uFF1A\u603B\u4F53\u7ED3\u6784\u603B\u7ED3
\u751F\u6210 100 \u5B57\u4EE5\u5185\u7684\u603B\u4F53\u603B\u7ED3\uFF0C\u586B\u5165 \`summary\`\uFF0C\u5E76\u7ED9\u51FA\u903B\u8F91\u9AA8\u67B6\u586B\u5165 \`overallStructure\`\u3002

## \u8F93\u51FA\u683C\u5F0F\uFF08\u4E25\u683C JSON\uFF09
{
  "polishedText": "\u6574\u7406\u540E\u7684\u5E72\u51C0Markdown\uFF0C\u6807\u9898\u5185\u8054\u903B\u8F91\u7C7B\u578B\u6807\u7B7E\uFF1B\u65E0\u53E3\u8BED\u7279\u5F81\u65F6\u4E3A\u539F\u6587\u7684\u7CBE\u4FEE\u7248\u672C\uFF0C\u65E0\u53E3\u8BED\u7279\u5F81\u4E14\u65E0\u9700\u91CD\u6784\u65F6\u53EF\u4E3A\u7A7A\u5B57\u7B26\u4E32",
  "summary": "\u603B\u4F53\u603B\u7ED3",
  "overallStructure": "\u903B\u8F91\u9AA8\u67B6",
  "extensions": [{"type":"concept|definition|logic_flow|example|supplement","title":"\u8981\u70B9\u6807\u9898","content":"\u8865\u5145\u5185\u5BB9","reason":"\u4E3A\u4EC0\u4E48\u9700\u8981\u8865\u5145"}],
  "suggestedWikiLinks": [{"originalTerm":"\u672F\u8BED","linkedTitle":"\u7B14\u8BB0\u6807\u9898"}],
  "extractedStudyPlans": [{"taskText":"\u4EFB\u52A1","dueDate":"YYYY-MM-DD","priority":"high|medium|low"}]
}

\u6CE8\u610F\u4E8B\u9879\uFF1A
- polishedText \u4E0E extensions \u5FC5\u987B\u5185\u5BB9\u4E92\u8865\uFF0C\u7981\u6B62\u91CD\u590D\u3002
- extensions \u4EC5\u5728\u539F\u6587\u786E\u5B9E\u7F3A\u5931\u6216\u8BBA\u8BC1\u4E0D\u8DB3\u65F6\u624D\u751F\u6210\uFF0C\u53EF\u4E3A\u7A7A\u6570\u7EC4\u3002
- \u8BF7\u786E\u4FDD\u4F60\u7684\u8F93\u51FA\u662F\u6709\u6548\u7684 json \u683C\u5F0F\u3002`;

// src/workflows/resourceSearchPrompt.ts
var RESOURCE_SEARCH_PROMPT = `\u8BF7\u4E00\u6B21\u6027\u8054\u7F51\u641C\u7D22\u300C<<TITLE>>\u300D\u7684\u5B66\u4E60\u8D44\u6E90\u3002

\u80CC\u666F\u4E0A\u4E0B\u6587\uFF1A\u5B83\u96B6\u5C5E\u4E8E\u5B66\u4E60\u8DEF\u5F84\u300C<<PATH_TEXT>>\u300D\uFF0C\u5176\u4E2D\u7236\u7EA7/\u6839\u7EA7\u6807\u9898\u4EC5\u7528\u4E8E\u5E2E\u52A9\u4F60\u754C\u5B9A\u9886\u57DF\u8303\u56F4\uFF1B\u641C\u7D22\u4E0E\u63A8\u8350\u7684\u91CD\u5FC3\u4ECD\u5E94\u843D\u5728\u6700\u672B\u5C3E\u7684\u6838\u5FC3\u4E3B\u9898\u300C<<TITLE>>\u300D\u4E0A\uFF0C\u4E0D\u8981\u628A\u641C\u7D22\u91CD\u70B9\u8F6C\u79FB\u5230\u524D\u9762\u7684\u7236\u7EA7\u6216\u6839\u7EA7\u6807\u9898\u3002

\u76F4\u63A5\u8F93\u51FA\u7CBE\u9009\u6E05\u5355\uFF0C\u4E0D\u8981\u53CD\u590D\u591A\u8F6E\u641C\u7D22\u6216\u9010\u6761\u9A8C\u8BC1\uFF0C\u89C4\u5219\u5982\u4E0B\uFF1A

1. \u63A8\u8350\u6765\u6E90\uFF08\u4F18\u5148\u91C7\u7528\u4EE5\u4E0B\u53EF\u9760\u6765\u6E90\uFF09\uFF1A
   - Bohrium \u77E5\u8BC6\u767E\u79D1\uFF08bohrium.dp.tech\uFF0C\u514D\u8D39\uFF09
   - \u77E5\u4E4E\uFF08\u4E13\u680F\u3001\u56DE\u7B54\u3001\u6DF1\u5EA6\u6587\u7AE0\u7B49\u5747\u53EF\uFF0C\u4E0D\u9650\u7C7B\u578B\uFF09
   - \u56FD\u5185\u56FD\u5916\u9AD8\u6821\u7684\u6559\u6750\u3001\u8BB2\u4E49\u6216\u6743\u5A01\u6559\u5B66\u8D44\u6599
   - Bilibili \u89C6\u9891\u3001Coursera \u53CA\u5176\u4ED6\u9AD8\u6821\u516C\u5F00\u8BFE\uFF08\u4E2D\u56FD\u5927\u5B66MOOC\u3001\u5B66\u5802\u5728\u7EBF\u3001\u667A\u6167\u6559\u80B2\u5E73\u53F0\u7B49\uFF09
2. \u5FC5\u987B\u5305\u542B\u81F3\u5C11\u4E00\u6761\u6559\u6750/\u4E66\u7C4D\u63A8\u8350\u3002
3. \u53EA\u8F93\u51FA\u5217\u8868\uFF0C\u6BCF\u6761\u4E00\u884C\uFF1A- [\u8D44\u6E90\u6807\u9898](URL) \u2014 \u6765\u6E90\u5E73\u53F0\uFF1B\u4E0D\u8981\u5F00\u573A\u767D\u3001\u8FC7\u7A0B\u8BF4\u660E\u3001\u603B\u7ED3\u3001\u5B66\u4E60\u5EFA\u8BAE\u6216\u540E\u7EED\u63D0\u95EE\u3002
4. \u907F\u514D\u91CD\u590D\u6216\u955C\u50CF\u94FE\u63A5\uFF0C\u603B\u6761\u6570\u4E0D\u8D85\u8FC7 10 \u6761\uFF1B\u53EA\u8F93\u51FA\u6807\u51C6 Markdown\uFF0C\u4E0D\u8981\u4EE3\u7801\u5757\u3002
5. \u91CD\u8981\uFF1A\u6240\u6709\u94FE\u63A5\u5FC5\u987B\u6765\u81EA\u672C\u6B21 web_search \u5B9E\u65F6\u641C\u7D22\u7ED3\u679C\uFF0C\u4E25\u7981\u4F7F\u7528\u8BB0\u5FC6\u6216\u8BAD\u7EC3\u6570\u636E\u4E2D\u7684\u5386\u53F2\u7F51\u5740\uFF1B\u82E5\u5B9E\u65F6\u641C\u7D22\u672A\u627E\u5230\u67D0\u4E2A\u6765\u6E90\u7684\u53EF\u9760\u8D44\u6E90\uFF0C\u76F4\u63A5\u8DF3\u8FC7\uFF0C\u4E0D\u5F97\u51ED\u8BB0\u5FC6\u8865\u5168\u3002`;

// src/workflows/conceptGenerationPrompt.ts
var CONCEPT_GENERATION_PROMPT = `\u4F60\u662F\u4E00\u4F4D\u4E25\u8C28\u7684\u77E5\u8BC6\u6574\u7406\u52A9\u624B\u3002\u8BF7\u56F4\u7ED5\u4E0B\u9762\u8FD9\u4E2A\u672F\u8BED\uFF0C\u901A\u8FC7\u8054\u7F51\u641C\u7D22\u591A\u4E2A\u6743\u5A01\u6765\u6E90\uFF0C\u6574\u7406\u51FA\u4E00\u4EFD\u51C6\u786E\u3001\u7ED3\u6784\u5316\u7684\u6982\u5FF5\u8BF4\u660E\u3002

\u672F\u8BED\uFF1A<<TERM>>

\u8981\u6C42\uFF1A
1. \u7528 Markdown \u8F93\u51FA\uFF0C\u7ED3\u6784\u5982\u4E0B\uFF1A
   # <<TERM>>
   ## \u5B9A\u4E49
   \uFF08\u4E00\u53E5\u8BDD\u7ED9\u51FA\u6838\u5FC3\u5B9A\u4E49\uFF0C\u518D\u8865\u5145 2-3 \u53E5\u5C55\u5F00\uFF0C\u8BF4\u660E\u5176\u672C\u8D28\u7279\u5F81\uFF09
   ## \u5173\u952E\u8981\u70B9
   - \u5217\u51FA 3-6 \u4E2A\u8981\u70B9\uFF0C\u8986\u76D6\u8BE5\u672F\u8BED\u6700\u6838\u5FC3\u7684\u6027\u8D28\u3001\u7528\u9014\u6216\u4E0E\u5176\u4ED6\u6982\u5FF5\u7684\u533A\u5206
   ## \u793A\u4F8B
   - \u7ED9\u51FA 1-2 \u4E2A\u5177\u4F53\u7684\u4F8B\u5B50\u6216\u5E94\u7528\u573A\u666F\uFF0C\u5E2E\u52A9\u7406\u89E3
   ## \u6765\u6E90
   - \u6BCF\u6761\u6765\u6E90\u4E00\u884C\uFF1A- [\u6807\u9898](URL) \u2014 \u5E73\u53F0
2. \u5B9A\u4E49\u5FC5\u987B\u51C6\u786E\u3001\u57FA\u4E8E\u672C\u6B21\u8054\u7F51\u641C\u7D22\u5230\u7684\u6743\u5A01\u6765\u6E90\uFF0C\u4E0D\u8981\u51ED\u8BB0\u5FC6\u7F16\u9020\uFF1B\u82E5\u641C\u7D22\u4E0D\u5230\u53EF\u9760\u6765\u6E90\uFF0C\u660E\u786E\u8BF4\u660E\u300C\u672A\u627E\u5230\u53EF\u9760\u6765\u6E90\u300D\u3002
3. \u8BED\u8A00\u4E0E\u672F\u8BED\u4E00\u81F4\uFF1A\u672F\u8BED\u662F\u4E2D\u6587\u5C31\u7528\u4E2D\u6587\uFF0C\u662F\u82F1\u6587\u5C31\u7528\u82F1\u6587\uFF08\u4E13\u6709\u540D\u8BCD\u539F\u6587\u4FDD\u7559\uFF09\u3002
4. \u5185\u5BB9\u9762\u5411\u6210\u5E74\u5B66\u4E60\u8005\uFF0C\u8868\u8FBE\u6E05\u6670\u3001\u514B\u5236\uFF0C\u4E0D\u6DFB\u52A0\u65E0\u5173\u7684\u5BA2\u5957\u8BDD\u3002
5. \u8F93\u51FA\u5185\u5BB9\u53EA\u5305\u542B\u4E0A\u8FF0 Markdown\uFF0C\u4E0D\u8981\u989D\u5916\u7684\u524D\u8A00\u3001\u540E\u8BB0\u6216\u89E3\u91CA\u3002`;

// src/services/unicode.ts
function sanitizeUnicode(input) {
  if (!input) return input;
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      const next = input.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        out += input.charAt(i) + input.charAt(i + 1);
        i++;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 56320 && code <= 57343) {
      out += "\uFFFD";
    } else {
      out += input.charAt(i);
    }
  }
  return out;
}

// src/electron/apiHandlers.ts
function buildUrl(apiType, baseUrl, model, apiKey) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  switch (apiType) {
    case "openai-compatible":
      return `${base}/chat/completions`;
    case "anthropic":
      return `${base}/messages`;
    case "gemini":
      return `${base}/models/${model || "gemini-2.5-flash"}:generateContent?key=${encodeURIComponent(apiKey || "")}`;
    case "ollama":
      return `${base}/api/chat`;
    default:
      return `${base}/chat/completions`;
  }
}
function parseContent(apiType, data) {
  switch (apiType) {
    case "openai-compatible":
      return {
        content: data.choices?.[0]?.message?.content || "",
        usage: data.usage ? { promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0 } : void 0
      };
    case "anthropic":
      return {
        content: data.content?.[0]?.text || "",
        usage: data.usage ? { promptTokens: data.usage.input_tokens || 0, completionTokens: data.usage.output_tokens || 0 } : void 0
      };
    case "gemini":
      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
        usage: data.usageMetadata ? { promptTokens: data.usageMetadata.promptTokenCount || 0, completionTokens: data.usageMetadata.candidatesTokenCount || 0 } : void 0
      };
    case "ollama":
      return {
        content: data.message?.content || "",
        usage: data.prompt_eval_count !== void 0 ? { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 } : void 0
      };
    default:
      return { content: "" };
  }
}
function buildBody(apiType, model, systemPrompt, userInput, temperature, maxTokens, apiKey, outputSchema, tools, messages) {
  const headers = { "Content-Type": "application/json" };
  systemPrompt = sanitizeUnicode(systemPrompt);
  userInput = sanitizeUnicode(userInput);
  if (Array.isArray(messages)) {
    messages = messages.map((m) => ({ ...m, content: sanitizeUnicode(m?.content || "") }));
  }
  switch (apiType) {
    case "openai-compatible": {
      headers["Authorization"] = `Bearer ${apiKey}`;
      const msgs = [{ role: "system", content: systemPrompt }];
      if (messages && Array.isArray(messages)) {
        for (const m of messages) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      msgs.push({ role: "user", content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature,
          max_tokens: maxTokens,
          ...tools && tools.length ? { tools, tool_choice: "auto" } : {},
          ...outputSchema ? { response_format: { type: "json_object" } } : {}
        }),
        headers
      };
    }
    case "anthropic": {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      let combinedUserInput = userInput;
      if (messages && Array.isArray(messages)) {
        const historyText = messages.map((m) => `${m.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}: ${m.content}`).join("\n");
        combinedUserInput = `${historyText}
\u7528\u6237: ${userInput}`;
      }
      return {
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: "user", content: combinedUserInput }],
          max_tokens: maxTokens,
          temperature
        }),
        headers
      };
    }
    case "gemini": {
      let combinedInput = `${systemPrompt}

`;
      if (messages && Array.isArray(messages)) {
        const historyText = messages.map((m) => `${m.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}: ${m.content}`).join("\n");
        combinedInput += `${historyText}
`;
      }
      combinedInput += `\u7528\u6237\u8F93\u5165\uFF1A${userInput}`;
      return {
        body: JSON.stringify({
          contents: [{ parts: [{ text: combinedInput }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens }
        }),
        headers
      };
    }
    case "ollama": {
      const msgs = [{ role: "system", content: systemPrompt }];
      if (messages && Array.isArray(messages)) {
        for (const m of messages) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      msgs.push({ role: "user", content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          stream: false,
          options: { temperature, num_predict: maxTokens }
        }),
        headers
      };
    }
    default:
      throw new Error(`Unsupported API type: ${apiType}`);
  }
}
function buildProbeUrl(apiType, baseUrl, apiKey, model) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  switch (apiType) {
    case "openai-compatible":
      return `${base}/models`;
    case "anthropic":
      return `${base}/models`;
    case "gemini":
      return `${base}/v1beta/models?key=${encodeURIComponent(apiKey || "")}`;
    case "ollama":
      return `${base}/api/tags`;
    default:
      return `${base}/models`;
  }
}
async function probeLlmRequest(req) {
  const apiType = req.provider.apiType;
  const model = req.provider.selectedModel || req.provider.models[0] || "gemini-2.5-flash";
  const url = buildProbeUrl(apiType, req.provider.baseUrl, req.provider.apiKey, model);
  const headers = { "Content-Type": "application/json" };
  if (apiType === "openai-compatible") headers["Authorization"] = `Bearer ${req.provider.apiKey}`;
  else if (apiType === "anthropic") {
    headers["x-api-key"] = req.provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  try {
    const resp = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8e3) });
    return resp.ok;
  } catch {
    return false;
  }
}
async function proxyLlmRequest(req) {
  const apiType = req.provider.apiType;
  const model = req.provider.selectedModel || req.provider.models[0] || "gemini-2.5-flash";
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const { body, headers } = buildBody(
    apiType,
    model,
    req.systemPrompt,
    req.userInput,
    req.temperature,
    req.maxTokens,
    req.provider.apiKey,
    req.outputSchema,
    req.tools,
    req.messages
  );
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(18e4)
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`LLM \u8BF7\u6C42\u5931\u8D25 (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  const { content, usage } = parseContent(apiType, data);
  let parsedJson;
  if (content) {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsedJson = JSON.parse(jsonMatch?.[1]?.trim() || content);
    } catch {
      parsedJson = void 0;
    }
  }
  return { content, parsedJson, usage };
}
async function streamLlmRequest(req, onChunk) {
  const apiType = req.provider.apiType;
  if (apiType !== "openai-compatible" && apiType !== "ollama") {
    const resp = await proxyLlmRequest(req);
    if (resp.content) onChunk({ type: "content", text: resp.content });
    return;
  }
  const model = req.provider.selectedModel || req.provider.models[0] || "gemini-2.5-flash";
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const headers = { "Content-Type": "application/json" };
  let body;
  const sysPrompt = sanitizeUnicode(req.systemPrompt);
  const usrInput = sanitizeUnicode(req.userInput);
  if (apiType === "openai-compatible") {
    headers["Authorization"] = `Bearer ${req.provider.apiKey}`;
    body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: usrInput }
      ],
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      ...req.outputSchema ? { response_format: { type: "json_object" } } : {}
    });
  } else {
    body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: usrInput }
      ],
      stream: true,
      options: { temperature: req.temperature, num_predict: req.maxTokens }
    });
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(9e4)
  });
  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`LLM \u6D41\u5F0F\u8BF7\u6C42\u5931\u8D25 (${response.status}): ${errorText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim() || !line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        const reasoning = delta?.reasoning_content || "";
        if (reasoning) onChunk({ type: "reasoning", text: reasoning });
        const content = delta?.content || parsed.message?.content || "";
        if (content) onChunk({ type: "content", text: content });
      } catch {
      }
    }
  }
}
async function segmentText(req) {
  const llmReq = {
    provider: {
      apiType: req.provider.apiType,
      baseUrl: req.provider.baseUrl,
      apiKey: req.provider.apiKey,
      selectedModel: req.provider.selectedModel,
      models: req.provider.models
    },
    systemPrompt: TEXT_SEGMENTATION_PROMPT,
    userInput: `\u3010\u7B14\u8BB0\u6807\u9898\u3011: ${req.noteTitle || "\u672A\u547D\u540D\u7B14\u8BB0"}
\u3010\u5DF2\u6709\u7B14\u8BB0\u8282\u70B9\u5217\u8868\u3011: ${req.existingNotes.join(", ") || "\u65E0"}

\u3010\u5F85\u5206\u6790\u957F\u6587\u672C\u3011:
${req.text}`,
    temperature: 0.5,
    maxTokens: 8192,
    outputSchema: {}
  };
  const resp = await proxyLlmRequest(llmReq);
  return resp.parsedJson || {};
}
async function autoLink(req) {
  let updatedContent = req.content;
  const addedLinks = [];
  for (const title of req.existingNoteTitles) {
    if (!title || title.trim().length === 0) continue;
    const regex = new RegExp(`(?<!\\[\\[)${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\]\\])`, "g");
    if (regex.test(updatedContent)) {
      updatedContent = updatedContent.replace(regex, `[[${title}]]`);
      addedLinks.push(title);
    }
  }
  return { updatedContent, addedLinks };
}
function parseResourcesFromMarkdown(md) {
  const resources = [];
  const lines = md.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s*\[([^\]]+)\]\(((?:https?:\/\/)[^)\s]+)\)(?:\s*[—\-–]\s*(.+))?$/);
    if (!match) continue;
    const title = match[1].trim();
    const url = match[2].trim();
    const platform = match[3]?.trim() || void 0;
    if (!title || !url) continue;
    resources.push({ title, url, platform });
  }
  return resources;
}
async function deepSeekWebSearch(markdownPrompt, provider) {
  const baseUrl = (provider.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = provider.model || "deepseek-chat";
  const safePrompt = sanitizeUnicode(markdownPrompt);
  const resp = await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + provider.apiKey },
    body: JSON.stringify({ model, input: safePrompt, tools: [{ type: "web_search" }] }),
    signal: AbortSignal.timeout(18e4)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new Error("DeepSeek \u8BF7\u6C42\u5931\u8D25: " + errText.slice(0, 300));
  }
  const data = await resp.json();
  let final = "";
  let fallback = "";
  for (const item of data.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      const text = typeof c.text === "string" ? c.text : "";
      if (!text) continue;
      if (item.phase === "final_answer") final += text;
      else fallback += text;
    }
  }
  return final.trim() || fallback;
}
async function resourceSearch(req) {
  const provider = req.provider;
  if (!provider.apiKey) {
    throw new Error("\u672A\u914D\u7F6E DeepSeek API Key\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E");
  }
  const model = provider.selectedModel || provider.models?.[0] || "deepseek-chat";
  const prompt = RESOURCE_SEARCH_PROMPT.replace(/<<TITLE>>/g, req.title.trim()).replace(/<<PATH_TEXT>>/g, req.pathText);
  const markdown = await deepSeekWebSearch(prompt, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model
  });
  if (!markdown) {
    throw new Error("\u672A\u80FD\u83B7\u53D6\u5230\u63A8\u8350\u5185\u5BB9");
  }
  const resources = parseResourcesFromMarkdown(markdown);
  return { markdown, resources };
}
async function conceptGeneration(req) {
  const provider = req.provider;
  if (!provider.apiKey) {
    throw new Error("\u672A\u914D\u7F6E DeepSeek API Key\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E");
  }
  const model = provider.selectedModel || provider.models?.[0] || "deepseek-chat";
  const prompt = CONCEPT_GENERATION_PROMPT.replace(/<<TERM>>/g, req.term.trim());
  const markdown = await deepSeekWebSearch(prompt, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model
  });
  if (!markdown) {
    throw new Error("\u672A\u80FD\u83B7\u53D6\u5230\u6982\u5FF5\u5185\u5BB9");
  }
  return { content: markdown };
}

// src/electron/noteRag.ts
var import_fs2 = require("fs");
var import_path2 = __toESM(require("path"), 1);
var dataRoot2 = "";
function setNoteRagDataRoot(root) {
  dataRoot2 = root;
}
function dbFile() {
  return import_path2.default.join(dataRoot2, "note-embeddings.json");
}
async function readAll() {
  try {
    const text = await import_fs2.promises.readFile(dbFile(), "utf-8");
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function writeAll(records) {
  await import_fs2.promises.mkdir(import_path2.default.dirname(dbFile()), { recursive: true });
  await import_fs2.promises.writeFile(dbFile(), JSON.stringify(records), "utf-8");
}
var PLACEHOLDER_CONTENTS = /* @__PURE__ */ new Set(["\u8BF7\u5BF9\u8BE5\u77E5\u8BC6\u70B9\u8FDB\u884C\u5B9A\u4E49\u63CF\u8FF0"]);
function cleanForEmbedding(c) {
  return (c || "").replace(/<[^>]+>/g, " ").replace(/data:image\/[^)\s]+/g, " ").replace(/\s+/g, " ").trim();
}
function buildEmbeddingText(title, content) {
  const body = cleanForEmbedding(content);
  const truncated = body.length > 800 ? body.slice(0, 800) : body;
  return `${title}
${truncated}`;
}
function hasSubstantiveContent(content) {
  const raw = (content || "").trim();
  if (!raw) return false;
  if (PLACEHOLDER_CONTENTS.has(raw)) return false;
  return cleanForEmbedding(raw).length >= 2;
}
async function indexNote(input) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.noteId === input.id);
  if (!hasSubstantiveContent(input.content)) {
    if (idx !== -1) {
      records.splice(idx, 1);
      await writeAll(records);
    }
    return;
  }
  const text = buildEmbeddingText(input.title, input.content);
  const embedding = await generateEmbedding(text);
  if (!embedding || embedding.length === 0) {
    console.warn("[note-rag] \u5D4C\u5165\u751F\u6210\u5931\u8D25\uFF0C\u8DF3\u8FC7\u7D22\u5F15:", input.title);
    return;
  }
  const record = {
    noteId: input.id,
    title: input.title,
    text,
    snippet: text.slice(0, 200),
    embedding,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (idx !== -1) records[idx] = record;
  else records.push(record);
  await writeAll(records);
}
async function indexNotes(inputs) {
  for (const input of inputs) {
    try {
      await indexNote(input);
    } catch (e) {
      console.warn("[note-rag] \u7D22\u5F15\u5931\u8D25:", input.title, e);
    }
  }
}
async function deleteNoteIndex(noteId) {
  const records = await readAll();
  await writeAll(records.filter((r) => r.noteId !== noteId));
}
async function searchNotes(query, k = 5) {
  const q = (query || "").trim();
  if (!q) return [];
  const records = await readAll();
  if (records.length === 0) return [];
  const qv = await generateEmbedding(q);
  if (!qv || qv.length === 0) return [];
  const queryTokens = tokenize(q);
  const texts = records.map((r) => r.text);
  const df = buildDf(texts);
  const lens = texts.map((t) => Math.max(tokenize(t).length, 1));
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(records.length, 1);
  const sparse = records.map(
    (r) => bm25Score(queryTokens, r.text, df, records.length, avgLen)
  );
  const dense = records.map((r) => cosineSimilarity(qv, r.embedding));
  const SEMANTIC_THRESHOLD = 0.25;
  const survivors = records.map((r, i) => ({ r, dense: dense[i], sparse: sparse[i] })).filter((x) => x.dense >= SEMANTIC_THRESHOLD || x.sparse > 0);
  if (survivors.length === 0) return [];
  const fused = weightedFusion(
    survivors.map((x) => ({ id: x.r.noteId, dense: x.dense, sparse: x.sparse })),
    0.35
  );
  const qCompact = q.replace(/\s+/g, "");
  return survivors.map((x) => {
    const textCompact = x.r.text.replace(/\s+/g, "");
    const bonus = qCompact.length >= 2 && textCompact.includes(qCompact) ? 0.5 : 0;
    return {
      noteId: x.r.noteId,
      title: x.r.title,
      score: x.dense,
      snippet: x.r.snippet,
      fusedScore: (fused.get(x.r.noteId) || 0) + bonus
    };
  }).sort((a, b) => b.fusedScore - a.fusedScore).slice(0, k).map(({ noteId, title, score, snippet }) => ({ noteId, title, score, snippet }));
}

// src/electron/main.ts
var sttProcess = null;
var sttPort = 0;
var mainWindow = null;
var vectorizationQueue = [];
var vectorizing = false;
function notifyRagChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("rag-docs:changed");
  }
}
async function processOneVectorization(docId) {
  if (!await documentExists(docId)) {
    await deleteChunksFile(docId);
    return;
  }
  const manifest = await readManifest();
  const doc = manifest.find((d) => d.id === docId);
  if (!doc) return;
  await updateManifest(docId, { status: "processing", chunkCount: 0, totalChars: 0 });
  notifyRagChanged();
  try {
    const ext = doc.fileType === "md" ? ".md" : doc.fileType === "txt" ? ".txt" : ".pdf";
    const srcPath = import_path3.default.join(await getDocumentsDir(), storedFileName(docId, ext));
    let text = "";
    if (doc.fileType === "pdf") {
      text = await extractPdfText(srcPath);
    } else {
      text = await import_promises2.default.readFile(srcPath, "utf-8");
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(
        doc.fileType === "pdf" ? "\u8BE5 PDF \u53EF\u80FD\u4E3A\u626B\u63CF\u4EF6\u6216\u65E0\u53EF\u62BD\u53D6\u6587\u672C\u5C42\uFF0C\u6682\u4E0D\u652F\u6301 OCR" : "\u6587\u6863\u5185\u5BB9\u4E3A\u7A7A"
      );
    }
    const chunks = await vectorizeDocument(docId, doc.fileName, trimmed);
    if (chunks.length === 0) {
      throw new Error("\u672A\u751F\u6210\u6709\u6548\u5206\u5757");
    }
    await writeChunksFile(docId, chunks);
    await updateManifest(docId, {
      status: "ready",
      chunkCount: chunks.length,
      totalChars: trimmed.length,
      error: void 0
    });
  } catch (e) {
    console.warn("[rag] \u5411\u91CF\u5316\u5931\u8D25:", doc.fileName, e?.message);
    await updateManifest(docId, { status: "failed", error: e?.message || "\u5411\u91CF\u5316\u5931\u8D25" });
  }
  notifyRagChanged();
}
async function drainVectorizationQueue() {
  if (vectorizing) return;
  vectorizing = true;
  try {
    while (vectorizationQueue.length > 0) {
      const docId = vectorizationQueue.shift();
      if (docId) {
        try {
          await processOneVectorization(docId);
        } catch (e) {
          console.warn("[rag] \u961F\u5217\u5904\u7406\u5F02\u5E38:", e);
        }
      }
    }
  } finally {
    vectorizing = false;
  }
}
function enqueueVectorization(docId) {
  vectorizationQueue.push(docId);
  void drainVectorizationQueue();
}
function detectFileType(fileName) {
  const ext = import_path3.default.extname(fileName).toLowerCase();
  if (ext === ".txt") return "txt";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".pdf") return "pdf";
  return null;
}
function storedFileName(id, ext) {
  return `${id}${ext}`;
}
async function recoverProcessingDocs() {
  try {
    const manifest = await readManifest();
    for (const d of manifest) {
      if (d.status === "processing") {
        await updateManifest(d.id, { status: "pending" });
        enqueueVectorization(d.id);
      }
    }
  } catch (e) {
    console.warn("[rag] \u542F\u52A8\u6062\u590D\u626B\u63CF\u5931\u8D25:", e);
  }
}
var ANCHOR_DIR = import_path3.default.join(import_os.default.homedir(), ".logi-note");
var ANCHOR_FILE = import_path3.default.join(ANCHOR_DIR, "storage-config.json");
function readAnchorConfig() {
  try {
    return JSON.parse((0, import_fs3.readFileSync)(ANCHOR_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveAnchorConfig(dataRoot3) {
  (0, import_fs3.mkdirSync)(ANCHOR_DIR, { recursive: true });
  (0, import_fs3.writeFileSync)(ANCHOR_FILE, JSON.stringify({ dataRoot: dataRoot3 }, null, 2), "utf-8");
}
function applyCustomUserDataPath() {
  const cfg = readAnchorConfig();
  if (cfg.dataRoot && typeof cfg.dataRoot === "string" && cfg.dataRoot.trim()) {
    try {
      import_electron.app.setPath("userData", import_path3.default.resolve(cfg.dataRoot.trim()));
    } catch (e) {
      console.warn("[storage] \u8BBE\u7F6E\u81EA\u5B9A\u4E49\u6570\u636E\u8DEF\u5F84\u5931\u8D25:", e);
    }
  }
}
applyCustomUserDataPath();
function getDataRoot() {
  return import_electron.app.getPath("userData");
}
var vaultRoot = "";
function getVaultRoot() {
  if (!vaultRoot) {
    vaultRoot = import_path3.default.join(getDataRoot(), "vault");
  }
  return vaultRoot;
}
async function ensureVaultDir() {
  const root = getVaultRoot();
  await import_promises2.default.mkdir(root, { recursive: true });
  await import_promises2.default.mkdir(import_path3.default.join(root, "notes"), { recursive: true });
  return root;
}
function getUserStateDir() {
  return import_path3.default.join(getDataRoot(), "user-state");
}
function isSubPath(child, parent) {
  const rel = import_path3.default.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !import_path3.default.isAbsolute(rel);
}
async function copyDirBestEffort(src, dst, isTop = true) {
  await import_promises2.default.mkdir(dst, { recursive: true });
  let entries = [];
  try {
    const list = await import_promises2.default.readdir(src, { withFileTypes: true });
    entries = list.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    return;
  }
  for (const ent of entries) {
    const s = import_path3.default.join(src, ent.name);
    const d = import_path3.default.join(dst, ent.name);
    if (isTop && isSubPath(d, src)) continue;
    try {
      if (ent.isDirectory) {
        await copyDirBestEffort(s, d, false);
      } else {
        await import_promises2.default.copyFile(s, d);
      }
    } catch {
    }
  }
}
async function migrateDataTo(oldRoot, newRoot) {
  if (isSubPath(newRoot, oldRoot)) {
    throw new Error("\u76EE\u6807\u6587\u4EF6\u5939\u4E0D\u80FD\u4F4D\u4E8E\u5F53\u524D\u6570\u636E\u76EE\u5F55\u5185\uFF0C\u8BF7\u9009\u62E9\u5176\u5B83\u4F4D\u7F6E");
  }
  await copyDirBestEffort(oldRoot, newRoot);
}
async function ensureUserStateDir() {
  const dir = getUserStateDir();
  await import_promises2.default.mkdir(dir, { recursive: true });
  return dir;
}
async function readUserStateFileIfExists(fileName) {
  try {
    return await import_promises2.default.readFile(import_path3.default.join(getUserStateDir(), fileName), "utf-8");
  } catch {
    return null;
  }
}
async function writeUserStateFile(fileName, content) {
  await ensureUserStateDir();
  await import_promises2.default.writeFile(import_path3.default.join(getUserStateDir(), fileName), content, "utf-8");
}
async function loadMergedNotes() {
  await ensureVaultDir();
  const root = getVaultRoot();
  let contentNotes = [];
  try {
    const metaText = await import_promises2.default.readFile(import_path3.default.join(root, "metadata.json"), "utf-8");
    const notesDir = import_path3.default.join(root, "notes");
    const files = await import_promises2.default.readdir(notesDir);
    const mdMap = /* @__PURE__ */ new Map();
    for (const f of files) {
      if (f.endsWith(".md")) {
        mdMap.set(f, await import_promises2.default.readFile(import_path3.default.join(notesDir, f), "utf-8"));
      }
    }
    contentNotes = deserializeVault(metaText, mdMap);
  } catch {
    return [];
  }
  let needsMigration = false;
  for (const n of contentNotes) {
    if (hasAnyUserState(splitUserStateFields(n))) {
      needsMigration = true;
      break;
    }
  }
  const stateText = await readUserStateFileIfExists(USER_STATE_FILES.noteStates);
  let noteStates = stateText ? deserializeUserStateFile(stateText) : {};
  if (needsMigration) {
    const mergedStates = {};
    for (const n of contentNotes) {
      const st = splitUserStateFields(n);
      if (hasAnyUserState(st)) mergedStates[n.id] = st;
    }
    noteStates = { ...noteStates, ...mergedStates };
    await writeUserStateFile(USER_STATE_FILES.noteStates, serializeUserStateFile(noteStates));
    const sharable = contentNotes.map(splitSharableFields);
    await import_promises2.default.writeFile(import_path3.default.join(root, "metadata.json"), serializeMetadata(sharable), "utf-8");
    contentNotes = sharable;
  }
  return contentNotes.map((n) => mergeNote(n, noteStates[n.id]));
}
function resolveModelsDir() {
  return import_electron.app.isPackaged ? import_path3.default.join(process.resourcesPath, "models") : import_path3.default.join(import_electron.app.getAppPath(), "models");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = import_net.default.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
async function spawnSttServer() {
  const isPackaged = import_electron.app.isPackaged;
  const modelsDir2 = resolveModelsDir();
  const logPath = import_path3.default.join(getDataRoot(), "stt_server.log");
  try {
    sttPort = await getFreePort();
  } catch (e) {
    console.warn("[stt] \u83B7\u53D6\u7A7A\u95F2\u7AEF\u53E3\u5931\u8D25\uFF0C\u4F7F\u7528\u9ED8\u8BA4 8765:", e);
    sttPort = 8765;
  }
  let logFd = null;
  try {
    logFd = (0, import_fs3.openSync)(logPath, "a");
  } catch (e) {
    console.warn("[stt] \u6253\u5F00\u65E5\u5FD7\u6587\u4EF6\u5931\u8D25\uFF0C\u6539\u7528\u5FFD\u7565\u8F93\u51FA:", e);
    logFd = null;
  }
  try {
    const env = { ...process.env, LOGINOTE_MODELS_DIR: modelsDir2 };
    const stdio = logFd !== null ? ["ignore", logFd, logFd] : ["ignore", "ignore", "ignore"];
    let child;
    if (isPackaged) {
      const sttExe = import_path3.default.join(process.resourcesPath, "stt_server", "stt_server.exe");
      child = (0, import_child_process2.spawn)(sttExe, ["--port", String(sttPort)], { env, stdio, windowsHide: true });
    } else {
      const sttScript = import_path3.default.join(import_electron.app.getAppPath(), "python", "stt_server.py");
      child = (0, import_child_process2.spawn)("python", [sttScript, "--port", String(sttPort)], { env, stdio, windowsHide: true });
    }
    sttProcess = child;
    if (logFd !== null) {
      try {
        (0, import_fs3.closeSync)(logFd);
      } catch {
      }
    }
    child.on("error", (err) => {
      console.warn("[stt] STT \u540E\u7AEF\u542F\u52A8\u5931\u8D25:", err.message);
      sttProcess = null;
    });
    child.on("exit", (code) => {
      console.log("[stt] STT \u540E\u7AEF\u9000\u51FA\uFF0Ccode =", code);
      sttProcess = null;
    });
  } catch (e) {
    console.warn("[stt] spawn \u5F02\u5E38:", e);
  }
}
function registerIpcHandlers() {
  import_electron.ipcMain.handle("open-external", (_e, url) => import_electron.shell.openExternal(url));
  import_electron.ipcMain.handle("llm:request", async (_e, req) => proxyLlmRequest(req));
  import_electron.ipcMain.handle("llm:probe", async (_e, req) => probeLlmRequest(req));
  import_electron.ipcMain.handle("llm:stream-start", async (_e, req) => {
    const sender = _e.sender;
    const streamId = `llm-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    void streamLlmRequest(req, (chunk) => {
      if (!sender.isDestroyed()) {
        sender.send("llm:stream-chunk", { streamId, chunk });
      }
    }).then(() => {
      if (!sender.isDestroyed()) sender.send("llm:stream-end", { streamId });
    }).catch((err) => {
      if (!sender.isDestroyed()) sender.send("llm:stream-error", { streamId, message: err.message || "\u6D41\u5F0F\u8BF7\u6C42\u5931\u8D25" });
    });
    return streamId;
  });
  import_electron.ipcMain.handle("ai:segment", async (_e, req) => segmentText(req));
  import_electron.ipcMain.handle("ai:auto-link", async (_e, req) => autoLink(req));
  import_electron.ipcMain.handle("ai:resource-search", async (_e, req) => resourceSearch(req));
  import_electron.ipcMain.handle("ai:concept-generation", async (_e, req) => conceptGeneration(req));
  import_electron.ipcMain.handle("data:open-folder", async () => {
    try {
      const dir = getDataRoot();
      const err = await import_electron.shell.openPath(dir);
      return { ok: !err, error: err || void 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  import_electron.ipcMain.handle("analysis:export", async (_e, content, fileName) => {
    try {
      const md = typeof content === "string" ? content : "";
      if (!md) return { ok: false, error: "\u5BFC\u51FA\u5185\u5BB9\u4E3A\u7A7A" };
      const name = typeof fileName === "string" && fileName.trim() ? fileName.trim().replace(/[\\/:*?"<>|]/g, "_") : "\u5206\u6790\u62A5\u544A.md";
      const baseName = name.endsWith(".md") ? name : `${name}.md`;
      const res = await import_electron.dialog.showOpenDialog({
        title: "\u9009\u62E9\u5BFC\u51FA\u76EE\u5F55\uFF08\u5C06\u751F\u6210 AnalysisResult \u6587\u4EF6\u5939\uFF09",
        properties: ["openDirectory", "createDirectory"]
      });
      if (res.canceled || res.filePaths.length === 0) return { ok: false, error: "\u5DF2\u53D6\u6D88" };
      const analysisDir = import_path3.default.join(res.filePaths[0], "AnalysisResult");
      await import_promises2.default.mkdir(analysisDir, { recursive: true });
      const targetPath = import_path3.default.join(analysisDir, baseName);
      await import_promises2.default.writeFile(targetPath, md, "utf-8");
      return { ok: true, path: targetPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  import_electron.ipcMain.handle("storage:get-root", async () => ({
    root: getDataRoot(),
    custom: !!readAnchorConfig().dataRoot
  }));
  import_electron.ipcMain.handle("storage:choose-folder", async () => {
    const res = await import_electron.dialog.showOpenDialog({
      title: "\u9009\u62E9\u6570\u636E\u5B58\u50A8\u6587\u4EF6\u5939\uFF08\u5EFA\u8BAE\u9009\u975E\u7CFB\u7EDF\u76D8\uFF0C\u5982 D \u76D8\uFF09",
      properties: ["openDirectory", "createDirectory"]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
  import_electron.ipcMain.handle("resource:choose-local-files", async () => {
    const res = await import_electron.dialog.showOpenDialog({
      title: "\u9009\u62E9\u672C\u5730\u5B66\u4E60\u8D44\u6E90",
      properties: ["openFile", "multiSelections"]
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });
  import_electron.ipcMain.handle("storage:set-root", async (_e, newRoot, migrate) => {
    try {
      const target = typeof newRoot === "string" && newRoot.trim() ? import_path3.default.resolve(newRoot.trim()) : "";
      if (!target) return { ok: false, error: "\u76EE\u6807\u8DEF\u5F84\u65E0\u6548" };
      const oldRoot = getDataRoot();
      if (target === oldRoot) return { ok: true };
      if (migrate) {
        await migrateDataTo(oldRoot, target);
      } else {
        await import_promises2.default.mkdir(target, { recursive: true });
      }
      saveAnchorConfig(target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  import_electron.ipcMain.handle("storage:reset", async () => {
    try {
      const root = getDataRoot();
      await import_promises2.default.rm(import_path3.default.join(root, "vault"), { recursive: true, force: true });
      await import_promises2.default.rm(import_path3.default.join(root, "user-state"), { recursive: true, force: true });
      try {
        await import_electron.session.defaultSession.clearStorageData({
          storages: ["localstorage", "indexdb", "cachestorage", "websql", "serviceworkers", "shadercache"]
        });
        await import_electron.session.defaultSession.clearCache();
      } catch (e) {
        console.warn("[storage] \u6E05\u7406\u6D4F\u89C8\u5668\u5B58\u50A8\u5931\u8D25\uFF08\u53EF\u5FFD\u7565\uFF09:", e);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  import_electron.ipcMain.handle("vault:load", async () => {
    return loadMergedNotes();
  });
  import_electron.ipcMain.handle("vault:save", async (_e, notes) => {
    const noteList = notes || [];
    const root = await ensureVaultDir();
    const sharable = noteList.map(splitSharableFields);
    const notesDir = import_path3.default.join(root, "notes");
    await import_promises2.default.writeFile(import_path3.default.join(root, "metadata.json"), serializeMetadata(sharable), "utf-8");
    const existing = await import_promises2.default.readdir(notesDir);
    for (const f of existing) {
      if (f.endsWith(".md")) {
        await import_promises2.default.unlink(import_path3.default.join(notesDir, f));
      }
    }
    const mdMap = markdownFileMap(sharable);
    for (const [file, content] of mdMap) {
      await import_promises2.default.writeFile(import_path3.default.join(notesDir, file), content, "utf-8");
    }
    const noteStates = {};
    for (const n of noteList) {
      const st = splitUserStateFields(n);
      if (hasAnyUserState(st)) noteStates[n.id] = st;
    }
    await writeUserStateFile(USER_STATE_FILES.noteStates, serializeUserStateFile(noteStates));
  });
  import_electron.ipcMain.handle("vault:get-root", async () => getVaultRoot());
  import_electron.ipcMain.handle("user-state:load-profile", async () => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.profile);
    return text ? deserializeProfileState(text) : null;
  });
  import_electron.ipcMain.handle("user-state:save-profile", async (_e, profile, conceptAliasMap) => {
    await writeUserStateFile(USER_STATE_FILES.profile, serializeProfileState(profile, conceptAliasMap || {}));
  });
  import_electron.ipcMain.handle("user-state:load-settings", async () => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.settings);
    return text ? deserializeSettingsState(text) : null;
  });
  import_electron.ipcMain.handle("user-state:save-settings", async (_e, settings) => {
    await writeUserStateFile(USER_STATE_FILES.settings, serializeSettingsState(settings));
  });
  import_electron.ipcMain.handle("user-state:load-llm", async () => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.llm);
    return text ? deserializeLlmState(text) : null;
  });
  import_electron.ipcMain.handle("user-state:save-llm", async (_e, settings) => {
    await writeUserStateFile(USER_STATE_FILES.llm, serializeLlmState(settings));
  });
  import_electron.ipcMain.handle("user-state:load-mastery-timeline", async () => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.masteryTimeline);
    return text ? deserializeMasteryTimelineState(text) : null;
  });
  import_electron.ipcMain.handle("user-state:save-mastery-timeline", async (_e, file) => {
    await writeUserStateFile(USER_STATE_FILES.masteryTimeline, serializeMasteryTimelineState(file));
  });
  import_electron.ipcMain.handle("user-state:get-root", async () => getUserStateDir());
  import_electron.ipcMain.handle("stt:status", () => ({
    running: sttProcess !== null && sttProcess.exitCode === null
  }));
  import_electron.ipcMain.handle("stt:get-port", () => sttPort);
  import_electron.ipcMain.handle("ragDocs:choose-files", async () => {
    const res = await import_electron.dialog.showOpenDialog({
      title: "\u9009\u62E9\u8D44\u6599\u6587\u6863\uFF08txt / md / pdf\uFF09",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "\u652F\u6301\u7684\u6587\u6863", extensions: ["txt", "md", "markdown", "pdf"] },
        { name: "\u6240\u6709\u6587\u4EF6", extensions: ["*"] }
      ]
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });
  import_electron.ipcMain.handle("ragDocs:upload", async (_e, filePaths) => {
    try {
      const paths = Array.isArray(filePaths) ? filePaths.filter((p) => typeof p === "string") : [];
      if (paths.length === 0) return { ok: false, error: "\u672A\u9009\u62E9\u6587\u4EF6" };
      const docsDir = await getDocumentsDir();
      const created = [];
      for (const src of paths) {
        const fileName = import_path3.default.basename(src);
        const type = detectFileType(fileName);
        if (!type) {
          console.warn("[rag] \u8DF3\u8FC7\u4E0D\u652F\u6301\u7684\u683C\u5F0F:", fileName);
          continue;
        }
        const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ext = import_path3.default.extname(fileName).toLowerCase() || (type === "md" ? ".md" : type === "txt" ? ".txt" : ".pdf");
        const stored = storedFileName(id, ext);
        await import_promises2.default.copyFile(src, import_path3.default.join(docsDir, stored));
        const stat = await import_promises2.default.stat(src);
        const doc = {
          id,
          fileName,
          fileType: type,
          size: stat.size,
          status: "pending",
          chunkCount: 0,
          totalChars: 0,
          uploadAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        created.push(doc);
      }
      if (created.length === 0) return { ok: false, error: "\u6CA1\u6709\u53EF\u4E0A\u4F20\u7684\u6587\u6863\uFF08\u4EC5\u652F\u6301 txt / md / pdf\uFF09" };
      const all = await upsertManifestEntries(created);
      created.forEach((d) => enqueueVectorization(d.id));
      notifyRagChanged();
      return { ok: true, documents: all };
    } catch (e) {
      return { ok: false, error: e?.message || "\u4E0A\u4F20\u5931\u8D25" };
    }
  });
  import_electron.ipcMain.handle("ragDocs:list", async () => readManifest());
  import_electron.ipcMain.handle("ragDocs:status", async (_e, docId) => {
    const docs = await readManifest();
    const d = docs.find((x) => x.id === docId);
    if (!d) return { status: "failed", chunkCount: 0, totalChars: 0, error: "\u6587\u6863\u4E0D\u5B58\u5728" };
    return { status: d.status, chunkCount: d.chunkCount, totalChars: d.totalChars, error: d.error };
  });
  import_electron.ipcMain.handle("ragDocs:retry", async (_e, docId) => {
    await updateManifest(docId, { status: "pending", error: void 0 });
    enqueueVectorization(docId);
    notifyRagChanged();
  });
  import_electron.ipcMain.handle("ragDocs:delete", async (_e, docId) => {
    const docs = await readManifest();
    const d = docs.find((x) => x.id === docId);
    if (d) {
      const ext = d.fileType === "md" ? ".md" : d.fileType === "txt" ? ".txt" : ".pdf";
      try {
        await import_promises2.default.unlink(import_path3.default.join(await getDocumentsDir(), storedFileName(docId, ext)));
      } catch {
      }
    }
    await deleteChunksFile(docId);
    await deleteManifestEntry(docId);
    notifyRagChanged();
  });
  import_electron.ipcMain.handle("ragDocs:search", async (_e, query, k) => {
    return searchDocuments(query, typeof k === "number" ? k : 5);
  });
  import_electron.ipcMain.handle("noteRag:index", async (_e, input) => {
    await indexNote(input);
  });
  import_electron.ipcMain.handle("noteRag:index-all", async (_e, inputs) => {
    await indexNotes(inputs);
  });
  import_electron.ipcMain.handle("noteRag:delete", async (_e, noteId) => {
    await deleteNoteIndex(noteId);
  });
  import_electron.ipcMain.handle("noteRag:search", async (_e, query, k) => {
    return searchNotes(query, typeof k === "number" ? k : 5);
  });
  import_electron.ipcMain.handle("updater:get-version", () => import_electron.app.getVersion());
  import_electron.ipcMain.handle("updater:check", async () => {
    try {
      const result = await import_electron_updater.autoUpdater.checkForUpdates();
      return { ok: true, message: result?.updateInfo?.version ? `\u53D1\u73B0\u65B0\u7248\u672C ${result.updateInfo.version}` : "\u5DF2\u662F\u6700\u65B0\u7248\u672C" };
    } catch (e) {
      return { ok: false, message: e?.message || "\u68C0\u67E5\u66F4\u65B0\u5931\u8D25\uFF08\u5C1A\u672A\u914D\u7F6E\u53D1\u5E03\u6E90\uFF09" };
    }
  });
  import_electron.ipcMain.handle("updater:download", async () => {
    try {
      await import_electron_updater.autoUpdater.downloadUpdate();
      return { ok: true, message: "\u66F4\u65B0\u5DF2\u5F00\u59CB\u4E0B\u8F7D" };
    } catch (e) {
      return { ok: false, message: e?.message || "\u4E0B\u8F7D\u66F4\u65B0\u5931\u8D25" };
    }
  });
  import_electron.ipcMain.handle("updater:quit-and-install", () => {
    import_electron_updater.autoUpdater.quitAndInstall(false, true);
  });
}
function registerWindowControls() {
  const winOf = (sender) => import_electron.BrowserWindow.fromWebContents(sender);
  import_electron.ipcMain.on("window:minimize", (e) => {
    winOf(e.sender)?.minimize();
  });
  import_electron.ipcMain.on("window:maximize-toggle", (e) => {
    const win = winOf(e.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  import_electron.ipcMain.on("window:close", (e) => {
    winOf(e.sender)?.close();
  });
  import_electron.ipcMain.handle("window:is-maximized", (e) => {
    return winOf(e.sender)?.isMaximized() ?? false;
  });
  import_electron.ipcMain.handle("window:get-bounds", (e) => {
    const win = winOf(e.sender);
    return win ? win.getBounds() : null;
  });
  import_electron.ipcMain.on("window:set-bounds", (e, bounds) => {
    const win = winOf(e.sender);
    if (!win || win.isMaximized()) return;
    win.setBounds(bounds);
  });
}
function createWindow() {
  const win = new import_electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1e3,
    minHeight: 620,
    frame: false,
    transparent: false,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: import_path3.default.join(import_electron.app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  const pushMaximized = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("window:maximized-changed", win.isMaximized());
    }
  };
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(import_path3.default.join(import_electron.app.getAppPath(), "dist", "index.html"));
}
function registerUpdaterEvents() {
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("updater:status", payload);
    }
  };
  import_electron_updater.autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  import_electron_updater.autoUpdater.on("update-available", (info) => send({ state: "available", version: info?.version }));
  import_electron_updater.autoUpdater.on("update-not-available", (info) => send({ state: "up-to-date", version: info?.version }));
  import_electron_updater.autoUpdater.on("download-progress", (p) => send({ state: "downloading", percent: p?.percent ?? 0 }));
  import_electron_updater.autoUpdater.on("update-downloaded", (info) => send({ state: "downloaded", version: info?.version }));
  import_electron_updater.autoUpdater.on("error", (err) => send({ state: "error", message: err?.message }));
}
import_electron.app.whenReady().then(() => {
  setDataRoot(getDataRoot());
  setModelsDir(resolveModelsDir());
  setPdfExtractScript(import_electron.app.isPackaged ? import_path3.default.join(process.resourcesPath, "python", "pdf_extract.py") : import_path3.default.join(import_electron.app.getAppPath(), "python", "pdf_extract.py"));
  setNoteRagDataRoot(getDataRoot());
  void spawnSttServer();
  registerIpcHandlers();
  registerWindowControls();
  registerUpdaterEvents();
  recoverProcessingDocs();
  createWindow();
});
import_electron.app.on("before-quit", () => {
  if (sttProcess) {
    try {
      sttProcess.kill();
    } catch {
    }
    sttProcess = null;
  }
  try {
    const flowPartition = import_electron.session.fromPartition("persist:flow-resource");
    flowPartition.clearCache().catch(() => {
    });
    flowPartition.clearStorageData().catch(() => {
    });
  } catch {
  }
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
