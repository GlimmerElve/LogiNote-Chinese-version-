import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NoteItem, ResourceItem } from '../types';
import { atomicWriteTextFile } from './atomicWrite';
import { preparationCandidates, preparationGoal, preparationRoot, type LearningPreparation, type LearningPreparationCommand } from '../services/progressiveLearning/preparation';

interface Host {
  notes(rootId: string): Promise<NoteItem[]>;
  automatic(): Promise<boolean>;
  search(title: string, signal: AbortSignal): Promise<ResourceItem[]>;
  collect(job: LearningPreparation, resources: ResourceItem[], signal: AbortSignal): Promise<number>;
  changed(rootId: string): void;
  current(): boolean;
  write?(file: string, text: string): Promise<unknown>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const busy = (job: LearningPreparation) => ['pending', 'searching', 'collecting'].includes(job.status);
function cancellableSearch<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(value => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
/** Small, durable root-level queue. Search/download runs outside the interface;
 * publication and indexing are independent, and failures never gate Flow. */
export class LearningPreparationQueue {
  private root: string;
  private lane: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;
  private pending = new Set<string>();
  private abort: AbortController | null = null;
  private stopped = false;
  constructor(userStateDir: string, private host: Host) { this.root = path.resolve(userStateDir, 'learning-preparation'); }
  private file(id: string) {
    if (typeof id !== 'string' || !id || id.length > 300) throw Error('资料准备项目标识无效');
    return path.join(this.root, `root-${hash(id)}.json`);
  }
  private current() { if (this.stopped || !this.host.current()) throw Error('资料准备环境已停止'); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.lane.catch(() => {}).then(run); this.lane = work; return work;
  }
  private async load(id: string): Promise<LearningPreparation | null> {
    try {
      const file = this.file(id), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 80000) throw Error('资料准备记录无效');
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as LearningPreparation;
      if (value.version !== 1 || value.rootId !== id || !/^[a-f0-9]{64}$/u.test(value.goalKey) || !Array.isArray(value.candidates) || value.candidates.length > 3
        || !Array.isArray(value.selected) || value.selected.some(url => !value.candidates.some(candidate => candidate.url === url))
        || value.selected.length > 3 || new Set(value.selected).size !== value.selected.length
        || typeof value.title !== 'string' || value.title.length > 160 || value.goalKey !== hash(value.title)
        || typeof value.approved !== 'boolean' || typeof value.automatic !== 'boolean' || !Number.isSafeInteger(value.bound) || value.bound < 0
        || JSON.stringify(preparationCandidates(value.candidates, value.title)) !== JSON.stringify(value.candidates)
        || !['pending', 'searching', 'recommended', 'collecting', 'ready', 'failed'].includes(value.status)) throw Error('资料准备记录无效');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async save(job: LearningPreparation) {
    this.current(); await fs.mkdir(this.root, { recursive: true });
    const stat = await fs.lstat(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('资料准备目录无效');
    await (this.host.write || ((file, text) => atomicWriteTextFile(file, text, { allowCopyFallback: false })))(this.file(job.rootId), JSON.stringify(job));
    this.current(); this.host.changed(job.rootId);
  }
  private async target(id: string) {
    const notes = await this.host.notes(id), note = notes.find(note => note.id === id);
    if (!note || preparationRoot(note, notes)?.id !== id) throw Error('资料准备只绑定已保存的根学习项目');
    const title = preparationGoal(note); if (!title) throw Error('请先填写学习目标');
    return { note, title, key: hash(title) };
  }
  command(input: Exclude<LearningPreparationCommand, { op: 'upload' }>) {
    return this.serial(async () => {
      this.current(); const target = await this.target(input.rootId), old = await this.load(input.rootId);
      if (input.op === 'status') return old;
      if (input.op === 'accept') {
        if (!old || old.goalKey !== input.goalKey || old.goalKey !== target.key || !['recommended', 'failed'].includes(old.status)
          || !input.urls.length || input.urls.length > 3 || new Set(input.urls).size !== input.urls.length
          || input.urls.some(url => !old.candidates.some(candidate => candidate.url === url))) throw Error('推荐已变化，请重新查看后收录');
        const next: LearningPreparation = { ...old, selected: input.urls, approved: true, automatic: false, status: 'collecting', updatedAt: new Date().toISOString(), error: undefined };
        await this.save(next); this.kick(input.rootId); return next;
      }
      if (old?.goalKey === target.key && input.op !== 'retry') { if (busy(old)) this.kick(input.rootId); return old; }
      if (input.op === 'retry' && old && busy(old)) return old;
      const next: LearningPreparation = { version: 1, rootId: input.rootId, title: target.title, goalKey: target.key,
        status: 'pending', candidates: [], selected: [], approved: false, automatic: false, bound: 0, updatedAt: new Date().toISOString() };
      // A collection failure can retry its saved approved selection without searching/downloading twice.
      if (old?.goalKey === target.key && old.selected.length) Object.assign(next, { candidates: old.candidates, selected: old.selected, approved: old.approved, automatic: old.automatic, status: 'collecting' });
      await this.save(next); this.kick(input.rootId); return next;
    });
  }
  private kick(id: string) {
    if (this.stopped) return; this.pending.add(id);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; if (this.pending.size && !this.stopped) this.kick([...this.pending][0]); });
  }
  private async drain() {
    while (this.pending.size && !this.stopped) {
      const id = [...this.pending][0]; this.pending.delete(id);
      this.abort = new AbortController(); const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(90000)]);
      let goalKey = '';
      const saveWork = (job: LearningPreparation) => this.serial(async () => {
        const latest = await this.load(id); if (latest?.goalKey !== job.goalKey || (await this.target(id)).key !== job.goalKey) throw Error('资料准备目标已变化');
        await this.save(job);
      });
      try {
        let job = await this.serial(() => this.load(id)); if (!job || !busy(job)) continue;
        goalKey = job.goalKey;
        const target = await this.target(id); if (target.key !== job.goalKey) throw Error('学习目标已变化，请重新准备资料');
        if (job.status !== 'collecting') {
          job = { ...job, status: 'searching', updatedAt: new Date().toISOString() }; await saveWork(job);
          const candidates = preparationCandidates(await cancellableSearch(this.host.search(target.title, signal), signal), target.title);
          signal.throwIfAborted(); this.current();
          if (!candidates.length) throw Error('未找到可用公开资料，可上传教材后直接开始学习');
          const automatic = await this.host.automatic();
          job = { ...job, candidates, selected: automatic ? candidates.map(candidate => candidate.url) : [], automatic, approved: automatic,
            status: automatic ? 'collecting' : 'recommended', updatedAt: new Date().toISOString() };
          await saveWork(job);
        }
        if (job.status === 'collecting') {
          if (!job.approved || job.automatic && !await this.host.automatic()) throw Error('自动收录已关闭，已保留推荐；可选择后收录');
          if ((await this.target(id)).key !== job.goalKey) throw Error('学习目标已变化，未写入旧推荐');
          const bound = await this.host.collect(job, job.candidates.filter(candidate => job!.selected.includes(candidate.url)), signal);
          signal.throwIfAborted(); this.current();
          await saveWork({ ...job, status: 'ready', bound, updatedAt: new Date().toISOString(), error: undefined });
        }
      } catch (error) {
        if (!this.stopped && this.host.current()) await this.serial(async () => {
          const job = await this.load(id); if (job && job.goalKey === goalKey) await this.save({ ...job, status: 'failed', error: error instanceof Error && /[\u4e00-\u9fff]/u.test(error.message) ? error.message.slice(0, 250) : '资料准备未完成，可上传教材或重试；不影响进入心流。', updatedAt: new Date().toISOString() });
        }).catch(() => {});
      } finally { this.abort = null; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  async recover() {
    this.stopped = false;
    let names: string[]; try { names = await fs.readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) if (/^root-[a-f0-9]{64}\.json$/u.test(name)) {
      const file = path.join(this.root, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 80000) continue;
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as LearningPreparation;
      if (this.file(raw.rootId) !== file) continue;
      const job = await this.load(raw.rootId); if (job && busy(job)) this.kick(job.rootId);
    }
  }
  async idle() { do { await this.lane; await this.running; } while (this.running || this.pending.size); }
  async stop() { this.stopped = true; this.abort?.abort(); this.pending.clear(); await this.running; await this.lane.catch(() => {}); }
}
