import type { Root, RootContent } from 'hast';
import { prepareFormula, type PreparedFormula } from './formulaRenderer';
export type { PreparedFormula } from './formulaRenderer';

declare module 'hast' {
  interface ElementData { preparedFormula?: PreparedFormula }
}

/** Owned by one reading worker. Pages stay raw so visiting the whole book does
 * not retain an expanded KaTeX copy of every formula in its AST. */
export function createReadingFormulaPreparer() {
  const cache = new Map<string, PreparedFormula>();
  let bytes = 0;
  const size = (value: PreparedFormula) => value.latex.length + (value.html?.length || value.error?.length || 0);
  const text = (node: RootContent): string => 'value' in node ? node.value
    : 'children' in node ? node.children.map(child => text(child as RootContent)).join('') : '';
  return (source: Root): Root => {
    const page = structuredClone(source);
    const visit = (node: RootContent) => {
      if (node.type !== 'element') return;
      const classes = node.properties.className;
      if (node.tagName === 'code' && Array.isArray(classes)
        && classes.some(value => value === 'math-inline' || value === 'math-display')) {
        const latex = text(node), displayMode = classes.includes('math-display');
        const key = `${displayMode ? 'display' : 'inline'}\u0000${latex}`;
        let result = cache.get(key);
        if (result) cache.delete(key);
        else { result = prepareFormula(latex, displayMode); bytes += size(result); }
        cache.set(key, result);
        while (cache.size > 128 || bytes > 512_000) {
          const first = cache.keys().next().value!;
          bytes -= size(cache.get(first)!); cache.delete(first);
        }
        node.data = { ...node.data, preparedFormula: result };
        return;
      }
      node.children.forEach(child => visit(child as RootContent));
    };
    page.children.forEach(visit);
    return page;
  };
}
