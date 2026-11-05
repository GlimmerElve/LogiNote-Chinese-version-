import type { ProgressiveCourse, ProgressiveLessonPage, SharedProgressiveTeaching } from './types';
import { projectProgressiveQuestion } from './validation.ts';
import { findInteractiveFigure } from '../textbook/interactiveFigureMarker';

/** Never spread a course, page, source packet or personal state into this projection. */
export function shareProgressiveTeaching(course: ProgressiveCourse, loadedPages?: readonly ProgressiveLessonPage[]): SharedProgressiveTeaching {
  const selected = course.page || course.firstPage;
  const pages = loadedPages || (selected ? [selected] : []);
  return {
    schemaVersion: 1,
    title: pages.length ? (course.plan?.title || pages[0].title) : '学习教材',
    pages: pages.map(page => ({
      title: page.title, body: page.body,
      hook: { kind: 'reflection', prompt: page.hook.prompt },
      ...(page.questions?.length ? { questions: page.questions.map(projectProgressiveQuestion) } : {}),
    })),
  };
}

/** Static teaching only. Source pointers belong to the originating library;
 * publishing an image/document ID never grants the recipient access to it. */
export function sharedTeachingBody(body: string, options?: { includeFigureAttachments?: boolean }): string {
  const shared = body.replace(/(^|\n)(`{3,}|~{3,})(textbook-image|textbook-references)\s*\r?\n[\s\S]*?\r?\n\2(?=\s*(?:\n|$))/gu,
    (_match, prefix: string, _fence: string, kind: string) => prefix + (kind === 'textbook-image' ? '（原资料插图未随本次教材分享提供）\n' : ''))
    .replace(/\[(?:S|L)\d+\]/gu, '');
  return findInteractiveFigure(shared) && !options?.includeFigureAttachments ? `${shared}\n\n> 交互图附件未随 Markdown 导出；上方文字保留了探索目标。` : shared;
}
export function sharedTeachingMarkdown(teaching: SharedProgressiveTeaching): string {
  if (!teaching.pages.length) throw Error('教材尚未生成，请先生成讲解页后分享。');
  return `# ${teaching.title}\n\n` + teaching.pages.map(page => {
    const questions = (page.questions || []).map((question, index) => `${index + 1}. ${question.prompt}\n\n${(question.options || []).map(option => `- ${option.id}：${option.text}`).join('\n')}`
      + `\n\n参考解答：${question.referenceAnswer}\n\n${question.explanation}`).join('\n\n');
    return `## ${page.title}\n\n${sharedTeachingBody(page.body)}\n\n${questions ? `### 思考与作答\n\n${questions}\n\n` : ''}### 复述提示\n\n${page.hook.prompt}`;
  }).join('\n\n---\n\n');
}
