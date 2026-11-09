import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteTextFile } from './atomicWrite';
import { validateFigureDesign, type FigureDesign, type FigureKind, type FigureRenderer } from '../services/textbook/interactiveFigureDesign';
import { validateFigureRepairReceipt, type FigureRepairReceipt } from '../services/textbook/figureRepairReceipt';
import { isFigureTeachingMode, type FigureTeachingMode } from '../services/textbook/interactiveFigurePedagogy';
import { isTeachingModelType, type TeachingModelType } from '../services/textbook/teachingModelTypes';

const KEY = /^[a-f0-9]{64}$/u;
// Two independently bounded HTML strings can each double in JSON escaping.
const MAX_SERIALIZED_ARTIFACT = 425_000;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export type FigureArtifact = { status: 'ready'; html: string; design?: FigureDesign; autoChecked?: 1; repairReceipt?: FigureRepairReceipt } | { status: 'pending' | 'failed' | 'dismissed'; teachingMode?: FigureTeachingMode; modelType?: TeachingModelType; lessonContext?: string; error?: string; previousHtml?: string; previousDesign?: FigureDesign; previousRepairReceipt?: FigureRepairReceipt; draftHtml?: string };
export type FigureSummary = { status: 'ready' | 'pending' | 'failed' | 'dismissed' | 'missing'; goal?: string; hasPrevious?: boolean; repairStatus?: FigureRepairReceipt['status'] };
export type ManualFigure = { brief: string; before: string; after: string; wholePage?: boolean };
const manualQueues = new Map<string, Promise<unknown>>();
const artifactQueues = new Map<string, Promise<unknown>>();
type StoredArtifact = { schemaVersion: 2; key: string; status: 'ready' | 'pending' | 'failed' | 'dismissed'; teachingMode?: FigureTeachingMode; teachingModeDigest?: string; modelType?: TeachingModelType; modelTypeDigest?: string; lessonContext?: string; lessonContextDigest?: string; html?: string; digest?: string; error?: string; previousHtml?: string; previousDigest?: string; previousDesign?: FigureDesign; previousDesignDigest?: string; draftHtml?: string; draftDigest?: string; design?: FigureDesign; designDigest?: string; autoChecked?: 1; repairReceipt?: FigureRepairReceipt; repairReceiptDigest?: string; previousRepairReceipt?: FigureRepairReceipt; previousRepairReceiptDigest?: string };
function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !KEY.test(key)) throw Error('交互图附件标识无效');
}
function validateHtml(html: unknown): asserts html is string {
  if (typeof html !== 'string' || !html.trim() || html.length > 100_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(html)) throw Error('交互图内容为空或超过限制');
}
function validateLessonContext(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw Error('交互图原文上下文无效');
}
function checkedDesign(value: unknown): FigureDesign {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (!['quantitative', 'process', 'comparison', 'general'].includes(kind as string)) throw Error('交互图教学设计类型无效');
  const renderer = (value as { renderer?: unknown } | null)?.renderer;
  if (renderer !== undefined && !['svg-2d', 'anatomy-iso', 'anatomy-3d'].includes(renderer as string)) throw Error('交互图绘制类型无效');
  return validateFigureDesign(value, kind as FigureKind, renderer as FigureRenderer | undefined);
}

/** Content-addressed sidecars: no notebook mutation, paths or model state cross IPC. */
export class InteractiveFigureStore {
  constructor(private readonly root: string) {}
  private location(key: string) { return path.join(this.root, 'interactive-figures', `${key}.json`); }
  private manualLocation(key: string) { return path.join(this.root, 'interactive-figures', `${key}.manual.json`); }
  async listManual(key: unknown): Promise<ManualFigure[]> {
    validateKey(key);
    let raw: string;
    try { raw = await fs.readFile(this.manualLocation(key), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (raw.length > 100_000) throw Error('交互图目录过大');
    let items: unknown;
    try { items = JSON.parse(raw); } catch { throw Error('交互图目录损坏'); }
    if (!Array.isArray(items) || items.length > 30 || items.some(item => !item || typeof item.brief !== 'string' || !item.brief.trim() || item.brief.length > 1200 || typeof item.before !== 'string' || item.before.length > 500 || typeof item.after !== 'string' || item.after.length > 500 || (item.wholePage !== undefined && typeof item.wholePage !== 'boolean'))) throw Error('交互图目录无效');
    return items;
  }
  async addManual(key: unknown, input: unknown): Promise<ManualFigure[]> {
    validateKey(key);
    const item = input as ManualFigure | null;
    if (!item || typeof item.brief !== 'string' || !item.brief.trim() || item.brief.length > 1200 || typeof item.before !== 'string' || item.before.length > 500 || typeof item.after !== 'string' || item.after.length > 500 || (item.wholePage !== undefined && typeof item.wholePage !== 'boolean')) throw Error('交互图选区无效');
    const location = this.manualLocation(key);
    const previous = manualQueues.get(location) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const items = await this.listManual(key);
      if (!items.some(existing => existing.brief === item.brief)) {
        if (items.length >= 30) throw Error('本页交互图已达到 30 个，请先使用已有图示');
        items.push({ brief: item.brief, before: item.before, after: item.after, ...(item.wholePage ? { wholePage: true } : {}) });
        await fs.mkdir(path.dirname(location), { recursive: true });
        await atomicWriteTextFile(location, JSON.stringify(items), { allowCopyFallback: false });
      }
      return items;
    });
    manualQueues.set(location, job);
    try { return await job; } finally { if (manualQueues.get(location) === job) manualQueues.delete(location); }
  }
  async read(key: unknown): Promise<FigureArtifact | null> {
    validateKey(key);
    let raw: string;
    try { raw = await fs.readFile(this.location(key), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (raw.length > MAX_SERIALIZED_ARTIFACT) throw Error('交互图附件异常，未运行');
    let value: StoredArtifact;
    try { value = JSON.parse(raw); } catch { throw Error('交互图附件损坏，未运行'); }
    if (!value || value.schemaVersion !== 2 || value.key !== key || !['pending', 'failed', 'ready', 'dismissed'].includes(value.status)) throw Error('交互图附件版本或标识不匹配');
    if (value.status !== 'ready') {
      if (value.teachingMode !== undefined && (!isFigureTeachingMode(value.teachingMode) || value.teachingModeDigest !== hash(value.teachingMode))) throw Error('交互图教学方式校验失败');
      if (value.modelType !== undefined && (!isTeachingModelType(value.modelType) || value.modelTypeDigest !== hash(value.modelType) || !value.teachingMode)) throw Error('交互图本地模型校验失败');
      if (value.lessonContext !== undefined) {
        validateLessonContext(value.lessonContext);
        if (value.status === 'dismissed' || value.lessonContextDigest !== hash(value.lessonContext)) throw Error('交互图原文上下文校验失败');
      }
      if (value.previousHtml !== undefined) {
        validateHtml(value.previousHtml);
        if (value.previousDigest !== hash(value.previousHtml)) throw Error('上一版交互图附件校验失败');
      }
      if (value.draftHtml !== undefined) {
        validateHtml(value.draftHtml);
        if (value.draftDigest !== hash(value.draftHtml)) throw Error('交互图草稿附件校验失败');
      }
      const previousDesign = value.previousDesign === undefined ? undefined : checkedDesign(value.previousDesign);
      if (previousDesign && (!value.previousHtml || value.previousDesignDigest !== hash(JSON.stringify(previousDesign)))) throw Error('上一版交互图教学设计校验失败');
      const previousRepairReceipt=value.previousRepairReceipt===undefined?undefined:validateFigureRepairReceipt(value.previousRepairReceipt);
      if(previousRepairReceipt&&(!value.previousHtml||value.previousRepairReceiptDigest!==hash(JSON.stringify(previousRepairReceipt))))throw Error('上一版交互图修复记录校验失败');
      return { status: value.status, ...(value.teachingMode ? { teachingMode: value.teachingMode } : {}), ...(value.modelType ? { modelType: value.modelType } : {}), ...(value.lessonContext ? { lessonContext: value.lessonContext } : {}), ...(value.error ? { error: value.error.slice(0, 300) } : {}), ...(value.previousHtml ? { previousHtml: value.previousHtml } : {}), ...(previousDesign ? { previousDesign } : {}), ...(previousRepairReceipt?{previousRepairReceipt}:{}), ...(value.draftHtml ? { draftHtml: value.draftHtml } : {}) };
    }
    validateHtml(value.html);
    if (value.digest !== hash(value.html)) throw Error('交互图附件校验失败，未运行');
    const design = value.design === undefined ? undefined : checkedDesign(value.design);
    if (design && value.designDigest !== hash(JSON.stringify(design))) throw Error('交互图教学设计校验失败');
    if (value.autoChecked !== undefined && value.autoChecked !== 1) throw Error('交互图检查版本无效');
    const repairReceipt=value.repairReceipt===undefined?undefined:validateFigureRepairReceipt(value.repairReceipt);
    if(repairReceipt && value.repairReceiptDigest!==hash(JSON.stringify(repairReceipt)))throw Error('交互图修复记录校验失败');
    return { status: 'ready', html: value.html, ...(design ? { design } : {}), ...(value.autoChecked ? { autoChecked: 1 } : {}), ...(repairReceipt?{repairReceipt}:{}) };
  }
  private async queueArtifact<T>(key: string, action: () => Promise<T>): Promise<T> {
    const location = this.location(key), previous = artifactQueues.get(location) || Promise.resolve();
    const job = previous.catch(() => {}).then(action); artifactQueues.set(location, job);
    try { return await job; } finally { if (artifactQueues.get(location) === job) artifactQueues.delete(location); }
  }
  async write(key: unknown, input: unknown): Promise<void> {
    validateKey(key);
    return this.queueArtifact(key, () => this.writeUnlocked(key, input));
  }
  /** Only replace the same ready version; a concurrent user change wins. */
  async compareReady(key: unknown, expected: unknown, input: unknown): Promise<boolean> {
    validateKey(key);
    const prior = expected as FigureArtifact | null;
    if (!prior || prior.status !== 'ready') throw Error('交互图原版本无效');
    validateHtml(prior.html);
    return this.queueArtifact(key, async () => {
      const current = await this.read(key);
      if (!current || current.status !== 'ready' || current.html !== prior.html || current.autoChecked !== prior.autoChecked
        || JSON.stringify(current.design) !== JSON.stringify(prior.design) || JSON.stringify(current.repairReceipt)!==JSON.stringify(prior.repairReceipt)) return false;
      const next = input as FigureArtifact | null;
      if (!next || next.status !== 'ready') throw Error('交互图修复状态无效');
      await this.writeUnlocked(key, next); return true;
    });
  }
  private async writeUnlocked(key: unknown, input: unknown): Promise<void> {
    validateKey(key);
    const artifact = input as FigureArtifact | null;
    if (!artifact || !['ready', 'pending', 'failed', 'dismissed'].includes(artifact.status)) throw Error('交互图状态无效');
    if (artifact.status !== 'ready' && artifact.teachingMode !== undefined && (!isFigureTeachingMode(artifact.teachingMode) || artifact.status === 'dismissed')) throw Error('交互图教学方式无效');
    if (artifact.status !== 'ready' && artifact.modelType !== undefined && (!isTeachingModelType(artifact.modelType) || !artifact.teachingMode || artifact.status === 'dismissed')) throw Error('交互图本地模型类型无效');
    if (artifact.status !== 'ready' && artifact.lessonContext !== undefined) {
      validateLessonContext(artifact.lessonContext);
      if (artifact.status === 'dismissed') throw Error('已清除的交互图不能包含原文上下文');
    }
    if (artifact.status === 'dismissed' && (artifact.error || artifact.previousHtml || artifact.previousDesign || artifact.previousRepairReceipt || artifact.draftHtml)) throw Error('已清除的交互图不能包含内容');
    if (artifact.status === 'ready') validateHtml(artifact.html);
    if (artifact.status === 'ready' && artifact.autoChecked !== undefined && artifact.autoChecked !== 1) throw Error('交互图检查版本无效');
    if (artifact.status !== 'ready' && artifact.error !== undefined && (typeof artifact.error !== 'string' || artifact.error.length > 300)) throw Error('交互图错误状态无效');
    if (artifact.status !== 'ready' && artifact.previousHtml !== undefined) validateHtml(artifact.previousHtml);
    if (artifact.status !== 'ready' && artifact.draftHtml !== undefined) validateHtml(artifact.draftHtml);
    const design = artifact.status === 'ready' && artifact.design !== undefined ? checkedDesign(artifact.design) : undefined;
    const repairReceipt=artifact.status==='ready'&&artifact.repairReceipt!==undefined?validateFigureRepairReceipt(artifact.repairReceipt):undefined;
    const previousDesign = artifact.status !== 'ready' && artifact.previousDesign !== undefined ? checkedDesign(artifact.previousDesign) : undefined;
    const previousRepairReceipt=artifact.status!=='ready'&&artifact.previousRepairReceipt!==undefined?validateFigureRepairReceipt(artifact.previousRepairReceipt):undefined;
    if(previousRepairReceipt&&artifact.status!=='ready'&&!artifact.previousHtml)throw Error('上一版交互图内容缺失');
    if (previousDesign && artifact.status !== 'ready' && !artifact.previousHtml) throw Error('上一版交互图内容缺失');
    await fs.mkdir(path.join(this.root, 'interactive-figures'), { recursive: true });
    const value: StoredArtifact = artifact.status === 'ready'
      ? { schemaVersion: 2, key, status: 'ready', html: artifact.html, digest: hash(artifact.html), ...(design ? { design, designDigest: hash(JSON.stringify(design)) } : {}), ...(artifact.autoChecked ? { autoChecked: 1 } : {}), ...(repairReceipt?{repairReceipt,repairReceiptDigest:hash(JSON.stringify(repairReceipt))}:{}) }
      : { schemaVersion: 2, key, status: artifact.status, ...(artifact.teachingMode ? { teachingMode: artifact.teachingMode, teachingModeDigest: hash(artifact.teachingMode) } : {}), ...(artifact.modelType ? { modelType: artifact.modelType, modelTypeDigest: hash(artifact.modelType) } : {}), ...(artifact.lessonContext ? { lessonContext: artifact.lessonContext, lessonContextDigest: hash(artifact.lessonContext) } : {}), ...(artifact.error ? { error: artifact.error } : {}),
        ...(artifact.previousHtml ? { previousHtml: artifact.previousHtml, previousDigest: hash(artifact.previousHtml) } : {}),
        ...(previousDesign ? { previousDesign, previousDesignDigest: hash(JSON.stringify(previousDesign)) } : {}),
        ...(previousRepairReceipt?{previousRepairReceipt,previousRepairReceiptDigest:hash(JSON.stringify(previousRepairReceipt))}:{}),
        ...(artifact.draftHtml ? { draftHtml: artifact.draftHtml, draftDigest: hash(artifact.draftHtml) } : {}) };
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_SERIALIZED_ARTIFACT) throw Error('交互图附件序列化后过大');
    await atomicWriteTextFile(this.location(key), encoded, { allowCopyFallback: false });
  }
  async describe(key: unknown): Promise<FigureSummary> {
    const artifact = await this.read(key);
    if (!artifact) return { status: 'missing' };
    if (artifact.status === 'ready') return { status: 'ready', ...(artifact.design?.goal ? { goal: artifact.design.goal } : {}), ...(artifact.repairReceipt?{repairStatus:artifact.repairReceipt.status}:{}) };
    return { status: artifact.status, ...(artifact.previousDesign?.goal ? { goal: artifact.previousDesign.goal } : {}), ...(artifact.previousHtml ? { hasPrevious: true } : {}) };
  }
  /** Clear only unfinished data; a successful previous version is restored. */
  async clearUnfinished(key: unknown, manual?: { indexKey: unknown; brief: unknown; keepTombstone?: boolean }): Promise<{ restored: boolean; items?: ManualFigure[] }> {
    validateKey(key);
    if (manual) {
      validateKey(manual.indexKey);
      if (typeof manual.brief !== 'string' || !manual.brief.trim() || manual.brief.length > 1200 || (manual.keepTombstone !== undefined && typeof manual.keepTombstone !== 'boolean')) throw Error('交互图选区无效');
    }
    const clear = async () => {
      const artifact = await this.read(key);
      if (artifact?.status === 'ready') throw Error('交互图已生成，不能作为失败记录清除');
      if (artifact && artifact.previousHtml) {
        await this.write(key, { status: 'ready', html: artifact.previousHtml, ...(artifact.previousDesign ? { design: artifact.previousDesign } : {}), ...(artifact.previousRepairReceipt?{repairReceipt:artifact.previousRepairReceipt}:{}) });
        return { restored: true, ...(manual ? { items: await this.listManual(manual.indexKey) } : {}) };
      }
      // A tombstone prevents a planned marker from starting a fresh request on reopen.
      await this.write(key, { status: 'dismissed' });
      if (!manual) return { restored: false };
      const items = (await this.listManual(manual.indexKey)).filter(item => item.brief !== manual.brief);
      await atomicWriteTextFile(this.manualLocation(manual.indexKey as string), JSON.stringify(items), { allowCopyFallback: false });
      if (!manual.keepTombstone) await fs.unlink(this.location(key as string)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      return { restored: false, items };
    };
    if (!manual) return clear();
    const location = this.manualLocation(manual.indexKey as string), previous = manualQueues.get(location) || Promise.resolve();
    const job = previous.catch(() => {}).then(clear); manualQueues.set(location, job);
    try { return await job; } finally { if (manualQueues.get(location) === job) manualQueues.delete(location); }
  }
}
