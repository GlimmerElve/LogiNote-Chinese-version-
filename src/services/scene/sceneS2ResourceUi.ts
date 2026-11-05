import type { S2PluginHost } from './sceneS2PluginHost';
import type { S2Document } from '../../types/sceneS2';
import { S2PluginProtocolError } from './sceneS2PluginProtocol';

export type S2TextResourceUi = Pick<S2PluginHost, 'textResourceSummary' | 'approveTextFile' | 'revokeTextFile'>;
export type S2ImageResourceUi = Pick<S2PluginHost, 'imageResourceSummary' | 'imageResourcePreview' | 'approveImageFile' | 'revokeImageFile'>;
export type S2NoteResourceUi = Pick<S2PluginHost, 'projectNoteSummary' | 'projectNoteChoices' | 'approveProjectNote' | 'revokeProjectNote'>;
const adapters = new WeakMap<S2PluginHost, { text: S2TextResourceUi; image: S2ImageResourceUi }>();
const snapshots = new WeakMap<S2Document, S2Document>();

/** Stable per immutable host revision, detached from the canvas and readonly in a package slot. */
export function s2ResourceUiDocument(document: S2Document) {
  let copy = snapshots.get(document);
  if (!copy) {
    copy = structuredClone(document);
    const seen = new WeakSet<object>();
    const freeze = (value: unknown) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value); Object.values(value).forEach(freeze); Object.freeze(value);
    };
    freeze(copy); snapshots.set(document, copy);
  }
  return copy;
}

/** Renderable slots can expose React props to package code. Pass a resource-only facade,
 * never the execution host or model-confirmation methods. File reads remain workflow operations. */
export function s2ResourceUi(host: S2PluginHost | null) {
  if (!host) return null;
  let adapter = adapters.get(host);
  if (!adapter) {
    adapter = Object.freeze({
      text: Object.freeze({
        textResourceSummary: () => host.textResourceSummary(),
        approveTextFile: (file: Parameters<S2PluginHost['approveTextFile']>[0]) => host.approveTextFile(file),
        revokeTextFile: (id: string) => host.revokeTextFile(id),
      }),
      image: Object.freeze({
        imageResourceSummary: () => host.imageResourceSummary(),
        imageResourcePreview: (id: string) => host.imageResourcePreview(id),
        approveImageFile: (file: Parameters<S2PluginHost['approveImageFile']>[0]) => host.approveImageFile(file),
        revokeImageFile: (id: string) => host.revokeImageFile(id),
      }),
    });
    adapters.set(host, adapter);
  }
  return adapter;
}

/** Stable resource-only facade. Merely rendering/listing never creates a session;
 * an actual file choice acquires it through the guarded owner callback. */
export function s2LazyResourceUi(readHost: () => S2PluginHost | null, acquireHost: () => S2PluginHost,
  readNoteChoices: S2NoteResourceUi['projectNoteChoices'] = () => []) {
  return Object.freeze({
    text: Object.freeze({
      textResourceSummary: () => readHost()?.textResourceSummary() ?? [],
      approveTextFile: (file: Parameters<S2PluginHost['approveTextFile']>[0]) => acquireHost().approveTextFile(file),
      revokeTextFile: (id: string) => { readHost()?.revokeTextFile(id); },
    }),
    note: Object.freeze({
      projectNoteSummary: () => readHost()?.projectNoteSummary() ?? [],
      projectNoteChoices: () => readHost()?.projectNoteChoices() ?? readNoteChoices(),
      approveProjectNote: (id: string) => acquireHost().approveProjectNote(id),
      revokeProjectNote: (id: string) => { readHost()?.revokeProjectNote(id); },
    }),
    image: Object.freeze({
      imageResourceSummary: () => readHost()?.imageResourceSummary() ?? [],
      imageResourcePreview: (id: string) => { const host = readHost(); if (!host) throw new S2PluginProtocolError('RUN_ENDED', id, '图片所属会话不可用'); return host.imageResourcePreview(id); },
      approveImageFile: (file: Parameters<S2PluginHost['approveImageFile']>[0]) => acquireHost().approveImageFile(file),
      revokeImageFile: (id: string) => { readHost()?.revokeImageFile(id); },
    }),
  });
}
