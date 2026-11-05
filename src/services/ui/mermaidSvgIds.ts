import parseCss from 'postcss/lib/parse';
import parseValue from 'postcss-value-parser';

/** Decode a CSS identifier escape without treating its following hex digits as
 * another token. Mermaid normally emits ASCII IDs, but selectors may escape them. */
function readIdentifier(value: string, start: number): { id: string; end: number } {
  let id = '', end = start;
  while (end < value.length) {
    const character = value[end];
    if (/[\w\-\u0080-\uffff]/u.test(character)) { id += character; end++; continue; }
    if (character !== '\\' || end + 1 >= value.length) break;
    const hex = value.slice(end + 1).match(/^[\da-f]{1,6}/iu)?.[0];
    if (hex) {
      const point = parseInt(hex, 16);
      id += String.fromCodePoint(point === 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? 0xfffd : point);
      end += hex.length + 1;
      if (/\s/u.test(value[end] || '')) end++;
    } else { id += value[end + 1]; end += 2; }
  }
  return { id, end };
}

function rewriteSelector(selector: string, ids: Map<string, string[]>): string {
  let rewritten = '', cursor = 0;
  while (cursor < selector.length) {
    const character = selector[cursor];
    if (selector.startsWith('/*', cursor)) {
      const end = selector.indexOf('*/', cursor + 2), next = end < 0 ? selector.length : end + 2;
      rewritten += selector.slice(cursor, next); cursor = next; continue;
    }
    if (character === '"' || character === "'") {
      const start = cursor++;
      while (cursor < selector.length) { if (selector[cursor] === '\\') cursor += 2; else if (selector[cursor++] === character) break; }
      rewritten += selector.slice(start, cursor); continue;
    }
    if (character === '\\') { rewritten += selector.slice(cursor, cursor + 2); cursor += 2; continue; }
    if (character !== '#') { rewritten += character; cursor++; continue; }
    const token = readIdentifier(selector, cursor + 1), matches = ids.get(token.id);
    if (!matches) { rewritten += selector.slice(cursor, token.end); cursor = token.end; continue; }
    rewritten += matches.length === 1 ? `#${matches[0]}` : `:is(${matches.map(id => `#${id}`).join(',')})`;
    cursor = token.end;
  }
  return rewritten;
}

function rewriteUrls(value: string, ids: Map<string, string[]>): string {
  // Only local fragments are references. Colours, ordinary strings and external
  // URLs are untouched; input/output still pass the existing SVG safety gate.
  const parsed = parseValue(value);
  parsed.walk(node => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const children = node.nodes.filter(child => child.type !== 'space' && child.type !== 'comment');
    const child = children[0];
    if (children.length !== 1 || !child || !['word', 'string'].includes(child.type) || !child.value.startsWith('#')) return false;
    const raw = child.value.slice(1), decoded = readIdentifier(raw, 0);
    const replacement = ids.get(decoded.end === raw.length ? decoded.id : raw)?.[0];
    if (replacement) child.value = `#${replacement}`;
    return false;
  });
  return parsed.toString();
}

/** Mermaid's root render ID does not namespace all node/marker IDs. Cached SVGs
 * from previous source/theme renders can coexist, so namespace every element
 * and reference before inserting it into the reader's shared Document. */
export function namespaceMermaidSvg(svg: string, namespace: string): string {
  if (!/^[\w-]{1,160}$/u.test(namespace)) throw new Error('图示标识无效');
  if (svg.length > 1_000_000) throw new Error('图示渲染结果过大');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('图示 SVG 格式无效');
  const root = document.documentElement, elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > 5_000) throw new Error('图示渲染节点过多');
  const ids = new Map<string, string[]>();
  let sequence = 0;
  for (const element of elements) {
    if (element !== root && !element.hasAttribute('id')) continue;
    const original = element.getAttribute('id'), replacement = element === root ? namespace : `${namespace}-id-${++sequence}`;
    if (original) ids.set(original, [...(ids.get(original) || []), replacement]);
    element.setAttribute('id', replacement);
  }
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'id') continue;
      let value = attribute.value;
      if (/^(?:xlink:)?href$/u.test(attribute.name) && value.startsWith('#')) value = `#${ids.get(value.slice(1))?.[0] || value.slice(1)}`;
      else if (/^aria-(?:labelledby|describedby|controls|owns|flowto|activedescendant|details|errormessage)$/u.test(attribute.name)) {
        value = value.split(/\s+/u).map(id => ids.get(id)?.[0] || id).join(' ');
      }
      value = rewriteUrls(value, ids);
      if (value !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    }
    if (element.localName === 'style') {
      const stylesheet = parseCss(element.textContent || '');
      stylesheet.walkRules(rule => { rule.selector = rewriteSelector(rule.selector, ids); });
      stylesheet.walkDecls(declaration => { declaration.value = rewriteUrls(declaration.value, ids); });
      element.textContent = stylesheet.toString();
    }
  }
  const result = new XMLSerializer().serializeToString(root);
  if (result.length > 1_000_000) throw new Error('图示渲染结果过大');
  return result;
}
