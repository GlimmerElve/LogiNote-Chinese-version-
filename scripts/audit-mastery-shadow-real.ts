import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateMasteryShadowViews,
  MasteryShadowContentStatus,
  projectMasteryShadow,
  sortMasteryShadowViewsForReview,
} from '../src/services/masteryShadow/index.ts';
import { calculateRetrievability } from '../src/services/reviewScheduler.ts';

interface NoteMeta {
  id: string;
  title: string;
  noteType: 'project' | 'knowledge';
}

interface LegacyDsr {
  stability?: number;
  lastReviewedAt?: string | null;
  conceptMastery?: number;
  conceptMasterySamples?: number;
  conceptMasteryUpdatedAt?: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveDataRoot(): Promise<string> {
  const explicit = argumentValue('--data-root');
  if (explicit) return path.resolve(explicit);
  const config = await readJson<{ dataRoot: string }>(
    path.join(os.homedir(), '.logi-note', 'storage-config.json'),
  );
  return config.dataRoot;
}

function visibleLength(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`\-\[\]]/g, ' ')
    .replace(/\s+/g, '')
    .length;
}

/** 旧库没有显式 contentStatus。这里只做只读兼容诊断，不作为未来正式判定规则。 */
function inferLegacyContentStatus(markdown: string): MasteryShadowContentStatus {
  const length = visibleLength(markdown);
  if (length < 40) return 'incomplete';
  if (length < 180 || !/^#{1,3}\s+\S+/m.test(markdown)) return 'needs_review';
  return 'ready';
}

const dataRoot = await resolveDataRoot();
const metadata = await readJson<{ notesMeta: Record<string, NoteMeta> }>(
  path.join(dataRoot, 'vault', 'metadata.json'),
);
const stateFile = await readJson<{
  noteStates?: Record<string, { dsrState?: LegacyDsr }>;
}>(path.join(dataRoot, 'user-state', 'user-state.json'));
const noteStates = stateFile.noteStates ?? {};
const knowledgeNotes = Object.values(metadata.notesMeta).filter(
  (note) => note.noteType === 'knowledge',
);

const views = [];
let missingNoteFile = 0;
let legacyWithScore = 0;
let legacyTrustedByOldRule = 0;
let oldLowExtreme = 0;
let oldHighExtreme = 0;

for (const note of knowledgeNotes) {
  let markdown = '';
  try {
    markdown = await fs.readFile(path.join(dataRoot, 'vault', 'notes', `${note.id}.md`), 'utf8');
  } catch {
    missingNoteFile += 1;
  }
  const dsr = noteStates[note.id]?.dsrState;
  const hasLegacyScore = dsr?.conceptMastery != null;
  if (hasLegacyScore) {
    legacyWithScore += 1;
    if ((dsr?.conceptMasterySamples ?? 0) >= 2) legacyTrustedByOldRule += 1;
    if ((dsr?.conceptMastery ?? 0) <= 10) oldLowExtreme += 1;
    if ((dsr?.conceptMastery ?? 0) >= 90) oldHighExtreme += 1;
  }
  views.push(
    projectMasteryShadow({
      knowledgePointId: note.id,
      contentStatus: inferLegacyContentStatus(markdown),
      // 旧数据没有按项目保存目标层级；影子审计统一使用最保守的概念层回退。
      requiredLevel: 1,
      retrievability: dsr
        ? calculateRetrievability(dsr.stability ?? 2, dsr.lastReviewedAt ?? null)
        : undefined,
      legacy: hasLegacyScore
        ? {
            score: dsr?.conceptMastery,
            samples: dsr?.conceptMasterySamples,
            updatedAt: dsr?.conceptMasteryUpdatedAt,
          }
        : undefined,
    }),
  );
}

const aggregate = aggregateMasteryShadowViews(views);
const reviewOrder = sortMasteryShadowViewsForReview(views);
const readyViews = views.filter((view) => view.contentStatus === 'ready');
const incorrectlyPromotedLegacy = views.filter(
  (view) => view.legacyOnly && view.assessmentStatus !== 'unassessed',
);

if (incorrectlyPromotedLegacy.length > 0) {
  throw new Error(`legacy score promoted ${incorrectlyPromotedLegacy.length} notes unexpectedly`);
}
if (views.length !== knowledgeNotes.length) {
  throw new Error('not every knowledge note received a shadow projection');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: 'read-only-shadow-audit',
      writesPerformed: 0,
      realLibrary: {
        knowledgePoints: knowledgeNotes.length,
        missingNoteFile,
        oldMastery: {
          withScore: legacyWithScore,
          withoutScore: knowledgeNotes.length - legacyWithScore,
          trustedByOldSamplesRule: legacyTrustedByOldRule,
          lowExtreme0To10: oldLowExtreme,
          highExtreme90To100: oldHighExtreme,
        },
      },
      fallbacks: {
        requiredLevelDefaultedToConcept: knowledgeNotes.length,
        contentStatusInferredFromLegacyMarkdown: knowledgeNotes.length,
        warning: 'fallbacks are audit-only and are not persisted',
      },
      compatibility: {
        allKnowledgePointsProjected: views.length === knowledgeNotes.length,
        oldScoresPromotedToConfirmed: incorrectlyPromotedLegacy.length,
        unassessedIsSeparateFromFailure: aggregate.assessment.unassessed === views.length,
        productionFilesWritten: 0,
      },
      aggregate,
      selectionPreview: {
        eligibleContentCount: readyViews.length,
        excludedForContentCompletion: aggregate.reviewCategories.content_incomplete,
        topPriorityBands: reviewOrder.slice(0, 10).map((view) => ({
          category: view.reviewCategory,
          priority: view.reviewPriority,
          legacyOnly: view.legacyOnly,
          targetGap: view.targetGap,
        })),
      },
    },
    null,
    2,
  ),
);
