/** Declarative primitives only. No user SVG, paths, CSS, URLs or executable code. */
export type ScienceInk = 'default' | 'accent' | 'warm' | 'cool';
type Point = [number, number];
export type ScienceElement = { color?: ScienceInk; label?: string } & (
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; dashed?: boolean }
  | { kind: 'polyline'; points: Point[]; dashed?: boolean }
  | { kind: 'label'; x: number; y: number; text: string }
  | { kind: 'symbol'; symbol: 'resistor' | 'battery' | 'switch-open' | 'switch-closed' | 'lamp'; x: number; y: number; angle?: number }
);
export interface ScienceDiagram { title: string; description: string; width: number; height: number; elements: ScienceElement[]; sourceIds: string[]; simulated: boolean }
export interface MoleculeDiagram { title: string; description: string; smiles: string; sourceIds: string[]; simulated: boolean }
function demand(ok: unknown, message = '科学图参数无效'): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  demand(!!value && typeof value === 'object' && !Array.isArray(value));
  demand(Object.keys(value).every(key => keys.includes(key)), '科学图不接受脚本、SVG或原始绘图选项');
}
function text(value: unknown, max = 160): asserts value is string {
  demand(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[<>\u0000-\u001f]|(?:https?|javascript|data|file):/iu.test(value), '科学图标签为空、过长或含链接/HTML');
}
function number(value: unknown, min: number, max: number): asserts value is number {
  demand(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
}
function parse(code: string): unknown { demand(code.length <= 12_000, '科学图过大'); try { return JSON.parse(code); } catch { throw new Error('科学图 JSON 无效'); } }
function provenance(value: Record<string, unknown>, allowed: readonly string[]) {
  text(value.title, 120); text(value.description, 600);
  demand(typeof value.simulated === 'boolean', '必须声明是否教学示意');
  demand(Array.isArray(value.sourceIds) && value.sourceIds.length <= 12 && new Set(value.sourceIds).size === value.sourceIds.length
    && value.sourceIds.every(id => typeof id === 'string' && allowed.includes(id)), '科学图引用未授权来源');
  demand(value.simulated || value.sourceIds.length > 0, '非示意图必须引用已采集来源');
}
export function parseScienceDiagram(code: string, allowed: readonly string[] = []): ScienceDiagram {
  const value = parse(code); object(value, ['title', 'description', 'width', 'height', 'elements', 'sourceIds', 'simulated']); provenance(value, allowed);
  number(value.width, 320, 960); number(value.height, 160, 640);
  const w = value.width, h = value.height;
  demand(Array.isArray(value.elements) && value.elements.length > 0 && value.elements.length <= 48, '科学图需要1–48个图元');
  for (const element of value.elements) {
    demand(!!element && typeof element === 'object');
    const keys: Record<string, string[]> = {
      rect: ['x', 'y', 'width', 'height'], circle: ['cx', 'cy', 'r'], line: ['x1', 'y1', 'x2', 'y2', 'dashed'],
      arrow: ['x1', 'y1', 'x2', 'y2', 'dashed'], polyline: ['points', 'dashed'], label: ['x', 'y', 'text'], symbol: ['symbol', 'x', 'y', 'angle'],
    };
    demand(Object.hasOwn(keys, element.kind), '未知科学图图元');
    object(element, ['kind', 'color', 'label', ...keys[element.kind]]);
    if (element.color !== undefined) demand(['default', 'accent', 'warm', 'cool'].includes(element.color as string));
    if (element.label !== undefined) text(element.label, 60);
    if (element.dashed !== undefined) demand(typeof element.dashed === 'boolean');
    const point = (x: unknown, y: unknown) => { number(x, 16, w - 16); number(y, 16, h - 16); };
    if (element.kind === 'rect') { point(element.x, element.y); number(element.width, 1, w - 32); number(element.height, 1, h - 32); demand((element.x as number) + element.width <= w - 16 && (element.y as number) + element.height <= h - 16); }
    else if (element.kind === 'circle') { point(element.cx, element.cy); number(element.r, 1, Math.min(w, h) / 2); demand((element.cx as number) - element.r >= 16 && (element.cx as number) + element.r <= w - 16 && (element.cy as number) - element.r >= 16 && (element.cy as number) + element.r <= h - 16); }
    else if (element.kind === 'line' || element.kind === 'arrow') { point(element.x1, element.y1); point(element.x2, element.y2); demand(element.x1 !== element.x2 || element.y1 !== element.y2); }
    else if (element.kind === 'polyline') { demand(Array.isArray(element.points) && element.points.length >= 2 && element.points.length <= 40); for (const p of element.points) { demand(Array.isArray(p) && p.length === 2); point(p[0], p[1]); } }
    else if (element.kind === 'label') { point(element.x, element.y); text(element.text, 60); }
    else if (element.kind === 'symbol') { number(element.x, 50, w - 50); number(element.y, 50, h - 50); demand(['resistor', 'battery', 'switch-open', 'switch-closed', 'lamp'].includes(element.symbol as string)); if (element.angle !== undefined) number(element.angle, -360, 360); }
  }
  return value as unknown as ScienceDiagram;
}
export function parseMoleculeDiagram(code: string, allowed: readonly string[] = []): MoleculeDiagram {
  const value = parse(code); object(value, ['title', 'description', 'smiles', 'sourceIds', 'simulated']); provenance(value, allowed);
  // Small, single-molecule SMILES only; actual syntax is parsed by SmilesDrawer.
  demand(typeof value.smiles === 'string' && value.smiles.length > 0 && value.smiles.length <= 160
    && /^[A-Za-z0-9@+\-\[\]()=#%\\/]+$/u.test(value.smiles)
    && (value.smiles.match(/[A-Z][a-z]?|[bcnops]/gu) || []).length <= 60, '仅支持有界的单分子 SMILES，不接受反应式、URL或代码');
  return value as unknown as MoleculeDiagram;
}
/** Include all displayed labels in the existing citation/privacy checks. */
export function scienceDisplayText(language: string, code: string, allowed: readonly string[]): string[] {
  if (language === 'molecule') { const v = parseMoleculeDiagram(code, allowed); return [v.title, v.description]; }
  const v = parseScienceDiagram(code, allowed);
  return [v.title, v.description, ...v.elements.flatMap(e => [e.label || '', e.kind === 'label' ? e.text : ''])];
}
