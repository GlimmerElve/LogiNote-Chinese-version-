/** Narrow follow-up contract: keep the target verbatim; never flip a semantic label from reason keywords. */
import { parseIdenticalCoreJson } from './identicalJson';
import { prepareMeaningProbe, parseMeaningProbe, MEANING_PROBE_PROMPT, type MeaningCase } from './relationMeaningProbe';

export const LOCKED_MEANING_VERSION = 'relation-meaning-target-locked-v2' as const;
export function prepareLockedMeaningProbe(cases: MeaningCase[]) {
  const base = prepareMeaningProbe(cases);
  const oldShape = '{"decisions":[{"id":"输入id","use":"上述六种之一","reason":"指出材料与目标的具体语义关系，最多140字"}]}';
  const newShape = '{"decisions":[{"id":"输入id","target":"逐字复制本项target","use":"上述六种之一","reason":"指出材料对这个原目标的作用，最多140字"}]}';
  if (!MEANING_PROBE_PROMPT.includes(oldShape)) throw new Error('冻结判别契约已变更，停止准备后续请求');
  return { ...base, version: LOCKED_MEANING_VERSION, systemPrompt: MEANING_PROBE_PROMPT.replace(oldShape, newShape)
    + '\nuse始终针对复制的原目标：支持“目标被违背”不是支持目标本身，而是rebuts。不得把target换成它的否定、补全后的更强断言或另一结论。reason和use必须说明对同一个原目标的作用。' };
}
export function parseLockedMeaningProbe(raw: string, cases: MeaningCase[]) {
  prepareLockedMeaningProbe(cases);
  const value = parseIdenticalCoreJson(raw).value;
  if (!value || !Array.isArray(value.decisions) || Object.keys(value).join() !== 'decisions') throw new Error('锁定判别结构非法');
  const targets = new Map(cases.map(c => [c.id, c.target]));
  const projected = value.decisions.map((d: any) => {
    if (!d || typeof d !== 'object' || Object.keys(d).sort().join() !== 'id,reason,target,use'
      || !targets.has(d.id) || d.target !== targets.get(d.id)) throw new Error('判别更换或遗漏原目标，未猜测修复');
    return { id: d.id, use: d.use, reason: d.reason };
  });
  // Mechanical removal of the verified echo field only; all semantic choices remain the model's.
  return parseMeaningProbe(JSON.stringify({ decisions: projected }), cases);
}
