import type { S2Json, S2PluginPort, S2ValueSchema } from '../../types/sceneS2Plugin';
import type { S2PublicComponentDescription, S2PublicFieldRules } from './sceneS2PublicAuthoring';

/** Model-only view. The installed public contract remains the authority for
 * compilation, validation and the canvas menu; packages maintain no second DTO. */
export interface S2AgentParameter {
  id: string;
  label?: string;
  meaning?: string;
  typeMeaning?: string;
  schema?: S2ValueSchema;
  field?: S2PublicFieldRules;
  required: boolean;
  allowBlank?: boolean;
  default?: S2Json;
}
export interface S2AgentPort {
  id: string;
  label?: string;
  meaning: string;
  /** Exact semantic type identity, including its version; never a guessed alias. */
  type: string;
  required: boolean;
  multiple: boolean;
}
export interface S2AgentComponentDescription {
  id: string;
  label: string;
  purpose: string;
  parameters: S2AgentParameter[];
  inputs: S2AgentPort[];
  outputs: S2AgentPort[];
}

export const S2_AGENT_COMPONENT_RULES = 'components的parameters是可写入values的参数，inputs/outputs仅供连线；空端口数组不影响参数编辑。参数遵守field或schema；allowBlank:true可暂留空串。数值须有限，integer为安全整数；serializedMaxLength为存储文本字符上限，maxBytes/cellMaxBytes为JSON的UTF-8字节上限。label省略时同id；端口type为精确的id@version，连接两端必须一致。';

const label = (value: { id: string; label: string }) => value.label === value.id ? {} : { label: value.label };
function port(value: S2PluginPort): S2AgentPort {
  return { id: value.id, ...label(value), meaning: value.meaning,
    type: `${value.type.id}@${value.type.version}`, required: value.required, multiple: value.multiple };
}

/** Deterministic, package-independent field projection. It never executes a
 * package, summarizes prose, invents constraints, or changes editable fields.
 * Native field rules replace the older approximate schema only in this view. */
export function projectS2AgentComponents(components: readonly S2PublicComponentDescription[]): S2AgentComponentDescription[] {
  return components.map(component => ({
    id: component.id, label: component.label, purpose: component.purpose,
    parameters: component.parameters.map(parameter => ({
      id: parameter.id, ...label(parameter),
      ...(parameter.meaning === undefined ? {} : { meaning: parameter.meaning }),
      ...(parameter.typeMeaning === undefined ? {} : { typeMeaning: parameter.typeMeaning }),
      ...(parameter.field === undefined ? { schema: structuredClone(parameter.schema) } : { field: structuredClone(parameter.field) }),
      required: parameter.required,
      ...(parameter.allowBlank === undefined ? {} : { allowBlank: parameter.allowBlank }),
      ...(Object.hasOwn(parameter, 'default') ? { default: structuredClone(parameter.default!) } : {}),
    })),
    inputs: component.inputs.map(port), outputs: component.outputs.map(port),
  }));
}
