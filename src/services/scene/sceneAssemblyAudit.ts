import type { SceneCapabilityId, SceneRecipeId } from '../../types';
import type { SceneAssemblyDiagnosticCode, SceneAssemblyResult } from './sceneAssembly';
import { normalizeSceneCapabilityId, normalizeUnifiedSceneRecipeId } from './sceneCapabilityRegistry';
import { readFreshAuditFile, auditRecord, assertAudit } from '../agent/auditRead';

export interface SceneAssemblyAuditEvent {
  id: string;
  sceneId: string;
  sceneSkill: 'S1' | 'S4';
  surface?: 'turn' | 'canvas';
  recipeId?: SceneRecipeId;
  requestedCapabilities: SceneCapabilityId[];
  enabledCapabilities: SceneCapabilityId[];
  missingCapabilities: SceneCapabilityId[];
  outcome: 'ready' | 'blocked';
  diagnosticCodes: SceneAssemblyDiagnosticCode[];
  createdAt: string;
}

export interface SceneAssemblyAuditFile {
  version: 1;
  events: SceneAssemblyAuditEvent[];
}

export interface SceneAssemblyAuditSummary {
  total: number;
  ready: number;
  blocked: number;
  blockedRate: number;
  diagnostics: Partial<Record<SceneAssemblyDiagnosticCode, number>>;
}

const STORAGE_KEY = 'loginote_scene_assembly_audit_v1';
const MAX_EVENTS = 500;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_CODES = new Set<SceneAssemblyDiagnosticCode>([
  'unknown-recipe', 'recipe-skill-mismatch', 'unknown-capability', 'capability-surface-mismatch',
  'missing-required-capability', 'preferred-capability-unavailable', 'legacy-scene', 'recipe-inferred',
  'missing-behavior', 'missing-interaction-capability', 'missing-compute', 'missing-operation',
  'missing-component-adapter',
  'missing-expected-formula', 'missing-symbol-table',
  'invalid-runtime-contract',
]);

function compact(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCapabilities(value: unknown): SceneCapabilityId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeSceneCapabilityId).filter((id): id is SceneCapabilityId => Boolean(id)))].slice(0, 24);
}

function normalizeEvent(value: unknown, cutoff: number): SceneAssemblyAuditEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<SceneAssemblyAuditEvent>;
  const createdAt = compact(raw.createdAt, 40);
  const createdTime = Date.parse(createdAt);
  const id = compact(raw.id, 160);
  const sceneId = compact(raw.sceneId, 120);
  if (!id || !sceneId || !Number.isFinite(createdTime) || createdTime < cutoff) return undefined;
  if (raw.sceneSkill !== 'S1' && raw.sceneSkill !== 'S4') return undefined;
  if (raw.surface !== undefined && raw.surface !== 'turn' && raw.surface !== 'canvas') return undefined;
  if (raw.outcome !== 'ready' && raw.outcome !== 'blocked') return undefined;
  const recipeId = normalizeUnifiedSceneRecipeId(raw.recipeId);
  const diagnosticCodes = Array.isArray(raw.diagnosticCodes)
    ? [...new Set(raw.diagnosticCodes.filter((code): code is SceneAssemblyDiagnosticCode => DIAGNOSTIC_CODES.has(code as SceneAssemblyDiagnosticCode)))].slice(0, 20)
    : [];
  return {
    id, sceneId, sceneSkill: raw.sceneSkill, surface: raw.surface, recipeId,
    requestedCapabilities: normalizeCapabilities(raw.requestedCapabilities),
    enabledCapabilities: normalizeCapabilities(raw.enabledCapabilities),
    missingCapabilities: normalizeCapabilities(raw.missingCapabilities),
    outcome: raw.outcome,
    diagnosticCodes,
    createdAt,
  };
}

export function normalizeSceneAssemblyAuditFile(value: unknown, now = Date.now()): SceneAssemblyAuditFile {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SceneAssemblyAuditFile>
    : {};
  const cutoff = now - RETENTION_MS;
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .map((event) => normalizeEvent(event, cutoff))
    .filter((event): event is SceneAssemblyAuditEvent => Boolean(event))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_EVENTS);
  return { version: 1, events };
}

export function summarizeSceneAssemblyAudit(events: SceneAssemblyAuditEvent[]): SceneAssemblyAuditSummary {
  const diagnostics: SceneAssemblyAuditSummary['diagnostics'] = {};
  for (const event of events) {
    for (const code of event.diagnosticCodes) diagnostics[code] = (diagnostics[code] || 0) + 1;
  }
  const ready = events.filter((event) => event.outcome === 'ready').length;
  const blocked = events.length - ready;
  return {
    total: events.length, ready, blocked,
    blockedRate: events.length ? Math.round((blocked / events.length) * 1000) / 10 : 0,
    diagnostics,
  };
}

function api() {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as {
    electronAPI?: { userState?: {
      loadSceneAssemblyAudit?: (strict?: boolean) => Promise<unknown>;
      saveSceneAssemblyAudit?: (file: unknown) => Promise<void>;
    } };
  }).electronAPI?.userState;
}

let cache: SceneAssemblyAuditFile | null = null;
let loadPromise: Promise<SceneAssemblyAuditFile> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<void> = Promise.resolve();

function emptyFile(): SceneAssemblyAuditFile { return { version: 1, events: [] }; }

function readLocal(): SceneAssemblyAuditFile {
  if (typeof localStorage === 'undefined') return emptyFile();
  try { return normalizeSceneAssemblyAuditFile(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
  catch { return emptyFile(); }
}

export async function loadSceneAssemblyAudit(strict = false): Promise<SceneAssemblyAuditFile> {
  if (strict) {
    await flushSceneAssemblyAuditWrites();
    const native = api();
    return readFreshAuditFile(STORAGE_KEY, native?.loadSceneAssemblyAudit ? () => native.loadSceneAssemblyAudit!(true) : undefined,
      value => {
        const file = auditRecord(value);
        assertAudit(Array.isArray(file.events) && file.events.every(event => normalizeEvent(event, -Infinity)));
      }, normalizeSceneAssemblyAuditFile);
  }
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const electron = api();
    if (electron?.loadSceneAssemblyAudit) {
      try {
        const remote = await electron.loadSceneAssemblyAudit();
        if (remote) {
          cache = normalizeSceneAssemblyAuditFile(remote);
          if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
          return cache;
        }
      } catch (error) { console.warn('[scene-assembly-audit] load failed:', error); }
    }
    cache = readLocal();
    return cache;
  })();
  return loadPromise.finally(() => { loadPromise = null; });
}

async function save(file: SceneAssemblyAuditFile): Promise<void> {
  cache = normalizeSceneAssemblyAuditFile(file);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); }
    catch (error) { console.warn('[scene-assembly-audit] local cache failed:', error); }
  }
  const electron = api();
  if (!electron?.saveSceneAssemblyAudit) return;
  const next = cache;
  const write = writeQueue.then(() => electron.saveSceneAssemblyAudit!(next));
  writeQueue = write.catch((error) => console.warn('[scene-assembly-audit] save failed:', error));
  await write;
}

export async function recordSceneAssemblyAudit(input: {
  sceneId: string;
  sceneSkill: 'S1' | 'S4';
  result: SceneAssemblyResult;
}): Promise<void> {
  const createdAt = new Date().toISOString();
  const event: SceneAssemblyAuditEvent = {
    id: `${compact(input.sceneId, 100)}:${Date.now().toString(36)}`,
    sceneId: compact(input.sceneId, 120),
    sceneSkill: input.sceneSkill,
    surface: input.result.surface,
    recipeId: input.result.recipeId,
    requestedCapabilities: input.result.requestedCapabilities,
    enabledCapabilities: input.result.enabledCapabilities,
    missingCapabilities: input.result.missingCapabilities,
    outcome: input.result.valid ? 'ready' : 'blocked',
    diagnosticCodes: uniqueDiagnosticCodes(input.result),
    createdAt,
  };
  const task = mutationQueue.then(async () => {
    const file = await loadSceneAssemblyAudit();
    await save({ version: 1, events: [event, ...file.events] });
  });
  mutationQueue = task.catch((error) => console.warn('[scene-assembly-audit] mutation failed:', error));
  await task;
}

function uniqueDiagnosticCodes(result: SceneAssemblyResult): SceneAssemblyDiagnosticCode[] {
  return [...new Set(result.diagnostics.map((item) => item.code))];
}

export async function listSceneAssemblyAuditEvents(limit = 100): Promise<SceneAssemblyAuditEvent[]> {
  return (await loadSceneAssemblyAudit()).events.slice(0, Math.max(0, Math.min(limit, MAX_EVENTS)));
}

export async function getSceneAssemblyAuditSummary(): Promise<SceneAssemblyAuditSummary> {
  return summarizeSceneAssemblyAudit((await loadSceneAssemblyAudit()).events);
}

export async function clearSceneAssemblyAudit(): Promise<void> {
  const task = mutationQueue.then(() => save(emptyFile()));
  mutationQueue = task.catch((error) => console.warn('[scene-assembly-audit] clear failed:', error));
  await task;
}

export function flushSceneAssemblyAuditWrites(): Promise<void> {
  return Promise.all([mutationQueue, writeQueue]).then(() => undefined);
}
