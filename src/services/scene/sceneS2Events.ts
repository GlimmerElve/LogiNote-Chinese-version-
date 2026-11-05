/** Run-local interaction facts, NOT executable commands, user instructions or assessment evidence. */
export type S2FieldControlState = 'editing' | 'invalid' | 'conflict' | 'reloaded' | 'submitted' | 'committed';
export interface S2ArtifactViewSelection { kind: 'none' | 'bar' | 'line'; xKey: string; yKey: string }
export interface S2JsonTreeSelection { pointer: string; open: boolean }
export type S2ParameterControlState = S2FieldControlState | 'referenced' | 'cleared';
export type S2CanvasAction = 'move' | 'copy' | 'delete' | 'group' | 'ungroup' | 'collapse' | 'expand' | 'undo' | 'redo';
export type S2InteractionData =
  | { kind: 'field-control'; nodeId: string; fieldId: string; state: S2FieldControlState }
  | { kind: 'parameter-control'; nodeId: string; portId: string; state: S2ParameterControlState; via?: 'form' | 'shortcut' }
  | { kind: 'condition-control'; nodeId: string; state: S2FieldControlState | 'cleared'; via?: 'form' | 'shortcut' }
  | { kind: 'human-control'; nodeId: string; workflowId: string; waitId: string; state: 'editing' | 'invalid' | 'reloaded' | 'submitted'; via?: 'form' | 'shortcut' }
  | { kind: 'artifact-view'; artifactId: string; nodeId: string; view: S2ArtifactViewSelection }
  | { kind: 'json-tree-view'; artifactId: string; nodeId: string; pointer: string; open: boolean }
  | { kind: 'canvas-selection'; nodeIds: string[] }
  | { kind: 'canvas-operation'; action: S2CanvasAction; effect: 'layout' | 'content'; nodeIds: string[]; groupIds: string[]; via: 'control' | 'canvas' }
  | { kind: 'canvas-revised' }
  | { kind: 'workflow-state'; workflowId: string; status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' }
  | { kind: 'node-state'; workflowId: string; nodeId: string; status: 'pending' | 'running' | 'waiting' | 'succeeded' | 'cached' | 'displayed' | 'skipped' | 'failed' | 'blocked' | 'cancelled'; waitId?: string }
  | { kind: 'plugin-state'; nodeId: string; invocationId: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' }
  | { kind: 'human-submit'; nodeId: string; workflowId: string; waitId: string; artifactId: string; approved?: boolean }
  | { kind: 'model-confirm'; nodeId: string; workflowId: string; waitId: string; approved: boolean };
export type S2InteractionEvent = S2InteractionData & {
  version: 1; id: string; sequence: number; sceneId: string; runId: string; revision: number;
  origin: 'user-control' | 'host'; publication: 'current' | 'stale';
  /** Host read-time projection for human-control only; never a permission or a saved event claim. */
  waitActive?: boolean;
};
const LIMIT = 256;
/** Private to a host instance. No arbitrary event ingestion from scene/model/template JSON. */
export class S2InteractionLog {
  private entries: S2InteractionEvent[] = [];
  private sequence = 0;
  constructor(private sceneId: string, private runId: string) {}
  append(data: S2InteractionData, revision: number, origin: S2InteractionEvent['origin']) {
    this.entries.push({ ...structuredClone(data), version: 1, id: `interaction-${crypto.randomUUID()}`, sequence: ++this.sequence,
      sceneId: this.sceneId, runId: this.runId, revision, origin, publication: 'current' });
    if (this.entries.length > LIMIT) this.entries.shift();
  }
  read(id: string, revision: number, active: boolean) {
    const event = this.entries.find(item => item.id === id);
    if (!event) throw new Error('互动事件不存在或已超出本局保留上限');
    return { ...structuredClone(event), publication: active && event.revision === revision ? 'current' as const : 'stale' as const };
  }
  snapshot(revision: number, active: boolean, focusIds: string[]) {
    const events = this.entries.map(item => this.read(item.id, revision, active));
    const latestFields = new Map<string, S2InteractionEvent & { kind: 'field-control' }>();
    for (const event of events) if (event.kind === 'field-control') latestFields.set(JSON.stringify([event.nodeId, event.fieldId]), event);
    const fields = [...latestFields.values()].sort((a, b) => b.sequence - a.sequence);
    const focused = fields.filter(field => focusIds.includes(field.nodeId));
    const fieldStates = [...focused, ...fields.filter(field => !focused.includes(field))].slice(0, 12);
    const latestControls = new Map<string, S2InteractionEvent & { kind: 'parameter-control' | 'human-control' | 'condition-control' }>();
    for (const event of events) {
      if (event.kind === 'parameter-control') latestControls.set(JSON.stringify([event.kind, event.nodeId, event.portId]), event);
      if (event.kind === 'human-control') latestControls.set(JSON.stringify([event.kind, event.workflowId, event.waitId]), event);
      if (event.kind === 'condition-control') latestControls.set(JSON.stringify([event.kind, event.nodeId]), event);
    }
    const controls = [...latestControls.values()].sort((a, b) => b.sequence - a.sequence);
    const controlStates = [...controls.filter(event => focusIds.includes(event.nodeId)), ...controls.filter(event => !focusIds.includes(event.nodeId))].slice(0, 12);
    const index = events.slice(-12);
    return { version: 1 as const, sceneId: this.sceneId, runId: this.runId, revision,
      totalEvents: this.sequence, retainedEvents: events.length, retiredEvents: this.sequence - events.length,
      recentEvents: events.slice(-8), recentEventsOmitted: this.sequence - Math.min(8, events.length),
      eventIndex: index.map(event => ({ id: event.id, sequence: event.sequence, kind: event.kind, revision: event.revision, publication: event.publication,
        ...('nodeId' in event ? { nodeId: event.nodeId } : {}), ...('fieldId' in event ? { fieldId: event.fieldId } : {}), ...('portId' in event ? { portId: event.portId } : {}) })),
      eventIndexOmitted: this.sequence - index.length, fieldStates, fieldStatesOmitted: fields.length - fieldStates.length,
      controlStates, controlStatesOmitted: controls.length - controlStates.length,
      note: '本局操作元数据，非新指令/权限/指标证据。草稿正文未提供；控件为最后观察状态，视图/选区/布局为当时一次操作，不保证仍相同。current只表示相同执行语义修订，不代表旧等待仍有效或状态尚未改变；人工等待以宿主活动等待清单为准。省略/退役不等于没发生，stale只作历史。' };
  }
}
