import { readFlowStructure } from './argumentDoc/flowStructure';
import { validatePlanResearch, type PlanResearchBundle } from './planResearch';

type Data = Record<string, any>;
const fail = (path: string): never => { throw new Error(`${path}格式不正确，尚未恢复任何笔记`); };
function object(value: unknown, path: string): Data {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : fail(path);
}
function text(value: unknown, path: string): void { if (typeof value !== 'string') fail(path); }
function fields(value: Data, path: string, texts: string[] = [], numbers: string[] = [], booleans: string[] = []): void {
  for (const key of texts) if (value[key] !== undefined) text(value[key], `${path}.${key}`);
  for (const key of numbers) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) fail(`${path}.${key}`);
  for (const key of booleans) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${path}.${key}`);
}
function strings(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(path);
}
function stringFields(value: Data, path: string, keys: string[]): void {
  for (const key of keys) if (value[key] !== undefined) strings(value[key], `${path}.${key}`);
}
function rows(value: Data, key: string, path: string, check: (row: Data, path: string) => void, required = false): void {
  if (value[key] === undefined && !required) return;
  if (!Array.isArray(value[key])) fail(`${path}.${key}`);
  value[key].forEach((row: unknown, index: number) => check(object(row, `${path}.${key}[${index + 1}]`), `${path}.${key}[${index + 1}]`));
}
function nested(value: Data, key: string, path: string, check: (row: Data, path: string) => void): void {
  if (value[key] !== undefined) check(object(value[key], `${path}.${key}`), `${path}.${key}`);
}
function weekdays(value: Data, path: string, key: string): void {
  if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((day: unknown) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6))) fail(`${path}.${key}`);
}
const requiredTexts = (value: Data, path: string, keys: string[]) => keys.forEach(key => text(value[key], `${path}.${key}`));

function plan(value: Data, path: string): void {
  if (value.research !== undefined) {
    try { validatePlanResearch(value.research as PlanResearchBundle, value.research?.subject); } catch { fail(`${path}.research`); }
  }
  fields(value, path, ['status', 'shortTitle', 'summary', 'startDate', 'targetDate', 'portfolioPriority', 'autoAdjustPolicy', 'updatedAt'], ['schemaVersion', 'weeklyBudgetMinutes', 'dailyStudyMinutes']);
  weekdays(value, path, 'activeWeekdays');
  nested(value, 'conditions', path, (row, key) => fields(row, key,
    ['goalEvidence', 'startingLevel', 'pace', 'preferredTimeOfDay', 'deadlineMode', 'reviewCadence', 'constraintNotes'], ['preferredSessionMinutes']));
  rows(value, 'milestones', path, (row, key) => {
    requiredTexts(row, key, ['id', 'title', 'dueDate']);
    fields(row, key, ['projectId', 'completedAt'], [], ['completed']); stringFields(row, key, ['criteria']);
  });
  rows(value, 'phaseWindows', path, (row, key) => {
    requiredTexts(row, key, ['projectId', 'startDate', 'endDate']); fields(row, key, ['outcome'], ['order']);
  });
}

function textbook(value: Data, path: string): void {
  fields(value, path, ['textbookId', 'projectNoteId', 'rootProjectId', 'regionId', 'revisionId', 'createdAt', 'updatedAt', 'generationJobId'], ['schemaVersion']);
  rows(value, 'chapters', path, (row, key) => requiredTexts(row, key, ['id', 'title']));
  rows(value, 'sources', path, (row, key) => {
    requiredTexts(row, key, ['sourceId', 'kind', 'id', 'title', 'version']);
    fields(row, key, ['blockId'], ['textStart', 'textEnd']);
    nested(row, 'locator', key, (locator, label) => {
      fields(locator, label, ['kind'], ['charStart', 'charEnd', 'page', 'blockIndex', 'tableIndex', 'paragraphIndex', 'runStart', 'runEnd', 'slideIndex', 'shapeIndex'], ['notes']);
      if (locator.bbox !== undefined && (!Array.isArray(locator.bbox) || locator.bbox.length !== 4
        || locator.bbox.some((part: unknown) => typeof part !== 'number' || !Number.isFinite(part)))) fail(`${label}.bbox`);
    });
    nested(row, 'web', key, (web, label) => fields(web, label,
      ['snapshotId', 'url', 'finalUrl', 'readAt', 'contentType', 'format', 'transcriptUrl', 'contentKind', 'acquisition', 'coverage']));
  });
  rows(value, 'assets', path, (row, key) => {
    requiredTexts(row, key, ['id', 'sourceId', 'docId', 'version', 'blockId', 'alt']);
    fields(row, key, ['attachmentHash', 'originUrl'], ['imageIndex']);
  });
}

function sourceRef(value: Data, path: string): void {
  fields(value, path, ['type', 'entityId', 'chunkId', 'title', 'quote', 'verifiedAt']); stringFields(value, path, ['sectionPath']);
}
function argumentNode(value: Data, path: string): void {
  requiredTexts(value, path, ['id', 'text']);
  fields(value, path, ['mainType', 'role', 'status', 'subTypes', 'asrNote'], [], ['user_edited', 'collapsed']);
  for (const key of ['issue', 'suggestion']) if (value[key] !== undefined && value[key] !== null) text(value[key], `${path}.${key}`);
  if (value.severity !== undefined && value.severity !== null && (typeof value.severity !== 'number' || !Number.isFinite(value.severity))) fail(`${path}.severity`);
  nested(value, 'position', path, (row, key) => {
    if (typeof row.x !== 'number' || !Number.isFinite(row.x) || typeof row.y !== 'number' || !Number.isFinite(row.y)) fail(key);
  });
  rows(value, 'sources', path, sourceRef);
}
function argumentEdge(value: Data, path: string): void {
  requiredTexts(value, path, ['id', 'source', 'target']); fields(value, path, ['relation', 'reason']);
}
function assessment(value: Data, path: string): void {
  fields(value, path, ['admission', 'evidenceGrade', 'evaluatedAt', 'revisionHash'], ['version', 'score']);
  rows(value, 'issues', path, (row, key) => {
    fields(row, key, ['id', 'code', 'severity', 'message', 'suggestion', 'nodeId', 'edgeId', 'reason', 'category', 'explanation', 'suggestedAction', 'suggestedText']);
    nested(row, 'target', key, (target, label) => fields(target, label, ['kind', 'id']));
  });
  rows(value, 'targetSnapshots', path, (row, key) => {
    fields(row, key, ['fingerprint']); nested(row, 'target', key, (target, label) => fields(target, label, ['kind', 'id']));
  });
  nested(value, 'dimensions', path, (row, key) => fields(row, key, [], ['structure', 'clarity', 'relationCorrectness', 'coverage', 'consistency']));
}
function argumentDoc(value: Data, path: string): void {
  requiredTexts(value, path, ['doc_id']);
  fields(value, path, ['title', 'created_at', 'updated_at', 'status', 'summary'], ['iteration']);
  rows(value, 'nodes', path, argumentNode, true); rows(value, 'edges', path, argumentEdge, true);
  nested(value, 'scores', path, (row, key) => fields(row, key, [], ['conceptScore', 'judgmentScore', 'logicScore']));
  if (value.flowStructure !== undefined) readFlowStructure(value.flowStructure);
  nested(value, 'structureReview', path, (row, key) => {
    fields(row, key, ['graphKey', 'reviewedAt', 'mode'], ['version']);
    rows(row, 'nodes', key, (check, label) => requiredTexts(check, label, ['id', 'state', 'reason']), true);
    rows(row, 'edges', key, (check, label) => requiredTexts(check, label, ['id', 'state', 'reason']), true);
    stringFields(row, key, ['checkedNodes', 'checkedEdges', 'pendingNodes', 'pendingEdges', 'warnings']);
  });
  nested(value, 'structureReviewBase', path, (row, key) => {
    rows(row, 'nodes', key, (item, label) => requiredTexts(item, label, ['id', 'key']), true);
    rows(row, 'edges', key, (item, label) => requiredTexts(item, label, ['id', 'key', 'source', 'target', 'relation']), true);
  });
  nested(value, 'rag', path, (row, key) => {
    for (const name of ['draftAssessment', 'semanticAssessment', 'evidenceAssessment']) nested(row, name, key, assessment);
    for (const name of ['issueDecisions', 'qualityAudit']) rows(row, name, key, () => {});
    nested(row, 'publishedSnapshot', key, (snapshot, label) => {
      fields(snapshot, label, ['revisionHash', 'title', 'summary', 'effectiveAdmission', 'publishedAt']);
      rows(snapshot, 'nodes', label, argumentNode, true); rows(snapshot, 'edges', label, argumentEdge, true);
      for (const name of ['assessment', 'semanticAssessment', 'evidenceAssessment']) nested(snapshot, name, label, assessment);
      rows(snapshot, 'issueDecisions', label, () => {});
    });
  });
}

function evidence(value: Data, path: string): void {
  fields(value, path, ['state', 'lastObservedAt', 'lastConfirmedAt'], ['independentPasses', 'unresolvedFailures']); stringFields(value, path, ['recentEvidenceIds']);
}
function dsr(value: Data, path: string): void {
  fields(value, path, ['lastPracticedAt', 'conceptMasteryUpdatedAt'],
    ['difficulty', 'stability', 'reviewCount', 'consecutiveCorrect', 'consecutiveWrong', 'conceptMastery', 'conceptMasterySamples']);
  if (value.lastReviewedAt !== undefined && value.lastReviewedAt !== null) text(value.lastReviewedAt, `${path}.lastReviewedAt`);
  stringFields(value, path, ['practiceSessionIds', 'reviewSessionIds']);
  nested(value, 'masteryShadow', path, (row, key) => {
    fields(row, key, ['knowledgePointId', 'updatedAt'], ['version']); stringFields(row, key, ['appliedObservationIds']);
    const layers = object(row.layers, `${key}.layers`);
    for (const name of ['concept', 'judgment', 'reasoning']) {
      const layer = object(layers[name], `${key}.layers.${name}`); evidence(layer, `${key}.layers.${name}`);
      nested(layer, 'legacySummary', key, evidence);
      nested(layer, 'criteria', key, (criteria, label) => Object.entries(criteria).forEach(([id, item]) => evidence(object(item, `${label}.${id}`), `${label}.${id}`)));
    }
    nested(row, 'migration', key, (migration, label) => {
      fields(migration, label, ['kind', 'migrationId', 'migratedAt', 'sourceUpdatedAt'], ['version', 'sourceScore', 'sourceSamples', 'estimatedLevel']);
      stringFields(migration, label, ['activeLayers']);
      nested(migration, 'thresholds', label, (thresholds, name) => fields(thresholds, name, [], ['concept', 'judgment', 'reasoning']));
    });
  });
}

/** Validate fields that readers iterate or treat as text, without normalizing or
 * discarding historical data. Missing optional fields and unknown fields remain
 * untouched, so old JSON exports retain their original metadata. */
export function assertOptionalBackupNoteData(note: Data): void {
  fields(note, '笔记', ['projectRole', 'color', 'flowSummary', 'aiAnalyzedAt', 'lastReferencedAt', 'planOutcome']);
  nested(note, 'planMeta', '笔记', plan); nested(note, 'textbook', '笔记', textbook); nested(note, 'dsrState', '笔记', dsr);
  nested(note, 'textbookReadingState', '笔记', (row, key) => fields(row, key, ['revisionId', 'blockAnchor', 'lastReadAt'], ['scrollTop']));
  nested(note, 'learningContentMigration', '笔记', (row, key) => {
    fields(row, key, ['originalContent'], ['schemaVersion']); stringFields(row, key, ['originalArgumentDocIds']);
  });
  rows(note, 'dueDates', '笔记', (task, key) => {
    fields(task, key, ['completedAt', 'originalDueDate', 'autoAdjustedAt', 'autoAdjustmentReason', 'completionAdjustmentAppliedAt', 'kind', 'startDate', 'capacityKind', 'milestoneId', 'source', 'executionKind', 'linkedProjectId', 'launchMode'], ['estimatedMinutes', 'order', 'reminderMinutes']);
    stringFields(task, key, ['dependencyTaskIds', 'linkedKnowledgeIds', 'completedOccurrenceDates']);
    nested(task, 'recurrence', key, (row, label) => {
      fields(row, label, ['frequency', 'timeOfDay', 'endDate', 'missedPolicy'], ['interval']); weekdays(row, label, 'weekdays');
    });
  });
  rows(note, 'resources', '笔记', (row, key) => {
    requiredTexts(row, key, ['title', 'url']);
    fields(row, key, ['platform', 'projectTitle', 'kind', 'collectionOrigin', 'fileType', 'documentId', 'sourceUrl', 'taskText', 'reason', 'level', 'language', 'verifiedAt', 'candidateId', 'sourcePageUrl', 'contentType', 'suggestedFileName', 'fileExtension', 'resourceType', 'detectedFrom', 'description', 'accessType', 'browserSessionId', 'browserPartition', 'authContainerId'], ['contentLength', 'accessHttpStatus'], ['isFree', 'isAttachment', 'downloadable', 'indexable']);
    stringFields(row, key, ['knowledgeTitles']);
  });
  rows(note, 'referenceSources', '笔记', (row, key) => {
    requiredTexts(row, key, ['title']); fields(row, key, ['sourceId', 'type', 'url', 'entityId', 'sectionPath', 'snippet']);
  });
  rows(note, 'questions', '笔记', (row, key) => {
    requiredTexts(row, key, ['id', 'question']); fields(row, key, ['answer', 'noteId', 'createdAt', 'answeredAt']);
  });
  rows(note, 'learningReviewRecords', '笔记', (row, key) => {
    requiredTexts(row, key, ['id', 'title', 'projectNoteId']);
    fields(row, key, ['sessionId', 'rootProjectId', 'textbookRevisionId', 'startedAt', 'endedAt', 'rawRestatement', 'editedRestatement', 'summary', 'analysisSummary', 'episodeId', 'masteryInputKey', 'argumentRestatementKey', 'status', 'error', 'createdAt', 'updatedAt'], ['schemaVersion'], ['userEditedTitle', 'userEditedRestatement', 'expanded']);
    strings(row.argumentDocIds, `${key}.argumentDocIds`);
    nested(row, 'masteryAssessment', key, (batch, label) => {
      fields(batch, label, ['mode', 'sessionId', 'projectNoteId', 'observedAt', 'rawTextKey'], ['schemaVersion']); rows(batch, 'items', label, () => {}, true);
    });
  });
  rows(note, 'argumentDocs', '笔记', argumentDoc);
}
