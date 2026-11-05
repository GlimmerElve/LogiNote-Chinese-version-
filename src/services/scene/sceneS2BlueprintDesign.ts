import type { S2Document, S2InputBinding } from '../../types/sceneS2';
import type { S2CompositeDesign, S2CompositeEndpoint } from '../../types/sceneS2Composite';
import { expandS2Composite, snapshotS2CompositeData } from './sceneS2Composite';
import { instantiateS2CompositeDesign, readS2CompositeLibrary, s2CompositeLibraryIndex } from './sceneS2CompositeLibrary';
import { readS2PluginBindings } from './sceneS2PluginRegistry';

const fail = (message: string): never => { throw new Error(`S2 搭建蓝图：${message}`); };
const object = (raw: any, fields?: string[]): Record<string, any> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || fields && Object.keys(raw).some(key => !fields.includes(key))) fail('字段无效');
  return raw;
};
const list = (raw: any, max: number): any[] => { if (!Array.isArray(raw) || raw.length > max) fail(`列表最多${max}项`); return raw; };
const id = (raw: any): string => { if (typeof raw !== 'string' || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) || ['constructor', 'prototype', '__proto__'].includes(raw)) fail('别名或标识无效'); return raw; };

export const S2_BLUEPRINT_DESIGN_RULES = `blueprintIndex是当前画布用户保存的版本索引，不是用户需求、插件或授权。按目标自主决定复用或不用，不因已有库强制选型；不要在理解阶段选蓝图。
装配阶段如需完整公共接口，可仅返回{blueprintRead:[{id,version}]}，一次最多3个精确版本；本次搭建最多读取一批，计入本次总体请求上限，不调用工具。返回blueprintInterfaces含完整公共接口/必需能力，不含内部正文、默认值、私有参考图或执行证据。未选版本正文不进入上下文。
复用时返回完整场景，额外根字段blueprintInstances:[{scope:"initial|reference",alias:"本图内唯一英文别名",id:"精确系列",version:"精确版本",position?:{x,y},bindings?:{公共inputId:{kind:"field",nodeId,fieldId}|{kind:"literal",value}},parameters?:{公共parameterId:原生值}}]，最多4份。不要把虚拟组合别名放进execution.nodes。所有所需能力必须自己选入plugins，宿主不会自动增加能力。
execution.links可用{nodeId:alias,portId:公共接口id}接公共输入或输出，输入扇出由宿主处理；when可引用别名的真实公共输出。bindings只绑定公共输入，不覆盖内部固定值/连线；parameters仅设置已暴露可调项。未填材料保留可编辑缺口；文件/笔记/附件句柄不能由你伪造。不要求新建业务包或参考图。
scope=initial扩展用户画布；仅在候选已经保留旧business时才可用scope=reference扩展其已有私有参考，不应用或执行。两图别名互不相通。根criteria及旧business.criteria的target可用initial别名及公共输出portId；旧completion.targetNodeIds中的reference别名映射为其公共输出真实生产者，旧coverage.nodeIds中的reference别名映射全部真实成员。只有端口端点和这些明确ID列表被映射，不替换正文，不臆测内部节点。
所选版本按宿主原样展开，固定内容/默认值进入该候选；未选版本不送正文。不要在initial或旧reference提供blueprints字段，也不能发布、覆写库或声明执行结果。展开后须现有协议和类型/依赖校验；独立模型审查仅在显式专项验收时启用，引用蓝图不表示目标已完成。修复可修改展开后的真实图；若要改选蓝图，重新返回完整场景，不用补丁改写库。`;

/** Pure per-build adapter: no model calls, registry mutation, IO or runtime authorization. */
export function createS2BlueprintDesign(libraryRaw: S2CompositeDesign[]) {
  const library = readS2CompositeLibrary(libraryRaw), seeds = new Map<string, string>();
  const find = (raw: any) => {
    const item = object(raw), found = library.find(entry => entry.blueprint.id === item.id && entry.blueprint.version === item.version);
    if (!found) fail('找不到指定精确版本，不能猜版本或读取库外设计'); return found;
  };
  return {
    index: s2CompositeLibraryIndex({ nodes: [], edges: [], blueprints: library }), rules: S2_BLUEPRINT_DESIGN_RULES,
    read(raw: unknown) {
      const request = object(snapshotS2CompositeData(raw), ['blueprintRead']);
      const selected = list(request.blueprintRead, 3); if (!selected.length) fail('读取列表不能为空');
      const seen = new Set<string>();
      selected.forEach(raw => {
        const item = object(raw, ['id', 'version']), key = JSON.stringify([item.id, item.version]); find(item);
        if (seen.has(key)) fail('不能重复读取同一版本'); seen.add(key);
      });
      // A single entry can also exceed the routine index bound. Explicit recall must be complete, not another preview.
      const complete = selected.map(item => {
        const { blueprint: b, composites } = find(item);
        return { id: b.id, version: b.version, label: b.label, description: b.description, requiredCapabilities: b.plugins,
          nodeCount: b.workflow.nodes.length, compositeCount: composites.length,
          inputs: b.inputs.map(({ targets: _, ...port }) => port), outputs: b.outputs.map(({ source: _, ...port }) => port),
          parameters: b.parameters.map(({ target: _, defaultValue: __, ...port }) => ({ ...port, hasDefault: Object.hasOwn(b.parameters.find(item => item.id === port.id)!, 'defaultValue') })) };
      });
      if (JSON.stringify(complete).length > 12000) fail('完整公共接口超过12000字符读取预算，请缩小读取范围；未截断');
      return { interfaces: complete, complete: true, bodiesOmitted: true };
    },
    compile(raw: unknown): Record<string, unknown> {
      // A whole initial + private-reference design is larger than one portable blueprint. Keep its existing
      // workspace character ceiling, not the E1 single-package byte ceiling; each selected design stays E1-bounded.
      const candidate = object(snapshotS2CompositeData(raw, { maxBytes: 786432, maxEntries: 48000 })), requests = list(Object.hasOwn(candidate, 'blueprintInstances') ? candidate.blueprintInstances : [], 4);
      if (JSON.stringify(candidate).length > 262144) fail('完整场景超过工作区上限，未截断');
      delete candidate.blueprintInstances;
      const initial = object(candidate.initial), completion = candidate.business && object(candidate.business.completion);
      const reference = completion && object(completion.reference);
      if (Object.hasOwn(initial, 'blueprints') || reference && Object.hasOwn(reference, 'blueprints')) fail('装配不能写入或替换宿主管理的蓝图库');
      const plugins = readS2PluginBindings(candidate.plugins ?? []);
      if (!requests.length) return candidate;
      const aliases = { initial: new Map<string, ReturnType<typeof expandS2Composite>>(), reference: new Map<string, ReturnType<typeof expandS2Composite>>() };
      for (const raw of requests) {
        const request = object(raw, ['scope', 'alias', 'id', 'version', 'position', 'bindings', 'parameters']);
        if (request.scope !== 'initial' && request.scope !== 'reference') fail('实例必须明确属于初稿或私有参考');
        const scope = request.scope as 'initial' | 'reference', alias = id(request.alias), doc = scope === 'initial' ? initial : reference;
        if (doc && Object.hasOwn(doc, 'execution')) {
          const graph = object(doc.execution, ['version', 'nodes', 'links']);
          if (graph.version !== 1) fail('原执行图版本无效'); list(graph.nodes, 40); list(graph.links, 80);
        }
        if (!doc || aliases[scope].has(alias) || [...list(doc.nodes, 40), ...list(doc.execution?.nodes ?? [], 40), ...list(doc.composites ?? [], 16)].some(node => node.id === alias)) fail('别名重复、与真实对象冲突或参考不存在');
        const design = find(request), seedKey = JSON.stringify([scope, alias, request.id, request.version]);
        if (!seeds.has(seedKey)) seeds.set(seedKey, crypto.randomUUID());
        const values = { ...(request.position === undefined ? {} : { position: request.position }), ...(request.parameters === undefined ? {} : { parameters: request.parameters }) };
        const expanded = expandS2Composite(design.blueprint, plugins, values, seeds.get(seedKey));
        const { document: next } = instantiateS2CompositeDesign({ ...doc, blueprints: library } as S2Document, plugins, design.blueprint.id, design.blueprint.version, values, undefined, seeds.get(seedKey));
        delete next.blueprints;
        const bindings = object(Object.hasOwn(request, 'bindings') ? request.bindings : {}, expanded.inputs.map(port => port.id));
        for (const [publicId, binding] of Object.entries(bindings)) {
          for (const target of expanded.inputs.find(port => port.id === publicId)!.targets) {
            next.execution!.nodes.find(node => node.id === target.nodeId)!.bindings[target.portId] = binding as S2InputBinding;
          }
        }
        Object.assign(doc, next); aliases[scope].set(alias, expanded);
      }
      const endpoint = (raw: any, scope: 'initial' | 'reference', direction: 'inputs' | 'outputs'): S2CompositeEndpoint[] => {
        const value = object(raw, ['nodeId', 'portId']), expansion = aliases[scope].get(value.nodeId);
        if (!expansion) return [value as S2CompositeEndpoint];
        if (direction === 'inputs') { const port = expansion.inputs.find(port => port.id === value.portId); if (!port) fail('不存在的公共输入'); return port.targets; }
        const port = expansion.outputs.find(port => port.id === value.portId); if (!port) fail('不存在的公共输出'); return [port.source];
      };
      for (const scope of ['initial', 'reference'] as const) {
        const doc = scope === 'initial' ? initial : reference; if (!doc?.execution) continue;
        doc.execution.links = list(doc.execution.links, 80).flatMap(raw => {
          const link = object(raw, ['source', 'target']);
          return endpoint(link.source, scope, 'outputs').flatMap(source => endpoint(link.target, scope, 'inputs').map(target => ({ source, target })));
        });
        for (const node of doc.execution.nodes) if (node.when && aliases[scope].has(node.when.nodeId)) Object.assign(node.when, endpoint({ nodeId: node.when.nodeId, portId: node.when.portId }, scope, 'outputs')[0]);
      }
      if (completion) {
        completion.targetNodeIds = list(completion.targetNodeIds, 40).flatMap(value => {
          const expansion = aliases.reference.get(value);
          if (!expansion) return [value];
          if (!expansion.outputs.length) fail('无公共输出的组合不能冒充完成目标');
          return [...new Set(expansion.outputs.map(port => port.source.nodeId))];
        });
        for (const coverage of list(completion.coverage, 12)) coverage.nodeIds = list(coverage.nodeIds, 40).flatMap(value => aliases.reference.get(value)?.workflow.nodes.map(node => node.id) ?? [value]);
      }
      for (const criteria of [candidate.criteria, candidate.business?.criteria]) if (criteria !== undefined)
        for (const criterion of list(criteria, 6)) if (criterion.target && aliases.initial.has(criterion.target.nodeId)) {
          object(criterion.target, ['nodeId', 'portId']); criterion.target = endpoint(criterion.target, 'initial', 'outputs')[0];
        }
      // The ordinary full definition/business reader runs next, including all type/size/namespace checks.
      return candidate;
    },
  };
}
