import React, { useEffect, useRef, useState } from 'react';
import { LlmSettings, LlmProvider, LlmApiType, LlmWorkflowId } from '../types';
import { Cpu, Plus, Trash2, Check, X, Wifi, Loader2, Settings, RefreshCw } from 'lucide-react';
import { useDialog } from './useDialog';
import { clearNewLlmProviderDraft, readNewLlmProviderDraft, updateNewLlmProviderDraft } from '../services/ui/newLlmProviderDraft';
import type { LlmProbeResponse } from '../electron/ipcTypes';
import { flushLlmSettingsWrites, hasUnsavedLlmSettings } from '../services/llmStorage';

interface LlmSettingsPanelProps {
  llmSettings: LlmSettings;
  onUpdate: (s: LlmSettings) => void;
}

const API_TYPE_LABELS: Record<LlmApiType, string> = {
  'openai-compatible': 'OpenAI 兼容',
  'anthropic': 'Anthropic',
  'gemini': 'Google Gemini',
  'ollama': 'Ollama',
};

const WORKFLOW_LABELS: Record<LlmWorkflowId, string> = {
  'textbook-blueprint': '教材·教学蓝图',
  'textbook-chapter': '教材·章节生成',
  'textbook-quality': '教材·质量复核',
  'agent-chat': 'Agent 学习助手',
  'agent-intent-routing': 'Agent·意图路由',
  'agent-resource-curation': 'Agent·学习资源统筹',
  'agent-study-task-generation': 'Agent·学习任务生成',
  'agent-personalized-qa': 'Agent·个性化答疑',
  'agent-scene-setup': 'Agent·场景搭设',
  'plan-generation': '学习计划生成',
  'flow-analysis': '心流复盘·论证与参考评价',
  'review-tutor': '苏格拉底式导师',
  'review-scoring': '对话统一评分',
  'question-answer': '问题卡片解答',
  'concept-generation': '证据驱动概念补全',
  'document-knowledge-extract': '资料·论证结构 v5.0',
  'argument-quality-review': '论证图·语义质量复核',
  'study-task-generation': '学习任务生成',
  'knowledge-discovery': '知识点识别',
  'knowledge-mastery-scoring': '知识点分层掌握度评分',
  // 仅兼容旧配置键；退役工作流不再出现在绑定列表或分组中。
  'profile-evidence-layered': '画像·分层证据（概念/判断/推理）',
  'profile-style-cognitive': '画像·认知风格',
  'profile-concept-aliases': '画像·概念归并',
  'logic-check': '逻辑检查',
  'flow-preprocess': '心流复盘·口语预处理',
  'storm-multi-perspective': 'STORM·多视角扫描',
  'storm-contradiction': 'STORM·矛盾图谱',
  'storm-brief': 'STORM·综合简报',
  'storm-peer-review': 'STORM·同行评审',
  'storm-abstract': 'STORM·多视角摘要',
  'scene-decide': '应用·场景决策',
  'scene-generate': '应用·场景生成',
  'scene-adapt': '应用·场景改编',
  'scene-role-reply': '应用·角色发言',
  'scene-turn-plan': '应用·互动 Agent 规划',
  'scene-general-turn': '应用·通用场景回合',
  'scene-model-experiment': '应用·独立模型实验',
  'scene-experiment-evaluate': '应用·隔离实验评估',
  'scene-metric-update': '应用·指标判定',
  // ===== S4 数理场景 =====
  'scene-compute-generate': '应用·数理场景生成',
  'scene-compute-config': '应用·数理计算配置',
  'scene-compute-adapt': '应用·数理场景改编',
  'scene-formula-parse': '应用·公式转译',
  'scene-compute-analyze': '应用·推导分析',
  'scene-help': '应用·推导求助',
};

const WORKFLOW_BINDING_LIST: LlmWorkflowId[] = [
  'agent-chat', 'agent-resource-curation', 'agent-study-task-generation', 'agent-personalized-qa', 'agent-scene-setup',
  'plan-generation', 'review-tutor', 'review-scoring', 'question-answer', 'study-task-generation',
];

/** 可一次绑定同一服务商的工作流分组；已有分项差异必须如实展示。 */
const WORKFLOW_GROUPS: Array<{ label: string; workflows: LlmWorkflowId[] }> = [
  { label: 'RAG 知识抽取', workflows: ['document-knowledge-extract', 'argument-quality-review'] },
  { label: '逻辑检查', workflows: ['logic-check'] },
  {
    label: 'STORM 学习法',
    workflows: [
      'storm-multi-perspective', 'storm-contradiction', 'storm-brief',
      'storm-peer-review', 'storm-abstract',
    ],
  },
  {
    label: '心流复盘分析',
    workflows: [
      'flow-analysis',
      'knowledge-discovery', 'knowledge-mastery-scoring',
    ],
  },
  {
    label: '应用场景',
    workflows: [
      'scene-decide', 'scene-generate', 'scene-adapt',
      'scene-role-reply', 'scene-general-turn', 'scene-metric-update',
    ],
  },
  {
    label: '应用·数理场景（S4）',
    workflows: [
      'scene-compute-generate', 'scene-compute-config', 'scene-compute-adapt', 'scene-formula-parse',
      'scene-compute-analyze', 'scene-help',
    ],
  },
];

export const LlmSettingsPanel: React.FC<LlmSettingsPanelProps> = ({ llmSettings, onUpdate }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddFormState] = useState(() => readNewLlmProviderDraft().open);
  const [newProvider, setNewProviderState] = useState<Partial<LlmProvider>>(() => readNewLlmProviderDraft().provider);
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>(() => {
    const contextInput = readNewLlmProviderDraft().contextInput;
    return contextInput === undefined ? {} : { new: contextInput };
  });
  const [contextErrors, setContextErrors] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({});
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [probePending, setProbePending] = useState<Record<string, boolean>>({});
  const [modelDiscovery, setModelDiscovery] = useState<Record<string, { pending: boolean; error?: string; count?: number }>>({});
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const addingProvider = useRef(false);
  const testingProviders = useRef(new Set<string>());
  const providerRevisions = useRef(new Map<string, number>());
  const probeRequests = useRef(new Map<string, { revision: number; signature: string }>());
  const modelDiscoveryRequests = useRef(new Map<string, { signature: string }>());
  const settingsRef = useRef(llmSettings);
  settingsRef.current = llmSettings;
  const providersRef = useRef(llmSettings.providers);
  providersRef.current = llmSettings.providers;
  const newProviderRef = useRef(newProvider);
  newProviderRef.current = newProvider;
  const setShowAddForm = (open: boolean) => {
    updateNewLlmProviderDraft({ open });
    setShowAddFormState(open);
  };
  const setNewProvider: React.Dispatch<React.SetStateAction<Partial<LlmProvider>>> = update => {
    const provider = typeof update === 'function' ? update(newProviderRef.current) : update;
    newProviderRef.current = provider;
    updateNewLlmProviderDraft({ provider });
    setNewProviderState(provider);
  };
  const mounted = useRef(true);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  useDialog(Boolean(deleteTargetId), deleteDialogRef, () => setDeleteTargetId(null), 80);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; probeRequests.current.clear(); modelDiscoveryRequests.current.clear(); };
  }, []);

  // Keep result identity separate from the busy lock: changing a configuration
  // invalidates its result but must not pretend its in-flight request has ended.
  const probeSignature = (provider: LlmProvider) => JSON.stringify([
    provider.apiType, provider.baseUrl, provider.apiKey, provider.selectedModel,
    provider.models, provider.enabled,
  ]);
  const invalidateProbe = (id: string) => {
    providerRevisions.current.set(id, (providerRevisions.current.get(id) || 0) + 1);
    setTestStatus(previous => ({ ...previous, [id]: 'idle' }));
    setTestMessages(previous => ({ ...previous, [id]: '' }));
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setNewProvider({ apiType: 'openai-compatible', enabled: true });
    setContextDrafts(previous => { const next = { ...previous }; delete next.new; return next; });
    setContextErrors(previous => { const next = { ...previous }; delete next.new; return next; });
    modelDiscoveryRequests.current.delete('new');
    setModelDiscovery(previous => { const next = { ...previous }; delete next.new; return next; });
    clearNewLlmProviderDraft();
    addingProvider.current = false;
    addButtonRef.current?.focus();
  };

  const handleAddProvider = () => {
    const draft = newProviderRef.current;
    if (addingProvider.current || !draft.name?.trim() || !draft.baseUrl?.trim()) return;
    const modelName = (draft.selectedModel ?? draft.models?.[0])?.trim();
    if (!modelName) return;
    // Enter submits a form while this input is still focused, so its blur
    // handler may never have committed the current text to the provider yet.
    const contextInput = readNewLlmProviderDraft().contextInput;
    const contextWindowTokens = contextInput === undefined ? draft.contextWindowTokens
      : contextInput.trim() ? Number(contextInput.trim()) : undefined;
    if (contextWindowTokens !== undefined && (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 4096 || contextWindowTokens > 2097152)) {
      setContextErrors(previous => ({ ...previous, new: '请输入 4,096–2,097,152 之间的整数，或留空。' }));
      return;
    }
    addingProvider.current = true;
    const provider: LlmProvider = { id: 'llm-' + Date.now(), name: draft.name.trim(), apiType: draft.apiType || 'openai-compatible', baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey || '', models: [modelName], selectedModel: modelName, contextWindowTokens, enabled: true, createdAt: new Date().toISOString() };
    onUpdate({ ...llmSettings, providers: [...llmSettings.providers, provider] });
    setShowAddForm(false);
    setNewProvider({ apiType: 'openai-compatible', enabled: true });
    setContextDrafts(previous => { const next = { ...previous }; delete next.new; return next; });
    setContextErrors(previous => { const next = { ...previous }; delete next.new; return next; });
    modelDiscoveryRequests.current.delete('new');
    setModelDiscovery(previous => { const next = { ...previous }; delete next.new; return next; });
    clearNewLlmProviderDraft();
  };

  const handleUpdateProvider = (id: string, updates: Partial<LlmProvider>) => {
    const settings = settingsRef.current;
    const previous = settings.providers.find(provider => provider.id === id);
    if (previous && probeSignature(previous) !== probeSignature({ ...previous, ...updates })) invalidateProbe(id);
    if (previous && (updates.apiType !== undefined && updates.apiType !== previous.apiType
      || updates.baseUrl !== undefined && updates.baseUrl !== previous.baseUrl
      || updates.apiKey !== undefined && updates.apiKey !== previous.apiKey)) {
      setModelDiscovery(current => ({ ...current, [id]: { pending: Boolean(current[id]?.pending) } }));
    }
    const next = { ...settings, providers: settings.providers.map(p => p.id === id ? { ...p, ...updates } : p) };
    settingsRef.current = next;
    providersRef.current = next.providers;
    onUpdate(next);
  };

  const contextWindowInput = (id: string, value: number | undefined, commit: (value: number | undefined) => void) => (
    <div>
      <label htmlFor={`llm-context-${id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">场景模型上下文窗口（tokens，可选）</label>
      <input id={`llm-context-${id}`} type="number" inputMode="numeric" min={4096} max={2097152} step={1}
        aria-describedby={`llm-context-help-${id}${contextErrors[id] ? ` llm-context-error-${id}` : ''}`}
        aria-invalid={Boolean(contextErrors[id])} placeholder="留空：本地估算预算 65,536"
        className="w-full min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]"
        value={contextDrafts[id] ?? (value === undefined ? '' : String(value))}
        onChange={event => {
          setContextDrafts(previous => ({ ...previous, [id]: event.target.value }));
          if (id === 'new') updateNewLlmProviderDraft({ contextInput: event.target.value });
          setContextErrors(previous => ({ ...previous, [id]: '' }));
        }}
        onBlur={event => {
          const raw = event.target.value.trim(), parsed = raw ? Number(raw) : undefined;
          if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 4096 || parsed > 2097152)) {
            setContextErrors(previous => ({ ...previous, [id]: '请输入 4,096–2,097,152 之间的整数，或留空。' }));
            return;
          }
          setContextErrors(previous => ({ ...previous, [id]: '' }));
          commit(parsed);
          setContextDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
          if (id === 'new') updateNewLlmProviderDraft({ contextInput: undefined });
        }} />
      <p id={`llm-context-help-${id}`} className="mt-1 text-[11px] leading-5 text-[var(--ln-text-secondary)]">按实际场景模型的窗口填写，输入和输出共同占用。留空值只是本地估算上限，并非自动探测；切换模型后请核对。仅用于场景请求预算。</p>
      {contextErrors[id] && <p id={`llm-context-error-${id}`} role="alert" className="text-[11px] text-[var(--ln-danger)]">{contextErrors[id]}</p>}
    </div>
  );

  useEffect(() => {
    if (deleteTargetId && !llmSettings.providers.some(provider => provider.id === deleteTargetId)) setDeleteTargetId(null);
  }, [deleteTargetId, llmSettings.providers]);

  const handleDeleteProvider = (id: string) => {
    invalidateProbe(id);
    const workflowBinding = { ...llmSettings.workflowBinding };
    for (const workflow of Object.keys(workflowBinding) as LlmWorkflowId[]) {
      if (workflowBinding[workflow] === id) delete workflowBinding[workflow];
    }
    const providers = llmSettings.providers.filter(p => p.id !== id);
    onUpdate({ ...llmSettings, providers, workflowBinding, defaultProviderId: llmSettings.defaultProviderId === id ? providers.find(p => p.enabled)?.id || '' : llmSettings.defaultProviderId });
    setDeleteTargetId(null);
  };

  const handleTestConnection = async (provider: LlmProvider) => {
    const current = providersRef.current.find(item => item.id === provider.id);
    if (!current) return;
    provider = current;
    if (!provider.enabled) {
      setTestStatus(previous => ({ ...previous, [provider.id]: 'error' }));
      setTestMessages(previous => ({ ...previous, [provider.id]: '供应商已停用，请先启用后测试模型。' }));
      return;
    }
    if (testingProviders.current.has(provider.id)) return;
    const model = (provider.selectedModel ?? provider.models?.[0] ?? '').trim();
    if (!model || !provider.baseUrl.trim()) {
      setTestStatus(previous => ({ ...previous, [provider.id]: 'error' }));
      setTestMessages(previous => ({ ...previous, [provider.id]: !model ? '请先填写要测试的模型名称。' : '请先填写服务地址。' }));
      return;
    }
    testingProviders.current.add(provider.id);
    const request = { revision: providerRevisions.current.get(provider.id) || 0, signature: probeSignature(provider) };
    probeRequests.current.set(provider.id, request);
    setProbePending(previous => ({ ...previous, [provider.id]: true }));
    setTestStatus(prev => ({ ...prev, [provider.id]: 'testing' }));
    setTestMessages(previous => ({ ...previous, [provider.id]: '' }));
    const resultStillCurrent = () => {
      const currentProvider = providersRef.current.find(item => item.id === provider.id);
      return mounted.current && probeRequests.current.get(provider.id) === request
        && (providerRevisions.current.get(provider.id) || 0) === request.revision
        && Boolean(currentProvider && probeSignature(currentProvider) === request.signature);
    };
    try {
      const api = (window as any).electronAPI?.llm;
      if (!api) {
        if (resultStillCurrent()) {
          setTestStatus(prev => ({ ...prev, [provider.id]: 'error' }));
          setTestMessages(previous => ({ ...previous, [provider.id]: '当前环境不支持模型测试，请在桌面版中重试。' }));
        }
        return;
      }
      if (hasUnsavedLlmSettings()) {
        await flushLlmSettingsWrites();
        if (!resultStillCurrent()) return;
      }
      const result = await api.probe({
        provider: {
          id: provider.id,
          apiType: provider.apiType,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          selectedModel: model,
          models: provider.models || [],
        },
        systemPrompt: 'Say OK',
        userInput: 'ping',
        temperature: 0,
        maxTokens: 10,
      }) as LlmProbeResponse | boolean;
      if (resultStillCurrent()) {
        const ok = typeof result === 'boolean' ? result : result.ok;
        setTestStatus(prev => ({ ...prev, [provider.id]: ok ? 'success' : 'error' }));
        setTestMessages(previous => ({ ...previous, [provider.id]: ok ? `模型测试成功：${model}`
          : typeof result === 'object' && result.error ? result.error : '模型测试失败，请检查模型名称、API Key 与服务地址后重试。' }));
      }
    } catch (error) {
      if (resultStillCurrent()) {
        setTestStatus(prev => ({ ...prev, [provider.id]: 'error' }));
        setTestMessages(previous => ({ ...previous, [provider.id]: error instanceof Error ? error.message : '模型测试失败，请重试。' }));
      }
    }
    finally {
      if (probeRequests.current.get(provider.id) === request) {
        if (mounted.current && !resultStillCurrent()) setTestStatus(previous => ({ ...previous, [provider.id]: 'idle' }));
        probeRequests.current.delete(provider.id);
        testingProviders.current.delete(provider.id);
        if (mounted.current) setProbePending(previous => ({ ...previous, [provider.id]: false }));
      }
    }
  };

  const handleBindWorkflow = (workflowId: LlmWorkflowId, providerId: string) => {
    onUpdate({ ...llmSettings, workflowBinding: { ...llmSettings.workflowBinding, [workflowId]: providerId } });
  };

  /** 绑定一组工作流：把组内所有 workflow 都指向同一个 provider */
  const handleBindGroup = (workflows: LlmWorkflowId[], providerId: string) => {
    const next = { ...llmSettings.workflowBinding };
    for (const wf of workflows) next[wf] = providerId;
    onUpdate({ ...llmSettings, workflowBinding: next });
  };

  const enabledProviders = llmSettings.providers.filter(p => p.enabled);
  const unavailableProviderOption = (boundId: string) => {
    if (!boundId || enabledProviders.some(provider => provider.id === boundId)) return null;
    const provider = llmSettings.providers.find(item => item.id === boundId);
    return <option value={boundId} disabled>{provider ? `${provider.name}（已停用）` : '原供应商已移除，请重新选择'}</option>;
  };

  const handleDiscoverModels = async (provider: Partial<LlmProvider>, key: string) => {
    if (key !== 'new') {
      const current = providersRef.current.find(item => item.id === key);
      if (!current?.enabled) return;
      provider = current;
    }
    if (!provider.baseUrl?.trim() || modelDiscovery[key]?.pending) return;
    const signature = JSON.stringify([provider.apiType, provider.baseUrl.trim(), provider.apiKey || '', provider.selectedModel, provider.enabled]);
    const request = { signature };
    modelDiscoveryRequests.current.set(key, request);
    setModelDiscovery(previous => ({ ...previous, [key]: { pending: true } }));
    const stillCurrent = () => {
      const current = key === 'new'
        ? newProviderRef.current
        : providersRef.current.find(item => item.id === key);
      return mounted.current && modelDiscoveryRequests.current.get(key) === request
        && Boolean(current && JSON.stringify([current.apiType, current.baseUrl?.trim(), current.apiKey || '', current.selectedModel, current.enabled]) === signature);
    };
    try {
      const api = (window as any).electronAPI?.llm;
      if (!api?.models) throw new Error('当前版本不支持自动获取模型列表');
      if (key !== 'new' && hasUnsavedLlmSettings()) {
        await flushLlmSettingsWrites();
        if (!stillCurrent()) return;
      }
      const result = await api.models({
        provider: {
          id: key === 'new' ? undefined : provider.id,
          apiType: provider.apiType || 'openai-compatible',
          baseUrl: provider.baseUrl.trim(),
          apiKey: provider.apiKey || '',
          selectedModel: provider.selectedModel || '',
          models: provider.models || [],
        },
        systemPrompt: '', userInput: '', temperature: 0, maxTokens: 1,
      }) as { ok: boolean; models: string[]; error?: string };
      if (!stillCurrent()) return;
      if (!result.ok || result.models.length === 0) throw new Error(result.error || '没有获取到可用模型');
      const selectedModel = result.models.includes(provider.selectedModel || '')
        ? provider.selectedModel
        : result.models[0];
      if (key === 'new') setNewProvider(previous => ({ ...previous, models: result.models, selectedModel }));
      else handleUpdateProvider(key, { models: result.models, selectedModel });
      setModelDiscovery(previous => ({ ...previous, [key]: { pending: false, count: result.models.length } }));
    } catch (error) {
      if (stillCurrent()) setModelDiscovery(previous => ({ ...previous, [key]: {
        pending: false, error: error instanceof Error ? error.message : '获取模型列表失败',
      } }));
    } finally {
      if (modelDiscoveryRequests.current.get(key) === request) {
        modelDiscoveryRequests.current.delete(key);
        // Credential edits invalidate a result, but this request still owns its
        // busy state until it settles. Do not leave its old spinner locked.
        if (mounted.current) setModelDiscovery(previous => previous[key]?.pending
          ? { ...previous, [key]: { pending: false } } : previous);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-[var(--ln-text-primary)] flex items-center gap-1.5"><Cpu className="w-4 h-4 text-[var(--ln-accent)]" />AI 模型配置</h3>
        <button type="button" ref={addButtonRef} aria-expanded={showAddForm} aria-controls="llm-add-provider" onClick={() => { addingProvider.current = false; setShowAddForm(true); }} className="min-h-11 px-2.5 py-1 rounded-lg bg-[var(--ln-accent)] text-[var(--ln-bg-surface)] text-xs font-semibold hover:bg-[var(--ln-accent-hover)] transition flex items-center gap-1"><Plus className="w-4 h-4" />添加供应商</button>
      </div>
      {showAddForm && (
        <form id="llm-add-provider" aria-label="添加模型供应商" onSubmit={event => { event.preventDefault(); handleAddProvider(); }} className="p-3 rounded-xl border-2 border-[var(--ln-border)] bg-[var(--ln-bg-subtle)] space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="llm-new-name" className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">名称</label>
              <input id="llm-new-name" required autoFocus type="text" className="w-full min-h-11 px-3 py-2 text-xs rounded-lg border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="DeepSeek" value={newProvider.name || ''} onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="llm-new-type" className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">类型</label>
              <select id="llm-new-type" className="w-full min-h-11 px-3 py-2 text-xs rounded-lg border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={newProvider.apiType} onChange={e => setNewProvider(prev => ({ ...prev, apiType: e.target.value as LlmApiType }))}>
                {Object.entries(API_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
              </select>
            </div>
            <div className="col-span-2">
              <label htmlFor="llm-new-url" className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">Base URL</label>
              <input id="llm-new-url" required type="text" className="w-full min-h-11 px-3 py-2 text-xs rounded-lg border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="https://api.deepseek.com" value={newProvider.baseUrl || ''} onChange={e => setNewProvider(prev => ({ ...prev, baseUrl: e.target.value }))} />
            </div>
            <div className="col-span-2">
              <label htmlFor="llm-new-model" className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">模型名称</label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input id="llm-new-model" list="llm-new-model-options" required type="text" className="flex-1 min-h-11 px-3 py-2 text-xs rounded-lg border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="可手动输入，或点击获取模型" value={newProvider.selectedModel || ''} onChange={e => setNewProvider(prev => ({ ...prev, selectedModel: e.target.value }))} />
                <datalist id="llm-new-model-options">{(newProvider.models || []).map(model => <option key={model} value={model} />)}</datalist>
                <button type="button" disabled={!newProvider.baseUrl?.trim() || modelDiscovery.new?.pending} onClick={() => void handleDiscoverModels(newProvider, 'new')} className="min-h-11 px-3 rounded-lg border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                  <RefreshCw className={`w-4 h-4 ${modelDiscovery.new?.pending ? 'animate-spin motion-reduce:animate-none' : ''}`} />{modelDiscovery.new?.pending ? '获取中…' : '获取模型'}
                </button>
              </div>
              {modelDiscovery.new?.error && <p role="alert" className="mt-1 text-[11px] text-[var(--ln-danger)]">{modelDiscovery.new.error}，仍可手动填写。</p>}
              {modelDiscovery.new?.count && <p role="status" className="mt-1 text-[11px] text-[var(--ln-accent)]">已获取 {modelDiscovery.new.count} 个模型，可输入筛选或从提示中选择。</p>}
            </div>
            <div className="col-span-2">
              {contextWindowInput('new', newProvider.contextWindowTokens, value => setNewProvider(previous => ({ ...previous, contextWindowTokens: value })))}
              <label htmlFor="llm-new-key" className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5 mt-2">API Key</label>
              <input id="llm-new-key" type="password" autoComplete="off" className="w-full min-h-11 px-3 py-2 text-xs rounded-lg border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="sk-..." value={newProvider.apiKey || ''} onChange={e => setNewProvider(prev => ({ ...prev, apiKey: e.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={resetAddForm} className="min-h-11 px-3 py-1 text-xs text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-surface)] rounded-lg">取消</button>
            <button type="submit" disabled={!newProvider.name?.trim() || !newProvider.baseUrl?.trim() || !newProvider.selectedModel?.trim()} className="min-h-11 px-3 py-1 text-xs font-semibold bg-[var(--ln-accent)] text-[var(--ln-bg-surface)] rounded-lg hover:bg-[var(--ln-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed">添加</button>
          </div>
        </form>
      )}
      <div className="space-y-2">
        {llmSettings.providers.map(provider => (
          <div key={provider.id} className="p-3 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex flex-wrap items-center gap-2">
                <button type="button" role="switch" aria-checked={provider.enabled} aria-label={`启用 ${provider.name}`} onClick={() => handleUpdateProvider(provider.id, { enabled: !provider.enabled })} className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"><span className={'w-9 h-5 rounded-full transition-colors motion-reduce:transition-none relative p-0.5 ' + (provider.enabled ? 'bg-[var(--ln-accent)]' : 'bg-[var(--ln-border)]')}><span className={'block w-4 h-4 rounded-full bg-[var(--ln-bg-surface)] transition-transform motion-reduce:transition-none ' + (provider.enabled ? 'translate-x-4' : 'translate-x-0')} /></span></button>
                <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-xs font-bold text-[var(--ln-text-primary)]">{provider.name}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--ln-bg-subtle)] text-[var(--ln-text-secondary)]">{API_TYPE_LABELS[provider.apiType]}</span>
                <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-xs text-[var(--ln-text-secondary)]">{(provider.selectedModel ?? provider.models?.[0]) || '待填写模型名称'}</span>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" aria-label={`测试 ${provider.name} 模型`} disabled={!provider.enabled || Boolean(probePending[provider.id]) || !(provider.selectedModel ?? provider.models?.[0])?.trim() || !provider.baseUrl.trim()} onClick={() => handleTestConnection(provider)} className="min-w-11 min-h-11 p-2 rounded hover:bg-[var(--ln-bg-subtle)] disabled:opacity-50" title={provider.enabled ? '测试模型：发送少量测试文字，会消耗少量 tokens' : '供应商已停用，请先启用'}>{probePending[provider.id] ? <Loader2 className="w-4 h-4 text-[var(--ln-accent)] animate-spin motion-reduce:animate-none" /> : testStatus[provider.id] === 'success' ? <Check className="w-4 h-4 text-[var(--ln-accent)]" /> : testStatus[provider.id] === 'error' ? <X className="w-4 h-4 text-[var(--ln-danger)]" /> : <Wifi className="w-4 h-4 text-[var(--ln-text-secondary)]" />}</button>
                <button type="button" aria-label={`编辑 ${provider.name} 配置`} aria-expanded={editingId === provider.id} aria-controls={`llm-edit-${provider.id}`} onClick={() => setEditingId(editingId === provider.id ? null : provider.id)} className="min-w-11 min-h-11 p-2 rounded hover:bg-[var(--ln-bg-subtle)]"><Settings className="w-4 h-4 text-[var(--ln-text-secondary)]" /></button>
                {provider.id !== 'deepseek-default' && (<button type="button" aria-label={`删除模型供应商 ${provider.name}`} onClick={() => setDeleteTargetId(provider.id)} className="min-w-11 min-h-11 p-2 rounded hover:bg-[var(--ln-bg-subtle)] text-[var(--ln-danger)]"><Trash2 className="w-4 h-4" /></button>)}
              </div>
            </div>
            {(probePending[provider.id] || (testStatus[provider.id] && testStatus[provider.id] !== 'idle')) && <p role="status" className={`text-xs ${testStatus[provider.id] === 'error' ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-text-secondary)]'}`}>{probePending[provider.id] ? testStatus[provider.id] === 'idle' ? '配置已更改，等待此前测试结束…' : '正在测试模型…' : testMessages[provider.id]}</p>}
            {editingId === provider.id && (
              <div id={`llm-edit-${provider.id}`} className="ml-7 space-y-2 pt-2 border-t border-[var(--ln-border-subtle)]">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label htmlFor={`llm-name-${provider.id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">供应商名称</label>
                    <input id={`llm-name-${provider.id}`} type="text" className="w-full min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={provider.name} onChange={event => handleUpdateProvider(provider.id, { name: event.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`llm-type-${provider.id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">接口类型</label>
                    <select id={`llm-type-${provider.id}`} className="w-full min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={provider.apiType} onChange={event => handleUpdateProvider(provider.id, { apiType: event.target.value as LlmApiType })}>
                      {Object.entries(API_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor={`llm-url-${provider.id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">Base URL</label>
                  <input id={`llm-url-${provider.id}`} type="text" className="w-full min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={provider.baseUrl} onChange={event => handleUpdateProvider(provider.id, { baseUrl: event.target.value })} />
                </div>
                <div>
                  <p className="text-[11px] leading-5 text-[var(--ln-text-secondary)]">测试模型会向当前填写的模型发送少量测试文字，并消耗少量 tokens。修改配置后需重新测试。</p>
                  <label htmlFor={`llm-model-${provider.id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5">模型名称</label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input id={`llm-model-${provider.id}`} list={`llm-model-options-${provider.id}`} type="text" className="flex-1 min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="可手动输入，或点击获取模型" value={provider.selectedModel ?? provider.models?.[0] ?? ''} onChange={e => handleUpdateProvider(provider.id, { selectedModel: e.target.value })} />
                    <datalist id={`llm-model-options-${provider.id}`}>{(provider.models || []).map(model => <option key={model} value={model} />)}</datalist>
                    <button type="button" disabled={!provider.enabled || !provider.baseUrl?.trim() || modelDiscovery[provider.id]?.pending} onClick={() => void handleDiscoverModels(provider, provider.id)} className="min-h-11 px-3 rounded border border-[var(--ln-border)] bg-[var(--ln-bg-subtle)] text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                      <RefreshCw className={`w-4 h-4 ${modelDiscovery[provider.id]?.pending ? 'animate-spin motion-reduce:animate-none' : ''}`} />{modelDiscovery[provider.id]?.pending ? '获取中…' : '获取模型'}
                    </button>
                  </div>
                  {modelDiscovery[provider.id]?.error && <p role="alert" className="mt-1 text-[11px] text-[var(--ln-danger)]">{modelDiscovery[provider.id].error}，仍可手动填写。</p>}
                  {modelDiscovery[provider.id]?.count && <p role="status" className="mt-1 text-[11px] text-[var(--ln-accent)]">已获取 {modelDiscovery[provider.id].count} 个模型。</p>}
                </div>
                <div>
                  {contextWindowInput(provider.id, provider.contextWindowTokens, value => handleUpdateProvider(provider.id, { contextWindowTokens: value }))}
                  <label htmlFor={`llm-key-${provider.id}`} className="text-xs font-semibold text-[var(--ln-text-secondary)] block mb-0.5 mt-2">API Key</label>
                  <input id={`llm-key-${provider.id}`} type="password" autoComplete="off" className="w-full min-h-11 px-3 py-2 text-xs rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-[var(--ln-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" placeholder="API Key" value={provider.apiKey} onChange={e => handleUpdateProvider(provider.id, { apiKey: e.target.value })} />
                </div>
                <div>
                  <label className="min-h-11 flex items-center gap-2 text-xs text-[var(--ln-text-primary)]">
                    <input type="checkbox" aria-describedby={`llm-vision-help-${provider.id}`}
                      disabled={!(provider.selectedModel ?? provider.models[0])?.trim()}
                      checked={(provider.visionModels || []).includes(provider.selectedModel ?? provider.models[0] ?? '')}
                      onChange={event => {
                        const model = provider.selectedModel ?? provider.models[0];
                        if (model) handleUpdateProvider(provider.id, { visionModels: event.target.checked
                          ? [...new Set([...(provider.visionModels || []), model])]
                          : (provider.visionModels || []).filter(item => item !== model) });
                      }} className="h-4 w-4 accent-[var(--ln-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" />
                    当前模型支持图片输入（教材公式／图示）
                  </label>
                  <p id={`llm-vision-help-${provider.id}`} className="text-[11px] leading-5 text-[var(--ln-text-secondary)]">仅对当前填写的模型名称启用，不是能力检测。教材生成确认后可附带已批准资料图片；不启用或接口明确不支持时保留原图，不猜写公式。图片输入会产生额外用量。</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="p-3 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] space-y-2">
        <h4 className="text-xs font-bold text-[var(--ln-text-secondary)]">工作流绑定</h4>
        <div className="space-y-1.5">
          {WORKFLOW_GROUPS.map(group => {
            const boundValues = group.workflows.map(workflow => llmSettings.workflowBinding[workflow] || '');
            const mixed = new Set(boundValues).size > 1;
            const boundValue = mixed ? '__mixed__' : boundValues[0];
            return (
              <div key={group.label} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[var(--ln-text-secondary)] font-medium">{group.label}</span>
                <select aria-label={`${group.label}的模型供应商`} className="min-h-11 max-w-full px-3 py-2 rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={boundValue} onChange={e => handleBindGroup(group.workflows, e.target.value)}>
                  <option value="">-- 选择 --</option>
                  {mixed && <option value="__mixed__" disabled>分项使用不同模型</option>}
                  {!mixed && unavailableProviderOption(boundValue)}
                  {enabledProviders.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
            );
          })}
          {WORKFLOW_BINDING_LIST.map(wf => (
            <div key={wf} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-[var(--ln-text-secondary)] font-medium">{WORKFLOW_LABELS[wf]}</span>
              <select aria-label={`${WORKFLOW_LABELS[wf]}的模型供应商`} className="min-h-11 max-w-full px-3 py-2 rounded border border-[var(--ln-border)] bg-[var(--ln-input-bg)] text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]" value={llmSettings.workflowBinding[wf] || ''} onChange={e => handleBindWorkflow(wf, e.target.value)}>
                <option value="">-- 选择 --</option>
                {unavailableProviderOption(llmSettings.workflowBinding[wf] || '')}
                {enabledProviders.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
              </select>
            </div>
          ))}
        </div>
      </div>
      {deleteTargetId && (() => {
        const target = llmSettings.providers.find(provider => provider.id === deleteTargetId);
        if (!target) return null;
        const boundCount = Object.values(llmSettings.workflowBinding).filter(id => id === deleteTargetId).length;
        return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={event => { if (event.target === event.currentTarget) setDeleteTargetId(null); }}>
          <div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="llm-delete-title"
            aria-describedby="llm-delete-description" tabIndex={-1}
            className="w-full max-w-sm rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-5 text-[var(--ln-text-primary)] shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--ln-danger)_12%,transparent)] text-[var(--ln-danger)]"><Trash2 className="h-5 w-5" aria-hidden="true" /></span>
              <div className="min-w-0">
                <h4 id="llm-delete-title" className="font-bold">删除“{target.name}”？</h4>
                <p id="llm-delete-description" className="mt-1 text-xs leading-5 text-[var(--ln-text-secondary)]">API Key 与模型配置会从本机移除。{boundCount > 0 ? `同时解除 ${boundCount} 项工作流绑定，之后需要重新选择供应商。` : '当前没有工作流绑定到它。'}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTargetId(null)} className="min-h-11 rounded-lg px-4 text-xs font-semibold text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-subtle)]">取消</button>
              <button type="button" onClick={() => handleDeleteProvider(deleteTargetId)} className="min-h-11 rounded-lg bg-[var(--ln-danger)] px-4 text-xs font-bold text-white hover:opacity-90">删除供应商</button>
            </div>
          </div>
        </div>;
      })()}
    </div>
  );
};
