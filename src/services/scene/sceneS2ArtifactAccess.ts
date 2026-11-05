import type { S2Artifact } from '../../types/sceneS2Plugin';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import type { S2Trial } from './sceneS2Trials';
import type { S2InteractionEvent } from './sceneS2Events';

export interface S2ArtifactSource { artifact: S2Artifact; text: string }
interface ArtifactReader { read: (id: string) => S2Artifact; output: (nodeId: string, portId: string) => string[]; outputs?: (nodeId: string, portId: string) => string[]; trial?: (id: string) => S2Trial; event?: (id: string) => S2InteractionEvent }
const readers = new WeakMap<object, ArtifactReader>();
/** Host-only bridge. No function or mutable store is serialized into model context. */
export function bindS2ArtifactContext(context: object, reader: ArtifactReader): void { readers.set(context, reader); }
function readerFor(context: unknown): ArtifactReader {
  const reader = context && typeof context === 'object' ? readers.get(context) : undefined;
  if (!reader) throw new Error('完整产物读取需要本局真实宿主上下文；JSON、克隆和预览不提供读取权限');
  return reader;
}
/** Exact host-owned port membership, including multi-value outputs. */
export function readS2ContextOutputIds(context: unknown, nodeId: string, portId: string): string[] {
  const reader = readerFor(context);
  return [...(reader.outputs ?? reader.output)(nodeId, portId)];
}
export function readS2ContextArtifact(context: unknown, id: string): S2ArtifactSource {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error('完整产物标识无效');
  const artifact = readerFor(context).read(id);
  if (artifact.complete !== true || artifact.payload.kind !== 'inline') throw new Error('产物没有可读取的完整内联正文；不使用预览或外部引用替代');
  return { artifact: structuredClone(artifact), text: artifact.type.id === 'core.text' && typeof artifact.payload.value === 'string'
    ? artifact.payload.value : canonicalS2Json(artifact.payload.value) };
}
declare const assessmentScope: unique symbol;
export interface S2AssessmentArtifactScope { readonly [assessmentScope]: true }
const scopes = new WeakMap<object, { context: unknown; ids: Set<string> }>();
/** Only IDs actually delivered as complete recall items belong to this turn's evidence. */
export function createS2AssessmentArtifactScope(context: unknown, artifactIds: string[]): S2AssessmentArtifactScope {
  if (!Array.isArray(artifactIds) || artifactIds.length > 3 || new Set(artifactIds).size !== artifactIds.length) throw new Error('本轮完整产物证据范围无效');
  // No artifact-dependent access is needed by legacy field-only assessments.
  if (artifactIds.length) { readerFor(context); artifactIds.forEach(id => readS2ContextArtifact(context, id)); }
  const scope = Object.freeze({}) as S2AssessmentArtifactScope;
  scopes.set(scope, { context, ids: new Set(artifactIds) }); return scope;
}
function scopeFor(scope: unknown) {
  const value = scope && typeof scope === 'object' ? scopes.get(scope) : undefined;
  if (!value) throw new Error('产物评价需要本轮宿主签发的完整正文证据范围');
  return value;
}
export function readS2AssessmentArtifact(scope: unknown, artifactId: string): S2ArtifactSource {
  const value = scopeFor(scope);
  if (!value.ids.has(artifactId)) throw new Error('该产物未在本轮完整提供；索引、预览和超限省略不能作为评价证据');
  return readS2ContextArtifact(value.context, artifactId);
}
export function resolveS2AssessmentOutput(scope: unknown, nodeId: string, portId: string): S2ArtifactSource | undefined {
  try {
    const value = scopeFor(scope), ids = readerFor(value.context).output(nodeId, portId);
    if (ids.length !== 1 || !value.ids.has(ids[0])) return undefined;
    const source = readS2AssessmentArtifact(scope, ids[0]);
    return source.artifact.source.nodeId === nodeId ? source : undefined;
  } catch { return undefined; }
}
export function readS2ContextTrial(context: unknown, id: string): S2Trial {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error('试验ID无效');
  const read = readerFor(context).trial;
  if (!read) throw new Error('当前真实宿主不提供历史试验读取');
  return structuredClone(read(id));
}
export function readS2ContextEvent(context: unknown, id: string): S2InteractionEvent {
  if (typeof id !== 'string' || !/^interaction-[A-Za-z0-9_-]{1,140}$/.test(id)) throw new Error('互动事件ID无效');
  const read = readerFor(context).event;
  if (!read) throw new Error('当前真实宿主不提供互动事件读取');
  return structuredClone(read(id));
}
declare const trialScope: unique symbol;
export interface S2TrialScope { readonly [trialScope]: true }
const trialScopes = new WeakMap<object, { context: unknown; trials: Map<string, S2Trial> }>();
/** Pin exactly the historical bodies delivered before the action call. Later
 * assessments cannot silently appear in the model's already-delivered evidence. */
export function createS2TrialScope(context: unknown, ids: string[]): S2TrialScope {
  if (ids.length > 2 || new Set(ids).size !== ids.length) throw new Error('试验对照范围无效');
  const scope = Object.freeze({}) as S2TrialScope;
  trialScopes.set(scope, { context, trials: new Map(ids.map(id => [id, readS2ContextTrial(context, id)])) }); return scope;
}
export function readS2ScopedTrial(scope: unknown, id: string): S2Trial {
  const value = scope && typeof scope === 'object' ? trialScopes.get(scope) : undefined;
  const trial = value?.trials.get(id);
  if (!value || !trial) throw new Error('试验未在本轮全文提供，索引、克隆和伪造档案不能用于对照');
  readS2ContextTrial(value.context, id); // Recheck the active run and prepared revision, not new evidence.
  return structuredClone(trial);
}
