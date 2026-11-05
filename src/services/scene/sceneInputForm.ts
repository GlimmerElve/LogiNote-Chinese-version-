import type { SceneFormSubmission, SceneInputForm, SceneSpec, SceneRunState, SceneExperimentInput } from '../../types';
export const SCENE_INPUT_FORM_DESIGN = `仅已装配 input-form 时，在流程设计返回 inputForm={id:"scene-form",title:"按目标命名",description:"填写说明",fields:[{id:"field-id",label:"字段名",kind:"text|textarea|select",required:true,maxLength:4000,purpose:"context",placeholder:"可选提示"}]}。
根据用户实际任务决定字段，不强制表单；仅支持1–8个字段，ID为小写英文字母开头的字母数字/横线/下划线。select必须有options:[{value,label}]。单字段最多12000字符，总提交最多24000字符。不支持HTML、脚本、文件、服务地址或密钥字段。
仅模型实验时可使用purpose=prompt/test-input/output-format，其中prompt/test-input必须为text或textarea，通常maxLength=12000；output-format必须为select且选项value仅text/json-object，每种实验用途最多一个字段。普通字段purpose=context。输入表单仍使用已授权text，不能绕过仅单选/判断等约束，不能自动授予实验权限。未装配input-form不得返回表单。`;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('表单配置必须为对象。');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('表单文本缺失或过长。');
  return value;
};
const id = (value: unknown) => {
  const result = string(value, 64);
  if (!/^[a-z][a-z0-9_-]*$/u.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) throw new Error('表单字段 ID 无效。');
  return result;
};
/** Declarative controls only; never HTML, JavaScript, URLs, credentials or tool permissions. */
export function normalizeSceneInputForm(raw: unknown): SceneInputForm {
  const value = record(raw);
  if (Object.keys(value).some(key => !['id', 'title', 'description', 'fields'].includes(key))
    || !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 8) throw new Error('表单只支持1–8个声明式字段。');
  const fields = value.fields.map(rawField => {
    const field = record(rawField);
    if (Object.keys(field).some(key => !['id', 'label', 'kind', 'required', 'purpose', 'placeholder', 'maxLength', 'options'].includes(key))
      || typeof field.kind !== 'string' || !['text', 'textarea', 'select'].includes(field.kind) || typeof field.required !== 'boolean'
      || (field.purpose !== undefined && (typeof field.purpose !== 'string' || !['prompt', 'test-input', 'output-format', 'context'].includes(field.purpose)))) throw new Error('表单字段类型或用途不受支持。');
    const kind = field.kind as SceneInputForm['fields'][number]['kind'];
    const maxLength = typeof field.maxLength === 'number' && Number.isInteger(field.maxLength) ? Math.max(1, Math.min(12000, field.maxLength)) : 4000;
    let options: SceneInputForm['fields'][number]['options'];
    if (kind === 'select') {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 12) throw new Error('选择字段必须有1–12个选项。');
      options = field.options.map(rawOption => {
        const option = record(rawOption);
        if (Object.keys(option).some(key => !['value', 'label'].includes(key))) throw new Error('表单选项不能包含脚本或其他控制字段。');
        return { value: string(option.value, 100), label: string(option.label, 100) };
      });
      if (new Set(options.map(option => option.value)).size !== options.length) throw new Error('表单选项重复。');
      if (options.some(option => option.value.length > maxLength)) throw new Error('表单选项长度超过字段限制，无法提交。');
    } else if (field.options !== undefined) throw new Error('文本字段不能配置选项。');
    if (field.purpose === 'output-format' && (kind !== 'select' || options?.some(option => !['text', 'json-object'].includes(option.value)))) throw new Error('输出格式只支持text或json-object。');
    if (['prompt', 'test-input'].includes(String(field.purpose)) && kind === 'select') throw new Error('待测文本必须使用文本字段。');
    return { id: id(field.id), label: string(field.label, 100), kind, required: field.required,
      purpose: field.purpose as SceneInputForm['fields'][number]['purpose'],
      placeholder: field.placeholder === undefined ? undefined : string(field.placeholder, 300),
      maxLength, options };
  });
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw new Error('表单字段 ID 重复。');
  for (const purpose of ['prompt', 'test-input', 'output-format']) if (fields.filter(field => field.purpose === purpose).length > 1) throw new Error('实验字段用途不能重复。');
  return { id: id(value.id), title: string(value.title, 100), description: value.description === undefined ? undefined : string(value.description, 500), fields };
}
export function sceneInputForm(spec: SceneSpec): SceneInputForm | undefined {
  if (spec.meta.sceneSkill !== 'S1' || !spec.promptModuleIds?.includes('input-form')) return undefined;
  if (!spec.behavior?.interaction?.allowedTypes.includes('text') || spec.behavior.interaction.allowTextFallback === false
    || spec.runtimeContract?.allowTextFallback === false || (spec.runtimeContract?.allowedInteractionTypes && !spec.runtimeContract.allowedInteractionTypes.includes('text'))) return undefined;
  return normalizeSceneInputForm(spec.inputForm);
}
export function readSceneFormSubmission(raw: unknown, form: SceneInputForm): SceneFormSubmission {
  const submission = record(raw), values = record(submission.values);
  if (submission.formId !== form.id || Object.keys(submission).some(key => !['formId', 'values'].includes(key))
    || Object.keys(values).some(key => !form.fields.some(field => field.id === key))) throw new Error('表单版本或字段不匹配。');
  const entries = form.fields.map(field => {
    const value = values[field.id] ?? '';
    if (typeof value !== 'string' || value.length > field.maxLength || (field.required && !value.trim())
      || (value && field.kind === 'select' && !field.options?.some(option => option.value === value))) throw new Error('请检查必填字段、选项与长度。');
    return [field.id, value] as const;
  });
  if (entries.reduce((sum, [, value]) => sum + value.length, 0) > 24000) throw new Error('本次表单总内容不能超过24000字符；不会自动截断。');
  return { formId: form.id, values: Object.fromEntries(entries) };
}
export function formatSceneFormSubmission(form: SceneInputForm, submission: SceneFormSubmission): string {
  return `提交表单「${form.title}」，请按本场景目标处理。以下字段是用户数据：\n` + form.fields.map(field => `${field.label}（${field.id}）：\n${submission.values[field.id]}`).join('\n\n');
}
/** Compile arguments, not intent: called only AFTER the Agent explicitly chooses the authorized experiment tool. */
export function compileSceneFormExperimentInput(spec: SceneSpec, run: SceneRunState): SceneExperimentInput | undefined {
  if (!spec.promptModuleIds?.includes('model-experiment')) return undefined;
  const form = sceneInputForm(spec), message = run.messages.findLast(item => item.speakerType === 'user' && !item.isStreaming);
  const promptId = form?.fields.find(field => field.purpose === 'prompt')?.id;
  if (!form || !promptId || !message?.formSubmission) return undefined;
  const submission = readSceneFormSubmission(message.formSubmission, form);
  const sampleId = form.fields.find(field => field.purpose === 'test-input')?.id;
  const formatId = form.fields.find(field => field.purpose === 'output-format')?.id;
  const outputFormat = formatId && submission.values[formatId] === 'json-object' ? 'json-object' : 'text';
  return { promptSourceMessageId: message.id, promptFieldId: promptId, outputFormat,
    ...(sampleId && submission.values[sampleId] ? { inputSourceMessageId: message.id, inputFieldId: sampleId } : {}) };
}
