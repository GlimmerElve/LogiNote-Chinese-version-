import { $getNodeByKey, $isElementNode, type LexicalNode, type RootNode } from 'lexical';
import { exportLexicalTreeToMdast, type ExportMarkdownFromLexicalOptions } from '@mdxeditor/editor';
import { defaultHandlers, toMarkdown } from 'mdast-util-to-markdown';
import type { Root, RootContent } from 'mdast';

type Params = ExportMarkdownFromLexicalOptions;
interface Written { signature: string; value: string; bulletLastUsed: unknown; bulletCurrent: unknown; attention: unknown }
interface Block { node: LexicalNode; nodes: LexicalNode[]; ast: RootContent[]; written: WeakMap<object, Written> }
// Context-dependent JSX imports/root handlers retain the original full exporter.
const reusableTypes = new Set(['paragraph', 'heading', 'blockquote', 'list', 'table', 'code', 'thematicBreak', 'math',
  'definition', 'footnoteDefinition', 'textbookBoundary', 'learningReviewBlock', 'argumentBlock']);

/** Instance-local cache; never writes to Lexical, DOM, selection or history.
 * It deliberately stays synchronous so every onChange/save/Agent read still
 * observes the latest complete Markdown, even during an IME composition. */
export function createIncrementalMarkdownExport() {
  const blocks = new Map<string, Block>();
  let configuration: unknown[] = [];
  const metrics = { blockExports: 0, markdownWrites: 0, reusedWrites: 0, fallback: 0 };
  const reset = () => { blocks.clear(); configuration = []; };
  return { metrics, reset, get size() { return blocks.size; },
    export(params: Params, dirtyElements: Map<string, boolean>, dirtyLeaves: Set<string>): string | undefined {
      const options = params.toMarkdownOptions;
      const config = [params.visitors, params.jsxComponentDescriptors, params.jsxIsAvailable, params.toMarkdownExtensions,
        options && Object.keys(options).length ? options : null];
      if (config.some((value, i) => value !== configuration[i])) { reset(); configuration = config; }
      if (params.jsxComponentDescriptors.some(descriptor => descriptor.source)
        || params.toMarkdownOptions?.handlers?.root || params.toMarkdownExtensions?.some(extension => extension.handlers?.root)) {
        metrics.fallback++; reset(); return;
      }
      const root = params.root as RootNode, children = root.getChildren(), dirty = new Set<string>();
      // History can dirty only the root. Compare immutable node identities in
      // that case; no text/Markdown serialization and no history modification.
      const ambiguous = dirtyElements.has('root') && dirtyElements.size === 1 && dirtyLeaves.size === 0;
      const snapshot = (node: LexicalNode): LexicalNode[] => [node, ...($isElementNode(node) ? node.getChildren().flatMap(snapshot) : [])];
      for (const key of new Set([...dirtyElements.keys(), ...dirtyLeaves])) {
        if (key === 'root') continue;
        let node = $getNodeByKey(key);
        if (!node) continue; // Removed keys are pruned below, never resurrected.
        let parent = node.getParent();
        while (parent && parent !== root) { node = parent; parent = node.getParent(); }
        if (parent === root) dirty.add(node.getKey());
      }
      const alive = new Set(children.map(node => node.getKey()));
      for (const key of blocks.keys()) if (!alive.has(key)) blocks.delete(key);
      const ast: Root = { type: 'root', children: [] };
      const owners = new Map<object, Block>();
      for (const node of children) {
        const key = node.getKey(); let cached = blocks.get(key);
        const currentNodes = ambiguous ? snapshot(node) : undefined;
        const nested = ['table', 'codeblock'].includes(node.getType());
        const changed = currentNodes && (!cached || nested || currentNodes.length !== cached.nodes.length || currentNodes.some((value, i) => value !== cached.nodes[i]));
        if (!cached || dirty.has(key) || cached.node !== node || changed) {
          // A read-only RootNode facade keeps the real node/parent relationships
          // for visitors but traverses ONLY this block. No editor mutation.
          const facade = Object.create(root) as RootNode;
          Object.defineProperty(facade, 'getChildren', { value: () => [node] });
          const fragment = exportLexicalTreeToMdast({ ...params, root: facade });
          if (fragment.children.some(child => !reusableTypes.has(child.type))) { metrics.fallback++; reset(); return; }
          cached = { node, nodes: currentNodes || snapshot(node), ast: fragment.children, written: new WeakMap() }; blocks.set(key, cached); metrics.blockExports++;
        }
        for (const child of cached.ast) { ast.children.push(child); owners.set(child, cached); }
      }
      // Use the official root/containerFlow/join rules (including adjacent
      // lists, numbering, tables and Markdown extensions), NOT string joining.
      const value = toMarkdown(ast, { extensions: params.toMarkdownExtensions, ...params.toMarkdownOptions,
        handlers: { ...params.toMarkdownOptions?.handlers, root(node, parent, state, info) {
          const original = state.handle;
          state.handle = Object.assign((child: any, owner: any, current: any, position: any) => {
            const block = owner === node ? owners.get(child) : undefined;
            if (!block) return original.call(current, child, owner, current, position);
            const signature = JSON.stringify([current.stack, current.indexStack, current.bulletLastUsed, current.bulletCurrent,
              current.attentionEncodeSurroundingInfo, position.before, position.after, position.now?.column, position.lineShift]);
            const hit = block.written.get(child);
            if (hit?.signature === signature) {
              current.bulletLastUsed = hit.bulletLastUsed; current.bulletCurrent = hit.bulletCurrent;
              current.attentionEncodeSurroundingInfo = hit.attention; metrics.reusedWrites++; return hit.value;
            }
            const result = original.call(current, child, owner, current, position); metrics.markdownWrites++;
            block.written.set(child, { signature, value: result, bulletLastUsed: current.bulletLastUsed,
              bulletCurrent: current.bulletCurrent, attention: current.attentionEncodeSurroundingInfo });
            return result;
          }, original) as typeof state.handle;
          try { return defaultHandlers.root(node, parent, state, info); }
          finally { state.handle = original; }
        } },
      });
      return value + '\n'; // Preserve upstream's exact export contract.
    },
  };
}
