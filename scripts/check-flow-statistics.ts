import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import { getDefaultUserProfile } from '../src/services/profile/profileStore';
import { applyProfileEvidenceGate } from '../src/services/profile/evidenceGateCore';
import { normalizeMasteryTimeline } from '../src/services/learningAbility/timelineCompatibility';
import { analysisWeeks, projectFlowStatistics, appendFlowStatistics, readFlowStatisticsFile, statisticsEvent,
  statisticsDay, statisticsWeek, type FlowStatisticsFile } from '../src/services/profile/flowStatistics';
import { buildFlowStatisticsSubmission } from '../src/services/flowAnalysis/postStatistics';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor';
import { serializeLearningEpisodeState, deserializeLearningEpisodeState, serializeProfileState, deserializeMasteryTimelineState } from '../src/services/userStateService';
import { loadFlowStatistics, recordFlowStatistics, backfillFlowStatistics, FLOW_STATISTICS_FILE } from '../src/electron/flowStatisticsStore';
import { selectProfileStyle } from '../src/services/profile/overviewModel';
import { loadProfileOverviewData, validateProfileRead } from '../src/services/profile/overviewRead';
import { computeWordCloud } from '../src/services/profile/wordCloud';
import type { LearningEpisode } from '../src/services/memory/types';
import type { NoteItem } from '../src/types';

const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
globalThis.fetch = async () => assert.fail('No network/model in statistics checks');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-statistics-'));
const legacy: any = { version: 1, weeks: [{ weekStart: '2026-08-31', weekEnd: '2026-09-06', errorRate: .5,
  reasoning: { conceptScore: 40, judgmentScore: 50, logicScore: 60, vulnerabilityCount: 2 },
  study: { activeDays: 2, dailyMinutes: [20, 30, 0, 0, 0, 0, 0] }, newMastered: 1, masteredCount: 2 }] };
try {
  const before = structuredClone(legacy), normalized = normalizeMasteryTimeline(legacy);
  assert.equal(normalized.weeks[0].analysisCountUnknown, true);
  assert.equal(normalized.weeks[0].study.dailyMinutes[1], 30);
  assert.equal(normalized.weeks[0].reasoning.logicScore, 60);
  assert.equal(validateProfileRead('timeline', normalized), true);
  assert.equal(analysisWeeks(normalized).length, 0, 'Unknown historical denominator is not a measured zero-error week');
  assert.deepEqual(legacy, before);
  assert.ok(deserializeMasteryTimelineState(JSON.stringify(legacy)));
  assert.equal(deserializeMasteryTimelineState('{broken'), null);
  assert.throws(() => normalizeMasteryTimeline({ ...legacy, weeks: [{ ...legacy.weeks[0], analysisCount: null }] }));
  assert.equal(statisticsDay('2026-10-18T17:00:00Z'), '2026-10-19');
  assert.equal(statisticsWeek('2026-10-18T17:00:00Z'), '2026-10-19');
  assert.equal(computeWordCloud('因此，因此。').find(w => w.word === '因此')!.count, 2, 'A word in multiple banks is counted once per occurrence');

  const fixture = createFlowResultPreview();
  const ungrounded = structuredClone(fixture.bundle.analysisV2);
  const baselineErrors = buildFlowStatisticsSubmission(ungrounded, 'filter', ungrounded.record.input.rawText).errors;
  const seedIssue = ungrounded.record.assessment.issues[0];
  assert.ok(seedIssue);
  ungrounded.record.assessment.issues.push(...(['extraction', 'external_unverified', 'asr_uncertain'] as const).map((kind, i) =>
    ({ ...seedIssue, id: `excluded-${i}`, kind })), { ...seedIssue, id: 'duplicate-root' },
    { ...seedIssue, id: 'no-evidence', evidenceIds: ['missing'] }, { ...seedIssue, id: 'no-target', targetIds: ['missing'] });
  assert.deepEqual(buildFlowStatisticsSubmission(ungrounded, 'filter', ungrounded.record.input.rawText).errors, baselineErrors);
  let profile = getDefaultUserProfile(), file: FlowStatisticsFile = { version: 1, events: [], snapshots: [] };
  const episodes: LearningEpisode[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `statistics-${i}`, observedAt = `2026-10-${14 + i}T09:00:00Z`;
    const analysis = structuredClone(fixture.bundle.analysisV2); analysis.observedAt = observedAt;
    const input = buildFlowStatisticsSubmission(analysis, id, analysis.record.input.rawText);
    const evidence = extractFlowEvidence({ episodeId: id, observedAt, report: fixture.bundle.report, analysisV2: analysis });
    profile = applyProfileEvidenceGate(profile, { episodeId: id, sampleChars: input.sampleChars, signals: evidence.profileSignals }).profile;
    const episode: LearningEpisode = { id, type: 'flow', status: 'completed', title: '合成复盘', startedAt: observedAt,
      endedAt: observedAt, createdAt: observedAt, updatedAt: observedAt, evidenceSnippets: evidence.evidenceSnippets,
      profileSignals: evidence.profileSignals, flowStatistics: input };
    episodes.push(episode);
    file = appendFlowStatistics(file, statisticsEvent(input, episode, profile), profile);
    if (i < 2) assert.equal(file.snapshots.length, 0, 'Pending styles do not become long-term history');
  }
  assert.equal(file.snapshots.length, 1);
  assert.equal(readFlowStatisticsFile(file).events.length, 3);
  const projection = projectFlowStatistics(file);
  const missingScores = projectFlowStatistics({ ...file, events: [{ ...file.events[0], scores: { concept: null, judgment: 55, reasoning: null } }] });
  assert.equal(missingScores.timeline!.weeks[0].conceptScore, null);
  assert.equal(missingScores.timeline!.weeks[0].logicScore, null);
  assert.equal(projection.timeline!.weeks[0].analysisCount, 3);
  assert.ok(projection.timeline!.weeks[0].errorRate !== null);
  assert.equal(projection.cloud.weeks[0].words.find(w => w.word === '所以')?.count, 3);
  const newTrend = { snapshots: [{ date: '2026-10-15', display: Object.fromEntries(['academic','critical','practical','divergent','objective'].map(k => [k,99])) as any, topStyle: '旧量规' }, ...file.snapshots] };
  assert.equal(selectProfileStyle(null, newTrend, 'd30', '2026-11-17', profile)?.conclusion, '同量规已采信表达风格');
  assert.equal(selectProfileStyle(null, { snapshots: [newTrend.snapshots[0]] }, 'd30', '2026-11-17', profile), null, 'No fallback to old nine-type history');

  const input = episodes[2].flowStatistics!;
  const profileText = serializeProfileState(profile, {}), episodesText = serializeLearningEpisodeState({ version: 2, episodes });
  assert.deepEqual(deserializeLearningEpisodeState(episodesText, true)!.episodes[2].flowStatistics, input, 'Recovery survives source serialization');
  await fs.writeFile(path.join(temp, 'profile.json'), profileText);
  await fs.writeFile(path.join(temp, 'learning-episodes.json'), episodesText);
  await fs.writeFile(path.join(temp, 'mastery-timeline.json'), JSON.stringify(legacy));
  await Promise.all([recordFlowStatistics(temp, input), recordFlowStatistics(temp, input)]);
  assert.equal((await loadFlowStatistics(temp))!.events.length, 1);
  await backfillFlowStatistics(temp, []);
  const persisted = (await loadFlowStatistics(temp))!;
  assert.equal(persisted.events.length, 3, 'Recover committed submissions after partial failure, without LLM');
  assert.equal(projectFlowStatistics(persisted).cloud.weeks[0].words.find(w => w.word === '所以')?.count, 3);
  const oldTime = (await fs.stat(path.join(temp, FLOW_STATISTICS_FILE))).mtimeMs;
  await backfillFlowStatistics(temp, []);
  assert.equal((await fs.stat(path.join(temp, FLOW_STATISTICS_FILE))).mtimeMs, oldTime, 'Restart is idempotent and does not rewrite identical statistics');
  assert.equal(await fs.readFile(path.join(temp, 'profile.json'), 'utf8'), profileText, 'Statistics cannot update profile or mastery');
  assert.equal(await fs.readFile(path.join(temp, 'learning-episodes.json'), 'utf8'), episodesText);
  assert.equal(await fs.readFile(path.join(temp, 'mastery-timeline.json'), 'utf8'), JSON.stringify(legacy), 'Old timeline remains untouched');
  await assert.rejects(recordFlowStatistics(temp, { ...input, episodeId: 'missing' }), /未保存/u);
  await assert.rejects(recordFlowStatistics(temp, { ...input, sampleChars: input.sampleChars + 1 }), /不一致/u);

  // Historical episode has no complete issues payload: retain unknown errors, recover only stored scores/words.
  const historical = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-statistics-history-'));
  await fs.writeFile(path.join(historical, 'profile.json'), profileText);
  await fs.writeFile(path.join(historical, 'learning-episodes.json'), serializeLearningEpisodeState({ version: 2,
    episodes: [{ ...episodes[0], flowStatistics: undefined }] }));
  const note = { id: 'project', learningReviewRecords: [{ projectNoteId: 'project', sessionId: episodes[0].id,
    rawRestatement: '因为条件不同，所以结论不同。' }] } as unknown as NoteItem;
  await backfillFlowStatistics(historical, [note]);
  const historicalProjection = projectFlowStatistics((await loadFlowStatistics(historical))!);
  assert.equal(historicalProjection.timeline!.weeks[0].errorRate, null);
  assert.ok(historicalProjection.cloud.weeks[0].words.length);
  await backfillFlowStatistics(historical, []);
  assert.ok(projectFlowStatistics((await loadFlowStatistics(historical))!).cloud.weeks[0].words.length, 'Removing a review block does not delete already recorded observations');

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { isElectron: true, userState: {
    loadProfile: async () => ({ profile }), loadMasteryTimeline: async () => legacy,
    loadStyleSnapshot: async () => null, loadStyleTrend: async () => ({ snapshots: [newTrend.snapshots[0]] }),
    loadWordCloud: async () => ({ weeks: [] }), loadFlowStatistics: async () => persisted,
  } } } });
  const displayed = await loadProfileOverviewData();
  assert.equal(displayed.timeline.ok, true);
  assert.equal(displayed.statistics!.ok, true);
  assert.equal(displayed.timeline.value!.weeks[0].study.dailyMinutes[0], 20);
  assert.equal(displayed.timeline.value!.flowAnalysis!.weeks[0].analysisCount, 3);
  assert.ok(displayed.cloud.value!.weeks[0].words.length);

  // Execute actual native handler guards and preload contracts, with IO boundary mocked.
  const mainText = readFileSync('src/electron/main.ts','utf8'), ast = ts.createSourceFile('main.ts', mainText, ts.ScriptTarget.Latest, true);
  let allowed = false, writes = 0, loads = 0; const handlers = new Map<string, any>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0])
      && ['user-state:load-flow-statistics','user-state:record-flow-statistics'].includes(node.arguments[0].text)) {
      handlers.set(node.arguments[0].text, runInNewContext(ts.transpileModule(`globalThis.fn=${node.arguments[1].getText(ast)}`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'; fn', {
        referenceCallerAllowed: () => allowed, getUserStateDir: () => temp, referenceSourceWriteEpoch: 1,
        loadFlowStatistics: async () => { loads++; return persisted; }, recordFlowStatistics: async () => { writes++; },
        withRagSourceTransaction: async (_roots: any, action: any) => action(),
      }));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(handlers.size, 2);
  await assert.rejects(handlers.get('user-state:load-flow-statistics')({}));
  await assert.rejects(handlers.get('user-state:record-flow-statistics')({}, input));
  assert.equal(loads + writes, 0);
  allowed = true; await handlers.get('user-state:load-flow-statistics')({});
  await handlers.get('user-state:record-flow-statistics')({}, input);
  assert.equal(loads, 1); assert.equal(writes, 1);
  const beforeCorrupt = '{broken-statistics';
  await fs.writeFile(path.join(temp, FLOW_STATISTICS_FILE), beforeCorrupt);
  await assert.rejects(recordFlowStatistics(temp, input));
  assert.equal(await fs.readFile(path.join(temp, FLOW_STATISTICS_FILE), 'utf8'), beforeCorrupt, 'Corrupt statistics fail visibly, never reset or overwrite');

  if (process.argv.includes('--read-current')) {
    const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'),'utf8'));
    const source = await fs.readFile(path.join(anchor.dataRoot,'user-state/mastery-timeline.json'),'utf8');
    const normalized = normalizeMasteryTimeline(JSON.parse(source));
    assert.equal(validateProfileRead('timeline', normalized), true);
    assert.equal(await fs.readFile(path.join(anchor.dataRoot,'user-state/mastery-timeline.json'),'utf8'), source);
    console.log(JSON.stringify({ currentDataReadOnly: true, weeksReadable: normalized.weeks.length,
      legacyDenominatorUnknown: normalized.weeks.filter(w => w.analysisCountUnknown).length, productionWrites: false }));
  }
  console.log('PASS statistics: legacy compatibility/preservation, Shanghai boundaries, same-rubric nullable scores, grounded error filtering, per-episode idempotence, trusted history, local word counts, actual read adapters/IPC guards, restart recovery, strict corrupt-file refusal; no LLM, no production writes.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis,'window',originalWindow); else Reflect.deleteProperty(globalThis,'window');
}
