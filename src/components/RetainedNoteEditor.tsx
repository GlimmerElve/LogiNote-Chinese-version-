import React, { useRef } from 'react';
import { NoteEditor } from './NoteEditor';
import { shouldPublishNoteSnapshot } from '../services/ui/noteSnapshotPublication';

type EditorProps = React.ComponentProps<typeof NoteEditor>;
type Props = EditorProps & { publication?: EditorProps['allNotes'] };

function sameProps(before: EditorProps, after: EditorProps): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as Array<keyof EditorProps>);
  for (const key of keys) {
    if (key === 'headingRequest') {
      if (before.headingRequest?.key !== after.headingRequest?.key || before.headingRequest?.heading !== after.headingRequest?.heading) return false;
    } else if (before[key] !== after[key]) return false;
  }
  return true;
}

/** Keep the same editor/undo tree mounted. Hidden pages accept one deactivation
 * commit, then catch up with the latest props only when shown again. Callback
 * proxies remain live even while a hidden page's registered capture is retained. */
export function RetainedNoteEditor(props: Props) {
  const latest = useRef(props); latest.current = props;
  const proxies = useRef(new Map<keyof EditorProps, (...args: any[]) => any>());
  const { publication, ...bound } = props;
  for (const key of Object.keys(bound) as Array<keyof EditorProps>) {
    if (typeof props[key] !== 'function') continue;
    if (!proxies.current.has(key)) proxies.current.set(key, (...args: any[]) => {
      const callback = latest.current[key];
      return typeof callback === 'function' ? (callback as (...values: any[]) => any)(...args) : undefined;
    });
    (bound as Record<string, unknown>)[key] = proxies.current.get(key);
  }
  const visible = props.isVisible ?? props.isActive ?? true;
  const cached = useRef<{ props: EditorProps; publication?: Props['publication']; visible: boolean; element: React.ReactElement } | undefined>(undefined);
  const previous = cached.current;
  const identityChanged = previous?.props.note?.id !== props.note?.id;
  const capabilityChanged = previous && [...new Set([...Object.keys(previous.props), ...Object.keys(bound)] as Array<keyof EditorProps>)]
    .some(key => (typeof previous.props[key] === 'function') !== (typeof bound[key] === 'function'));
  if (previous && publication !== undefined && publication === previous.publication && !identityChanged
    && visible === previous.visible && props.isActive === previous.props.isActive
    && props.contentVersion === previous.props.contentVersion
    && (props.note && previous.props.note ? !shouldPublishNoteSnapshot([previous.props.note], [props.note]) : props.note === previous.props.note)) {
    // A first keystroke changes save feedback, not the published directory.
    // Preserve the live editor's data inputs until a real publication or focus
    // boundary, so deriving project context is not moved back into typing.
    bound.note = previous.props.note; bound.allNotes = previous.props.allNotes;
  }
  if (!previous || identityChanged || capabilityChanged || visible !== previous.visible || visible && !sameProps(previous.props, bound)) {
    cached.current = { props: bound, publication, visible, element: <NoteEditor {...bound} /> };
  } else if (previous.publication !== publication) {
    cached.current = { ...previous, publication };
  }
  return cached.current!.element;
}
