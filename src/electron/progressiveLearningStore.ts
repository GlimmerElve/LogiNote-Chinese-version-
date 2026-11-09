import { ProgressiveReviewAuthority } from './progressiveReview';
import type { ProgressiveReviewCommand } from '../services/progressiveLearning/reviewTypes';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { NoteItem } from '../types';
import type { ProgressiveBeginReply, ProgressiveCheckpoint, ProgressiveCommand, ProgressiveCourse,
  ProgressiveLease, ProgressiveLessonPage, ProgressiveMainline, ProgressiveProgressRequest,
  ProgressivePublication, ProgressiveReply, ProgressivePageSummary, ProgressiveNextRequest, ProgressivePageStudy,
  ProgressiveStudyRequest, ProgressiveStudyReply, ProgressiveRoute } from '../services/progressiveLearning/types';
import { progressiveText, validateProgressiveMainline, validateProgressiveHook,
  validateProgressiveSources, validateProgressiveProgressPatch,
  PROGRESSIVE_MAX_BODY, PROGRESSIVE_MAX_RAW, validProgressivePageId, validateProgressiveConcepts,
  validateProgressiveQuestions, projectProgressiveQuestion, validateProgressiveRoute } from '../services/progressiveLearning/validation';
import { emptyProgressiveStudy, mutateProgressiveStudy, validateStoredProgressiveStudy, progressiveStudySummary, progressiveAdaptation, consumeProgressiveSignals } from './progressiveStudy';
import { readTextbookBody } from '../services/textbook/noteContent';
import { atomicWriteTextFile } from './atomicWrite';
import { shareProgressiveTeaching } from '../services/progressiveLearning/share';
import { createProgressiveWritingPolicy } from '../services/progressiveLearning/writingGuidance';
import { patchProgressiveDiagram } from '../services/progressiveLearning/diagramEditing';
import { progressiveBudgetedPageCount } from '../services/progressiveLearning/budget';
import { mutateCognition } from './cognitionStore';
import type { CognitionMutation } from '../services/cognition/types';

export interface ProgressiveTarget { note: NoteItem; root: NoteItem; isLeaf: boolean }
export interface ProgressiveStoreDependencies {
  readTarget(projectNoteId: string): Promise<ProgressiveTarget>;
  write?(file: string, text: string): Promise<unknown>;
  isCurrent?(): boolean;
  canBegin?(projectNoteId: string): void | Promise<void>;
  /** A durable publication is the input journal; derived work is never awaited here. */
  changed?(projectNoteId: string): void;
  reviewChanged?(projectNoteId:string):void;
  pageChanged?(projectNoteId:string):void;
  knowledgeIds?(projectNoteId:string,pageId:string,pageHash:string):Promise<string[]>;
  /** Runs inside the course command queue; never re-enters this store's command(). */
  writeCognition?(input: CognitionMutation): Promise<unknown>;
}
export type StoredProgressiveCourse = Omit<ProgressiveCourse, 'environmentId' | 'firstPage' | 'page' | 'study' | 'currentFeedback'> & { firstPageReady: boolean };
type StoredCourse = StoredProgressiveCourse;
type ActiveLease = ProgressiveLease & { owner: number };
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const progressivePageHash = (page: ProgressiveLessonPage) => createHash('sha256')
  .update(JSON.stringify({ title: page.title, body: page.body, hook: page.hook, concepts: page.concepts || [],
    ...(page.questions?.length ? { questions: page.questions.map(projectProgressiveQuestion) } : {}) })).digest('hex');
export const progressivePageSummary = (page: ProgressiveLessonPage): ProgressivePageSummary => ({
  id: page.id, kind: page.kind, mainlineIndex: page.mainlineIndex,
  ...(page.parentPageId ? { parentPageId: page.parentPageId } : {}), title: page.title,
  ...(page.manualExpansion ? { manualExpansion: true as const } : {}),
  contentHash: progressivePageHash(page), createdAt: page.createdAt, updatedAt: page.updatedAt,
  ...(page.questions?.length ? { questionCount: page.questions.length } : {}),
});

/** Private page checkpoints. No NoteItem writes, index calls or model work occur here. */
export class ProgressiveLearningStore {
  readonly environmentId: string;
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private leases = new Map<string, ActiveLease>();
  private reviews:ProgressiveReviewAuthority;
  constructor(userStateDir: string, private dependencies: ProgressiveStoreDependencies) {
    this.directory = path.resolve(userStateDir, 'progressive-learning');
    this.environmentId = `ple-${createHash('sha256').update(this.directory).digest('hex').slice(0, 32)}`;
    this.reviews=new ProgressiveReviewAuthority({environmentId:this.environmentId,current:()=>this.current(),directory:id=>this.directories(id,true),
      readJson:(f,l)=>this.readJson(f,l),write:(f,v,l)=>this.write(f,v,l),read:id=>this.read(id),save:c=>this.save(c),snapshot:c=>this.snapshot(c),
      target:id=>this.target(id),readPage:(id,p,h)=>this.readPage(id,p,h),study:(c,p)=>this.study(c,p),list:()=>this.listPublished(),
      knowledgeIds:dependencies.knowledgeIds,changed:dependencies.reviewChanged,
      writeCognition: input => dependencies.writeCognition ? dependencies.writeCognition(input)
        : mutateCognition(userStateDir, input, () => { this.current(); return true; })});
  }
  private current() { if (this.dependencies.isCurrent && !this.dependencies.isCurrent()) throw new Error('学习存储环境已变化，请重新进入心流。'); }
  private projectDirectory(projectNoteId: string) {
    progressiveText(projectNoteId, 300, '项目编号');
    return path.join(this.directory, `project-${createHash('sha256').update(projectNoteId).digest('hex')}`);
  }
  private async directories(projectNoteId: string, create = false) {
    const project = this.projectDirectory(projectNoteId);
    for (const directory of [this.directory, project, path.join(project, 'pages'), path.join(project, 'study'), path.join(project,'reviews')]) {
      if (create) await fs.mkdir(directory, { recursive: true });
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('渐进课程存储路径无效');
      } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return project; throw error; }
    }
    return project;
  }
  private async readJson(file: string, limit: number): Promise<unknown | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('课程文件无效或超过读取上限');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('课程保存记录无法读取；未覆盖原有内容。'); }
  }
  private async read(projectNoteId: string): Promise<StoredCourse | null> {
    const directory = await this.directories(projectNoteId);
    const value = await this.readJson(path.join(directory, 'course.json'), 1_500_000) as StoredCourse | null;
    if (!value) return null;
    if (value.schemaVersion !== 1 || value.projectNoteId !== projectNoteId || typeof value.id !== 'string'
      || !integer(value.revision) || !value.budget || !value.generation || !validProgressivePageId(value.generation.pageId)
      || !integer(value.generation.sequence) || !integer(value.generation.attempts)
      || !['prepared', 'generating', 'interrupted', 'failed', 'ready'].includes(value.generation.status)
      || typeof value.firstPageReady !== 'boolean' || !value.progress || !integer(value.progress.version)
      || !Number.isSafeInteger(value.budget.maxMainlinePages) || value.budget.maxMainlinePages < 1 || value.budget.maxMainlinePages > 4
      || !Number.isSafeInteger(value.budget.totalPageLimit) || value.budget.totalPageLimit < value.budget.maxMainlinePages) throw new Error('课程记录格式无效；未覆盖原有内容。');
    progressiveText(value.generation.requestId, 100, '生成请求');
    progressiveText(value.generation.rawDraft, PROGRESSIVE_MAX_RAW, '生成草稿', true);
    progressiveText(value.generation.bodyDraft, PROGRESSIVE_MAX_BODY, '讲解草稿', true);
    if (value.generation.figurePolicy !== undefined && value.generation.figurePolicy !== 1)
      throw Error('交互教学策略标记无效；原课程保持不变。');
    if (value.generation.manualExpansion !== undefined
      && (value.generation.manualExpansion !== true || value.generation.kind !== 'expansion' || value.generation.routePending))
      throw Error('主动补充任务标记无效；原课程保持不变。');
    if (value.generation.supplementDesign !== undefined) {
      const design = value.generation.supplementDesign;
      if (!design || design.version !== 1 || !['selection', 'page'].includes(design.mode)
        || value.generation.manualExpansion !== true || value.generation.kind !== 'expansion') throw Error('补充讲解设计无效；原课程保持不变。');
      progressiveText(design.sourceTitle, 300, '补充来源标题');
    }
    if (value.generation.previousTeaching) {
      progressiveText(value.generation.previousTeaching.title, 300, '前页标题');
      progressiveText(value.generation.previousTeaching.excerpt, 2500, '前页衔接', true);
    }
    if (value.plan) validateProgressiveMainline(value.plan, value.budget.maxMainlinePages);
    validateProgressiveSources(value.sourcePackets);
    const { version: _version, ...progress } = value.progress;
    validateProgressiveProgressPatch(progress, projectNoteId);
    if (value.progress.restatementSpans?.some(span => span.end > value.progress.restatementDraft.length)) throw Error('复述原文与页面定位不一致');
    if (!value.pages) {
      value.pages = value.firstPageReady ? [progressivePageSummary(await this.readPage(projectNoteId, 'main-1'))] : [];
    }
    const ids = new Set<string>();
    if (!Array.isArray(value.pages)) throw Error('页面目录无效');
    for (const entry of value.pages) {
      if (!validProgressivePageId(entry.id) || ids.has(entry.id) || !/^[a-f0-9]{64}$/u.test(entry.contentHash)
        || !integer(entry.mainlineIndex) || entry.mainlineIndex > 3
        || !['mainline', 'expansion'].includes(entry.kind)
        || (entry.manualExpansion !== undefined && (entry.manualExpansion !== true || entry.kind !== 'expansion'))
        || (entry.kind === 'mainline' ? entry.id !== `main-${entry.mainlineIndex + 1}`
          : !entry.id.startsWith('extra-') || entry.parentPageId !== `main-${entry.mainlineIndex + 1}`)) throw Error('页面目录无效；原课程保持不变。');
      ids.add(entry.id);
    }
    if (progressiveBudgetedPageCount(value.pages) > value.budget.totalPageLimit) throw Error('自动页面目录超过课程预算');
    return value;
  }
  private async readPage(projectNoteId: string, pageId: string, hash?: string): Promise<ProgressiveLessonPage> {
    if (!validProgressivePageId(pageId)) throw Error('页面编号无效');
    if (hash && !/^[a-f0-9]{64}$/u.test(hash)) throw Error('页面版本无效');
    // Stage-one files are retained; later revisions are immutable and directory-selected.
    const versioned = hash ? await this.readJson(path.join(this.projectDirectory(projectNoteId), 'pages', `${pageId}.${hash}.json`), 1_000_000) : null;
    const page = (versioned || await this.readJson(path.join(this.projectDirectory(projectNoteId), 'pages', `${pageId}.json`), 1_000_000)) as ProgressiveLessonPage | null;
    if (!page || page.id !== pageId || !['mainline', 'expansion'].includes(page.kind) || !integer(page.mainlineIndex) || page.mainlineIndex > 3) throw Error('已保存讲解页缺失；未用空白内容替代。');
    if (page.manualExpansion !== undefined && (page.manualExpansion !== true || page.kind !== 'expansion')) throw Error('讲解页主动补充标记无效；原文未覆盖。');
    progressiveText(page.title, 300, '讲解标题'); progressiveText(page.body, PROGRESSIVE_MAX_BODY, '讲解正文');
    validateProgressiveHook(page.hook);
    if (page.concepts) validateProgressiveConcepts(page.concepts);
    if (page.sourcePackets) validateProgressiveSources(page.sourcePackets);
    if (page.questions) validateProgressiveQuestions(page.questions, page.body);
    if (hash && progressivePageHash(page) !== hash) throw Error('页面正文与已保存版本不一致；原文未覆盖。');
    return page;
  }
  private async writePage(projectNoteId: string, page: ProgressiveLessonPage) {
    await this.directories(projectNoteId, true);
    await this.write(path.join(this.projectDirectory(projectNoteId), 'pages', `${page.id}.${progressivePageHash(page)}.json`), page);
  }
  private async study(course: StoredCourse, pageId: string): Promise<ProgressivePageStudy> {
    if (!validProgressivePageId(pageId)) throw Error('学习记录页面无效');
    const ref = course.studyPages?.find(item => item.pageId === pageId);
    if (!ref) return emptyProgressiveStudy(pageId);
    if (!integer(ref.version) || !ref.version) throw Error('学习记录版本无效');
    const study = await this.readJson(path.join(this.projectDirectory(course.projectNoteId), 'study', `${pageId}.${ref.version}.json`), 6_000_000) as ProgressivePageStudy | null;
    if (!study || study.schemaVersion !== 1 || study.pageId !== pageId || study.version !== ref.version
      || !Array.isArray(study.attempts) || study.attempts.length > 90 || !Array.isArray(study.feedback) || study.feedback.length > 60
      || !study.drafts || typeof study.drafts !== 'object') throw Error('私人学习记录损坏；原记录未覆盖。');
    validateStoredProgressiveStudy(study);
    return study;
  }
  private async snapshot(course: StoredCourse, requestedPageId?: string): Promise<ProgressiveCourse> {
    const selected = requestedPageId || course.progress.currentPageId || course.generation.pageId;
    const descriptor = course.pages?.find(entry => entry.id === selected);
    const page = descriptor ? await this.readPage(course.projectNoteId, selected, descriptor.contentHash) : null;
    if (page && progressivePageHash(page) !== descriptor!.contentHash) throw Error('页面正文与目录版本不一致，原文已保留。');
    if (page && page.manualExpansion !== descriptor!.manualExpansion) throw Error('讲解页补充属性与目录不一致，原文已保留。');
    const { firstPageReady: _ready, ...stored } = course;
    const study = page ? await this.study(course, page.id) : null;
    const result: ProgressiveCourse = { ...stored, environmentId: this.environmentId, firstPage: page?.id === 'main-1' ? page : null, page,
      ...(page && study ? { study, currentFeedback: progressiveAdaptation(course, page, study) } : {}),
      ...(requestedPageId ? { progress: { ...stored.progress, currentPageId: requestedPageId, scrollTop: 0 } } : {}) };
    if (result.generation.status === 'generating' && !this.leases.has(course.projectNoteId)) {
      result.generation = { ...result.generation, status: 'interrupted', error: '上次生成已中断，已保存内容可继续。' };
    }
    return result;
  }
  private async write(file: string, value: unknown, limit = 350_000) {
    this.current();
    const text = JSON.stringify(value);
    if (text.length > limit) throw new Error('课程数据超过本页保存上限。');
    await (this.dependencies.write || ((target, content) => atomicWriteTextFile(target, content, { allowCopyFallback: false })))(file, text);
    this.current();
  }
  private async save(course: StoredCourse) {
    await this.directories(course.projectNoteId, true);
    await this.write(path.join(this.projectDirectory(course.projectNoteId), 'course.json'), course);
  }
  private async target(projectNoteId: string): Promise<ProgressiveTarget> {
    const target = await this.dependencies.readTarget(projectNoteId);
    if (!target || target.note?.id !== projectNoteId || target.note.noteType !== 'project'
      || target.note.projectRole === 'reference' || !target.isLeaf || target.root?.noteType !== 'project') throw new Error('只有学习叶子项目可以建立渐进课程。');
    return target;
  }
  private async required(projectNoteId: string) {
    const course = await this.read(projectNoteId);
    if (!course) throw new Error('课程尚未建立，请重新进入心流。');
    return course;
  }
  private checkLease(value: ProgressiveLease, owner: number, course: StoredCourse) {
    const lease = this.leases.get(course.projectNoteId);
    if (!value || value.environmentId !== this.environmentId || value.projectNoteId !== course.projectNoteId
      || value.courseId !== course.id || value.requestId !== course.generation.requestId || value.pageId !== course.generation.pageId
      || !lease || lease.owner !== owner || lease.token !== value.token) throw new Error('生成任务已结束或发生变化，旧结果未覆盖当前课程。');
  }
  private plan(plan: ProgressiveMainline, maxPages: number): ProgressiveMainline {
    validateProgressiveMainline(plan, maxPages);
    return { title: plan.title, objectives: [...plan.objectives], pages: plan.pages.map(page => ({ id: page.id, title: page.title, objectives: [...page.objectives] })) };
  }
  private budget(target: ProgressiveTarget) {
    const deadline = target.note.dueDates?.find(item => item.taskText.trim() === target.note.title.trim());
    const explicit = deadline?.estimatedMinutes;
    const daily = target.root.planMeta?.dailyStudyMinutes;
    const start = deadline?.startDate && Date.parse(`${deadline.startDate}T00:00:00Z`);
    const end = deadline?.dueDate && Date.parse(`${deadline.dueDate}T00:00:00Z`);
    const days = typeof start === 'number' && Number.isFinite(start) && typeof end === 'number' && end >= start
      ? Math.floor((end - start) / 86400000) + 1 : null;
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
      && value > 0 && value < Number.MAX_SAFE_INTEGER / 10;
    const estimated = valid(explicit) ? explicit : valid(daily) && days && valid(daily * days) ? daily * days : null;
    const totalPageLimit = estimated ? Math.max(1, Math.ceil(estimated / 5)) : 4;
    return { estimatedMinutes: estimated, totalPageLimit, maxMainlinePages: Math.min(4, totalPageLimit) };
  }
  hasRunningProject(projectNoteId: string): boolean { return this.leases.has(projectNoteId); }
  async hasCourse(projectNoteId: string): Promise<boolean> { return Boolean(await this.read(projectNoteId)); }
  async idle(): Promise<void> { await this.queue.catch(() => {}); }
  /** Explicit export reads committed pages without visiting them or projecting
   * answer drafts, source packets, progress, review receipts or job state. */
  exportTeaching(projectNoteId: string) {
    const run = this.queue.catch(() => {}).then(async () => {
      this.current(); const course = await this.read(projectNoteId); if (!course) return null;
      const pages: ProgressiveLessonPage[] = [];
      for (const ref of course.pages || []) pages.push(await this.readPage(projectNoteId, ref.id, ref.contentHash));
      return shareProgressiveTeaching({ ...course, environmentId: this.environmentId, firstPage: null }, pages);
    });
    this.queue = run; return run;
  }
  releaseOwner(owner: number): void {
    this.reviews.releaseOwner(owner);
    for (const [id, lease] of this.leases) if (lease.owner === owner) this.leases.delete(id);
  }
  /** Background recovery scans small committed directories, never all note or page bodies. */
  async listPublished(projectNoteId?: string): Promise<Array<{ projectNoteId: string; courseId: string; pages: ProgressivePageSummary[] }>> {
    this.current();
    if (projectNoteId) {
      const course = await this.read(projectNoteId);
      return course ? [{ projectNoteId, courseId: course.id, pages: course.pages || [] }] : [];
    }
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: Awaited<ReturnType<ProgressiveLearningStore['listPublished']>> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^project-[a-f0-9]{64}$/u.test(entry.name)) continue;
      const raw = await this.readJson(path.join(this.directory, entry.name, 'course.json'), 1_500_000) as StoredCourse | null;
      if (!raw || this.projectDirectory(raw.projectNoteId) !== path.join(this.directory, entry.name)) continue;
      result.push(...await this.listPublished(raw.projectNoteId));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  }
  async readPublished(projectNoteId: string, pageId: string, expectedHash: string): Promise<ProgressiveLessonPage | null> {
    this.current();
    const course = await this.read(projectNoteId);
    if (!course?.pages?.some(page => page.id === pageId && page.contentHash === expectedHash)) return null;
    const page = await this.readPage(projectNoteId, pageId, expectedHash);
    if (progressivePageHash(page) !== expectedHash) throw Error('页面正文版本校验失败');
    return page;
  }
  command(input: ProgressiveCommand, owner: number): Promise<ProgressiveReply> {
    const run = this.queue.catch(() => {}).then(() => this.execute(input, owner));
    this.queue = run; return run;
  }
  private async execute(input: ProgressiveCommand, owner: number): Promise<ProgressiveReply> {
    this.current();
    if(input&&typeof input==='object'&&typeof input.op==='string'&&input.op.startsWith('review-')){
      if(JSON.stringify(input).length>2800000)throw Error('复盘请求超过单段上限');
      return this.reviews.execute(input as ProgressiveReviewCommand,owner);
    }
    return this.executeTeaching(input as Exclude<ProgressiveCommand,ProgressiveReviewCommand>,owner);
  }
  private async executeTeaching(input:Exclude<ProgressiveCommand,ProgressiveReviewCommand>,owner:number):Promise<ProgressiveReply>{
    if (!input || typeof input !== 'object' || !['load', 'read-page', 'study', 'route', 'begin', 'next', 'update-page', 'patch-diagram', 'delete-page', 'checkpoint', 'publish', 'save-progress', 'interrupt'].includes(input.op)
      || JSON.stringify(input).length > 200_000) throw new Error('渐进课程请求无效。');
    const projectNoteId = 'projectNoteId' in input ? input.projectNoteId : input.lease?.projectNoteId;
    progressiveText(projectNoteId, 300, '项目编号');
    if (input.op === 'load' || input.op === 'read-page') {
      await this.target(projectNoteId);
      const course = await this.read(projectNoteId);
      if (input.op === 'read-page' && (!validProgressivePageId(input.pageId) || !course?.pages?.some(page => page.id === input.pageId))) throw Error('该讲解页尚未保存');
      return course ? this.snapshot(course, input.op === 'read-page' ? input.pageId : undefined) : null;
    }
    if (input.op === 'begin') {
      const target = await this.target(projectNoteId);
      await this.dependencies.canBegin?.(projectNoteId);
      let course = await this.read(projectNoteId);
      if (!course) {
        const legacyBody = target.note.textbook ? readTextbookBody(target.note.content, target.note.textbook) : null;
        if (legacyBody?.trim()) throw new Error('此项目已有完整教材，请继续阅读原教材。');
        validateProgressiveSources(input.sourcePackets || []);
        const now = new Date().toISOString();
        course = {
          schemaVersion: 1, id: `course-${randomUUID()}`, projectNoteId, rootProjectId: target.root.id, title: target.note.title,
          revision: 0, createdAt: now, updatedAt: now, budget: this.budget(target), plan: null, firstPageReady: false,
          progress: { version: 0, currentPageId: 'main-1', scrollTop: 0, restatementDraft: '', summaryDraft: '',
            questions: target.note.questions === undefined ? undefined : structuredClone(target.note.questions), questionDraft: '' },
          generation: { requestId: `request-${randomUUID()}`, pageId: 'main-1', status: 'prepared', attempts: 0, sequence: 0, rawDraft: '', bodyDraft: '', figurePolicy: 1,
            writingPolicy: createProgressiveWritingPolicy({ title: target.note.title, rootTitle: target.root.title, sources: input.sourcePackets }) },
          sourcePackets: structuredClone(input.sourcePackets || []),
        };
      }
      if (course.generation.status === 'ready') return { course: await this.snapshot(course), running: false } satisfies ProgressiveBeginReply;
      return this.acquire(course, owner);
    }
    const course = await this.required(projectNoteId);
    if (input.op === 'save-progress') return this.saveProgress(course, input.progress);
    if (input.op === 'study') return this.saveStudy(course, input.request);
    if (input.op === 'route') return this.route(course, input.lease, input.route, owner);
    if (input.op === 'next') return this.next(course, input.request, owner);
    if (input.op === 'update-page' || input.op === 'patch-diagram' || input.op === 'delete-page') return this.changePage(course, input);
    // A successful commit may lose its IPC reply. A retry reads the same publication,
    // never writes it again and never replaces already published teaching content.
    if (input.op === 'publish' && course.generation.status === 'ready') {
      if (input.lease?.environmentId !== this.environmentId || input.lease.courseId !== course.id
        || input.lease.requestId !== course.generation.requestId || input.lease.pageId !== course.generation.pageId
        || input.teaching?.sequence !== course.generation.sequence) throw new Error('讲解发布版本已变化，未覆盖已生成内容。');
      const saved = await this.snapshot(course);
      const page = await this.readPage(projectNoteId, input.lease.pageId, course.pages?.find(page => page.id === input.lease.pageId)?.contentHash);
      if (!same(saved.plan, this.plan(input.teaching.plan, course.budget.maxMainlinePages))
        || page.title !== input.teaching.title || page.body !== input.teaching.body.trim()
        || !same(page.hook, input.teaching.hook) || !same(page.concepts || [], input.teaching.concepts || [])) throw new Error('讲解已经保存，未用不同内容覆盖原页。');
      if (!same(page.questions || [], input.teaching.questions || [])) throw Error('原题已保存，不接受迟到替换');
      return saved;
    }
    this.checkLease(input.lease, owner, course);
    if (input.op === 'interrupt') {
      const error = input.error === undefined ? '生成已暂停，已保存内容可继续。' : progressiveText(input.error, 1500, '任务状态', true);
      const next: StoredCourse = { ...course, revision: course.revision + 1, updatedAt: new Date().toISOString(),
        generation: { ...course.generation, status: input.error ? 'failed' : 'interrupted', error } };
      await this.save(next); this.leases.delete(projectNoteId); return this.snapshot(next);
    }
    if (input.op === 'checkpoint') return this.checkpoint(course, input.checkpoint);
    return this.publish(course, input.teaching);
  }
  private async acquire(course: StoredCourse, owner: number): Promise<ProgressiveBeginReply> {
    const active = this.leases.get(course.projectNoteId);
    if (active) return { course: await this.snapshot(course), running: true };
    const lease: ActiveLease = { environmentId: this.environmentId, projectNoteId: course.projectNoteId, courseId: course.id,
      requestId: course.generation.requestId, pageId: course.generation.pageId, token: randomUUID(), owner };
    const next: StoredCourse = { ...course, revision: course.revision + 1, updatedAt: new Date().toISOString(),
      generation: { ...course.generation, status: 'generating', attempts: course.generation.attempts + 1, error: undefined } };
    await this.save(next); this.leases.set(course.projectNoteId, lease);
    const { owner: _owner, ...publicLease } = lease;
    return { course: await this.snapshot(next), lease: publicLease, running: true };
  }
  private async next(course: StoredCourse, request: ProgressiveNextRequest, owner: number): Promise<ProgressiveBeginReply> {
    const target = await this.target(course.projectNoteId); await this.dependencies.canBegin?.(course.projectNoteId);
    if (!request || request.environmentId !== this.environmentId || request.courseId !== course.id
      || !integer(request.expectedRevision) || !validProgressivePageId(request.fromPageId)
      || !['mainline', 'expansion', 'auto'].includes(request.intent)) throw Error('下一页请求无效');
    progressiveText(request.requestId, 100, '下一页请求编号');
    if (request.requestId === course.generation.requestId) return course.generation.status === 'ready'
      ? { course: await this.snapshot(course), running: false } : this.acquire(course, owner);
    if (course.revision !== request.expectedRevision) throw Error('课程已更新，请重试下一页。');
    if (!course.plan || course.generation.status !== 'ready' || this.leases.has(course.projectNoteId)) throw Error('请先完成或继续当前页的生成。');
    const pages = course.pages || [], source = pages.find(page => page.id === request.fromPageId);
    if (!source) throw Error('补充或衔接来源页尚未保存。');
    const missing = course.plan.pages.findIndex(page => !pages.some(saved => saved.id === page.id));
    const remainingMainline = course.plan.pages.filter(page => !pages.some(saved => saved.id === page.id)).length;
    const sourcePage = await this.readPage(course.projectNoteId, source.id, source.contentHash);
    const adaptation = progressiveAdaptation(course, sourcePage, await this.study(course, source.id));
    if (request.intent === 'auto' && !remainingMainline && (!adaptation.fresh || !adaptation.expansionAvailable)) {
      return { course: await this.snapshot(course), running: false };
    }
    if (request.intent === 'mainline' && missing < 0) throw Error('主线讲解已全部生成。');
    const routePending = request.intent === 'auto' && adaptation.fresh;
    const kind = request.intent === 'expansion' ? 'expansion' : 'mainline';
    const index = kind === 'mainline' && missing >= 0 ? missing : source.mainlineIndex;
    const pageId = !routePending && kind === 'mainline' ? course.plan.pages[index].id : `extra-${randomUUID()}`;
    if (request.sourcePackets !== undefined) validateProgressiveSources(request.sourcePackets);
    if (request.scope) {
      if (request.intent !== 'expansion' || request.scope.pageHash !== source.contentHash) throw Error('补充选区所属页面已变化');
      progressiveText(request.scope.text, PROGRESSIVE_MAX_BODY, '补充选区', true);
      for (const text of [request.scope.before, request.scope.after]) if (text !== undefined) progressiveText(text, 1000, '选区上下文', true);
    }
    const next: StoredCourse = { ...course, revision: course.revision + 1,
      sourcePackets: request.sourcePackets === undefined ? course.sourcePackets : structuredClone(request.sourcePackets),
      ...(!routePending && adaptation.fresh ? { consumedFeedback: { ...course.consumedFeedback, [source.id]: adaptation.feedbackKey },
        consumedSignals: consumeProgressiveSignals(course, source.id, adaptation) } : {}),
      progress: { ...course.progress, version: course.progress.version + 1, currentPageId: pageId, scrollTop: 0 },
      generation: { requestId: request.requestId, pageId, status: 'prepared', attempts: 0, sequence: 0,
        rawDraft: '', bodyDraft: '', figurePolicy: 1, kind, mainlineIndex: index, fromPageId: source.id,
        ...(request.intent === 'expansion' ? { manualExpansion: true as const } : {}),
        ...(request.intent === 'expansion' ? { supplementDesign: { version: 1 as const,
          mode: request.scope?.text.trim() ? 'selection' as const : 'page' as const, sourceTitle: sourcePage.title } } : {}),
        writingPolicy: createProgressiveWritingPolicy({ title: target.note.title, rootTitle: target.root.title,
          pageTitle: routePending ? `${sourcePage.title}\n${course.plan.pages[index]?.title || ''}`
            : kind === 'expansion' ? sourcePage.title : course.plan.pages[index]?.title,
          objectives: kind === 'mainline' ? course.plan.pages[index]?.objectives : undefined,
          scope: kind === 'expansion' ? request.scope?.text : undefined,
          sources: request.sourcePackets ?? course.sourcePackets }),
        originPageId: source.id, originScrollTop: course.progress.scrollTop, routePending, adaptation,
        ...(kind === 'expansion' ? { scope: { text: request.scope?.text.trim() ? request.scope.text : sourcePage.body,
          ...(request.scope?.before ? { before: request.scope.before } : {}), ...(request.scope?.after ? { after: request.scope.after } : {}), pageHash: source.contentHash } } : {}),
        previousTeaching: { title: sourcePage.title, excerpt: sourcePage.body.slice(-2500) },
        ...(kind === 'expansion' ? { parentPageId: source.kind === 'mainline' ? source.id : source.parentPageId } : {}) } };
    // Persist the identity before leasing: a failed or lost reply resumes this page, not a new one.
    await this.save(next);
    return this.acquire(next, owner);
  }
  private async route(course: StoredCourse, lease: ProgressiveLease, route: ProgressiveRoute, owner: number): Promise<ProgressiveBeginReply> {
    validateProgressiveRoute(route);
    if (lease.environmentId !== this.environmentId || lease.courseId !== course.id || lease.requestId !== course.generation.requestId) throw Error('编排任务已变化');
    if (!course.generation.routePending) {
      if (course.generation.route?.kind !== route.kind) throw Error('已有编排不接受迟到替换');
      const active = this.leases.get(course.projectNoteId);
      if (active && (active.owner !== owner || active.token !== lease.token)) throw Error('当前窗口没有编排许可');
      const publicLease = active ? { ...active } : undefined;
      if (publicLease) delete (publicLease as Partial<ActiveLease>).owner;
      return { course: await this.snapshot(course), lease: publicLease, running: Boolean(active) };
    }
    this.checkLease(lease, owner, course);
    const adaptation = course.generation.adaptation!, origin = course.pages!.find(page => page.id === course.generation.originPageId)!;
    const missing = course.plan!.pages.findIndex(page => !course.pages!.some(saved => saved.id === page.id));
    if (route.kind === 'expansion' && (!adaptation.fresh || !adaptation.expansionAvailable)) throw Error('当前没有可用补充依据或预算');
    if (route.kind === 'mainline' && missing < 0 || route.kind === 'finish' && missing >= 0) throw Error('编排结果与剩余主线不符');
    const pageId = route.kind === 'mainline' ? course.plan!.pages[missing].id : route.kind === 'finish' ? origin.id : course.generation.pageId;
    const next: StoredCourse = { ...course, revision: course.revision + 1,
      consumedFeedback: { ...course.consumedFeedback, [origin.id]: adaptation.feedbackKey },
      consumedSignals: consumeProgressiveSignals(course, origin.id, adaptation),
      lastDecision: { kind: route.kind, reason: route.reason, ...(route.correction ? { correction: route.correction } : {}),
        requestId: course.generation.requestId, fromPageId: origin.id, at: new Date().toISOString() },
      progress: { ...course.progress, version: course.progress.version + 1, currentPageId: pageId,
        scrollTop: route.kind === 'finish' ? course.generation.originScrollTop || 0 : 0 },
      generation: { ...course.generation, pageId, routePending: false, route: { kind: route.kind, reason: route.reason, ...(route.correction ? { correction: route.correction } : {}) },
        mainlineIndex: route.kind === 'mainline' ? missing : origin.mainlineIndex,
        kind: route.kind === 'expansion' ? 'expansion' : route.kind === 'finish' ? origin.kind : 'mainline',
        parentPageId: route.kind === 'expansion' ? origin.kind === 'mainline' ? origin.id : origin.parentPageId : undefined,
        status: route.kind === 'finish' ? 'ready' : 'generating' } };
    if (route.kind === 'finish') { next.generation.rawDraft = ''; next.generation.bodyDraft = ''; }
    await this.save(next);
    const active = this.leases.get(course.projectNoteId)!;
    if (route.kind === 'finish') { this.leases.delete(course.projectNoteId); return { course: await this.snapshot(next), running: false }; }
    const rebound = { ...active, pageId }; this.leases.set(course.projectNoteId, rebound);
    const { owner: _owner, ...publicLease } = rebound;
    return { course: await this.snapshot(next), lease: publicLease, running: true };
  }
  private async saveStudy(course: StoredCourse, request: ProgressiveStudyRequest): Promise<ProgressiveStudyReply> {
    if (!request || request.environmentId !== this.environmentId || request.courseId !== course.id
      || !integer(request.expectedVersion) || !validProgressivePageId(request.pageId)) throw Error('学习记录所属环境已变化');
    await this.target(course.projectNoteId);
    const descriptor = course.pages?.find(page => page.id === request.pageId);
    if (!descriptor) throw Error('只能为已保存页面记录作答');
    const page = await this.readPage(course.projectNoteId, request.pageId, descriptor.contentHash);
    const old = await this.study(course, page.id);
    const study = mutateProgressiveStudy(old, page, descriptor.contentHash, request.mutation);
    if (study === old) return { course: await this.snapshot(course), study };
    if (request.expectedVersion !== old.version) throw Error('本页学习记录已更新，未覆盖较新的作答');
    await this.directories(course.projectNoteId, true);
    await this.write(path.join(this.projectDirectory(course.projectNoteId), 'study', `${page.id}.${study.version}.json`), study, 1_500_000);
    const next = { ...course, updatedAt: study.updatedAt,
      studyPages: [...(course.studyPages || []).filter(ref => ref.pageId !== page.id), progressiveStudySummary(study, page)] };
    // Publishing the small pointer is the commit. Private writes never enqueue textbook work.
    await this.save(next);
    return { course: await this.snapshot(next), study };
  }
  private async changePage(course: StoredCourse, input: Extract<ProgressiveCommand, { op: 'update-page' | 'patch-diagram' | 'delete-page' }>) {
    const target = await this.target(course.projectNoteId);
    if (input.environmentId !== this.environmentId || input.courseId !== course.id || !validProgressivePageId(input.pageId)
      || course.generation.status !== 'ready' || this.leases.has(course.projectNoteId)) throw Error('当前不能修改课程页。');
    const descriptor = course.pages?.find(page => page.id === input.pageId);
    if (!descriptor || descriptor.contentHash !== input.expectedHash) throw Error('讲解页已变化，未覆盖较新的内容。');
    let pages: ProgressivePageSummary[];
    if (input.op === 'update-page' || input.op === 'patch-diagram') {
      const page = await this.readPage(course.projectNoteId, input.pageId, descriptor.contentHash);
      const body = input.op === 'patch-diagram' ? patchProgressiveDiagram(page.body, input.diagramIndex, input.replacements)
        : progressiveText(input.body, PROGRESSIVE_MAX_BODY, '讲解正文').trim();
      progressiveText(body, PROGRESSIVE_MAX_BODY, '讲解正文');
      if (page.body === body) return this.snapshot(course);
      const changed = { ...page, body, updatedAt: new Date().toISOString() };
      // A new immutable body file is committed before its directory entry (see writePage below).
      await this.writePage(course.projectNoteId, changed);
      pages = course.pages!.map(entry => entry.id === page.id ? progressivePageSummary(changed) : entry);
    } else {
      // Never remove children silently; remove the requested page only.
      if (course.pages!.some(page => page.parentPageId === input.pageId)) throw Error('请先移除本页的补充页。');
      pages = course.pages!.filter(page => page.id !== input.pageId);
    }
    const currentPageId = pages.some(page => page.id === course.progress.currentPageId) ? course.progress.currentPageId : pages.at(-1)?.id || 'main-1';
    const next = { ...course, pages, firstPageReady: pages.some(page => page.id === 'main-1'), revision: course.revision + 1,
      ...(!pages.length ? { generation: { requestId: `request-${randomUUID()}`, pageId: 'main-1', status: 'prepared' as const,
        attempts: 0, sequence: 0, rawDraft: '', bodyDraft: '', figurePolicy: 1 as const, kind: 'mainline' as const, mainlineIndex: 0,
        writingPolicy: createProgressiveWritingPolicy({ title: target.note.title, rootTitle: target.root.title,
          pageTitle: course.plan?.pages[0]?.title, objectives: course.plan?.pages[0]?.objectives, sources: course.sourcePackets }) } } : {}),
      progress: input.op === 'patch-diagram' ? course.progress
        : { ...course.progress, currentPageId, scrollTop: 0, version: course.progress.version + 1 } };
    await this.save(next); this.dependencies.changed?.(course.projectNoteId);
    if (input.op === 'patch-diagram') this.dependencies.pageChanged?.(course.projectNoteId);
    return this.snapshot(next);
  }
  private async checkpoint(course: StoredCourse, checkpoint: ProgressiveCheckpoint): Promise<ProgressiveCourse> {
    if (!checkpoint || !integer(checkpoint.sequence)) throw new Error('生成检查点编号无效。');
    if (checkpoint.sequence <= course.generation.sequence) return this.snapshot(course);
    progressiveText(checkpoint.rawDraft, PROGRESSIVE_MAX_RAW, '生成草稿', true);
    progressiveText(checkpoint.bodyDraft, PROGRESSIVE_MAX_BODY, '讲解草稿', true);
    const plan = checkpoint.plan ? this.plan(checkpoint.plan, course.budget.maxMainlinePages) : course.plan;
    if (course.plan && !same(course.plan, plan)) throw new Error('已保存主线不会被继续生成覆盖。');
    const next: StoredCourse = { ...course, plan, revision: course.revision + 1, updatedAt: new Date().toISOString(),
      generation: { ...course.generation, sequence: checkpoint.sequence, rawDraft: checkpoint.rawDraft, bodyDraft: checkpoint.bodyDraft } };
    await this.save(next); return this.snapshot(next);
  }
  private async publish(course: StoredCourse, teaching: ProgressivePublication): Promise<ProgressiveCourse> {
    if (course.generation.routePending) throw Error('尚未确认下一页编排，不能发布正文');
    if (!teaching || !integer(teaching.sequence) || teaching.sequence < course.generation.sequence) throw new Error('讲解发布版本已过期。');
    await this.target(course.projectNoteId);
    const plan = this.plan(teaching.plan, course.budget.maxMainlinePages);
    if (course.plan && !same(course.plan, plan)) throw new Error('已保存主线不会被发布覆盖。');
    progressiveText(teaching.title, 300, '讲解标题');
    const body = progressiveText(teaching.body, PROGRESSIVE_MAX_BODY, '讲解正文').trim();
    if (body.length < 40) throw new Error('讲解正文尚未完整，请继续生成。');
    validateProgressiveHook(teaching.hook);
    if (teaching.concepts !== undefined) validateProgressiveConcepts(teaching.concepts);
    if (teaching.questions !== undefined) validateProgressiveQuestions(teaching.questions, body);
    const now = new Date().toISOString();
    const page: ProgressiveLessonPage = { id: course.generation.pageId, kind: course.generation.kind || 'mainline',
      mainlineIndex: course.generation.mainlineIndex || 0,
      ...(course.generation.manualExpansion ? { manualExpansion: true as const } : {}),
      ...(course.generation.parentPageId ? { parentPageId: course.generation.parentPageId } : {}), title: teaching.title,
      body, hook: { id: teaching.hook.id, kind: 'reflection', prompt: teaching.hook.prompt },
      ...(teaching.concepts ? { concepts: teaching.concepts.map(({ key, title, summary }) => ({ key, title, summary })) } : {}),
      ...(teaching.questions?.length ? { questions: teaching.questions.map(projectProgressiveQuestion) } : {}),
      sourcePackets: structuredClone(course.sourcePackets),
      createdAt: now, updatedAt: now };
    // Publishing is saved-first: an orphan page is never exposed if metadata commit fails.
    await this.directories(course.projectNoteId, true);
    await this.writePage(course.projectNoteId, page);
    const pages = [...(course.pages || []).filter(entry => entry.id !== page.id), progressivePageSummary(page)];
    const next: StoredCourse = { ...course, plan, pages, firstPageReady: pages.some(page => page.id === 'main-1'), revision: course.revision + 1, updatedAt: now,
      generation: { ...course.generation, status: 'ready', sequence: teaching.sequence, rawDraft: '', bodyDraft: '', error: undefined } };
    await this.save(next); this.leases.delete(course.projectNoteId);
    // The committed page directory is a durable outbox, including the crash-before-notify case.
    this.dependencies.changed?.(course.projectNoteId);
    return this.snapshot(next);
  }
  private async saveProgress(course: StoredCourse, request: ProgressiveProgressRequest): Promise<ProgressiveCourse> {
    if (!request || request.environmentId !== this.environmentId || request.courseId !== course.id
      || !integer(request.expectedProgressVersion)) throw new Error('学习进度所属环境已变化，请重新进入。');
    validateProgressiveProgressPatch(request.patch, course.projectNoteId);
    const mergedProgress = { ...course.progress, ...request.patch };
    if (mergedProgress.restatementSpans?.some(span => span.end > mergedProgress.restatementDraft.length)) throw Error('复述页面定位不能超过已保存原文');
    if (request.patch.currentPageId && request.patch.currentPageId !== course.generation.pageId
      && !course.pages?.some(page => page.id === request.patch.currentPageId)) throw Error('该页尚未生成。');
    if (course.generation.status !== 'ready' && request.patch.currentPageId !== undefined
      && request.patch.currentPageId !== course.generation.pageId) throw Error('请先完成当前页的生成再切换页面。');
    await this.target(course.projectNoteId);
    const changed = Object.entries(request.patch).some(([key, value]) => !same(course.progress[key as keyof typeof course.progress], value));
    if (!changed) return this.snapshot(course);
    if (request.expectedProgressVersion !== course.progress.version) throw new Error('学习进度已更新，未覆盖较新的草稿。');
    // Only private progress changes here. Content/generation revisions are
    // checked by next(), while stale personal drafts keep their own guard.
    const next: StoredCourse = { ...course, updatedAt: new Date().toISOString(),
      progress: { ...course.progress, ...request.patch, version: course.progress.version + 1 } };
    await this.save(next); return this.snapshot(next);
  }
}
