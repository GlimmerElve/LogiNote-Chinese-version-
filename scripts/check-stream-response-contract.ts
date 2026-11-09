/** Actual collector and production ReviewChat read loops. No models or user IO. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { collectStreamResponse, type StreamChunk } from '../src/services/llmStreamService';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('The stream contract regression must never use network');
const stream = (chunks: StreamChunk[]) => new ReadableStream<StreamChunk>({ start(controller) {
  for (const chunk of chunks) controller.enqueue(chunk);
  controller.close();
} });
const calls = [{ id: 'call-read', name: 'read_synthetic_note', arguments: { id: 'synthetic-note' } }];
const diagnostics = { finishReason: 'tool_calls', responseModel: 'synthetic-stream-model' };
const checks: string[] = [];

try {
  const plainStream = stream([{ type: 'content', text: '原有' }, { type: 'content', text: '正文。' }]);
  const plain = await collectStreamResponse(plainStream);
  assert.deepEqual(plain, { content: '原有正文。', diagnostics: undefined });
  assert.deepEqual(Object.keys(plain), ['content', 'diagnostics']);
  assert.equal(plainStream.locked, false);
  checks.push('ordinary text keeps its original return shape and releases the reader');

  const chunks: StreamChunk[] = [
    { type: 'activity', text: 'ACTIVITY_IS_NOT_CONTENT', activity: { phase: 'reasoning' } },
    { type: 'content', text: '先查阅' },
    { type: 'response', text: 'METADATA_IS_NOT_CONTENT', toolCalls: calls, toolContinuationId: 'opaque-synthetic-id' },
    { type: 'content', text: '资料。' },
    { type: 'diagnostics', text: 'DIAGNOSTICS_ARE_NOT_CONTENT', diagnostics },
  ];
  const unchanged = JSON.stringify(chunks);
  const resultStream = stream(chunks);
  assert.deepEqual(await collectStreamResponse(resultStream), { content: '先查阅资料。', diagnostics,
    toolCalls: calls, toolContinuationId: 'opaque-synthetic-id' });
  assert.equal(JSON.stringify(chunks), unchanged, 'Collection never mutates source events or tool arguments');
  assert.equal(resultStream.locked, false);
  checks.push('complete response metadata is collected separately from visible text and never executed');

  assert.deepEqual(await collectStreamResponse(stream([{ type: 'response', text: '', toolCalls: [], toolContinuationId: 'final-continuation' }])),
    { content: '', diagnostics: undefined, toolContinuationId: 'final-continuation' });
  assert.deepEqual(await collectStreamResponse(stream([{ type: 'response', text: '', toolCalls: [] }])),
    { content: '', diagnostics: undefined });
  assert.deepEqual(await collectStreamResponse(stream([{ type: 'response', text: '', toolCalls: calls }])),
    { content: '', diagnostics: undefined, toolCalls: calls });
  checks.push('tool-less final answers can retain opaque continuation; absent tool fields stay absent');

  const stop = new DOMException('Synthetic cancellation', 'AbortError');
  let pulls = 0;
  const interrupted = new ReadableStream<StreamChunk>({ pull(controller) {
    if (pulls++ === 0) controller.enqueue({ type: 'content', text: '已到达的前缀' });
    else controller.error(stop);
  } });
  await assert.rejects(collectStreamResponse(interrupted), error => error === stop);
  assert.equal(interrupted.locked, false);
  checks.push('stream failure propagates without a fabricated result and still releases the reader');

  const file = 'src/components/ReviewChat.tsx', source = await fs.readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const readLoops = new Map<string, ts.WhileStatement>();
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      && node.right.getText(ast) === 'value.text' && ['content', 'fullContent'].includes(node.left.getText(ast))) {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isWhileStatement(parent)) parent = parent.parent;
      assert.ok(parent && ts.isWhileStatement(parent));
      readLoops.set(node.left.getText(ast), parent);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(readLoops.size, 2, 'Test both real ReviewChat stream read loops');
  const runLoop = async (name: 'content' | 'fullContent', input: StreamChunk[]) => {
    const body = `return (async () => { const reader = stream.getReader(); let content = '', fullContent = ''; let lastDiagnostics;
      const tutorId = 'synthetic-tutor'; let messages = [{ id: tutorId, content: '' }], updates = 0;
      const setMessages = update => { updates++; messages = update(messages); };
      try { ${readLoops.get(name)!.getText(ast)} } finally { reader.releaseLock(); }
      return { content, fullContent, lastDiagnostics, updates, messages }; })();`;
    const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const inputStream = stream(input);
    const output = await new Function('stream', js)(inputStream);
    assert.equal(inputStream.locked, false);
    return output;
  };
  const tutor = await runLoop('content', chunks);
  assert.equal(tutor.content, '先查阅资料。');
  assert.equal(tutor.updates, 2, 'Only content chunks cause tutor message redraws');
  assert.deepEqual(tutor.lastDiagnostics, diagnostics);
  const scoring = await runLoop('fullContent', [
    { type: 'content', text: '{"score":' },
    { type: 'activity', text: 'NEVER_IN_SCORING_JSON', activity: { phase: 'reasoning' } },
    { type: 'response', text: 'NEVER_IN_SCORING_JSON', toolCalls: calls },
    { type: 'content', text: '1}' },
    { type: 'diagnostics', text: 'NEVER_IN_SCORING_JSON', diagnostics },
  ]);
  assert.equal(scoring.fullContent, '{"score":1}');
  assert.deepEqual(JSON.parse(scoring.fullContent), { score: 1 });
  assert.equal(scoring.updates, 0);
  checks.push('actual tutor and scoring loops ignore metadata, preserve diagnostics and update visible content only');

  await fs.mkdir('build', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('build/stream-response-contract-'));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, checks,
    actualCollector: true, actualReviewReadLoops: 2, realModelRequests: 0, networkCalls: 0, realSettingsAccessed: false }, null, 2));
  console.log(JSON.stringify({ passed: true, root, checks: checks.length, actualReviewReadLoops: 2, modelRequests: 0, networkCalls: 0 }));
} finally { globalThis.fetch = originalFetch; }
