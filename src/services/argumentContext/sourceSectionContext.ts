/** Read-only provenance enrichment. Heading containment is not a semantic graph edge. */
export interface SourceContextWindow {id: string; section: string; text: string}
export interface SectionSourceContext {
  sectionPath: string[];
  experiment: {label: string; heading: string; headingWindow: string} | null;
  status: 'available' | 'partial' | 'unstructured';
  missingHeadings: string[];
}
export interface SourceContextIndex {
  document: string;
  windows: Map<string, {text: string; context: SectionSourceContext}>;
}
const numberParts = (title: string) => title.trim().replace(/^#+\s*/u, '').match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)(?=\S)/u)?.[1].split('.') || [];
const titleBody = (title: string) => title.trim().replace(/^#+\s*/u, '').replace(/^\d+(?:\.\d+)*(?:\.\s*|\s+)/u, '').trim();
// An experiment number mentioned inside a paragraph is not its source owner.
// Even a heading comparing two experiments is not assigned one owner.
function experimentLabel(title: string): string | null {
  const body = titleBody(title);
  return body.match(/^(实验\s*[0-9一二三四五六七八九十]+)(?:\s*[:：—-].+)?$/u)?.[1]
    || body.match(/^((?:Experiment|Study)\s+\d+)(?:\s*[:：—-].+)?$/iu)?.[1] || null;
}
export function buildSourceContextIndex(document: string, windows: SourceContextWindow[]): SourceContextIndex {
  if (!document.trim()) throw new Error('source_context_document');
  const result = new Map<string, {text: string; context: SectionSourceContext}>();
  type Heading = {parts: string[]; title: string; window: string};
  let stack: Heading[] = [], previousSection: string | undefined, previousContext: SectionSourceContext | undefined;
  for (const w of windows) {
    if (!w.id || result.has(w.id) || typeof w.section !== 'string' || typeof w.text !== 'string') throw new Error('source_context_window');
    const parts = numberParts(w.section);
    let context: SectionSourceContext;
    if (w.section === previousSection && previousContext) context = previousContext;
    else {
      if (parts.length) {
        // Ordered document headings only: no future parent, guessed parent name,
        // inherited sibling experiment, or external-document section lookup.
        stack = stack.filter(h => h.parts.length < parts.length && h.parts.every((p, i) => p === parts[i]));
        stack.push({parts, title: w.section, window: w.id});
      } else stack = w.section.trim() ? [{parts: [], title: w.section, window: w.id}] : [];
      const missing = parts.slice(0,-1).map((_, i) => parts.slice(0,i+1).join('.')).filter(prefix => !stack.some(h => h.parts.join('.') === prefix));
      const owner = [...stack].reverse().map(h => ({h, label: experimentLabel(h.title)})).find(v => v.label);
      context = {sectionPath: stack.map(h => h.title), experiment: owner ? {label: owner.label!, heading: owner.h.title, headingWindow: owner.h.window} : null,
        status: !w.section.trim() ? 'unstructured' : missing.length ? 'partial' : 'available', missingHeadings: missing};
    }
    result.set(w.id, {text: w.text, context}); previousSection = w.section; previousContext = context;
  }
  return {document, windows: result};
}
interface FlatSource {window: string; quote: string; sourceContext?: SectionSourceContext; [key: string]: unknown}
interface FlatNode {id: string; source: FlatSource[]; [key: string]: unknown}
interface FlatInput {question: string; material: {document: string; nodes: FlatNode[]; relations: unknown[]; readingIndex?: unknown; [key: string]: unknown}; [key: string]: unknown}
type EnrichedNode<N extends FlatNode> = Omit<N, 'source'> & Pick<N, 'id'> & {source: Array<N['source'][number] & {sourceContext: SectionSourceContext}>};
type EnrichedInput<T extends FlatInput> = Omit<T, 'material'> & Pick<T, 'question'> & {material: Omit<T['material'], 'nodes'> & Pick<T['material'], 'document' | 'relations'> & {nodes: Array<EnrichedNode<T['material']['nodes'][number]>>}};
/** Adds provenance to each individual source; never rewrites text, type, IDs or relations. */
export function attachFlatSourceContext<T extends FlatInput>(input: T, index: SourceContextIndex): EnrichedInput<T> {
  if (input.material.document !== index.document) throw new Error('source_context_document_mismatch');
  if (input.material.readingIndex !== undefined) throw new Error('source_context_flat_only');
  const nodes = input.material.nodes.map(n => ({...n, source: n.source.map(s => {
    const entry = index.windows.get(s.window); if (!entry) throw new Error('source_context_unknown_window');
    const start = entry.text.indexOf(s.quote);
    if (!s.quote || start < 0 || entry.text.indexOf(s.quote, start + 1) >= 0) throw new Error('source_context_quote_not_unique');
    if (s.sourceContext && JSON.stringify(s.sourceContext) !== JSON.stringify(entry.context)) throw new Error('source_context_conflict');
    const c = entry.context;
    return {...s, sourceContext: {...c, sectionPath: [...c.sectionPath], experiment: c.experiment ? {...c.experiment} : null, missingHeadings: [...c.missingHeadings]}};
  })}));
  return {...input, material: {...input.material, nodes}} as EnrichedInput<T>;
}
