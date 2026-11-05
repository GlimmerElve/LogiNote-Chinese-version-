import type { AgentPersonaSettings } from '../../../types';
import { DEFAULT_AGENT_PERSONA, describeAgentPersona, normalizeAgentPersona } from '../persona';
import { registerTool } from '../toolRegistry';

const MODES = ['balanced', 'coach', 'socratic', 'companion', 'expert'] as const;
const TONES = ['neutral', 'warm', 'direct', 'encouraging', 'academic', 'playful'] as const;
const DETAILS = ['concise', 'balanced', 'detailed'] as const;

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const text = value.trim().replace(/\s+/gu, ' ');
  if (!text || text.length > maxLength) throw new Error(`${label}长度应为 1 到 ${maxLength} 个字符`);
  return text;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new Error(`${label}无效`);
  return value as T;
}

function directiveList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label}必须是文本数组`);
  if (!value.length || value.length > 12) throw new Error(`${label}必须包含 1 到 12 条要求`);
  const result: string[] = [];
  for (const item of value) {
    const directive = optionalText(item, `${label}中的每一项`, 160);
    if (directive && !result.includes(directive)) result.push(directive);
  }
  return result;
}

export function resolveAgentPersonaUpdate(
  args: Record<string, unknown>,
  currentValue: unknown,
): AgentPersonaSettings {
  const resetToDefault = args.resetToDefault === true;
  const updateKeys = ['displayName', 'communicationMode', 'tone', 'answerDetail', 'addStyleDirectives',
    'removeStyleDirectives', 'replaceStyleDirectives', 'clearStyleDirectives', 'customInstructions', 'clearCustomInstructions']
    .filter((key) => args[key] !== undefined);
  if (resetToDefault && updateKeys.length) throw new Error('恢复默认不能与其他人格修改同时提交');
  if (resetToDefault) return normalizeAgentPersona(DEFAULT_AGENT_PERSONA);
  if (!updateKeys.length) throw new Error('没有提供要修改的人格项目');

  const current = normalizeAgentPersona(currentValue);
  const displayName = optionalText(args.displayName, '助手名称', 24);
  const communicationMode = enumValue(args.communicationMode, MODES, '交流模式');
  const tone = enumValue(args.tone, TONES, '回答语气');
  const answerDetail = enumValue(args.answerDetail, DETAILS, '默认篇幅');
  const addStyleDirectives = directiveList(args.addStyleDirectives, '新增表达要求');
  const removeStyleDirectives = directiveList(args.removeStyleDirectives, '移除表达要求');
  const replaceStyleDirectives = directiveList(args.replaceStyleDirectives, '替换后的表达要求');
  const customInstructions = optionalText(args.customInstructions, '补充人格偏好', 500);

  for (const key of ['clearStyleDirectives', 'clearCustomInstructions']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  if (replaceStyleDirectives && (addStyleDirectives || removeStyleDirectives || args.clearStyleDirectives === true)) {
    throw new Error('替换全部表达要求不能与新增、移除或清空同时提交');
  }

  const shouldClear = args.clearStyleDirectives === true || args.clearCustomInstructions === true;
  let styleDirectives = shouldClear ? [] : [...current.styleDirectives];
  if (replaceStyleDirectives) styleDirectives = replaceStyleDirectives;
  if (removeStyleDirectives) {
    const removals = new Set(removeStyleDirectives);
    styleDirectives = styleDirectives.filter((item) => !removals.has(item));
  }
  if (addStyleDirectives) {
    styleDirectives = [...styleDirectives, ...addStyleDirectives.filter((item) => !styleDirectives.includes(item))];
  }
  // Backward compatibility for calls made by an older prompt/tool schema.
  if (customInstructions) styleDirectives = [customInstructions];
  if (styleDirectives.length > 12) throw new Error('表达要求最多保留 12 条，请合并或删除后再添加');

  return normalizeAgentPersona({
    ...current,
    ...(displayName ? { displayName } : {}),
    ...(communicationMode ? { communicationMode } : {}),
    ...(tone ? { tone } : {}),
    ...(answerDetail ? { answerDetail } : {}),
    styleDirectives,
  });
}

function changedDescriptions(currentValue: unknown, nextValue: unknown): string[] {
  const current = normalizeAgentPersona(currentValue);
  const next = normalizeAgentPersona(nextValue);
  const changes: string[] = [];
  if (current.displayName !== next.displayName) changes.push(`称呼：${current.displayName} → ${next.displayName}`);
  if (current.communicationMode !== next.communicationMode) changes.push(`交流模式：${current.communicationMode} → ${next.communicationMode}`);
  if (current.tone !== next.tone) changes.push(`回答语气：${current.tone} → ${next.tone}`);
  if (current.answerDetail !== next.answerDetail) changes.push(`默认篇幅：${current.answerDetail} → ${next.answerDetail}`);
  const removed = current.styleDirectives.filter((item) => !next.styleDirectives.includes(item));
  const added = next.styleDirectives.filter((item) => !current.styleDirectives.includes(item));
  changes.push(...added.map((item) => `新增表达要求：${item}`));
  changes.push(...removed.map((item) => `移除表达要求：${item}`));
  return changes;
}

export function registerPersonaTools(): void {
  registerTool({
    name: 'update_agent_persona',
    description: '修改助手独立人格。既支持名称和预设，也支持从用户自然语言中提取任意、可组合、可逐条编辑的表达要求。任何修改都必须弹出确认卡，确认前不生效。不要用来修改学习画像。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        displayName: { type: 'string', description: '用户希望以后称呼助手的名字，最多 24 字' },
        communicationMode: { type: 'string', enum: [...MODES], description: '可选快捷预设；用户未明确要求这些模式时不要强行映射' },
        tone: { type: 'string', enum: [...TONES], description: '可选快捷预设；用户的自由表达优先用 addStyleDirectives 保留原意' },
        answerDetail: { type: 'string', enum: [...DETAILS], description: '默认回答篇幅；用户没有要求时不要改变' },
        addStyleDirectives: {
          type: 'array', maxItems: 12, items: { type: 'string' },
          description: '从用户自然语言中语义提取的新增要求。每项只表达一个可独立修改的行为，例如“适度使用幽默”“多用形象化语言”“解释概念时优先使用通俗说法”。不要受 tone 枚举限制，也不要改写成僵硬标签',
        },
        removeStyleDirectives: {
          type: 'array', maxItems: 12, items: { type: 'string' },
          description: '要删除的既有人格表达要求，必须逐字使用当前人格中已有的条目',
        },
        replaceStyleDirectives: {
          type: 'array', maxItems: 12, items: { type: 'string' },
          description: '仅当用户明确要求重写或替换全部自定义人格时使用',
        },
        clearStyleDirectives: { type: 'boolean', description: '用户明确要求清除全部开放式表达要求时设为 true' },
        customInstructions: { type: 'string', description: '兼容旧客户端；新调用不要使用，改用可拆分的 addStyleDirectives' },
        clearCustomInstructions: { type: 'boolean', description: '兼容旧客户端；新调用使用 clearStyleDirectives' },
        resetToDefault: { type: 'boolean', description: '恢复全部默认人格；为 true 时不得同时提交其他字段' },
      },
    },
    location: 'renderer', permission: 'write',
    approvalSnapshot: (_args, ctx) => ctx.getAgentPersona?.() || DEFAULT_AGENT_PERSONA,
    confirmation: (args, ctx) => {
      const current = ctx?.getAgentPersona?.() || DEFAULT_AGENT_PERSONA;
      const next = resolveAgentPersonaUpdate(args, current);
      const impacts = changedDescriptions(current, next);
      return {
        title: args.resetToDefault === true ? '恢复默认助手人格' : '确认修改助手人格',
        description: `确认后将保存到本地，并从下一轮对话开始使用“${next.displayName}”的人格设置。`,
        impacts: impacts.length ? impacts : ['人格设置没有实际变化。'],
      };
    },
    execute: async (args, ctx) => {
      if (!ctx.updateAgentPersona) throw new Error('当前环境无法保存助手人格');
      const persona = resolveAgentPersonaUpdate(args, ctx.getAgentPersona?.() || DEFAULT_AGENT_PERSONA);
      const saved = await ctx.updateAgentPersona(persona);
      return { updated: true, persona: saved, summary: describeAgentPersona(saved) };
    },
  });
}
