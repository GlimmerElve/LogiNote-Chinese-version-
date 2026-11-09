import type { ReadingInput } from './readingDocument';
import { createReadingDocumentSession } from './readingDocumentClient';

import type { ReadingViewport } from './readingViewport';
interface Session { dispose(): void; readonly isDisposed?: boolean; ready: Promise<unknown> }
interface Clock { setTimer(run: () => void, ms: number): unknown; clearTimer(timer: unknown): void }
const browserClock: Clock = { setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

/** Reuse recent parsing without retaining entire React views or an unbounded
 * document cache. Positions survive worker eviction, separately and cheaply. */
export function createRecentReadingSessions<S extends Session>(create: (input: ReadingInput) => S, clock: Clock = browserClock) {
  type Entry = { owner: string; input: ReadingInput; manifest: string; session: S; refs: number; reusable: boolean; touched: number; timer?: unknown };
  const entries = new Set<Entry>(), positions = new Map<string, ReadingViewport>();
  let sequence = 0;
  const cancelExpiry = (entry: Entry) => { if (entry.timer !== undefined) clock.clearTimer(entry.timer); entry.timer = undefined; };
  const retire = (entry: Entry) => {
    entry.reusable = false; cancelExpiry(entry);
    if (!entry.refs) { entries.delete(entry); entry.session.dispose(); }
  };
  const trim = () => {
    const idle = [...entries].filter(entry => !entry.refs).sort((a, b) => a.touched - b.touched);
    let units = idle.reduce((sum, entry) => sum + entry.input.content.length + entry.manifest.length, 0);
    while (idle.length > 2 || units > 300_000) {
      const oldest = idle.shift()!; units -= oldest.input.content.length + oldest.manifest.length; retire(oldest);
    }
  };
  return {
    acquire(owner: string, input: ReadingInput, fresh = false) {
      const manifest = JSON.stringify([input.manifest, input.citationIds || []]);
      let entry: Entry | undefined;
      for (const candidate of entries) {
        if (candidate.owner !== owner) continue;
        if (fresh || candidate.session.isDisposed || !candidate.reusable || candidate.input.content !== input.content || candidate.manifest !== manifest) retire(candidate);
        else entry = candidate;
      }
      if (!entry) {
        entry = { owner, input, manifest, session: create(input), refs: 0, reusable: true, touched: ++sequence };
        entries.add(entry);
        const created = entry;
        void created.session.ready.catch(() => { created.reusable = false; if (!created.refs) retire(created); });
      }
      const current = entry; cancelExpiry(current); current.refs++; current.touched = ++sequence;
      let released = false;
      return {
        session: current.session,
        getPosition(): ReadingViewport | undefined {
          const value = positions.get(owner); if (!value) return;
          positions.delete(owner); positions.set(owner, value); return { ...value };
        },
        remember(position: ReadingViewport) {
          if (released || !Number.isSafeInteger(position.block) || position.block < 0 || !Number.isFinite(position.offset) || position.offset < 0 || position.offset > 100_000_000
            || position.element !== undefined && (!Number.isSafeInteger(position.element) || position.element < 0)) return;
          positions.delete(owner); positions.set(owner, { ...position });
          while (positions.size > 64) positions.delete(positions.keys().next().value!);
        },
        release() {
          if (released) return; released = true; current.refs--; current.touched = ++sequence;
          if (current.refs) return;
          if (!current.reusable || current.session.isDisposed) { retire(current); return; }
          const expiry = clock.setTimer(() => { if (!current.refs && current.timer === expiry) retire(current); }, 60_000);
          current.timer = expiry; trim();
        },
      };
    },
    clear() { for (const entry of entries) { cancelExpiry(entry); entry.reusable = false; entry.session.dispose(); } entries.clear(); positions.clear(); },
  };
}

export const recentReadingSessions = createRecentReadingSessions(createReadingDocumentSession);
