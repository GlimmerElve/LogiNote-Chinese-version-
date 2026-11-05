/** An explicitly cleared selection must not silently call a previously listed model. */
export function requireLlmModel(provider: { selectedModel?: string; models: string[] }, override?: string): string {
  // Existing workflows use an empty request override to inherit the provider.
  // The provider's explicit empty selection still means it is not configured.
  const model = override?.trim() || (provider.selectedModel ?? provider.models?.[0] ?? '').trim();
  if (!model) throw new Error('请先填写模型名称，再使用模型服务。');
  return model;
}
