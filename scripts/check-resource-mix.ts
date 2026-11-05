import assert from 'node:assert/strict';
import { buildAutomaticResourcePlan, AUTOMATIC_RESOURCE_TARGETS, automaticResourceIntentIssue, resourceIdentity } from '../src/services/resourceCuration';
import { emptyResourceState, selectResourcesForAutomaticCollection } from '../src/services/resourceState';
import { buildResourceSearchTabs } from '../src/electron/resourceBrowserCore';
import { extractResourceCoreTerm } from '../src/services/resourceSearchTerm';
import type { ResourceItem, ResourceSearchCategory } from '../src/types';

const categories = ['encyclopedia', 'video', 'practice', 'paper', 'materials'] as ResourceSearchCategory[];
const now = '2026-11-04T02:00:00Z';
const title = { encyclopedia: '概念解释', video: '视频讲解', practice: '实践案例', paper: '研究论文', materials: '教材讲义' };
const make = (category: ResourceSearchCategory, i: number, patch: Partial<ResourceItem> = {}): ResourceItem => ({
  title: `心理账户${title[category]} ${i}`, url: `https://source${i % 3}.example/${category}/${i}`,
  searchCategory: category, kind: 'online', projectTitle: '心理账户', taskText: '理解心理账户', knowledgeTitles: ['心理账户'],
  accessType: 'public', isFree: true, verifiedAt: now, resourceType: category === 'video' ? 'video' : 'webpage', ...patch,
});
const input = { projectTitle: '心理账户', taskText: '理解心理账户', knowledgeTitles: ['心理账户'], existingUrls: [] as string[] };
const pool = categories.flatMap(category => Array.from({ length: 7 }, (_, i) => make(category, i,
  category === 'materials' && i > 3 ? { url: `https://files.example/lesson-${i}.pdf`, resourceType: 'pdf', downloadable: true, isAttachment: true } : {})));
const baseline = buildAutomaticResourcePlan(emptyResourceState());
assert.deepEqual(baseline.targets, AUTOMATIC_RESOURCE_TARGETS);
for (const preference of ['adaptive', 'video', 'reading', 'practice', 'paper', 'malformed']) {
  const plan = buildAutomaticResourcePlan(emptyResourceState(), preference);
  assert.equal(Object.values(plan.targets).reduce((a, b) => a + b), 10);
  assert.equal(plan.targets.materials, 2); assert.ok(Object.values(plan.targets).every(n => n >= 1));
}
const videoPlan = buildAutomaticResourcePlan(emptyResourceState(), 'video');
assert.equal(videoPlan.targets.video, 5);
const selected = selectResourcesForAutomaticCollection(pool, { ...input, targets: videoPlan.targets });
assert.equal(selected.selected.length, 10);
assert.equal(selected.selected.filter(r => r.searchCategory === 'video').length, 5);
assert.equal(selected.selected.filter(r => r.searchCategory === 'materials' && r.downloadable).length, 2, 'real files outrank high-ranking HTML textbook pages');
assert.deepEqual(new Set(selected.selected.map(r => r.searchCategory)), new Set(categories));
console.log('PASS explicit resource preferences conserve ten slots, retain four online categories and reserve actual downloadable documents');

const state = emptyResourceState();
for (let i = 0; i < 4; i++) state.discoveryPreferences[`v${i}`] = { key: `v${i}`, noteId: 'p', url: `https://video.example/${i}`, host: 'video.example', resourceType: 'video', decision: 'selected', updatedAt: now };
assert.ok(buildAutomaticResourcePlan(state).targets.video > baseline.targets.video);
assert.equal(buildAutomaticResourcePlan(state, 'paper').targets.paper, 5, 'explicit setting outranks past selections');
state.discoveryPreferences = {};
state.feedback.video = { key: 'video', noteId: 'p', url: 'https://video.example/watched', rating: 'completed', resourceType: 'video', updatedAt: now };
assert.ok(buildAutomaticResourcePlan(state).targets.video > baseline.targets.video);
assert.deepEqual(buildAutomaticResourcePlan(emptyResourceState(), 'adaptive', [{ id: 'p', resources: pool } as any]).targets, baseline.targets, 'automatically saved resources alone never teach a preference');
console.log('PASS explicit video choices and completion feedback adapt ratios; automatic saves do not reinforce themselves');

assert.ok(automaticResourceIntentIssue(make('video', 1, { title: '心理账户的文章', resourceType: 'article' })));
assert.ok(automaticResourceIntentIssue(make('paper', 1, { title: '心理账户概念速览' })));
assert.ok(automaticResourceIntentIssue(make('practice', 1, { title: '心理账户定义' })));
assert.ok(automaticResourceIntentIssue(make('materials', 1, { title: '心理账户 PDF 下载中心' })));
assert.equal(automaticResourceIntentIssue(make('materials', 1, { title: '心理账户 lecture notes' })), undefined, 'lecture notes are written handouts, not videos');
const sparse = selectResourcesForAutomaticCollection(pool.filter(r => r.searchCategory !== 'paper' && !r.downloadable), { ...input, targets: videoPlan.targets });
assert.equal(sparse.selected.some(r => r.searchCategory === 'paper'), false);
assert.equal(sparse.selected.filter(r => r.searchCategory === 'video').length, 5, 'missing papers do not expand the video quota');
assert.equal(sparse.selected.filter(r => r.searchCategory === 'materials').length, 2, 'missing files degrade to real textbook/handout pages');
console.log('PASS no articles masquerading as videos/papers/cases; unavailable files degrade to relevant textbook links without fabricated quota fills');

assert.equal(resourceIdentity({ url: 'https://arxiv.org/abs/2401.12345?utm_source=test#x' }), resourceIdentity({ url: 'https://arxiv.org/pdf/2401.12345.pdf' }));
const paperPair = [make('paper', 1, { url: 'https://arxiv.org/abs/2401.12345' }), make('materials', 2,
  { url: 'https://arxiv.org/pdf/2401.12345.pdf', resourceType: 'pdf', downloadable: true })];
assert.equal(selectResourcesForAutomaticCollection(paperPair, input).selected.length, 1);
assert.equal(selectResourcesForAutomaticCollection(paperPair, { ...input, existingUrls: ['https://arxiv.org/abs/2401.12345'] }).selected.length, 0);
const manualTabs = buildResourceSearchTabs({ ...input, interactionMode: 'review' });
const autoTabs = buildResourceSearchTabs({ ...input, interactionMode: 'auto' });
assert.equal(manualTabs.length, 4); assert.equal(autoTabs.length, 5);
assert.match(autoTabs.find(t => t.id === 'materials')!.query, /filetype:pdf/u);
assert.ok(!autoTabs.find(t => t.id === 'practice')!.variants!.some(t => t.label === '论文'));
assert.equal(extractResourceCoreTerm('建立 LLM 全景概念地图'), 'LLM');
console.log('PASS paper abstract/PDF and tracking URLs deduplicate; automatic search separates papers and requests files, manual four-tab browser stays intact');
