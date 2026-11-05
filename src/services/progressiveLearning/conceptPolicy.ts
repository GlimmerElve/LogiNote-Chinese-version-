import type { ProgressiveCourse } from './types';

export interface ProgressiveExistingConcept { title: string; aliases?: string[]; key?: string }

/** One semantic extraction in the teaching response, not a second model pass.
 * Local matching only sees bounded public names, never personal learning state. */
export const PROGRESSIVE_CORE_CONCEPT_GUIDANCE = `@@CONCEPTS只提取本页重点讲授的核心概念名词，以独立学习对象为粒度，不按小节、讲解角度、性质、公式、成立条件、判断步骤或例子逐项建笔记。名词化的标题也不自动成为独立概念；先问这些内容是不是在解释同一个对象，同属一个对象就归到一个核心概念。
例如讲数列极限的直观含义、收敛与发散、极限唯一性、函数在一点和无穷远处的极限、左右极限判据、单调有界及夹逼方法时，若本页目标是理解极限，核心条目用“极限”，这些侧面写入该条summary；不要为八个侧面分别输出八个概念。只有本页主目标确实独立讲授某个定理或方法本身时，才可把它作为独立核心条目。讲提示词的指令、上下文、约束、输出格式时，若它们仅是同一对象的组成，也归入“提示词”，不因出现四个名词就拆四篇笔记。
一个核心概念能承载本页就只输出一个；确有多个独立核心才输出多个。没有实际讲授核心概念时可输出[]，不为了配额凑数。title用简洁、稳定的概念名，不用“某概念的直观含义”“某概念的唯一性”“判断某概念的步骤”等描述性标题。summary保留本页实际讲清的定义、不同情形、性质、必要条件、方法及简短例子，可分段组织，不因归并而丢失关键内容。
existingConcepts仅供查重，不是本页必须提取的清单，历史记录可能过细，不能照搬其拆分方式。粒度合适的已有概念优先复用原title和key（若提供）；同一概念在后续主线或扩展中继续使用同一名称，不为新增例子、性质、应用或讲法新建变体。复用时仍在本页@@CONCEPTS列出该核心概念及本页摘要；题目的conceptKeys只指向本页这些核心键，不另外生成性质或方法的细分键。`;

/** Name-only catalogue. The first/active saved pages cover a newly published
 * concept even if its background note has not been materialized yet. */
export function progressiveExistingConcepts(course: ProgressiveCourse, linked: readonly ProgressiveExistingConcept[] = []): ProgressiveExistingConcept[] {
  const result = new Map<string, ProgressiveExistingConcept>();
  const saved = [...(course.firstPage?.concepts || []), ...(course.page?.concepts || [])];
  const candidates: ProgressiveExistingConcept[] = [...saved, ...linked];
  for (const concept of candidates) {
    const title = concept.title.trim().slice(0, 80), normalized = title.normalize('NFKC').toLocaleLowerCase();
    if (!title || /[\r\n]/u.test(title)) continue;
    const previous = result.get(normalized);
    if (!previous && result.size >= 24) continue;
    const aliases = [...new Set([...(previous?.aliases || []), ...(concept.aliases || [])])]
      .filter(alias => typeof alias === 'string' && alias.trim() && !/[\r\n]/u.test(alias)).slice(0, 5).map(alias => alias.slice(0, 80));
    const key = previous?.key || concept.key?.slice(0, 100);
    result.set(normalized, { title: previous?.title || title, ...(key ? { key } : {}), ...(aliases.length ? { aliases } : {}) });
  }
  return [...result.values()];
}
