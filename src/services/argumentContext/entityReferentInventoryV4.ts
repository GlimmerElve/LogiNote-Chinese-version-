/** Potential mention positions only. Lexical scanning never decides reference identity. */
import type {ReferentContext} from './entityReferentBindings.ts';
import {assertReferentUnitCatalogV3, resolveReferentSelectionV3, type ReferentSelectionV3, type ReferentUnitCatalogV3} from './entityReferentUnitsV3.ts';

export const REFERENCE_TASK_LIMIT_V4 = 160;
// Broad but finite lexical coverage. False positives are expected; the model can reject them.
const PREFIX = '上述|前述|以上|该|本|这种|这个|这些|那种|那个|那些|此';
const OBJECT = '研究团队|认知偏向|实验设计|研究结果|实验结果|实验条件|被试群体|患者群体|比较结果|观察结果|结果|实验|研究|团队|食物|偏向|现象|情况|条件|对象|群体|被试|患者|方法|任务|结论|观点|假设|模型|过程|机制|原因|方案|数据|训练|行为|关系|问题|证据';
const PERSONAL = ['他们', '她们', '它们', '他', '她', '它', '其', '之', '这', '那', '此'];
const ROLE_WORDS = ['其他被试', '被试', '研究者', '个体'];
const cuePattern = () => new RegExp(`(?:${PREFIX})(?:项|个|组|种)?(?:${OBJECT})|${[...ROLE_WORDS, ...PERSONAL].sort((a, b) => b.length - a.length).join('|')}`, 'gu');
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
export interface ReferenceTaskV4 {
  id: string; mention: ReferentSelectionV3;
  location: ReturnType<typeof resolveReferentSelectionV3>;
  context: {before: string; selected: string; after: string};
  origin: 'local_lexical_candidate_not_semantic_decision';
}
export interface ReferenceInventoryV4 {
  revision: string; documentId: string; snapshotId: string; tasks: ReferenceTaskV4[];
  lexicalCoverageOnly: true; semanticCertified: false; usableForRetrieval: false;
  graphEdgesCreated: 0; productionAdmission: false;
}
export function buildReferenceInventoryV4(ctx: ReferentContext, catalog: ReferentUnitCatalogV3): ReferenceInventoryV4 {
  assertReferentUnitCatalogV3(ctx, catalog);
  const windowOrder = new Map(ctx.windows.map((w, i) => [w.id, i]));
  const ordered = [...catalog.units].sort((a, b) => windowOrder.get(a.window)! - windowOrder.get(b.window)!
    || a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const tasks: ReferenceTaskV4[] = [];
  for (const unit of ordered) for (const hit of unit.text.matchAll(cuePattern())) {
    const phrase = hit[0], at = hit.index!; let occurrence = 0;
    // Count occurrences in the whole unit, not only earlier scanner matches.
    for (let p = unit.text.indexOf(phrase); p >= 0 && p <= at; p = unit.text.indexOf(phrase, p + 1)) occurrence++;
    const mention = {unitId: unit.id, phrase, occurrence}, location = resolveReferentSelectionV3(catalog, mention);
    tasks.push({id: 'C' + String(tasks.length + 1).padStart(4, '0'), mention, location,
      context: {before: unit.text.slice(Math.max(0, at - 45), at), selected: phrase, after: unit.text.slice(at + phrase.length, at + phrase.length + 45)},
      origin: 'local_lexical_candidate_not_semantic_decision'});
  }
  return {revision: 'referent-position-inventory-v4', documentId: ctx.documentId, snapshotId: ctx.snapshotId, tasks,
    lexicalCoverageOnly: true, semanticCertified: false, usableForRetrieval: false, graphEdgesCreated: 0, productionAdmission: false};
}
export function assertReferenceInventoryV4(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, inventory: ReferenceInventoryV4) {
  check(JSON.stringify(inventory) === JSON.stringify(buildReferenceInventoryV4(ctx, catalog)), 'reference_inventory_changed');
}
/** No silent truncation. Each source position appears in exactly one task batch. */
export function referenceTaskBatchesV4(inventory: ReferenceInventoryV4, size = REFERENCE_TASK_LIMIT_V4) {
  check(Number.isInteger(size) && size > 0 && size <= REFERENCE_TASK_LIMIT_V4, 'reference_task_batch_size');
  return Array.from({length: Math.ceil(inventory.tasks.length / size)}, (_, i) => inventory.tasks.slice(i * size, (i + 1) * size).map(t => t.id));
}
export function referenceBatchTasksV4(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, inventory: ReferenceInventoryV4, taskIds?: string[]) {
  assertReferenceInventoryV4(ctx, catalog, inventory);
  const ids = taskIds ?? inventory.tasks.map(t => t.id);
  check(Array.isArray(ids) && ids.length <= REFERENCE_TASK_LIMIT_V4 && new Set(ids).size === ids.length, 'reference_task_batch');
  const tasks = ids.map(id => inventory.tasks.find(t => t.id === id));
  check(tasks.every(Boolean), 'unknown_reference_task');
  return tasks as ReferenceTaskV4[];
}
