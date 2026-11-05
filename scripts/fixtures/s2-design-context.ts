/** Offline model-capacity declaration. Never reads or writes the user's settings. */
export async function withS2DesignContext<T>(contextWindowTokens: number, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>([['loginote_llm_settings', JSON.stringify({
    providers: [{ id: 'deepseek-default', name: 'Synthetic design fixture', apiType: 'openai-compatible',
      baseUrl: 'https://fixture.invalid', apiKey: '', models: ['synthetic'], selectedModel: 'synthetic',
      enabled: true, createdAt: '', contextWindowTokens }],
    defaultProviderId: 'deepseek-default', workflowBinding: { 'agent-scene-setup': 'deepseek-default' },
  })]]);
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
