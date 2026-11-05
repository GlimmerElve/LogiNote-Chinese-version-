import type { SceneInteractionPack, ScenePackConfig } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2InteractionEvent, S2InteractionScope, S2InteractionTrigger } from '../../types/sceneS2Interaction';
import { projectS2PublicCanvas } from './sceneS2PublicAuthoring';
import { readS2InteractionScope, S2_BUILTIN_INTERACTION_EVENTS, snapshotS2InteractionData,
  validateS2InteractionEventData, validateS2InteractionReferences } from './sceneS2InteractionProtocol';

export interface S2InteractionCause { id: string; chain: string[] }
export interface S2InteractionTask { event: S2InteractionEvent; trigger: S2InteractionTrigger; scope: S2InteractionScope }

export function validateS2PublicInteraction(pack: SceneInteractionPack, definition: S2CanvasDefinition, document = definition.initial) {
  if (!definition.interaction) return;
  const publicCanvas = projectS2PublicCanvas(pack, definition, document);
  const ids = publicCanvas.nodes.map(node => node.id);
  validateS2InteractionReferences(definition.interaction, { publicNodeIds: ids,
    executionNodeIds: (document.execution?.nodes ?? []).filter(node => ids.includes(node.id)).map(node => node.id),
    eventIds: pack.interaction?.events.map(event => event.id) ?? [] });
}

/** Terminal-owned queue. Model output and package payloads cannot supply causal metadata. */
export class S2InteractionEventRouter {
  private active = true;
  private draining = false;
  private queue: S2InteractionTask[] = [];
  private seen = new Set<string>();
  private fired = new Map<string, Set<string>>();
  private cancelledCauses = new Set<string>();
  private causes = new Map<string, Array<{ token: object; cause: S2InteractionCause }>>();
  private currentCause: S2InteractionCause = { id: crypto.randomUUID(), chain: [] };
  constructor(private readonly options: {
    pack: SceneInteractionPack;
    readConfig(): ScenePackConfig;
    revision(): number;
    current(): boolean;
    canRun(): boolean;
    run(task: S2InteractionTask): Promise<void>;
    onError(error: unknown): void;
  }) {}
  newCause(): S2InteractionCause {
    this.currentCause = { id: crypto.randomUUID(), chain: [] };
    return structuredClone(this.currentCause);
  }
  cancelCause(causeId: string): void {
    this.cancelledCauses.add(causeId);
    this.queue = this.queue.filter(task => task.event.causeId !== causeId);
  }
  bindCause(nodeIds: string[], cause: S2InteractionCause): () => void {
    const token = {};
    for (const id of nodeIds) this.causes.set(id, [...(this.causes.get(id) ?? []), { token, cause: structuredClone(cause) }]);
    return () => { for (const id of nodeIds) { const rest = (this.causes.get(id) ?? []).filter(item => item.token !== token); if (rest.length) this.causes.set(id, rest); else this.causes.delete(id); } };
  }
  private causeFor(nodeId: string): S2InteractionCause {
    const active = this.causes.get(nodeId) ?? [];
    if (new Set(active.map(item => item.cause.id)).size > 1) throw new Error('业务事件来源同时属于多个执行，无法确定事件归属');
    return structuredClone(active[0]?.cause ?? this.currentCause);
  }
  publish(type: string, nodeId: string, data: S2Json, cause?: S2InteractionCause, eventId: string = crypto.randomUUID(), invocationId?: string): void {
    if (!this.active || !this.options.current()) return;
    const config = this.options.readConfig(), pack = this.options.pack;
    const canvas = projectS2PublicCanvas(pack, config.definition, config.document);
    if (!canvas.nodes.some(node => node.id === nodeId)) throw new Error('业务事件来源必须是当前包的公开节点');
    const builtin = S2_BUILTIN_INTERACTION_EVENTS.find(event => event.id === type);
    const declaration = builtin ?? pack.interaction?.events.find(event => event.id === type);
    if (!declaration) throw new Error('交互事件没有在底座或当前包公开声明');
    if (builtin && !config.document.execution?.nodes.some(node => node.id === nodeId)) throw new Error('执行完成事件需要真实执行节点');
    const payload = snapshotS2InteractionData(data);
    validateS2InteractionEventData(declaration, payload);
    const source = cause ?? this.causeFor(nodeId);
    if (this.cancelledCauses.has(source.id)) return;
    const event: S2InteractionEvent = { id: eventId, type, nodeId, data: payload, causeId: source.id, chain: [...source.chain], revision: this.options.revision(), ...(invocationId ? { invocationId } : {}) };
    for (const trigger of config.definition.interaction?.triggers ?? []) {
      if (trigger.on.event !== type || trigger.on.nodeId !== nodeId) continue;
      const key = `${eventId}:${trigger.id}`, fired = this.fired.get(source.id) ?? new Set<string>();
      if (this.seen.has(key) || fired.has(trigger.id) || source.chain.includes(trigger.id)) continue;
      if (this.queue.length >= 32 || this.seen.size >= 2048) throw new Error('本局自动交互事件数量已达上限');
      this.seen.add(key); fired.add(trigger.id); this.fired.set(source.id, fired);
      this.queue.push({ event: { ...structuredClone(event), chain: [...event.chain, trigger.id] }, trigger: structuredClone(trigger), scope: readS2InteractionScope(trigger.scope) });
    }
    void this.flush();
  }
  async flush(): Promise<void> {
    if (this.draining || !this.active) return;
    this.draining = true;
    try {
      while (this.active && this.queue.length && this.options.current() && this.options.canRun()) {
        const task = this.queue.shift()!;
        if (task.event.revision !== this.options.revision() || this.cancelledCauses.has(task.event.causeId)) continue;
        try { await this.options.run(task); }
        catch (error) { if (this.active && this.options.current()) this.options.onError(error); }
      }
    } finally { this.draining = false; }
  }
  close() { this.active = false; this.queue = []; this.causes.clear(); this.fired.clear(); this.seen.clear(); this.cancelledCauses.clear(); }
}

type EventSink = (nodeId: string, event: string, data: S2Json) => void;
const sinks = new WeakMap<object, EventSink>();
export function bindS2PackageInteractionEvents(host: object, sink: EventSink) { sinks.set(host, sink); }
export function closeS2PackageInteractionEvents(host: object) { sinks.delete(host); }
export function emitS2PackageInteractionEvent(host: object, nodeId: string, event: string, data: S2Json) {
  const sink = sinks.get(host);
  if (!sink) throw new Error('当前场景没有可用的交互事件接收器');
  sink(nodeId, event, data);
}
