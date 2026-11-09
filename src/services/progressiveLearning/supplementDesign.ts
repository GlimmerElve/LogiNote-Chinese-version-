import type { ProgressiveCourse, ProgressiveSupplementDesign } from './types';

const common = '补充页设计v1：正文以一个独立的#标题开头，标题点明本页要解决的问题或讲解目的，通常8–28字；不在原标题后加“补充讲解”，不用“本页补充/选中区域”等泛称。标题、正文和最小检验围绕同一个目的。沿用原有输出协议与篇幅，不增元数据字段或规划请求，不改主线。';
const selection = '选区模式：supplementScope.text是用户选中的教学内容；先定位其中需要说明的概念、条件、符号或推理环节，直接讲清该处。可补必要前置、逐步推导或一组有条件的正反例，不逐字扩写选区、不复述整章、不抢讲其它主线。上下文只用于理解该处；没有证据不推断用户答错。标题具体到选区所解决的问题。';
const page = '整页模式：supplementScope.text是来源页参考全文，不是用户选区。围绕同一核心问题，先看原页如何讲，再选一条互补路径：具体案例、正反例对比、图像直觉、分步推导或迁移应用。按内容需要选，连续补充时避开近期标题体现的重复路径；不随机改语气、不按原顺序改写整页、不加无关新知识，也不推断用户未掌握。标题体现这次的新角度及目的。';

export function progressiveSupplementGuidance(design?: ProgressiveSupplementDesign): string {
  return design?.version === 1 ? '\n' + common + (design.mode === 'selection' ? selection : page) : '';
}

function acceptableTitle(text: string): boolean {
  return Boolean(text.trim()) && text.length <= 180 && !/[<>\u0000-\u001f]/u.test(text)
    && !/!?\[[^\]]*\]\(|https?:\/\//iu.test(text)
    && !/^(?:补充(?:讲解|说明|内容)?|本页补充|进一步讲解|换个角度(?:理解)?|学习目标|小结|总结)$/u.test(text)
    && !/[·：:\-—]\s*补充(?:讲解|说明)\s*$/u.test(text);
}

/** Promote an optional leading Markdown H1 into the existing title field.
 * Called at final/recovered publication only, never on each streamed token.
 * No new required protocol section, semantic rewrite or repair request. */
export function progressivePublicationContent(course: Pick<ProgressiveCourse, 'plan' | 'generation' | 'title'>, body: string): { title: string; body: string } {
  const mainTitle = course.plan?.pages[course.generation.mainlineIndex || 0]?.title || course.title;
  if (course.generation.kind !== 'expansion') return { title: mainTitle, body };
  const design = course.generation.supplementDesign;
  if (design?.version !== 1) return { title: `${mainTitle} · 补充讲解`, body };
  // Anchoring to the first nonblank line excludes headings inside fences,
  // formulas, quotations and later sections. Preserve inline LaTeX verbatim.
  const heading = /^(?:[ \t]*\r?\n)*[ ]{0,3}#[ \t]+([^\r\n]+)(?:\r?\n|$)/u.exec(body);
  const candidate = heading?.[1].replace(/[ \t]+#+[ \t]*$/u, '').trim();
  if (heading && candidate && acceptableTitle(candidate)) {
    const remainder = body.slice(heading[0].length).replace(/^(?:[ \t]*\r?\n)+/u, '');
    // Retain the complete body if removing its heading would introduce a new
    // minimum-content failure at the existing store's 40-character boundary.
    return { title: candidate, body: remainder.trim().length >= 40 ? remainder : body };
  }
  const topic = design.sourceTitle.replace(/^(?:(?:拆开理解|换个角度理解)[：:]\s*)+/u, '')
    .replace(/\s*[·：:\-—]\s*补充(?:讲解|说明)\s*$/u, '').trim();
  const fallback = design.mode === 'selection' ? '拆开理解选区中的关键条件' : '从另一条路径理解本页的核心问题';
  return { title: acceptableTitle(topic) && topic.length <= 100
    ? `${design.mode === 'selection' ? '拆开理解' : '换个角度理解'}：${topic}` : fallback, body };
}
