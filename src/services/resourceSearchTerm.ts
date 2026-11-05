/** Shared by query construction and relevance checks; never changes note titles. */
export function extractResourceCoreTerm(value: string): string {
  let term = String(value || '')
    .normalize('NFKC')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/\s*@due\s*\([^)]*\)/giu, ' ')
    .replace(/^\s*[-*]\s*\[[ xX]\]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^学习(?:效应|理论|曲线|迁移|动机|策略|能力|风格|障碍|方法)$/u.test(term)) return term;
  term = term
    .replace(/^(?:建立|绘制|构建|梳理)\s*/u, '')
    .replace(/\s*(?:全景概念地图|概念地图|知识图谱|知识框架)\s*$/u, '')
    .replace(/^[\s《》「」“”"']*(?:第\s*)?(?:\d+|[一二三四五六七八九十百两]+)\s*(?:天|日|周|个?月|年)(?:内)?\s*/u, '')
    .replace(/^[\s《》「」“”"']*(?:学习)?什么知识点\s*[：:—–\-]+\s*/u, '')
    .replace(/^[\s《》「」“”"']*(?:(?:全面|系统|深入|快速|重点|逐步|重新|初步|进一步|完整|彻底)(?:地)?\s*)*(?:(?:学习|了解|理解|掌握|学会|研究|认识|探索|探究|走进|入门)如何|如何学习|学习|了解|理解|掌握|学会|研究|认识|探索|探究|走进)\s*/u, '')
    .split(/\s*[：:—–｜|\n（(]\s*/u)[0]
    .replace(/\s*(?:学习计划|训练计划|课程计划|学习课程|入门课程|学习|入门|计划|课程|阶段)\s*$/u, '')
    .replace(/^[\s《》「」“”"'，,、;；.。\-—–]+|[\s《》「」“”"'，,、;；.。\-—–]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(?:学习|知识点|学习资源|未命名|新项目|项目)$/u.test(term)) return '';
  return [...term].slice(0, 36).join('');
}
