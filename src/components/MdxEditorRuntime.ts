import type { Realm } from '@mdxeditor/gurx';
import type { RealmPlugin } from '@mdxeditor/editor';
import { argumentBlockPlugin } from './ArgumentBlockNode';
import { learningReviewBlockPlugin } from './textbook/LearningReviewBlockNode';
import type { LearningReviewPatch } from '../services/textbook/types';

type ArgumentHandlers = NonNullable<Parameters<typeof argumentBlockPlugin>[0]>;
type ReviewHandlers = NonNullable<Parameters<typeof learningReviewBlockPlugin>[0]>;
export interface MdxEditorCallbacks {
  onWikiLinkClick?: (title: string) => void;
  onArgumentBlockEdit?: (id: string) => void;
  onArgumentBlockDelete?: (id: string) => void;
  getArgumentDoc?: ArgumentHandlers['getDoc'];
  getLearningReviewRecord?: ReviewHandlers['getRecord'];
  onLearningReviewPatch?: (id: string, patch: LearningReviewPatch) => void | Promise<void>;
}

// Only values actually requested by this editor's decorators are observed. In
// particular, a plain-text editor never enumerates notes or their graph arrays.
// Keep a value snapshot as well as identity: an external caller may update a
// graph/review in place before publishing its next React snapshot. Retain seen
// IDs until this editor is disposed, including IDs reachable through undo.
// An upstream setMarkdown(sameText) is a no-op and must not drop their refresh.
function observedValues<T>() {
  const values = new Map<string, { signature: string | undefined; view: T }>();
  let changedDuringRead = false;
  const capture = (value: T, signature: string | undefined) => ({ signature,
    // Decorators memoize graph node/edge arrays. A view snapshot is created only
    // when this used value changes, so an in-place external edit cannot hide
    // behind the previous arrays' identity. Stored authority is never mutated.
    view: signature === undefined ? value : JSON.parse(signature) as T,
  });
  const remember = (id: string, value: T) => {
    const signature = JSON.stringify(value), previous = values.get(id);
    if (previous && previous.signature === signature) return previous.view;
    if (previous) changedDuringRead = true;
    const next = capture(value, signature); values.set(id, next); return next.view;
  };
  return {
    remember,
    refresh(resolve: (id: string) => T) {
      // One duplicate decorator may have read new data before the parent effect.
      // Still notify its siblings rather than consuming that invalidation here.
      let changed = changedDuringRead; changedDuringRead = false;
      for (const [id, previous] of values) {
        const value = resolve(id), signature = JSON.stringify(value);
        if (signature !== previous.signature) { values.set(id, capture(value, signature)); changed = true; }
      }
      return changed;
    },
    clear: () => { values.clear(); changedDuringRead = false; },
  };
}

/** Editor-local data refresh; never installs schema or touches Lexical history. */
export function createMdxEditorRuntime(getCallbacks: () => MdxEditorCallbacks) {
  let realm: Realm | undefined;
  const argumentsUsed = observedValues<ReturnType<NonNullable<ArgumentHandlers['getDoc']>>>();
  const reviewsUsed = observedValues<ReturnType<NonNullable<ReviewHandlers['getRecord']>>>();
  const argument: ArgumentHandlers = {
    onClick: id => getCallbacks().onArgumentBlockEdit?.(id),
    onDelete: id => getCallbacks().onArgumentBlockDelete?.(id),
    getDoc: id => argumentsUsed.remember(id, getCallbacks().getArgumentDoc?.(id)),
  };
  const review: ReviewHandlers = {
    getRecord: id => reviewsUsed.remember(id, getCallbacks().getLearningReviewRecord?.(id)),
    onPatch: (id, patch) => getCallbacks().onLearningReviewPatch?.(id, patch),
  };
  const plugin: RealmPlugin = { init: value => { realm = value; } };
  return {
    plugin,
    nodeCallbacks: { wiki: { onClick: (title: string) => getCallbacks().onWikiLinkClick?.(title) }, argument, review },
    refresh() {
      // Publishing a new handlers value notifies only the existing decorators.
      // realmPlugin.update is its supported runtime API; init must not run again.
      if (argumentsUsed.refresh(id => getCallbacks().getArgumentDoc?.(id)) && realm) {
        argumentBlockPlugin({ ...argument }).update?.(realm);
      }
      if (reviewsUsed.refresh(id => getCallbacks().getLearningReviewRecord?.(id)) && realm) {
        learningReviewBlockPlugin({ ...review }).update?.(realm);
      }
    },
    disconnect() { realm = undefined; argumentsUsed.clear(); reviewsUsed.clear(); },
  };
}
