import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const promptPath = resolve(
  projectRoot,
  "docs/prompts/document-argument-extractor-v4.5.md",
);
const manifestPath = resolve(
  projectRoot,
  "docs/prompts/document-argument-extractor-v4.5.baseline.json",
);

const prompt = readFileSync(promptPath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  id: string;
  status: string;
  semanticNonBlankSha256: string;
  windowPolicy: {
    maximumWindowsPerBatch: number;
    wholeDocumentSingleRequest: boolean;
  };
};

const semanticText = prompt
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .join("\n");
const semanticHash = createHash("sha256")
  .update(semanticText, "utf8")
  .digest("hex")
  .toUpperCase();

assert.equal(manifest.id, "document-argument-extractor-v4.5");
assert.equal(manifest.status, "frozen-acceptance-baseline");
assert.equal(semanticHash, manifest.semanticNonBlankSha256);
assert.equal(manifest.windowPolicy.maximumWindowsPerBatch, 5);
assert.equal(manifest.windowPolicy.wholeDocumentSingleRequest, false);

for (const requiredText of [
  "role 与 relations 独立判定",
  "数据概括",
  "method_for",
  "直接来源绑定",
  "逐节点连通性",
]) {
  assert.ok(
    prompt.includes(requiredText),
    `Frozen prompt is missing required contract text: ${requiredText}`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      id: manifest.id,
      status: manifest.status,
      semanticHash,
      maximumWindowsPerBatch: manifest.windowPolicy.maximumWindowsPerBatch,
      wholeDocumentSingleRequest:
        manifest.windowPolicy.wholeDocumentSingleRequest,
    },
    null,
    2,
  ),
);
