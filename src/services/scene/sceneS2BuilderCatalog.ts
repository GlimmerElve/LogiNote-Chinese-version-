import type { S2DataType, S2PluginCapability, S2PluginManifest, S2PluginPort, S2TypeRef, S2ValueSchema } from '../../types/sceneS2Plugin';
import type { ScenePackDescription } from '../../types/sceneInteractionPack';

export interface S2BuilderCatalogSource {
  protocolVersion: number;
  schemaDialect: string;
  fieldEditors?: readonly string[];
  plugins: readonly S2PluginManifest[];
}
/** Start discovery with the selected package's declared component interfaces.
 * Existing graphs and saved blueprints remain discoverable; this never changes runtime grants. */
export function s2BuilderDiscoveryCatalog(source: S2BuilderCatalogSource, guide?: ScenePackDescription,
  retained: readonly { pluginId: string; pluginVersion: string; capabilityId: string }[] = []): S2BuilderCatalogSource {
  if (!guide?.components.length || guide.components.some(component => component.capabilities === undefined)) return source;
  const key = (ref: { pluginId: string; pluginVersion: string; capabilityId: string }) => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`;
  const available = new Set(source.plugins.flatMap(plugin => plugin.capabilities.filter(cap => cap.kind !== 'editor')
    .map(cap => key({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id }))));
  const declared = guide.components.flatMap(component => component.capabilities ?? []);
  for (const ref of declared) if (!available.has(key(ref))) fail(`组件所需能力 ${key(ref)} 未安装或不在本包范围`);
  const selected = new Set([...declared, ...retained].map(key));
  return { ...source, plugins: source.plugins.flatMap(plugin => {
    const capabilities = plugin.capabilities.filter(cap => selected.has(key({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id })));
    return capabilities.length ? [{ ...plugin, capabilities }] : [];
  }) };
}
/** A compact authoring vocabulary, deliberately distinct from executable manifests. */
export type S2BuilderValueShape = 'JSON' | 'boolean'
  | ['string', number, string[]?]
  | ['integer' | 'number', number, number]
  | ['array', S2BuilderValueShape, number]
  | ['object', Record<string, S2BuilderValueShape>, string[]];
export type S2BuilderPort = [string, string, boolean, boolean, string?, string?];
export interface S2BuilderCatalog {
  protocolVersion: number;
  schemaDialect: string;
  representation: 's2-builder-catalog-v1';
  legend: string;
  fieldEditors: string[];
  plugins: Array<{
    id: string; version: string; label: string; meaning: string;
    capabilities: Array<{
      id: string; kind: S2PluginCapability['kind']; meaning: string;
      inputs: S2BuilderPort[]; outputs: S2BuilderPort[];
      effect: S2PluginCapability['effect']; permissions?: S2PluginCapability['permissions'];
    }>;
  }>;
  types: Array<{ ref: string; meaning: string; shape: S2BuilderValueShape }>;
}

const LEGEND = '这是搭建说明，不是运行manifest或授权。端口=[id,"语义类型id@版本",必填,多值,显示名?,含义?]；省略显示名等于id，省略含义等于“id 完整数据”。shape：JSON=原生JSON；boolean=布尔；[string,最大长度,枚举?]；[integer|number,最小值,最大值]；[array,元素shape,最多项数]；[object,{字段:shape},必填字段]。literal.value直接填该形状的原生值，不填shape标签。保留精确类型版本与全部可选能力；省略的执行参数及JSON字节/深度限额仍由本地完整契约校验，超限拒绝，不表示无限制。';
const refKey = (ref: S2TypeRef) => `${ref.id}@${ref.version}`;
const fail = (detail: string): never => { throw new Error(`S2 搭建目录：${detail}`); };

function shape(schema: S2ValueSchema): S2BuilderValueShape {
  switch (schema.kind) {
    case 'json': return 'JSON';
    case 'boolean': return 'boolean';
    case 'string': return schema.enum === undefined ? ['string', schema.maxLength] : ['string', schema.maxLength, [...schema.enum]];
    case 'number': return [schema.integer ? 'integer' : 'number', schema.minimum, schema.maximum];
    case 'array': return ['array', shape(schema.item), schema.maxItems];
    case 'object': return ['object', Object.fromEntries(Object.entries(schema.fields).map(([key, value]) => [key, shape(value)])), [...schema.required]];
  }
}

/** Only omit labels/descriptions that match the protocol's exact generated defaults. */
function port(port: S2PluginPort): S2BuilderPort {
  const result: S2BuilderPort = [port.id, refKey(port.type), port.required, port.multiple];
  const label = port.label === port.id ? undefined : port.label;
  const meaning = port.meaning === `${port.id} 完整数据` ? undefined : port.meaning;
  if (meaning !== undefined) result.push(label ?? port.id, meaning);
  else if (label !== undefined) result.push(label);
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Project a validated installation snapshot without running, granting, filtering by business, or
 * mutating it. Extra providers resolve precise port types only; their capabilities never enter scope. */
export function createS2BuilderCatalog(source: S2BuilderCatalogSource,
  allTypeProviders: readonly Pick<S2PluginManifest, 'dataTypes'>[] = []): S2BuilderCatalog {
  const types = new Map<string, S2DataType>();
  for (const provider of [...source.plugins, ...allTypeProviders]) for (const type of provider.dataTypes) {
    const key = refKey(type), existing = types.get(key);
    if (existing && canonical(existing) !== canonical(type)) fail(`类型 ${key} 的完整声明冲突`);
    types.set(key, type);
  }
  const needed = new Set<string>();
  const plugins = source.plugins.map(plugin => ({ id: plugin.id, version: plugin.version, label: plugin.label, meaning: plugin.meaning,
    capabilities: plugin.capabilities.filter(capability => capability.kind !== 'editor').map(capability => {
      for (const endpoint of [...capability.inputs, ...capability.outputs]) needed.add(refKey(endpoint.type));
      return { id: capability.id, kind: capability.kind, meaning: capability.meaning,
        inputs: capability.inputs.map(port), outputs: capability.outputs.map(port), effect: capability.effect,
        ...(capability.permissions.length ? { permissions: [...capability.permissions] } : {}),
      };
    }),
  }));
  return { protocolVersion: source.protocolVersion, schemaDialect: source.schemaDialect, representation: 's2-builder-catalog-v1',
    legend: LEGEND, fieldEditors: [...(source.fieldEditors ?? [])], plugins,
    types: [...needed].map(ref => {
      const type = types.get(ref) ?? fail(`找不到端口类型 ${ref} 的完整声明；未猜测或省略类型`);
      return { ref, meaning: type.meaning, shape: shape(type.schema) };
    }),
  };
}
