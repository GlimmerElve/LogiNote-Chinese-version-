import type { S2InteractionAction, S2InteractionRead } from '../../types/sceneS2Interaction';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2PublicCanvas } from './sceneS2PublicAuthoring';
import type { S2AgentComponentDescription, S2AgentParameter, S2AgentPort } from './sceneS2AgentCatalog';
import { S2_AGENT_COMPONENT_RULES } from './sceneS2AgentCatalog';
import { S2_INTERACTION_LIMITS } from './sceneS2InteractionProtocol';

export class S2InteractionDisclosureError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) {
    super(`S2 交互披露：${reason}`); this.name = 'S2InteractionDisclosureError';
  }
}
const fail = (code: string, path: string, reason: string): never => { throw new S2InteractionDisclosureError(code, path, reason); };
type Section = 'parameters' | 'inputs' | 'outputs';
type RecordValue = Record<string, unknown>;
type Node = S2PublicCanvas['nodes'][number];
type Member = S2AgentParameter | S2AgentPort;
type FailureKind = 'component' | 'interface' | 'node' | 'value' | 'result' | 'package' | 'event';
interface State {
  components: Map<string, S2AgentComponentDescription>;
  indices: Map<string, RecordValue>;
  members: Map<string, { componentId: string; section: Section; member: Member }>;
  nodes: Map<string, Node>;
  values: Map<string, RecordValue>;
  results: Map<string, RecordValue>;
  failures: Map<string, { kind: FailureKind; value: RecordValue }>;
  provided: Set<string>;
  guide?: string;
  eventData?: S2Json;
  eventProvided: boolean;
}
const empty = (): State => ({ components: new Map(), indices: new Map(), members: new Map(), nodes: new Map(), values: new Map(), results: new Map(),
  failures: new Map(), provided: new Set(), eventProvided: false });
const key = (...parts: string[]) => JSON.stringify(parts);
const memberKey = (componentId: string, section: Section, id: string) => key('member', componentId, section, id);
const size = (value: unknown) => JSON.stringify(value).length;
const clone = <T>(value: T): T => structuredClone(value);
function merge(previous: State, next: State): State {
  const state = clone(previous);
  for (const name of ['components', 'indices', 'members', 'nodes', 'values', 'results', 'failures'] as const)
    for (const [id, value] of next[name]) (state[name] as Map<string, unknown>).set(id, clone(value));
  for (const id of next.provided) { state.provided.add(id); state.failures.delete(id); }
  if (next.guide !== undefined) state.guide = next.guide;
  if (next.eventProvided) { state.eventData = clone(next.eventData!); state.eventProvided = true; }
  return state;
}

/** Request-local, terminal-owned disclosure. Prose or instance values never
 * confer authority to write a parameter or connect an unread public port. */
export class S2InteractionDisclosure {
  private state = empty();
  constructor(private readonly options: {
    components: Map<string, S2AgentComponentDescription>;
    nodes: Map<string, Node>;
    resultIds: Set<string>;
    readResult(id: string): { resultId: string };
    description: { purpose: string; assistant: { instructions: string } };
    event?: { data: S2Json; readable: boolean };
    /** Affects disclosed syntax only; the public action preflight owns permission. */
    editable?: boolean;
    /** A scoped task may edit existing instances while forbidding new ones. */
    allowAdd?: boolean;
    /** The terminal determines whether a public source/target pairing exists. */
    allowConnect?: boolean;
  }) {}

  private projection(state: State): RecordValue {
    const interfaces = new Map<string, RecordValue>();
    for (const { componentId, section } of state.members.values()) {
      if (state.components.has(componentId)) continue;
      const value = interfaces.get(componentId) ?? { componentId, representation: 'selected-interface' };
      if (value[section] === undefined) value[section] = (this.component(componentId)[section] as Member[])
        .filter(member => state.members.has(memberKey(componentId, section, member.id)))
        .map(member => state.members.get(memberKey(componentId, section, member.id))!.member);
      interfaces.set(componentId, value);
    }
    const failures = (kind: FailureKind) => [...state.failures.values()].filter(value => value.kind === kind).map(value => value.value);
    const nodeDetails = [...state.nodes.values(), ...failures('node')], resultDetails = [...state.results.values(), ...failures('result')];
    const values = [...state.values.values(), ...failures('value')];
    const componentDetails = failures('component'), interfaceDetails = failures('interface');
    const canEdit = this.options.editable !== false;
    const parameterRules = canEdit && ([...state.components.values()].some(component => component.parameters.length > 0)
      || [...state.members.values()].some(value => value.section === 'parameters'));
    const portRules = canEdit && ([...state.components.values()].some(component => component.inputs.length > 0 || component.outputs.length > 0)
      || [...state.members.values()].some(value => value.section === 'inputs' || value.section === 'outputs'));
    // Only supply the syntax made useful by successfully disclosed rules. This
    // projection also runs during budget admission, so the guide is never free
    // context outside the existing per-batch/cumulative disclosure limits.
    const actionGuide = [
      ...(parameterRules ? ['setValues{nodeId,values:{已读参数ID:值}}'] : []),
      ...(parameterRules && this.options.allowAdd !== false ? ['addNode{node:{id,componentId,position:{x,y},label?,readOnly?,values?:{已读参数ID:值}}}'] : []),
      ...(portRules && this.options.allowConnect !== false ? ['connect{connection:{source:{nodeId,portId},target:{nodeId,portId}}}'] : []),
    ].join('；');
    const recalled = {
      ...(nodeDetails.length ? { nodeDetails } : {}), ...(resultDetails.length ? { resultDetails } : {}), ...(values.length ? { values } : {}),
      ...(componentDetails.length ? { componentDetails } : {}), ...(interfaceDetails.length ? { interfaceDetails } : {}),
      ...(state.eventProvided ? { eventData: state.eventData } : failures('event')[0] ? { eventData: failures('event')[0] } : {}),
      ...(failures('package')[0] ? { packageInstructions: failures('package')[0] } : {}),
    };
    return {
      ...(state.indices.size ? { interfaceIndex: [...state.indices.values()] } : {}),
      ...(state.components.size ? { components: [...state.components.values()] } : {}),
      ...(interfaces.size ? { interfaces: [...interfaces.values()] } : {}),
      ...(state.components.size || state.members.size ? { componentRules: S2_AGENT_COMPONENT_RULES } : {}),
      ...(actionGuide ? { actionGuide } : {}),
      ...(state.guide === undefined ? {} : { packagePurpose: this.options.description.purpose, packageInstructions: state.guide }),
      ...(Object.keys(recalled).length ? { recalled } : {}),
    };
  }
  context(): RecordValue { return clone(this.projection(this.state)); }

  private component(id: string) {
    const value = this.options.components.get(id);
    if (!value) fail('INTERACTION_READ_SCOPE', '/read', '只能读取本轮范围内的公开组件');
    return value;
  }
  private node(id: string) {
    const value = this.options.nodes.get(id);
    if (!value) fail('INTERACTION_READ_SCOPE', '/read', '只能读取本轮范围内的公开实例');
    return value;
  }
  private hasMember(componentId: string, section: Section, id: string) {
    return this.state.components.has(componentId) || this.state.members.has(memberKey(componentId, section, id));
  }

  /** Validate every selector before reading any body. Accepted items remain
   * whole; a failed budget admission changes neither field nor port authority. */
  read(read: S2InteractionRead): void {
    for (const id of read.componentIds ?? []) this.component(id);
    for (const selection of read.interfaces ?? []) {
      const component = this.component(selection.componentId);
      for (const section of ['parameters', 'inputs', 'outputs'] as const)
        if (selection[section]?.some(id => !component[section].some(member => member.id === id)))
          fail('INTERACTION_READ_SCOPE', '/read/interfaces', '请求的参数或端口没有在当前组件公开');
    }
    for (const id of read.nodeIds ?? []) this.node(id);
    for (const selection of read.values ?? []) {
      const node = this.node(selection.nodeId), component = this.component(node.componentId);
      if (selection.parameterIds.some(id => !component.parameters.some(parameter => parameter.id === id)))
        fail('INTERACTION_READ_SCOPE', '/read/values', '只能读取实例的公开参数值');
    }
    if (read.resultIds?.some(id => !this.options.resultIds.has(id))) fail('INTERACTION_READ_SCOPE', '/read/resultIds', '只能读取本轮已提供索引中的结果');
    if (read.eventData && (!this.options.event || !this.options.event.readable)) fail('INTERACTION_READ_SCOPE', '/read/eventData', '当前事件没有范围内可读取的数据');

    let batch = empty();
    const marker = (id: string, kind: FailureKind, value: RecordValue) => batch.failures.set(id, { kind, value: { ...value, unavailable: true,
      ...(kind === 'component' ? { representation: 'complete-interface', reason: '整套组件详情未提供；已成功读取的局部参数或端口仍可按其限制使用，未读字段不可用' }
        : { reason: '完整内容超出本轮披露额度；未读内容不能用于编辑或接线' }) } });
    const wanted = new Set<string>();
    const want = (id: string) => { if (!this.state.provided.has(id)) { wanted.add(id); return true; } return false; };
    // Named members already identify the needed interface; do not expand that
    // request into every unrelated member's identifier or label.
    const overviewIds = [...new Set([...(read.componentIds ?? []), ...(read.interfaces ?? [])
      .filter(value => value.parameters === undefined && value.inputs === undefined && value.outputs === undefined).map(value => value.componentId)])];
    for (const id of overviewIds) if (want(key('index', id))) marker(key('index', id), 'interface', { componentId: id, section: 'index' });
    for (const id of read.componentIds ?? []) if (want(key('component', id))) marker(key('component', id), 'component', { id });
    for (const selection of read.interfaces ?? []) for (const section of ['parameters', 'inputs', 'outputs'] as const)
      for (const id of selection[section] ?? []) if (!this.hasMember(selection.componentId, section, id) && want(memberKey(selection.componentId, section, id)))
        marker(memberKey(selection.componentId, section, id), 'interface', { componentId: selection.componentId, section, id });
    for (const id of read.nodeIds ?? []) if (want(key('node', id))) marker(key('node', id), 'node', { id });
    for (const selection of read.values ?? []) for (const id of selection.parameterIds)
      if (want(key('value', selection.nodeId, id))) marker(key('value', selection.nodeId, id), 'value', { nodeId: selection.nodeId, parameterId: id });
    for (const id of read.resultIds ?? []) if (want(key('result', id))) marker(key('result', id), 'result', { resultId: id });
    if (read.packageInstructions && want('guide')) marker('guide', 'package', {});
    if (read.eventData && want('event')) marker('event', 'event', {});
    if (!wanted.size) fail('INTERACTION_READ_NO_PROGRESS', '/read', '请求内容已在context.recalled提供，勿重读。只解释可直接回复；修改须另用read.interfaces读取parameters规则，接线须读inputs/outputs规则，values不是规则');

    const fits = (value: State) => size(this.projection(value)) <= S2_INTERACTION_LIMITS.readChars
      && size(this.projection(merge(this.state, value))) <= S2_INTERACTION_LIMITS.readTotalChars;
    if (!fits(batch)) fail('INTERACTION_READ_TOO_LARGE', '/read', '读取条目索引已超出额度，请缩小本次读取范围');
    const admit = (id: string, write: (value: State) => boolean | void) => {
      if (!wanted.has(id)) return;
      const candidate = clone(batch);
      if (write(candidate) !== false) { candidate.failures.delete(id); candidate.provided.add(id); }
      if (fits(candidate)) batch = candidate;
    };
    for (const id of overviewIds) admit(key('index', id), state => {
      const component = this.component(id), overview: RecordValue = { componentId: id };
      for (const section of ['parameters', 'inputs', 'outputs'] as const)
        overview[section] = (component[section] as Member[]).map(member => ({ id: member.id, ...(member.label === undefined ? {} : { label: member.label }) }));
      state.indices.set(id, overview);
    });
    for (const id of read.componentIds ?? []) admit(key('component', id), state => {
      const component = this.component(id); state.components.set(id, clone(component));
      for (const section of ['parameters', 'inputs', 'outputs'] as const)
        for (const member of component[section]) state.provided.add(memberKey(id, section, member.id));
    });
    for (const selection of read.interfaces ?? []) for (const section of ['parameters', 'inputs', 'outputs'] as const)
      for (const id of selection[section] ?? []) admit(memberKey(selection.componentId, section, id), state => {
        const member = this.component(selection.componentId)[section].find(member => member.id === id)!;
        state.members.set(memberKey(selection.componentId, section, id), { componentId: selection.componentId, section, member: clone(member) });
      });
    for (const id of read.nodeIds ?? []) admit(key('node', id), state => {
      const node = clone(this.node(id)); state.nodes.set(id, node);
      for (const parameterId of Object.keys(node.values ?? {})) state.provided.add(key('value', id, parameterId));
    });
    for (const selection of read.values ?? []) for (const id of selection.parameterIds) admit(key('value', selection.nodeId, id), state => {
      const node = this.node(selection.nodeId);
      const value = Object.hasOwn(node.values ?? {}, id) ? { nodeId: node.id, parameterId: id, value: clone(node.values![id]) }
        : { nodeId: node.id, parameterId: id, unavailable: true, reason: '当前实例没有设置此参数值' };
      state.values.set(key('value', node.id, id), value);
    });
    for (const id of read.resultIds ?? []) admit(key('result', id), state => {
      const value = clone(this.options.readResult(id)) as RecordValue;
      if (value.unavailable === true) {
        const pending = state.failures.get(key('result', id));
        if (pending) pending.value = value;
        return false;
      }
      state.results.set(id, value);
    });
    if (read.packageInstructions) admit('guide', state => { state.guide = this.options.description.assistant.instructions; });
    if (read.eventData) admit('event', state => { state.eventData = clone(this.options.event!.data); state.eventProvided = true; });
    const merged = merge(this.state, batch);
    if (size(this.projection(merged)) === size(this.projection(this.state)) && JSON.stringify(this.projection(merged)) === JSON.stringify(this.projection(this.state)))
      fail('INTERACTION_READ_NO_PROGRESS', '/read', '本次读取没有新增可用详情，请缩小到需要的字段或使用已有内容');
    this.state = merged;
  }

  /** Values and ports are independent capabilities. A selected input port never
   * becomes a writable parameter merely because both use the same identifier. */
  assertActions(actions: S2InteractionAction[]): void {
    const types = new Map([...this.options.nodes].map(([id, node]) => [id, node.componentId]));
    const requireMember = (componentId: string | undefined, section: Section, id: string, index: number) => {
      if (componentId === undefined) return; // The full public preflight rejects missing/private targets.
      const component = this.options.components.get(componentId);
      if (!component || !component[section].some(member => member.id === id))
        fail('INTERACTION_FIELD_PRIVATE', `/actions/${index}`, '参数或端口没有在当前组件公开');
      if (!this.hasMember(componentId, section, id))
        fail('INTERACTION_COMPONENT_UNREAD', `/actions/${index}`, '操作前须读取所用参数或端口的完整详情；索引和实例正文不能解锁接口');
    };
    for (const [index, action] of actions.entries()) {
      if (action.type === 'addNode') {
        if (!this.options.components.has(action.node.componentId)) fail('INTERACTION_FIELD_PRIVATE', `/actions/${index}`, '新增类型没有在本轮公开');
        for (const id of Object.keys(action.node.values ?? {})) requireMember(action.node.componentId, 'parameters', id, index);
        types.set(action.node.id, action.node.componentId);
      } else if (action.type === 'setValues') {
        for (const id of Object.keys(action.values)) requireMember(types.get(action.nodeId), 'parameters', id, index);
      } else if (action.type === 'connect') {
        requireMember(types.get(action.connection.source.nodeId), 'outputs', action.connection.source.portId, index);
        requireMember(types.get(action.connection.target.nodeId), 'inputs', action.connection.target.portId, index);
      } else if (action.type === 'removeNode') types.delete(action.nodeId);
    }
  }
}
