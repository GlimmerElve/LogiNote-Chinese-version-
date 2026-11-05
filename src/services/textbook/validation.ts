import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookFinding, TextbookJob, TextbookSource } from './generationTypes';
import { TEXTBOOK_CHAPTER_SECTIONS } from './generationTypes';
import { isTextbookBlockLanguage, parseControlledTextbookBlock, parseTextbookTip, parseTextbookAnswer, parseChartBlock, parseTextbookImage, parseTextbookReferences } from './contentSchema';
import { parseTextbookMarkdown } from './markdown';
import { TextbookValidationError } from './repair';
import { assessTextbookQuality } from './quality';
import { TEACHING_VISUAL_FORMATS, TEACHING_VISUAL_SECTIONS } from './visualGuidance';
import { optionalFunctionPlot } from './functionPlot';
import { scienceDisplayText } from './scienceDiagram';
import { textbookSourceImageAppendix } from './visualMaterials.ts';
import { prepareMarkdownForMdx } from '../markdownMdxCompatibility';
import { hasChapterRestatement } from './restatement';

const safeId = /^[a-zA-Z0-9_-]{1,80}$/u;
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function plain(value: unknown, max = 400): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\u0000]/u.test(value), '教材结构中的文本无效');
}
function ids(value: unknown, allowed: Set<string>, empty = false): asserts value is string[] {
  requireValue(Array.isArray(value) && (empty || value.length > 0) && value.length <= 32
    && new Set(value).size === value.length && value.every((id) => typeof id === 'string' && allowed.has(id)), '教材引用了不存在或重复的目标/证据/来源编号');
}
function markdownProse(text: string): string {
  let fence: { char: string; length: number } | undefined; const prose: string[] = [];
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!fence && marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else prose.push(line);
  }
  requireValue(!fence, '教材代码围栏不完整');
  return prose.join('\n');
}
/** Decode ordinary Markdown entities and join inline emphasis as the reader does.
 * This is for privacy scanning only, not an alternate way to satisfy fact citations. */
function renderedMarkdownText(text: string): string {
  const inline = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'tableCell']);
  const visit = (node: any): string => typeof node.value === 'string' ? node.value
    : (node.children || []).map(visit).join(inline.has(node.type) ? '' : '\n');
  return visit(parseTextbookMarkdown(text));
}
/** Fences are not all opaque code: these fields are rendered as teaching text.
 * Parse JSON before checking citations/privacy so Unicode escapes cannot bypass the gate.
 * Ordinary code stays code and does not satisfy prose's required fact citations. */
function controlledDisplayText(text: string, sourceIds: string[], assetIds: string[]): { prose: string[]; diagrams: string[] } {
  const result: string[] = [], diagrams: string[] = [];
  const visit = (node: any) => {
    if (node.type === 'code' && isTextbookBlockLanguage(node.lang || '')) {
      parseControlledTextbookBlock(node.lang, node.value, { sourceIds, assetIds });
      if (node.lang === 'textbook-tip' || node.lang === 'textbook-answer') {
        const annotation = node.lang === 'textbook-tip' ? parseTextbookTip(node.value) : parseTextbookAnswer(node.value);
        result.push(annotation.title, annotation.text);
      } else if (node.lang === 'chart') {
        const chart = parseChartBlock(node.value, { sourceIds });
        result.push(chart.title, ...chart.labels, ...chart.series.map((series) => series.name));
      } else if (node.lang === 'function-plot') {
        const plot = optionalFunctionPlot(node.value);
        if (plot) result.push(plot.title, plot.xLabel, plot.yLabel, ...plot.curves.map(curve => curve.label));
      } else if (node.lang === 'science-diagram' || node.lang === 'molecule') {
        result.push(...scienceDisplayText(node.lang, node.value, sourceIds));
      } else if (node.lang === 'textbook-image') result.push(parseTextbookImage(node.value, { assetIds }).caption || '');
      else if (node.lang === 'textbook-references') {
        const references = parseTextbookReferences(node.value, { sourceIds });
        result.push(...references.entries.flatMap(entry => [`[${entry.sourceId}]`, entry.title, entry.detail]));
      }
      else if (node.lang === 'mermaid') {
        // Mermaid resolves numeric #NN; label entities before displaying the SVG.
        // Diagram DSL is not Markdown prose (e.g. A[[label]] is a valid subroutine).
        // Ignore non-display comments; references in diagrams require nearby sourced prose.
        diagrams.push(node.value.replace(/%%[^\n]*/gu, '').replace(/#(?:([0-9]{1,7})|x([0-9a-f]{1,6}));/giu, (raw: string, decimal?: string, hex?: string) => {
          const point = parseInt(decimal || hex!, decimal ? 10 : 16);
          return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
        }));
      }
    }
    node.children?.forEach(visit);
  };
  visit(parseTextbookMarkdown(text));
  return { prose: result, diagrams };
}
export function validateBlueprint(value: unknown, context: TextbookContext, sources: TextbookSource[]): asserts value is TeachingBlueprint {
  const book = value as TeachingBlueprint;
  requireValue(book && typeof book === 'object', '教学蓝图格式无效'); plain(book.title, 160);
  requireValue(Array.isArray(book.objectives) && book.objectives.length >= 1 && book.objectives.length <= 12, '教学蓝图需要 1–12 个目标');
  const objectiveIds = new Set<string>();
  for (const item of book.objectives) { requireValue(safeId.test(item.id) && !objectiveIds.has(item.id), '学习目标编号重复或无效'); plain(item.text); objectiveIds.add(item.id); }
  const evidenceIds = new Set(context.personal.map((item) => item.evidenceId));
  const sourceIds = new Set(sources.map((item) => item.sourceId));
  requireValue(Array.isArray(book.focuses) && book.focuses.length <= 12, '教学重点格式无效');
  const focusIds = new Set<string>();
  for (const focus of book.focuses) {
    requireValue(safeId.test(focus.id) && !focusIds.has(focus.id) && ['expressed_view', 'possible_confusion', 'not_expressed'].includes(focus.kind), '教学重点编号或类型无效');
    plain(focus.description); plain(focus.strategy); ids(focus.evidenceIds, evidenceIds, focus.kind === 'not_expressed'); ids(focus.sourceIds, sourceIds);
    requireValue(focus.kind !== 'not_expressed' || focus.evidenceIds.length === 0, '未表达不能伪造个人认知证据');
    focusIds.add(focus.id);
  }
  requireValue(Array.isArray(book.chapters) && book.chapters.length >= 2 && book.chapters.length <= 6, '教学蓝图需要 2–6 个章节');
  if (book.teachingPlan !== undefined) {
    const plan = book.teachingPlan;
    requireValue(plan?.version === 1 && ['focused', 'extended'].includes(plan.depth)
      && Number.isSafeInteger(plan.targetChars) && plan.targetChars >= 3500 && plan.targetChars <= 8500, '教学篇幅分配无效');
    requireValue(book.chapters.every((chapter) => chapter?.writingPlan), '教学篇幅分配缺少章节计划');
  }
  const chapterIds = new Set<string>(); const covered = new Set<string>(); const treated = new Set<string>();
  for (const chapter of book.chapters) {
    requireValue(safeId.test(chapter.id) && !chapterIds.has(chapter.id), '章节编号重复或无效'); plain(chapter.title, 160); plain(chapter.bridge);
    ids(chapter.objectiveIds, objectiveIds); ids(chapter.focusIds, focusIds, true); ids(chapter.sourceIds, sourceIds);
    if (chapter.writingPlan !== undefined) {
      const plan = chapter.writingPlan;
      requireValue(book.teachingPlan && plan && Number.isSafeInteger(plan.targetChars) && plan.targetChars > 0 && plan.targetChars <= 8500
        && Array.isArray(plan.sections) && plan.sections.includes('explanation') && plan.sections.length <= 7
        && new Set(plan.sections).size === plan.sections.length && plan.sections.every((section) => TEXTBOOK_CHAPTER_SECTIONS.includes(section))
        && plan.sections.includes('practice') === plan.sections.includes('answer')
        && (plan.restatement === undefined || plan.restatement === 1), '章节写作分配无效');
    }
    // Optional on old checkpoints. Validate metadata when supplied, but never
    // reject an otherwise usable chapter/book merely for lacking a diagram.
    if (chapter.visuals !== undefined) {
      requireValue(Array.isArray(chapter.visuals) && chapter.visuals.length <= 2, '每章可视化计划最多两项');
      const visualTargets = new Set<string>();
      for (const visual of chapter.visuals) {
        requireValue(visual && TEACHING_VISUAL_FORMATS.includes(visual.format) && TEACHING_VISUAL_SECTIONS.includes(visual.section), '可视化计划格式或小节无效');
        if (visual.format === 'textbook-image') requireValue(sources.some(source => chapter.sourceIds.includes(source.sourceId)
          && source.kind === 'document' && source.assets?.some(asset => asset.sourceId === source.sourceId
            && asset.docId === source.id && asset.version === source.version && asset.blockId === source.blockId)),
        '本章没有已采集且匹配来源的图片，不能安排原图展示');
        plain(visual.purpose, 160); plain(visual.readingQuestion, 160);
        const target = `${visual.format}:${visual.section}`;
        requireValue(!visualTargets.has(target), '可视化计划重复'); visualTargets.add(target);
        requireValue(!chapter.writingPlan || chapter.writingPlan.sections.includes(visual.section), '可视化没有分配到章节小节');
      }
    }
    requireValue(chapter.focusIds.every((id) => book.focuses.find((focus) => focus.id === id)!.sourceIds.every((sourceId) => chapter.sourceIds.includes(sourceId))), '针对性重点的资料没有落实到对应章节');
    chapter.objectiveIds.forEach((id) => covered.add(id)); chapter.focusIds.forEach((id) => treated.add(id)); chapterIds.add(chapter.id);
  }
  requireValue([...objectiveIds].every((id) => covered.has(id)) && [...focusIds].every((id) => treated.has(id)), '学习目标或针对性重点没有落实到章节');
  if (book.teachingPlan) {
    requireValue(TEXTBOOK_CHAPTER_SECTIONS.every((section) => book.chapters.some((chapter) => chapter.writingPlan!.sections.includes(section))), '全书缺少必要的教学环节');
    requireValue(book.chapters.reduce((sum, chapter) => sum + chapter.writingPlan!.targetChars, 0) === book.teachingPlan.targetChars, '章节篇幅未按全书分配');
  }
}
export function validateChapter(value: unknown, expectedId: string, sourceIds: string[], assetIds: string[] = [],
  writingPlan?: TeachingBlueprint['chapters'][number]['writingPlan']): asserts value is TextbookChapter {
  const chapter = value as TextbookChapter;
  requireValue(chapter?.id === expectedId && chapter.sections && typeof chapter.sections === 'object' && !Array.isArray(chapter.sections), '章节与教学蓝图不匹配');
  const allowed = new Set(sourceIds);
  const normalized: Partial<TextbookChapter['sections']> = {};
  for (const name of TEXTBOOK_CHAPTER_SECTIONS) {
    try {
    const required = (!writingPlan || writingPlan.sections.includes(name))
      && !(name === 'selfCheck' && hasChapterRestatement(writingPlan));
    const raw: unknown = chapter.sections[name];
    // Only genuinely unassigned slots may be absent. Do not drop arbitrary
    // short prose (or objects/code) to make a model response pass validation.
    const emptyOptional = !required && (raw == null || typeof raw === 'string'
      && /^(?:略|本节略|不适用|无需重复|见(?:上|前|前一)章|(?:参见|见)(?:前文|上文))[。.!！]?$/u.test(raw.trim()));
    const text = emptyOptional ? '' : raw;
    requireValue(typeof text === 'string', `章节 ${name} ${required ? '为必填小节，缺失或不是文本' : '必须是文本，不能使用对象、数组或数字'}`);
    requireValue(text.length <= 14_000, `章节 ${name} 过长（${text.length} 字符，上限 14000）`);
    if (emptyOptional) normalized[name] = '';
    if (!required && !text.trim()) continue;
    if (required) requireValue(text.trim().length >= 15, `章节 ${name} 为必填小节，正文不足 15 字（当前 ${text.trim().length} 字）`);
    const controlled = controlledDisplayText(text, sourceIds, assetIds);
    const prose = [markdownProse(text), ...controlled.prose].join('\n');
    const display = [prose, ...controlled.diagrams].join('\n');
    requireValue(!/<\/?[a-zA-Z]|<TextbookBoundary|<LearningReviewBlock|<ArgumentBlock|\[\[[^\]]+\]\]|^\s*[-*+]\s+\[[ xX]\]|@due\(|(?:javascript|file|data):|!\[|\]\(/imu.test(prose), '教材不能包含可执行 HTML、控制块、任务或未经采集的图片/链接');
    const citations = [...display.matchAll(/\[([LN]\d+)\]/gu)].map((hit) => hit[1]);
    requireValue(citations.every((id) => allowed.has(id)), '章节引用了不存在的来源');
    requireValue(!/\[(?:[CMR]\d+)\]/u.test(text + '\n' + display), '个人记录只能用于教学适配，不能作为教材事实引用');
    if (['explanation', 'boundaries', 'workedExample', 'answer'].includes(name)) requireValue(/\[([LN]\d+)\]/u.test(prose), `章节 ${name} 缺少原文来源引用`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '章节校验未通过';
      throw new TextbookValidationError(message, { stage: 'chapters', chapterId: expectedId, section: name, message });
    }
  }
  // Commit compatibility defaults only after every nonempty section has passed
  // the same safety, provenance and privacy gates. Valid legacy bytes stay exact.
  Object.assign(chapter.sections, normalized);
}
export function assembleTextbook(blueprint: TeachingBlueprint, chapters: TextbookChapter[], sources: TextbookSource[],
  options: { references?: 'plain' | 'collapsible' } = {}): string {
  requireValue(chapters.length === blueprint.chapters.length, '教材章节未全部完成');
  const label: Record<keyof TextbookChapter['sections'], string> = { explanation: '概念与机制', boundaries: '适用条件与边界', workedExample: '例子与反例', practice: '迁移练习', answer: '参考答案与解释', selfCheck: '自检', summary: '本章小结' };
  const escape = (value: string) => value.replace(/([\\`*_\[\]<>#])/gu, '\\$1').replace(/\r?\n/gu, ' ');
  const body = [`# ${escape(blueprint.title)}`, '## 学习目标', ...blueprint.objectives.map((item) => `- ${escape(item.text)}`)];
  for (const [index, chapter] of blueprint.chapters.entries()) {
    const written = chapters[index]; validateChapter(written, chapter.id, chapter.sourceIds,
      sources.filter((source) => chapter.sourceIds.includes(source.sourceId)).flatMap((source) => (source.assets || []).map((asset) => asset.id)), chapter.writingPlan);
    body.push(`## ${index + 1}. ${escape(chapter.title)}`, escape(chapter.bridge));
    const sectionOrder = Object.keys(label) as Array<keyof typeof label>;
    // The new prompt is a reading pause, after this chapter's summary/answer.
    // Legacy order/titles stay byte-identical for cached publication and review.
    const ordered = hasChapterRestatement(chapter.writingPlan)
      ? [...sectionOrder.filter(name => name !== 'selfCheck'), 'selfCheck' as const] : sectionOrder;
    for (const name of ordered) {
      let section = written.sections[name].trim();
      if (!section) continue;
      if (name === 'answer') {
        // Basic Markdown answers collapse by default. Complex/code answers retain their
        // original Markdown without loss; authors can use a controlled answer block explicitly.
        try {
          parseTextbookAnswer(JSON.stringify({ title: label[name], text: section }));
          section = '```textbook-answer\n' + JSON.stringify({ title: label[name], text: section }) + '\n```';
        } catch { /* Preserve complex answers exactly; never silently truncate. */ }
      }
      const sectionTitle = name === 'selfCheck' && hasChapterRestatement(chapter.writingPlan) ? '试着复述'
        : name === 'summary' && blueprint.teachingPlan && index === blueprint.chapters.length - 1 ? '学习小结' : label[name];
      body.push(`### ${sectionTitle}`, section);
    }
  }
  const used = new Set(blueprint.chapters.flatMap((chapter) => chapter.sourceIds));
  body.push(...textbookSourceImageAppendix(sources.filter(source => used.has(source.sourceId)), body.join('\n\n')));
  const referenced = sources.filter((item) => used.has(item.sourceId));
  const sourceDescription = (item: TextbookSource) => item.kind === 'web' && item.web
    ? `公开资源${item.web.format === 'transcript' ? '字幕/文字稿' : item.web.contentKind === 'abstract' ? '论文摘要（非全文）' : '正文'}${item.web.coverage === 'excerpt' ? '选段（非整份资料）' : ''}${item.web.acquisition === 'provider_api' ? '（联网 API）' : item.web.acquisition === 'anonymous_browser' ? '（匿名浏览器渲染）' : ''}；${item.web.url}；读取于 ${item.web.readAt}`
    : item.locator ? JSON.stringify(item.locator) : '知识点笔记';
  body.push('## 资料来源');
  const plainReferences = () => referenced.map(item => `- [${item.sourceId}] ${escape(item.title)}；${escape(sourceDescription(item))}；版本 ${item.version.slice(0, 12)}`);
  if (options.references === 'plain') body.push(...plainReferences());
  else {
    const code = JSON.stringify({ entries: referenced.map(item => ({ sourceId: item.sourceId, title: item.title,
      detail: `${sourceDescription(item)}；版本 ${item.version.slice(0, 12)}` })) });
    // Presentation must not make otherwise valid legacy metadata unpublishable.
    try { parseTextbookReferences(code, { sourceIds: [...used] }); body.push('```textbook-references\n' + code + '\n```'); }
    catch { body.push(...plainReferences()); }
  }
  // Validate the original chapter first: escaping must not bypass HTML/privacy
  // gates. Normalize only the assembled publication; private drafts stay exact.
  return prepareMarkdownForMdx(body.join('\n\n')).markdown;
}
/** Publication is computed from validated checkpoints, never from a model's saved=true. */
export function validateTextbookJob(job: TextbookJob, body: string): void {
  const { quality } = job.checkpoint;
  requireValue(quality?.passed === true && quality.issues.length === 0 && quality.status !== 'needs_recheck' && quality.status !== 'blocked', '教材尚未通过完整质量门控');
  validateTextbookContent(job, body);
  if (quality.schemaVersion === 2 || quality.schemaVersion === 3) {
    const { context, sources, blueprint, chapters } = job.checkpoint;
    requireValue(assessTextbookQuality(quality.report, { context: context!, sources: sources!, blueprint: blueprint!, chapters: chapters! }).passed, '教材尚未通过证据绑定的语义门控');
  }
}
/** Run deterministic content/privacy gates BEFORE sending a book for semantic review,
 * and again at publication. A review verdict cannot override any of these checks. */
export function validateTextbookContent(job: TextbookJob, body: string): void {
  const { context, sources, blueprint, chapters } = job.checkpoint;
  requireValue(context && sources?.length && blueprint && chapters, '教材草稿尚未完整');
  requireValue(context.project.id === job.spec.projectNoteId && context.project.rootId === job.spec.rootProjectId, '教学上下文不属于目标项目');
  requireValue(sources.every((item) => item.kind === 'document' ? job.spec.allowedDocIds.includes(item.id)
    : item.kind === 'knowledge' ? item.id in job.spec.knowledgeHashes
    : item.kind === 'web' && !!item.web
      && (job.spec.readBoundUrls === true && job.spec.boundUrls?.some((resource) => resource.id === item.id && resource.url === item.web!.url)
        || job.spec.webSupplement?.version === 1 && /^S[1-3]$/u.test(item.id))
      && item.web.snapshotId === `${job.id}-${item.id}` && /^[a-f0-9]{64}$/u.test(item.version)
      && Number.isSafeInteger(item.textStart) && Number.isSafeInteger(item.textEnd) && item.textStart! >= 0
      && item.textEnd! - item.textStart! === item.text.length), '教材来源越过批准范围');
  const assets = sources.flatMap((source) => source.assets || []);
  requireValue(assets.length <= 160 && new Set(assets.map((asset) => asset.id)).size === assets.length
    && sources.every((source) => (source.assets || []).every((asset) =>
      asset.sourceId === source.sourceId && asset.docId === source.id && asset.version === source.version
      && (source.kind === 'document' && asset.blockId === source.blockId && asset.blockId.startsWith(`${source.id}:block:`)
        || source.kind === 'web' && /^S[1-3]$/u.test(source.id) && /^[a-f0-9]{64}$/u.test(asset.attachmentHash || '') && asset.blockId === `${source.id}:web-image:${asset.imageIndex}`)
      && Number.isSafeInteger(asset.imageIndex) && asset.imageIndex >= 0)), '教材图片引用越过批准范围或重复');
  validateBlueprint(blueprint, context, sources);
  requireValue(body === assembleTextbook(blueprint, chapters, sources)
    || body === assembleTextbook(blueprint, chapters, sources, { references: 'plain' }), '待发布教材与通过校验的章节不一致');
  // Locate deterministic privacy failures before scanning the assembled book. A
  // single rejected section must not turn into an unlocated whole-book rewrite.
  const privacyFindings: TextbookFinding[] = [];
  // Match assembly's published fields exactly. Unknown model metadata (e.g. an
  // object-valued summaryTable) is neither rendered nor a Markdown input.
  for (const chapter of chapters) for (const section of TEXTBOOK_CHAPTER_SECTIONS) {
    try { validateTextbookPrivacy(job, chapter.sections[section], false); }
    catch (error) {
      const message = error instanceof Error ? error.message : '教材隐私校验未通过';
      privacyFindings.push({ stage: 'chapters', chapterId: chapter.id, section: section as keyof TextbookChapter['sections'], message });
      break;
    }
  }
  try { validateTextbookPrivacy(job, [blueprint.title, ...blueprint.objectives.map((item) => item.text), ...blueprint.chapters.flatMap((chapter) => [chapter.title, chapter.bridge])].join('\n'), false); }
  catch (error) {
    const message = error instanceof Error ? error.message : '教学蓝图隐私校验未通过';
    privacyFindings.push({ stage: 'blueprint', message });
  }
  if (privacyFindings.length) throw new TextbookValidationError(privacyFindings[0].message, privacyFindings[0], privacyFindings);
  validateTextbookPrivacy(job, body);
}
function validateTextbookPrivacy(job: TextbookJob, body: string, includeAssets = true): void {
  const { context, sources } = job.checkpoint;
  requireValue(context && sources, '教材缺少隐私校验上下文');
  const assets = sources.flatMap((source) => source.assets || []);
  const controlled = controlledDisplayText(body, sources.map((source) => source.sourceId), assets.map((asset) => asset.id));
  const display = [body, renderedMarkdownText(body), ...controlled.prose, ...controlled.diagrams, ...(includeAssets ? assets.map((asset) => asset.alt || '') : [])].join('\n');
  for (const item of context.personal) {
    if (!/^[CMR]\d+$/u.test(item.evidenceId)) continue;
    const identifier = new RegExp(`\\b${item.evidenceId}\\b`, 'u');
    if (!identifier.test(display)) continue;
    // A domain term such as monetary aggregate M1 is not a private reference
    // merely because an internal evidence ID happens to match it. It must exist
    // in factual material and must not be presented as an internal record ID.
    const domainTerm = sources.some((source) => identifier.test(source.text) || identifier.test(renderedMarkdownText(source.text)));
    const descriptor = '(?:个人记录|个人证据|个人认知材料|内部编号|内部证据|认知记录|认知证据)';
    // Do not associate an ordinary domain term with an unrelated next sentence.
    const withinSentence = '[^\\n。！？；.!?;]{0,160}';
    const before = new RegExp(`${descriptor}${withinSentence}\\b${item.evidenceId}\\b`, 'u');
    const after = new RegExp(`\\b${item.evidenceId}\\b${withinSentence}${descriptor}`, 'u');
    requireValue(domainTerm && !before.test(display) && !after.test(display), '教材正文泄露了内部个人证据编号，不能作为可分享教材发布');
  }
  requireValue(context.personal.every((item) => item.text.trim().length < 24 || !display.includes(item.text.trim())), '教材正文复制了个人原话，不能作为可分享教材发布');
  requireValue(context.profile.length < 40 || !display.includes(context.profile), '教材正文复制了内部画像');
}
