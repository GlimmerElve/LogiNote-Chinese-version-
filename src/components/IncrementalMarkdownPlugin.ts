import { $getRoot, DecoratorNode, type LexicalEditor } from 'lexical';
import { realmPlugin, exportVisitors$, jsxComponentDescriptors$, jsxIsAvailable$, markdown$, markdownProcessingError$, initialMarkdownNormalize$, muteChange$ } from '@mdxeditor/editor';
import { mdxRuntime, MDX_IMPORT_TAG } from './mdxRuntime';
import { createIncrementalMarkdownExport } from './incrementalMarkdownExport';

/** Replaces only core's export subscription, before any application plugins are
 * installed. All commands, selection listeners, transforms and history remain
 * upstream-owned. An unknown core layout keeps upstream behavior unchanged. */
export const incrementalMarkdownPlugin = realmPlugin<{ onImport?: (markdown: string) => void }>({ init(realm, params) {
  if (!mdxRuntime.rootEditorSubscriptions$ || !mdxRuntime.toMarkdownExtensions$ || !mdxRuntime.toMarkdownOptions$) return;
  let subscriptions: Array<(editor: LexicalEditor) => () => void>;
  const candidates: number[] = [];
  try {
    subscriptions = realm.getValue(mdxRuntime.rootEditorSubscriptions$);
    subscriptions.forEach((subscribe, index) => {
      subscribe({ registerCommand: () => () => {}, registerUpdateListener: (listener: Function) => {
        // Public payload field names survive production minification. Do not
        // replace an unrelated future core update listener by its array index.
        if (/dirtyElements/u.test(String(listener)) && /dirtyLeaves/u.test(String(listener))) candidates.push(index);
        return () => {};
      } } as unknown as LexicalEditor)();
    });
  } catch { return; }
  if (candidates.length !== 1) return;
  const index = candidates[0], upstream = subscriptions[index];
  realm.pub(mdxRuntime.rootEditorSubscriptions$, subscriptions.map((subscribe, position) => position !== index ? subscribe : (editor: LexicalEditor) => {
    const cache = createIncrementalMarkdownExport();
    // Bind all real editor methods: the upstream trailing-decorator repair must
    // never write to a fake/proxy editor or create a separate history instance.
    const proxy = new Proxy(editor, { get(target, key) {
      if (key === 'registerUpdateListener') return (original: Parameters<LexicalEditor['registerUpdateListener']>[0]) => target.registerUpdateListener(payload => {
        if (realm.getValue(markdownProcessingError$) !== null || !payload.dirtyElements.size && !payload.dirtyLeaves.size) return;
        const importing = payload.tags.has(MDX_IMPORT_TAG) || realm.getValue(initialMarkdownNormalize$) || realm.getValue(muteChange$);
        let markdown: string | undefined;
        try {
          payload.editorState.read(() => {
            const root = $getRoot(); if (root.getLastChild() instanceof DecoratorNode) return;
            markdown = cache.export({ root, visitors: realm.getValue(exportVisitors$), jsxComponentDescriptors: realm.getValue(jsxComponentDescriptors$),
              jsxIsAvailable: realm.getValue(jsxIsAvailable$), toMarkdownExtensions: realm.getValue(mdxRuntime.toMarkdownExtensions$),
              toMarkdownOptions: realm.getValue(mdxRuntime.toMarkdownOptions$) }, payload.dirtyElements, payload.dirtyLeaves);
          });
        } catch { cache.reset(); }
        if (markdown === undefined) { original(payload); if (importing) params?.onImport?.(realm.getValue(markdown$)); return; }
        if (importing) params?.onImport?.(markdown.trim());
        realm.pub(markdown$, markdown.trim()); realm.pub(initialMarkdownNormalize$, false);
      });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return upstream(proxy);
  }));
} });
