import assert from 'node:assert/strict';
import { planResourceSearch, reviewResourceCandidates, validateResourceSemanticPlan } from '../src/services/resourceSemanticSearch';
import { AUTOMATIC_RESOURCE_TARGETS, resourceIdentity, automaticResourceIntentIssue } from '../src/services/resourceCuration';
import { automaticResourceContentIssue } from '../src/services/resourceContentAdmission';
import { buildResourceSearchTabs, classifyBrowserResource } from '../src/electron/resourceBrowserCore';
import type { ResourceItem, ResourceSearchCategory } from '../src/types';
import { discoverAcademicReferences } from '../src/electron/resourceAcademicSources';
import { automaticResourceAccessIssue } from '../src/services/resourceState';

const categories = Object.keys(AUTOMATIC_RESOURCE_TARGETS) as ResourceSearchCategory[];
const plan = { goal: 'Understand the LLM processing pipeline and external retrieval', topics: ['Transformer self-attention', 'RAG'],
  lanes: categories.map(category => ({ category, reason: 'Evidence for the actual learning goal', queries: category === 'paper'
    ? ['Attention Is All You Need original paper', 'Retrieval-Augmented Generation Lewis 2020'] : [`Agent-designed ${category} query`] })) };
let calls = 0;
const planned = await planResourceSearch({ projectTitle: '建立 LLM 全景概念地图', taskText: '建立概念联系', knowledgeTitles: ['自注意力', 'RAG'], targets: AUTOMATIC_RESOURCE_TARGETS }, async request => {
  calls++; assert.ok(request.systemPrompt.includes('不要机械拼接')); return JSON.stringify(plan);
});
assert.equal(calls, 1); assert.deepEqual(planned, plan);
const tabs = buildResourceSearchTabs({ projectTitle: '建立 LLM 全景概念地图', taskText: 'test', knowledgeTitles: ['自注意力'], interactionMode: 'auto', semanticPlan: planned });
assert.deepEqual(tabs.find(tab => tab.id === 'paper')!.variants!.map(variant => variant.query), plan.lanes.find(lane => lane.category === 'paper')!.queries, 'model queries execute verbatim without a title/keyword template');
assert.throws(() => validateResourceSemanticPlan({ ...plan, lanes: [...plan.lanes.slice(0, 4), plan.lanes[0]] }));
assert.throws(() => validateResourceSemanticPlan({ ...plan, lanes: plan.lanes.map(lane => ({ ...lane, queries: ['x'.repeat(129)] })) }));
const stopped = new AbortController(); stopped.abort();
await assert.rejects(planResourceSearch({ projectTitle: 'LLM', taskText: 'test', knowledgeTitles: ['LLM'], targets: AUTOMATIC_RESOURCE_TARGETS }, async () => { throw Error('must not call'); }, stopped.signal));
console.log('PASS real planner understands the task before selecting bounded queries; no fixed keyword rewrite, duplicate lanes, or dispatch after Stop');

const candidate: ResourceItem = { candidateId: 'session:1', title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762',
  description: 'The original Transformer architecture.', searchCategory: 'paper', searchQuery: plan.lanes.find(lane => lane.category === 'paper')!.queries[0], resourceType: 'webpage',
  accessType: 'public', verifiedAt: new Date().toISOString() };
const decision = { candidateId: candidate.candidateId, accept: true, category: 'paper', score: 0.95, reason: 'Original self-attention architecture for the LLM pipeline',
  topics: ['Transformer self-attention'], displayTitle: 'Attention Is All You Need — Transformer 原始论文' };
const review = await reviewResourceCandidates(planned, [candidate], async request => {
  const input = JSON.parse(request.userInput); assert.equal(input.candidates[0].url, candidate.url);
  return { decisions: [decision] };
});
assert.equal(review.resources.length, 1); assert.equal(review.resources[0].url, candidate.url);
assert.equal(automaticResourceContentIssue(review.resources[0], { projectTitle: '建立 LLM 全景概念地图', knowledgeTitles: ['自注意力'] }), undefined, 'semantic English evidence is not rejected for missing Chinese keywords');
await assert.rejects(reviewResourceCandidates(planned, [candidate], async () => ({ decisions: [{ ...decision, candidateId: 'invented-id' }] })));
await assert.rejects(reviewResourceCandidates(planned, [candidate], async () => ({ decisions: [decision, decision] })));
assert.equal((await reviewResourceCandidates(planned, [candidate], async () => ({ decisions: [{ ...decision, accept: false, score: 0.2 }] }))).resources.length, 0);
assert.equal(resourceIdentity({ url: 'https://arxiv.org/html/1706.03762v1' }), resourceIdentity({ url: 'https://arxiv.org/pdf/1706.03762.pdf' }));
console.log('PASS semantic review handles translated concepts, pins every accepted URL to a real candidate, rejects invented/duplicate IDs, and deduplicates paper representations');

const crowded = Array.from({ length: 20 }, (_, index) => ({ ...candidate, candidateId: `session:${index}`, searchQuery: index < 14 ? 'first-query' : 'supplement-query' }));
await reviewResourceCandidates(planned, crowded, async request => {
  const input = JSON.parse(request.userInput); assert.equal(input.candidates.length, 12);
  assert.ok(input.candidates.some((item: any) => item.candidateId === 'session:14'), 'later planned concepts must survive the evidence limit');
  return { decisions: [] };
});
console.log('PASS semantic evidence is balanced across planned queries instead of being consumed by the first search');
for (const url of ['https://ocw.mit.edu/course/captions.vtt', 'https://www.youtube.com/captions.srt']) {
  const format = classifyBrowserResource({ title: 'Lecture captions', url, contentType: 'text/vtt' });
  assert.equal(format.resourceType, 'document');
  assert.ok(automaticResourceIntentIssue({ ...candidate, ...format, url, searchCategory: 'video', semanticReview: { version: 1, score: 0.99, reason: 'Model erroneously treated captions as video' } }));
}
assert.ok(automaticResourceIntentIssue({ ...candidate, url: 'https://github.com/example/animation/README.md', resourceType: 'webpage', searchCategory: 'video',
  semanticReview: { version: 1, score: 0.99, reason: 'Animation video explanation' } }));
assert.equal(resourceIdentity({ url: 'https://www.youtube.com/watch?v=abc123&app=desktop&pp=tracking' }), resourceIdentity({ url: 'https://youtu.be/abc123' }));
console.log('PASS live-found regressions: captions and animation READMEs cannot consume video quotas even after model approval; video aliases deduplicate');
assert.ok(automaticResourceIntentIssue({ ...candidate, title: 'RAG 原论文笔记', url: 'https://github.com/example/notes/rag.md',
  semanticReview: { version: 1, score: 0.99, reason: 'Notes cite the original paper' } }));
const citationFetches: string[] = [];
const expanded = await discoverAcademicReferences([{ title: 'Reading notes', url: 'https://github.com/example/notes' }], undefined, {
  fetchPage: async (url: string) => {
    citationFetches.push(url);
    return url.includes('github.com') ? { title: 'Notes', content: 'Original: https://arxiv.org/abs/2005.11401 and unsafe http://localhost/private' }
      : { title: 'Retrieval-Augmented Generation', content: 'The actual original paper abstract.' };
  },
} as any);
assert.equal(expanded[0].url, 'https://arxiv.org/abs/2005.11401');
assert.deepEqual(citationFetches, ['https://github.com/example/notes', 'https://arxiv.org/abs/2005.11401']);
console.log('PASS reading notes cannot masquerade as papers; original sources are discovered only from actual retrieved citations, never invented URLs');
const approximate = await reviewResourceCandidates(planned, [candidate], async () => ({ decisions: [{ ...decision, score: 0.6 }] }));
assert.equal(approximate.resources.length, 1, 'approximately relevant learning resources need not meet an academic precision threshold');
assert.ok(automaticResourceAccessIssue({ ...candidate, url: 'https://openi.pcl.ac.cn/user/guest_verify' }));
console.log('PASS relaxed relevance admits useful approximate matches while verification/login landing pages remain excluded');
