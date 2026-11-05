import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import type { SceneInteractionPackRef } from '../../types/sceneInteractionPack';
import { readSceneInteractionPackRef } from './sceneInteractionPackManifest';

type ValueNode = valueParser.Node;
type Mode = 'animation' | 'name';
const wide = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const slots = [new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']),
  new Set(['infinite']), new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']),
  new Set(['none', 'forwards', 'backwards', 'both']), new Set(['running', 'paused'])];
const decode = (value: string) => value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/giu, (_all, hex, char) => {
  const point = hex && parseInt(hex, 16);
  return hex ? String.fromCodePoint(!point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? 0xfffd : point) : char;
});

/** Scope selectors AND animation names. Parse/reject before publishing any package. */
export function scenePackStyles(reference: SceneInteractionPackRef, css: string): string {
  const ref = readSceneInteractionPackRef(reference), key = `${ref.id}@${ref.version}`;
  if (css.length > 65536) throw Error('交互包样式超限');
  const root = postcss.parse(css, { from: undefined });
  const names = new Map<string, string>();
  root.walkAtRules(rule => {
    const kind = rule.name.toLowerCase();
    if (kind === 'charset') { rule.remove(); return; }
    if (!['keyframes', '-webkit-keyframes', 'media', 'supports', 'container', 'starting-style', 'scope'].includes(kind))
      throw Error(`交互包样式不支持全局规则 @${rule.name}；请使用局部样式`);
    if (kind !== 'keyframes' && kind !== '-webkit-keyframes') return;
    const tokens = valueParser(rule.params).nodes.filter(node => node.type !== 'space' && node.type !== 'comment');
    if (tokens.length !== 1 || !['word', 'string'].includes(tokens[0].type)) throw Error('交互包动画名称无效');
    const original = decode(tokens[0].value);
    if (!names.has(original)) names.set(original, `s2_${ref.id}__${ref.version.replaceAll('.', '_')}__kf_${names.size}`);
    if (names.size > 128) throw Error('交互包动画数量超限');
    rule.params = names.get(original)!;
  });
  const variables = new Map<string, Set<Mode>>();
  function variableUses(nodes: ValueNode[], mode: Mode) {
    for (const node of nodes) if (node.type === 'function' && node.value.toLowerCase() === 'var') {
      const first = node.nodes.find(item => item.type !== 'space' && item.type !== 'comment');
      if (first?.type === 'word' && first.value.startsWith('--')) {
        const name = decode(first.value), modes = variables.get(name) ?? new Set<Mode>();
        modes.add(mode); variables.set(name, modes);
      }
      variableUses(node.nodes, mode);
    }
  }
  const animationMode = (prop: string): Mode | undefined => /^(?:-webkit-)?animation-name$/i.test(prop) ? 'name'
    : /^(?:-webkit-)?animation$/i.test(prop) ? 'animation' : undefined;
  root.walkDecls(decl => { const mode = animationMode(decl.prop); if (mode) variableUses(valueParser(decl.value).nodes, mode); });
  for (let pass = 0; pass < 16; pass++) {
    const before = [...variables.values()].reduce((sum, modes) => sum + modes.size, 0);
    root.walkDecls(decl => { for (const mode of variables.get(decl.prop) ?? []) variableUses(valueParser(decl.value).nodes, mode); });
    if ([...variables.values()].reduce((sum, modes) => sum + modes.size, 0) === before) break;
    if (pass === 15) throw Error('交互包动画变量引用过深');
  }
  function rewrite(nodes: ValueNode[], mode: Mode, depth = 0): string {
    if (depth > 16) throw Error('交互包动画变量回退层级过深');
    let used = new Set<number>();
    for (const node of nodes) {
      if (node.type === 'div' && node.value === ',') { used = new Set(); continue; }
      if (node.type === 'function') {
        if (node.value.toLowerCase() === 'var') {
          const comma = node.nodes.findIndex(item => item.type === 'div' && item.value === ',');
          if (comma >= 0) {
            const fallback = valueParser(rewrite(node.nodes.slice(comma + 1), mode, depth + 1)).nodes;
            node.nodes = [...node.nodes.slice(0, comma + 1), ...fallback];
          }
        } else if (mode === 'animation' && ['steps', 'cubic-bezier', 'linear'].includes(node.value.toLowerCase())) used.add(0);
        continue;
      }
      if (node.type !== 'word' && node.type !== 'string') continue;
      const name = decode(node.value), lower = name.toLowerCase();
      if (node.type === 'word') {
        if (mode === 'name' && wide.has(lower)) continue;
        if (mode === 'animation') {
          // Shorthand keywords consume their grammar slot before an ident can
          // be the animation name (e.g. "1s linear linear").
          if (/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?m?s$/i.test(name) || wide.has(lower) && lower !== 'none') continue;
          const slot = slots.findIndex((values, index) => values.has(lower) && !used.has(index));
          if (slot >= 0) { used.add(slot); continue; }
          if (/^(?:\d*\.)?\d+(?:e[+-]?\d+)?$/i.test(name) && !used.has(1)) { used.add(1); continue; }
        }
      }
      if (names.has(name)) node.value = names.get(name)!;
    }
    return valueParser.stringify(nodes);
  }
  root.walkDecls(decl => {
    const mode = animationMode(decl.prop), modes = mode ? [mode] : [...variables.get(decl.prop) ?? []];
    if (!modes.length) return;
    const values = modes.map(mode => rewrite(valueParser(decl.value).nodes, mode));
    if (values.some(value => value !== values[0])) throw Error('动画变量同时用于不同语法，请拆分变量后重试');
    decl.value = values[0];
  });
  const scope = postcss.atRule({ name: 'scope', params: `([data-scene-pack="${key}"])` });
  scope.append(root.nodes);
  const output = postcss.root().append(scope).toString();
  if (output.length > 262144) throw Error('交互包隔离后的样式超限');
  return output;
}
