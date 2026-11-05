import type {
  SceneInteractionDiagnostic,
  SceneInteractionDiagnosticReason,
  SceneInteractionType,
} from '../../types';
import { readFreshAuditFile, auditRecord, assertAudit } from '../agent/auditRead';

import { normalizeSceneTurnAttemptDiagnostic, type SceneTurnAttemptDiagnostic } from './sceneTurnDiagnostics';

export interface SceneInteractionAuditEvent extends SceneInteractionDiagnostic {
  id: string;
  runId: string;
  sceneId: string;
  turnNumber: number;
  allowedTypes: SceneInteractionType[];
  createdAt: string;
  attempts?: SceneTurnAttemptDiagnostic[];
}

export interface SceneInteractionAuditFile {
  version: 1;
  events: SceneInteractionAuditEvent[];
}

export interface SceneInteractionAuditSummary {
  total: number;
  accepted: number;
  textFallbacks: number;
  noInteraction: number;
  fallbackRate: number;
  reasons: Partial<Record<SceneInteractionDiagnosticReason, number>>;
}

const STORAGE_KEY = 'loginote_scene_interaction_audit_v1';
const MAX_EVENTS = 500;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const INTERACTION_TYPES = new Set<SceneInteractionType>([
  'text',
  'single-choice',
  'multiple-choice',
  'ordering',
  'fill-blanks',
  'question-set',
]);
const REASONS = new Set<SceneInteractionDiagnosticReason>([
  'accepted',
  'conversation',
  'invalid-json',
  'empty-response',
  'missing-interaction',
  'invalid-interaction-shape',
  'missing-id',
  'unsupported-type',
  'disallowed-type',
  'invalid-fields',
  'scene-ended',
]);

function compact(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max);
}

function isInteractionType(value: unknown): value is SceneInteractionType {
  return typeof value === 'string' && INTERACTION_TYPES.has(value as SceneInteractionType);
}

function normalizeRequestedType(value: unknown): string | undefined {
  const requestedType = compact(value, 40).toLowerCase();
  if (!requestedType) return undefined;
  return /^[a-z][a-z0-9-]{0,39}$/.test(requestedType) ? requestedType : 'invalid';
}

function normalizeEvent(value: unknown, cutoff: number): SceneInteractionAuditEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<SceneInteractionAuditEvent>;
  const createdAt = compact(raw.createdAt, 40);
  const createdTime = Date.parse(createdAt);
  if (!compact(raw.id, 160) || !compact(raw.runId, 120) || !compact(raw.sceneId, 120)) return undefined;
  if (!Number.isFinite(createdTime) || createdTime < cutoff) return undefined;
  if (!Number.isInteger(raw.turnNumber) || Number(raw.turnNumber) < 0) return undefined;
  if (!REASONS.has(raw.reason as SceneInteractionDiagnosticReason)) return undefined;
  if (!['accepted', 'text-fallback', 'none'].includes(String(raw.outcome))) return undefined;
  if (raw.resolvedType !== 'none' && !isInteractionType(raw.resolvedType)) return undefined;

  return {
    id: compact(raw.id, 160),
    runId: compact(raw.runId, 120),
    sceneId: compact(raw.sceneId, 120),
    turnNumber: Number(raw.turnNumber),
    requestedType: normalizeRequestedType(raw.requestedType),
    resolvedType: raw.resolvedType,
    outcome: raw.outcome as SceneInteractionAuditEvent['outcome'],
    reason: raw.reason as SceneInteractionDiagnosticReason,
    allowedTypes: Array.isArray(raw.allowedTypes)
      ? [...new Set(raw.allowedTypes.filter(isInteractionType))].slice(0, 8)
      : [],
    createdAt,
    attempts: Array.isArray(raw.attempts) ? raw.attempts.slice(0,12).map(normalizeSceneTurnAttemptDiagnostic).filter((attempt): attempt is SceneTurnAttemptDiagnostic => Boolean(attempt)) : undefined,
  };
}

export function normalizeSceneInteractionAuditFile(
  value: unknown,
  now = Date.now(),
): SceneInteractionAuditFile {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SceneInteractionAuditFile>
    : {};
  const cutoff = now - RETENTION_MS;
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .map((event) => normalizeEvent(event, cutoff))
    .filter((event): event is SceneInteractionAuditEvent => Boolean(event))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_EVENTS);
  return { version: 1, events };
}

export function summarizeSceneInteractionAudit(
  events: SceneInteractionAuditEvent[],
): SceneInteractionAuditSummary {
  const reasons: SceneInteractionAuditSummary['reasons'] = {};
  for (const event of events) reasons[event.reason] = (reasons[event.reason] || 0) + 1;
  const accepted = events.filter((event) => event.outcome === 'accepted').length;
  const textFallbacks = events.filter((event) => event.outcome === 'text-fallback').length;
  const noInteraction = events.filter((event) => event.outcome === 'none').length;
  return {
    total: events.length,
    accepted,
    textFallbacks,
    noInteraction,
    fallbackRate: events.length ? Math.round((textFallbacks / events.length) * 1000) / 10 : 0,
    reasons,
  };
}

function api() {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as {
    electronAPI?: {
      userState?: {
        loadSceneInteractionAudit?: (strict?: boolean) => Promise<unknown>;
        saveSceneInteractionAudit?: (file: unknown) => Promise<void>;
      };
    };
  }).electronAPI?.userState;
}

let cache: SceneInteractionAuditFile | null = null;
let loadPromise: Promise<SceneInteractionAuditFile> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<void> = Promise.resolve();

function emptyFile(): SceneInteractionAuditFile {
  return { version: 1, events: [] };
}

function readLocal(): SceneInteractionAuditFile {
  if (typeof localStorage === 'undefined') return emptyFile();
  try {
    return normalizeSceneInteractionAuditFile(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return emptyFile();
  }
}

export async function loadSceneInteractionAudit(strict = false): Promise<SceneInteractionAuditFile> {
  if (strict) {
    await flushSceneInteractionAuditWrites();
    const native = api();
    return readFreshAuditFile(STORAGE_KEY, native?.loadSceneInteractionAudit ? () => native.loadSceneInteractionAudit!(true) : undefined,
      value => {
        const file = auditRecord(value);
        assertAudit(Array.isArray(file.events) && file.events.every(event => normalizeEvent(event, -Infinity)));
      }, normalizeSceneInteractionAuditFile);
  }
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const electron = api();
    if (electron?.loadSceneInteractionAudit) {
      try {
        const remote = await electron.loadSceneInteractionAudit();
        if (remote) {
          cache = normalizeSceneInteractionAuditFile(remote);
          if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
          return cache;
        }
      } catch (error) {
        console.warn('[scene-interaction-audit] load failed:', error);
      }
    }
    cache = readLocal();
    return cache;
  })();
  return loadPromise.finally(() => { loadPromise = null; });
}

async function save(file: SceneInteractionAuditFile): Promise<void> {
  cache = normalizeSceneInteractionAuditFile(file);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch (error) {
      console.warn('[scene-interaction-audit] local cache failed:', error);
    }
  }
  const electron = api();
  if (!electron?.saveSceneInteractionAudit) return;
  const next = cache;
  const write = writeQueue.then(() => electron.saveSceneInteractionAudit!(next));
  writeQueue = write.catch((error) => console.warn('[scene-interaction-audit] save failed:', error));
  await write;
}

export async function recordSceneInteractionAudit(input: {
  runId: string;
  sceneId: string;
  turnNumber: number;
  allowedTypes: SceneInteractionType[];
  diagnostic: SceneInteractionDiagnostic;
  attempts?: SceneTurnAttemptDiagnostic[];
}): Promise<void> {
  const createdAt = new Date().toISOString();
  const event: SceneInteractionAuditEvent = {
    id: `${compact(input.runId, 100)}:${input.turnNumber}:${Date.now().toString(36)}`,
    runId: compact(input.runId, 120),
    sceneId: compact(input.sceneId, 120),
    turnNumber: Math.max(0, Math.floor(input.turnNumber)),
    requestedType: normalizeRequestedType(input.diagnostic.requestedType),
    resolvedType: input.diagnostic.resolvedType,
    outcome: input.diagnostic.outcome,
    reason: input.diagnostic.reason,
    allowedTypes: [...new Set(input.allowedTypes.filter(isInteractionType))].slice(0, 8),
    createdAt,
  };
  const task = mutationQueue.then(async () => {
    const file = await loadSceneInteractionAudit();
    await save({ version: 1, events: [event, ...file.events] });
  });
  mutationQueue = task.catch((error) => console.warn('[scene-interaction-audit] mutation failed:', error));
  await task;
}

export async function listSceneInteractionAuditEvents(limit = 100): Promise<SceneInteractionAuditEvent[]> {
  const file = await loadSceneInteractionAudit();
  return file.events.slice(0, Math.max(0, Math.min(limit, MAX_EVENTS)));
}

export async function getSceneInteractionAuditSummary(): Promise<SceneInteractionAuditSummary> {
  return summarizeSceneInteractionAudit((await loadSceneInteractionAudit()).events);
}

export async function clearSceneInteractionAudit(): Promise<void> {
  const task = mutationQueue.then(() => save(emptyFile()));
  mutationQueue = task.catch((error) => console.warn('[scene-interaction-audit] clear failed:', error));
  await task;
}

export function flushSceneInteractionAuditWrites(): Promise<void> {
  return Promise.all([mutationQueue, writeQueue]).then(() => undefined);
}
