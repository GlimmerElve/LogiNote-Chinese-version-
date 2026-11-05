import { prepareReadingDocument, type ReadingDocument, type ReadingInput } from './readingDocument';
import { createReadingFormulaPreparer } from './readingFormula';

let document: ReadingDocument | undefined;
let prepareFormulas = createReadingFormulaPreparer();
const FRAGMENT_DOCUMENTS = 8, FRAGMENT_CHARACTERS = 128_000;
const fragments = new Map<string, { document: ReadingDocument; signature: string }>();
let fragmentCharacters = 0;
function forgetFragment(scope: string) {
  const previous = fragments.get(scope);
  if (previous) { fragmentCharacters -= previous.signature.length; fragments.delete(scope); }
}
function fragmentDocument(scope: string, input?: ReadingInput): ReadingDocument {
  const previous = fragments.get(scope);
  if (previous) {
    if (input && JSON.stringify(input) !== previous.signature) throw new Error('阅读片段来源已变化，请重新打开');
    fragments.delete(scope); fragments.set(scope, previous);
    return previous.document;
  }
  if (!input) throw new Error('阅读片段已释放，请重新请求原片段');
  const prepared = prepareReadingDocument(input), signature = JSON.stringify(input);
  // Include source/context bytes in the bound. Oversized fragments are served
  // once, never retained as an exception to the worker's raw-document budget.
  if (signature.length <= FRAGMENT_CHARACTERS) {
    fragments.set(scope, { document: prepared, signature }); fragmentCharacters += signature.length;
    while (fragments.size > FRAGMENT_DOCUMENTS || fragmentCharacters > FRAGMENT_CHARACTERS)
      forgetFragment(fragments.keys().next().value!);
  }
  return prepared;
}
self.onmessage = (event: MessageEvent<{ id: number; scope?: string; input?: ReadingInput; page?: number; release?: boolean }>) => {
  const { id, scope, input, page, release } = event.data;
  try {
    if (scope !== undefined) {
      if (typeof scope !== 'string' || !/^fragment-[1-9]\d*$/u.test(scope)) throw new Error('阅读片段身份无效');
      if (release) { forgetFragment(scope); return; }
      const fragment = fragmentDocument(scope, input);
      if (page === undefined) self.postMessage({ id, index: fragment.index });
      else {
        if (!Number.isSafeInteger(page) || page < 0 || page >= fragment.pages.length) throw new Error('阅读分段不存在');
        const tree = prepareFormulas(fragment.pages[page]);
        self.postMessage({ id, tree, cacheUnits: JSON.stringify(tree).length });
      }
      return;
    }
    if (input) { document = prepareReadingDocument(input); prepareFormulas = createReadingFormulaPreparer(); self.postMessage({ id, index: document.index }); }
    else {
      if (!document || !Number.isSafeInteger(page) || page! < 0 || page! >= document.pages.length) throw new Error('阅读分段不存在');
      // Only the requested page crosses the worker boundary, not the whole AST.
      const tree = prepareFormulas(document.pages[page!]);
      // Account for expanded math markup off the interface thread as well.
      self.postMessage({ id, tree, cacheUnits: JSON.stringify(tree).length });
    }
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : '长文解析失败' }); }
};
