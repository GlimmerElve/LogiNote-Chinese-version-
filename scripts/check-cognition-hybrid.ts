import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COGNITION_INDEX_FILE_NAME, COGNITION_FILE_NAME, mutateCognition, loadCognition } from '../src/electron/cognitionStore.ts';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval.ts';
import { currentCognitionItems, retrieveCurrentCognition, readCognitionRetrieval, withCognitionNeighborhood } from '../src/services/cognition/retrieval.ts';
import { latestCognition } from '../src/services/cognition/core.ts';
import { setModelsDir } from '../src/electron/rag/embedding.ts';
import { searchCurrentPersonalCognition } from '../src/services/cognition/store.ts';

let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-hybrid-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network forbidden in cognition tests'); };
const n = (id: string, text: string) => ({ id, text, mainType: '事实陈述' as const });
const indexPath = (dir: string) => path.join(dir, COGNITION_INDEX_FILE_NAME);
const vector = (axis: number) => Array.from({ length: 384 }, (_, i) => Number(i === axis));
let encoded: string[] = [];
const encode = async (text: string) => { encoded.push(text); return vector(/睡眠|休息|熬夜/.test(text) ? 0 : /选择|选项|决策/.test(text) ? 1 : 2); };
async function seed(name: string) {
  const dir = path.join(root, name);
  await mutateCognition(dir, { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
    doc: { doc_id: 'g', title: '合成认知', nodes: [n('sleep', '充分睡眠有助于记忆巩固。'), n('condition', '比较成本较低时'), n('choice', '选择增加能改善决策。'), n('result', '因此值得增加选项。')],
      edges: [{ id: 'a', source: 'condition', target: 'choice', relation: 'support' }, { id: 'b', source: 'choice', target: 'result', relation: 'support' }] } });
  return dir;
}
async function update(dir: string, text: string) {
  const file = await loadCognition(dir);
  return mutateCognition(dir, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true, authorship: 'own_expression', stance: 'tentative', mainType: '事实陈述', text,
    target: { recordId: 'g', revisionId: latestCognition(file.records[0]).id, branchId: 'primary', nodeId: 'choice', operation: 'qualify', reason: '补充条件' } });
}
try {
  await test('语义近义词召回、独立索引、重复读取复用向量且不改变认知库', async () => {
    const dir = await seed('reuse'), before = await fs.readFile(path.join(dir, COGNITION_FILE_NAME), 'utf-8');
    encoded = [];
    const result = await searchPersonalCognition(dir, '充足休息', encode);
    assert.equal(result.method, 'local-hybrid-v1'); assert.equal(result.items[0].nodeId, 'sleep');
    assert.equal(retrieveCurrentCognition(await loadCognition(dir), '充足休息').items.length, 0);
    assert.equal(encoded.length, 5);
    assert.equal(await fs.readFile(path.join(dir, COGNITION_FILE_NAME), 'utf-8'), before);
    const raw = await fs.readFile(indexPath(dir), 'utf-8');
    assert.equal(raw.includes('充分睡眠'), false); assert.equal(raw.includes('充足休息'), false);
    encoded = []; await searchPersonalCognition(dir, '充足休息', encode); assert.equal(encoded.length, 1);
    assert.ok(result.items.every((hit) => hit.usableAsFactEvidence === false));
  });
  await test('低相似度不硬凑结果，无主题不生成整库向量', async () => {
    const dir = await seed('empty'); encoded = [];
    assert.equal((await searchPersonalCognition(dir, '我的理解和资料有什么差异', encode)).items.length, 0);
    assert.equal(encoded.length, 0);
    const result = await searchPersonalCognition(dir, '火星轨道', async (text) => vector(text.includes('火星') ? 3 : 0));
    assert.equal(result.items.length, 0);
  });
  await test('已有方向、前提、下游均保留；不会自动改成互斥或跨图补边', async () => {
    const dir = await seed('edges'), file = await loadCognition(dir);
    const result = await searchPersonalCognition(dir, '选择决策', encode);
    const hit = result.items.find((h) => h.nodeId === 'choice')!;
    assert.deepEqual(hit.neighbors?.map((e) => [e.sourceNodeId, e.targetNodeId, e.relation]), [['condition', 'choice', 'support'], ['choice', 'result', 'support']]);
    assert.ok(hit.neighbors?.some((e) => e.text === '比较成本较低时'));
    const branch = latestCognition(file.records[0]).branches[0];
    branch.graph.nodes.push(n('extra', '额外条件'.repeat(300)));
    branch.graph.edges.push({ id: 'c', source: 'extra', target: 'choice', relation: 'oppose' });
    const limited = withCognitionNeighborhood(file, retrieveCurrentCognition(file, '选择'));
    assert.equal(limited.items[0].neighbors?.length, 2); assert.equal(limited.items[0].neighborhoodTruncated, true);
    assert.equal(limited.items[0].neighbors?.[1].relation, 'oppose');
    assert.equal(limited.items[0].neighbors?.[1].textTruncated, true);
    assert.deepEqual(readCognitionRetrieval(limited)?.items[0].neighbors, limited.items[0].neighbors);
    const invalid = { ...limited, items: [{ ...limited.items[0], neighbors: [{ ...hit.neighbors![0], sourceNodeId: 'foreign' }] }] };
    assert.equal(readCognitionRetrieval(invalid)?.items[0].neighbors?.length, 0);
  });
  await test('修订立即删除旧索引；当前版本重建，下游待复核', async () => {
    const dir = await seed('revision'); await searchPersonalCognition(dir, '选择', encode);
    await update(dir, '选择增加也可能降低决策质量，要考虑比较成本。');
    await assert.rejects(fs.stat(indexPath(dir)), { code: 'ENOENT' });
    const result = await searchPersonalCognition(dir, '选择', encode);
    assert.ok(result.items.find((h) => h.nodeId === 'choice')?.text.includes('也可能'));
    assert.equal(result.items.find((h) => h.nodeId === 'choice')?.neighbors?.find((e) => e.nodeId === 'result')?.needsReview, true);
  });
  await test('新增结果不覆盖旧结论，不同情境分支不混合上下文', async () => {
    const dir = await seed('supplement');
    let file = await loadCognition(dir);
    const base = { kind: 'update_cognition', confirmed: true, authorship: 'own_expression', stance: 'tentative', mainType: '事实陈述' };
    file = await mutateCognition(dir, { ...base, expectedRevision: file.revision, text: '选择增加也可能促进探索。',
      target: { recordId: 'g', revisionId: latestCognition(file.records[0]).id, branchId: 'primary', nodeId: 'choice', operation: 'supplement', reason: '增加结果' } });
    const result = await searchPersonalCognition(dir, '选择', encode);
    assert.ok(result.items.some((h) => h.text === '选择增加能改善决策。'));
    assert.ok(result.items.some((h) => h.text === '选择增加也可能促进探索。'));
    file = await mutateCognition(dir, { ...base, expectedRevision: file.revision, text: '选择过多在紧迫情境下可能妨碍决策。',
      target: { recordId: 'g', revisionId: latestCognition(file.records[0]).id, branchId: 'primary', nodeId: 'choice', operation: 'contextual', reason: '时间紧迫时' } });
    const hits = currentCognitionItems(file).filter((h) => h.nodeId === 'choice' || h.branchKind === 'contextual');
    assert.equal(hits.length, 2);
    const enriched = withCognitionNeighborhood(file, { status: 'ready', method: 'local-hybrid-v1', items: hits, warning: '' });
    const primary = enriched.items.find((h) => h.branchKind === 'primary')!;
    const contextual = enriched.items.find((h) => h.branchKind === 'contextual')!;
    assert.equal(primary.context, ''); assert.equal(contextual.context, '时间紧迫时');
    assert.equal(primary.text.includes('紧迫'), false); assert.equal(contextual.text.includes('紧迫'), true);
    assert.ok(enriched.items.every((h) => h.neighbors?.every((neighbor) => neighbor.nodeId !== 'choice')));
  });
  await test('忘记同步失效；并发构建不能复活旧向量或旧主张', async () => {
    const dir = await seed('forget'); await searchPersonalCognition(dir, '选择', encode);
    let edited = false;
    const result = await searchPersonalCognition(dir, '选择', async (text) => {
      if (!edited) { edited = true; const file = await loadCognition(dir); await mutateCognition(dir, { kind: 'forget', expectedRevision: file.revision, confirmed: true, recordId: 'g' }); }
      return encode(text);
    });
    assert.equal(result.items.length, 0); assert.match(result.warning, /已变化/);
    await assert.rejects(fs.stat(indexPath(dir)), { code: 'ENOENT' });
  });
  await test('构建时修订不阻塞用户保存，返回新版本而非旧快照', async () => {
    const dir = await seed('race'); let edited = false;
    const result = await searchPersonalCognition(dir, '选择', async (text) => {
      if (!edited) { edited = true; await update(dir, '选择需要结合具体条件。'); }
      return encode(text);
    });
    assert.equal(result.method, 'local-lexical-v1'); assert.match(result.items[0].text, /具体条件/);
    await assert.rejects(fs.stat(indexPath(dir)), { code: 'ENOENT' });
  });
  await test('模型缺失、非法维度、非有限向量均安全退回词项，不访问网络', async () => {
    const dir = await seed('fallback');
    for (const bad of [async () => { throw new Error('missing'); }, async () => [1], async () => Array(384).fill(NaN)]) {
      const result = await searchPersonalCognition(dir, '选择', bad);
      assert.equal(result.method, 'local-lexical-v1'); assert.match(result.warning, /退回词项/); assert.ok(result.items.length);
    }
  });
  await test('损坏派生索引可重建，模型版本不匹配不复用；源文件损坏拒绝检索', async () => {
    const dir = await seed('corrupt'); await searchPersonalCognition(dir, '选择', encode);
    const index = JSON.parse(await fs.readFile(indexPath(dir), 'utf-8')); index.model = 'incompatible';
    await fs.writeFile(indexPath(dir), JSON.stringify(index)); encoded = [];
    await searchPersonalCognition(dir, '选择', encode); assert.equal(encoded.length, 5);
    await fs.writeFile(indexPath(dir), '{'); await searchPersonalCognition(dir, '选择', encode);
    assert.ok(JSON.parse(await fs.readFile(indexPath(dir), 'utf-8')).entries.length);
    await fs.writeFile(path.join(dir, COGNITION_FILE_NAME), '{');
    await assert.rejects(() => searchPersonalCognition(dir, '选择', encode));
  });
  await test('数据根目录隔离，旧候选仅在读取时自动接入当前索引，随后重复检索复用向量', async () => {
    const a = await seed('root-a'), b = path.join(root, 'root-b'); await searchPersonalCognition(a, '选择', encode);
    assert.equal((await searchPersonalCognition(b, '选择', encode)).items.length, 0);
    const before = await fs.readFile(indexPath(a), 'utf-8');
    await mutateCognition(a, { kind: 'capture_review', enabled: true, observations: [{ activityKind: 'review', activityId: 'r', messageId: 'm', role: 'user', answer: '火星是尚未采纳的理解内容', question: '', observedAt: new Date().toISOString(), noteTitle: '', hintLevel: null, consultedMaterialIds: [], targetKnowledgeNames: [] }] });
    assert.equal(await fs.readFile(indexPath(a), 'utf-8'), before);
    encoded = []; await searchPersonalCognition(a, '选择', encode); assert.equal(encoded.length, 6);
    assert.equal((await loadCognition(a)).records.length, 2, 'valid legacy user answer automatically admitted without confirmation');
    encoded = []; await searchPersonalCognition(a, '选择', encode); assert.equal(encoded.length, 1);
  });
  await test('单次增量构建有上限，部分索引明确披露并在后续补齐', async () => {
    const dir = path.join(root, 'bounded');
    await mutateCognition(dir, { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
      doc: { doc_id: 'many', title: '规模样本', nodes: Array.from({ length: 70 }, (_, i) => n(`n${i}`, `选择样本 ${i}`)), edges: [] } });
    encoded = []; const first = await searchPersonalCognition(dir, '选择', encode);
    assert.match(first.warning, /尚未完成/); assert.equal(encoded.length, 65);
    encoded = []; const second = await searchPersonalCognition(dir, '选择', encode);
    assert.equal(second.warning.includes('尚未完成'), false); assert.equal(encoded.length, 7);
  });
  await test('新桌面 IPC 结果接入原 Agent 服务且规范化邻域', async () => {
    const dir = await seed('ipc'), result = await searchPersonalCognition(dir, '选择', encode);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { userState: { searchCognition: async () => result } } } });
    try { const actual = await searchCurrentPersonalCognition('选择'); assert.equal(actual.method, 'local-hybrid-v1'); assert.ok(actual.items[0].neighbors?.length); }
    finally { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else Reflect.deleteProperty(globalThis, 'window'); }
  });

  if (process.argv.includes('--real-local')) {
    setModelsDir(path.resolve('models'));
    const dir = path.join(root, 'real-local');
    const samples = [
      ['sleep', '充分睡眠有助于记忆巩固。', '充足休息怎样帮助记住所学内容'],
      ['choice', '选项过多可能增加比较成本，降低决策效率。', '备选方案太丰富会不会让人难以作出决定'],
      ['practice', '间隔重复比短时间集中重读更有利于长期保持。', '隔几天再复习与临时抱佛脚哪种记得更牢'],
      ['water', '在标准大气压下，纯水的沸点为摄氏一百度。', '液体在海平面烧开需要多少温度'],
      ['light', '绿色植物利用光能将二氧化碳和水转化为有机物。', '叶片如何借助阳光制造养分'],
      ['motion', '物体不受外力时保持静止或匀速直线运动。', '没有推拉作用的东西会一直以相同速度前进吗'],
    ];
    await mutateCognition(dir, { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
      doc: { doc_id: 'real', title: '离线合成评测', nodes: samples.map(([id, text]) => n(id, text)), edges: [] } });
    let sparseTop1 = 0, hybridTop1 = 0, hybridTop4 = 0;
    for (const [id, , query] of samples) {
      const sparse = retrieveCurrentCognition(await loadCognition(dir), query);
      const hybrid = await searchPersonalCognition(dir, query);
      assert.equal(hybrid.method, 'local-hybrid-v1', hybrid.warning);
      sparseTop1 += Number(sparse.items[0]?.nodeId === id); hybridTop1 += Number(hybrid.items[0]?.nodeId === id);
      hybridTop4 += Number(hybrid.items.some((hit) => hit.nodeId === id));
      console.log(JSON.stringify({ query, expected: id, lexical: sparse.items.map((h) => h.nodeId), hybrid: hybrid.items.map((h) => h.nodeId) }));
    }
    const negatives = ['如何给银行账户设置转账限额', '恒星坍缩形成黑洞的过程', '吉他的和弦指法如何练习'];
    let unrelatedWithHits = 0;
    for (const query of negatives) {
      const result = await searchPersonalCognition(dir, query);
      assert.equal(result.method, 'local-hybrid-v1');
      unrelatedWithHits += Number(result.items.length > 0);
      console.log(JSON.stringify({ unrelatedQuery: query, hits: result.items.map((h) => h.nodeId) }));
    }
    console.log(JSON.stringify({ realLocalEmbedding: true, samples: samples.length, sparseTop1, hybridTop1, hybridTop4, unrelatedQueries: negatives.length, unrelatedWithHits, note: 'Synthetic retrieval smoke test only; not conflict-classification accuracy.' }));
  }
} finally {
  globalThis.fetch = originalFetch;
  // Only this test's explicitly created temp subtree; never a vault/user-state directory.
  await fs.rm(root, { recursive: true, force: true });
}
console.log(`${passed} cognition hybrid checks passed.`);
