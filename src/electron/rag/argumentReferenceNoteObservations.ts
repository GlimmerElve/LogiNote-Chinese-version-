import { createHash } from 'node:crypto';
import type { NoteItem } from '../../types.ts';
import type { ArgumentSourceIdentity } from '../../services/argumentContext/types.ts';

/** Same canonicalization/identity as the source adapter, without async model or disk work. */
export function argumentReferenceSavedNoteVersion(note: NoteItem): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, canonical(value)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical({ contract: 'saved-note-content-identity-v2', noteId: note.id,
    noteType: note.noteType, title: note.title, canonicalText: note.content, createdAt: note.createdAt,
    referenceSources: note.referenceSources ?? [] })), 'utf8').digest('hex');
}
export interface ArgumentReferenceNoteObservationStart { sequence: number; barrier: number }
export interface ArgumentReferenceNoteObservation extends ArgumentReferenceNoteObservationStart {
  notes: { id: string; version: string; changedAt: number }[];
}
/** Serializes complete application snapshot observations, outside the source lock. */
export function createArgumentReferenceNoteSnapshotQueue() {
  let tail = Promise.resolve();
  function run<T>(action: () => Promise<T>): Promise<T> {
    const job = tail.then(action); tail = job.then(() => undefined, () => undefined); return job;
  }
  return { run };
}
/**
 * Host-only application-observed content transitions. An upcoming full snapshot is
 * compared with saved previous content, not personal timestamps or global saveState.
 * A → B → A preserves a changed revision even if no model-phase read observed B.
 * Bounds retain current note IDs; deleted IDs cannot revive an old observation, and
 * re-additions get a new changed revision. Root/reset revocation resets this instance.
 */
export function createArgumentReferenceNoteObservations() {
  let sequence = 0, barrier = 0;
  let notes = new Map<string, { version: string; changedAt: number }>();
  const limit = 20000;
  function begin(): ArgumentReferenceNoteObservationStart { return { sequence, barrier }; }
  function reset(): void { barrier++; sequence = 0; notes.clear(); }
  function current(observation: ArgumentReferenceNoteObservation): boolean {
    return observation.barrier === barrier && observation.notes.every(item => {
      const actual = notes.get(item.id); return actual?.version === item.version && actual.changedAt === item.changedAt;
    });
  }
  function capture(start: ArgumentReferenceNoteObservationStart, sources: ArgumentSourceIdentity[]): ArgumentReferenceNoteObservation {
    if (start.barrier !== barrier) throw new Error('argument_reference_build_source_changed');
    const selected = new Map<string, string>();
    for (const source of sources) if (source.kind === 'knowledge-note') {
      const existing = selected.get(source.entityId);
      if (existing !== undefined && existing !== source.version) throw new Error('argument_reference_build_source_changed');
      selected.set(source.entityId, source.version);
    }
    const captured = [...selected].map(([id, version]) => {
      const actual = notes.get(id);
      if (actual && (actual.version !== version || actual.changedAt > start.sequence)) throw new Error('argument_reference_build_source_changed');
      if (!actual) {
        if (notes.size >= limit) throw new Error('argument_reference_build_capacity');
        notes.set(id, { version, changedAt: 0 });
      }
      return { id, version, changedAt: notes.get(id)!.changedAt };
    });
    return { ...start, notes: captured };
  }
  function versions(snapshot: NoteItem[]): Map<string, string> {
    const mapped = new Map<string, string>();
    for (const note of snapshot) {
      if (!note || typeof note.id !== 'string' || typeof note.content !== 'string' || mapped.has(note.id)) {
        throw new Error('argument_reference_build_invalid_request');
      }
      mapped.set(note.id, argumentReferenceSavedNoteVersion(note));
    }
    return mapped;
  }
  function observe(nextValue: NoteItem[], previousValue: NoteItem[]): void {
    // Capture both host snapshots synchronously, before any caller can await/save.
    const next = structuredClone(nextValue), previous = structuredClone(previousValue);
    if (!Array.isArray(next) || !Array.isArray(previous)) throw new Error('argument_reference_build_invalid_request');
    if (next.length > limit || previous.length > limit || sequence >= Number.MAX_SAFE_INTEGER - limit * 2) { reset(); return; }
    const prior = versions(previous), after = versions(next), updated = new Map<string, { version: string; changedAt: number }>();
    for (const id of new Set([...prior.keys(), ...after.keys(), ...notes.keys()])) {
      const known = notes.get(id), previousVersion = prior.get(id), nextVersion = after.get(id);
      let changedAt = known?.changedAt ?? 0;
      // A differing saved previous version is already an observed change (including
      // a prior external edit); restoring our old version cannot erase that change.
      if (known && known.version !== previousVersion) changedAt = ++sequence;
      if (previousVersion !== nextVersion) changedAt = ++sequence;
      if (nextVersion !== undefined) updated.set(id, { version: nextVersion, changedAt });
    }
    notes = updated;
  }
  /** Partial save: unmentioned sources retain their identity/revision. */
  function observeDelta(nextValue: NoteItem[], previousValue: NoteItem[]): void {
    const next = structuredClone(nextValue), previous = structuredClone(previousValue);
    if (!Array.isArray(next) || !Array.isArray(previous)) throw new Error('argument_reference_build_invalid_request');
    if (next.length > limit || previous.length > limit || sequence >= Number.MAX_SAFE_INTEGER - limit * 2) { reset(); return; }
    const prior = versions(previous), after = versions(next);
    for (const id of new Set([...prior.keys(), ...after.keys()])) {
      const known = notes.get(id), previousVersion = prior.get(id), nextVersion = after.get(id);
      let changedAt = known?.changedAt ?? 0;
      if (known && known.version !== previousVersion) changedAt = ++sequence;
      if (previousVersion !== nextVersion) changedAt = ++sequence;
      if (nextVersion === undefined) notes.delete(id);
      else {
        if (!notes.has(id) && notes.size >= limit) { reset(); return; }
        notes.set(id, { version: nextVersion, changedAt });
      }
    }
  }
  return { begin, capture, current, observe, observeDelta, reset };
}
