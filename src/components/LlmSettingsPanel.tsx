import React, { useState } from 'react';
import { LlmSettings, LlmProvider, LlmApiType, LlmWorkflowId } from '../types';
import { Cpu, Plus, Trash2, Check, X, Wifi, Loader2, Settings } from 'lucide-react';

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
  'plan-generation': '学习计划生成',
  'text-segmentation': '笔记逻辑解构',
  'auto-link': '自动关联匹配',
  'flow-analysis': '智能分析',
  'review-questioning': '复习提问与分析',
  'review-tutor': '苏格拉底式导师',
  'review-scoring': '对话统一评分',
  'review-bubble': '气泡问题生成',
  'question-answer': '问题卡片解答',
  'study-task-generation': '学习任务生成',
  'knowledge-discovery': '知识点识别',
  'knowledge-mastery-scoring': '知识点分层掌握度评分',
  'profile-evidence-layered': '画像·分层证据（概念/判断/推理）',
  'profile-style-cognitive': '画像·认知风格',
  'profile-concept-aliases': '画像·概念归并',
  'logic-check': '逻辑检查',
  'storm-multi-perspective': 'STORM·多视角扫描',
  'storm-contradiction': 'STORM·矛盾图谱',
  'storm-brief': 'STORM·综合简报',
  'storm-peer-review': 'STORM·同行评审',
  'storm-abstract': 'STORM·多视角摘要',
};

const WORKFLOW_BINDING_LIST: LlmWorkflowId[] = [
  'plan-generation', 'text-segmentation', 'auto-link', 'flow-analysis', 'review-questioning',
  'review-tutor', 'review-scoring', 'review-bubble', 'question-answer', 'study-task-generation',
];

export const LlmSettingsPanel: React.FC<LlmSettingsPanelProps> = ({ llmSettings, onUpdate }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProvider, setNewProvider] = useState<Partial<LlmProvider>>({ apiType: 'openai-compatible', enabled: true });
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({});

  const handleAddProvider = () => {
    if (!newProvider.name || !newProvider.baseUrl) return;
    const modelName = newProvider.selectedModel?.trim() || newProvider.models?.[0]?.trim();
    if (!modelName) return;
    const provider: LlmProvider = { id: 'llm-' + Date.now(), name: newProvider.name || '', apiType: newProvider.apiType || 'openai-compatible', baseUrl: newProvider.baseUrl || '', apiKey: newProvider.apiKey || '', models: [modelName], selectedModel: modelName, enabled: true, createdAt: new Date().toISOString() };
    onUpdate({ ...llmSettings, providers: [...llmSettings.providers, provider] });
    setShowAddForm(false);
    setNewProvider({ apiType: 'openai-compatible', enabled: true });
  };

  const handleUpdateProvider = (id: string, updates: Partial<LlmProvider>) => {
    onUpdate({ ...llmSettings, providers: llmSettings.providers.map(p => p.id === id ? { ...p, ...updates } : p) });
  };

  const handleDeleteProvider = (id: string) => {
    onUpdate({ ...llmSettings, providers: llmSettings.providers.filter(p => p.id !== id) });
  };

  const handleTestConnection = async (provider: LlmProvider) => {
    setTestStatus(prev => ({ ...prev, [provider.id]: 'testing' }));
    try {
      const api = (window as any).electronAPI?.llm;
      if (!api) {
        setTestStatus(prev => ({ ...prev, [provider.id]: 'error' }));
        setTimeout(() => setTestStatus(prev => ({ ...prev, [provider.id]: 'idle' })), 3000);
        return;
      }
      const model = provider.selectedModel || provider.models?.[0] || 'gemini-2.5-flash';
      const ok = await api.probe({
        provider: {
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
      });
      setTestStatus(prev => ({ ...prev, [provider.id]: ok ? 'success' : 'error' }));
    } catch { setTestStatus(prev => ({ ...prev, [provider.id]: 'error' })); }
    setTimeout(() => setTestStatus(prev => ({ ...prev, [provider.id]: 'idle' })), 3000);
  };

  const handleBindWorkflow = (workflowId: LlmWorkflowId, providerId: string) => {
    onUpdate({ ...llmSettings, workflowBinding: { ...llmSettings.workflowBinding, [workflowId]: providerId } });
  };

  const enabledProviders = llmSettings.providers.filter(p => p.enabled);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5"><Cpu className="w-4 h-4 text-indigo-500" />AI 模型配置</h3>
        <button onClick={() => setShowAddForm(true)} className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white text-[11px] font-semibold hover:bg-indigo-700 transition flex items-center gap-1"><Plus className="w-3 h-3" />添加供应商</button>
      </div>
      {showAddForm && (
        <div className="p-3 rounded-xl border-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">名称</label>
              <input type="text" className="w-full px-2 py-1 text-[11px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="DeepSeek" value={newProvider.name || ''} onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">类型</label>
              <select className="w-full px-2 py-1 text-[11px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" value={newProvider.apiType} onChange={e => setNewProvider(prev => ({ ...prev, apiType: e.target.value as LlmApiType }))}>
                {Object.entries(API_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">Base URL</label>
              <input type="text" className="w-full px-2 py-1 text-[11px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="https://api.deepseek.com" value={newProvider.baseUrl || ''} onChange={e => setNewProvider(prev => ({ ...prev, baseUrl: e.target.value }))} />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">模型名称</label>
              <input type="text" className="w-full px-2 py-1 text-[11px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="deepseek-v4-flash" value={newProvider.selectedModel || ''} onChange={e => setNewProvider(prev => ({ ...prev, selectedModel: e.target.value }))} />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">API Key</label>
              <input type="password" className="w-full px-2 py-1 text-[11px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="sk-..." value={newProvider.apiKey || ''} onChange={e => setNewProvider(prev => ({ ...prev, apiKey: e.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setShowAddForm(false)} className="px-3 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">取消</button>
            <button onClick={handleAddProvider} className="px-3 py-1 text-[11px] font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">添加</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {llmSettings.providers.map(provider => (
          <div key={provider.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/40 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button onClick={() => handleUpdateProvider(provider.id, { enabled: !provider.enabled })} className={'w-9 h-5 rounded-full transition-colors relative p-0.5 ' + (provider.enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')}><div className={'w-4 h-4 rounded-full bg-white transition-transform ' + (provider.enabled ? 'translate-x-4' : 'translate-x-0')} /></button>
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200">{provider.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">{API_TYPE_LABELS[provider.apiType]}</span>
                <span className="text-[10px] text-slate-400">{provider.selectedModel || provider.models?.[0]}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => handleTestConnection(provider)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700" title="测试连接">{testStatus[provider.id] === 'testing' ? <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" /> : testStatus[provider.id] === 'success' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : testStatus[provider.id] === 'error' ? <X className="w-3.5 h-3.5 text-red-500" /> : <Wifi className="w-3.5 h-3.5 text-slate-400" />}</button>
                <button onClick={() => setEditingId(editingId === provider.id ? null : provider.id)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700"><Settings className="w-3.5 h-3.5 text-slate-400" /></button>
                {provider.id !== 'deepseek-default' && (<button onClick={() => handleDeleteProvider(provider.id)} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>)}
              </div>
            </div>
            {editingId === provider.id && (
              <div className="ml-7 space-y-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                <div>
                  <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">模型名称</label>
                  <input type="text" className="w-full px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="deepseek-v4-flash" value={provider.selectedModel || provider.models?.[0] || ''} onChange={e => handleUpdateProvider(provider.id, { selectedModel: e.target.value, models: [e.target.value] })} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-500 block mb-0.5">API Key</label>
                  <input type="password" className="w-full px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none" placeholder="API Key" value={provider.apiKey} onChange={e => handleUpdateProvider(provider.id, { apiKey: e.target.value })} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/40 space-y-2">
        <h4 className="text-[11px] font-bold text-slate-700 dark:text-slate-300">工作流绑定</h4>
        <div className="space-y-1.5">
          {WORKFLOW_BINDING_LIST.map(wf => (
            <div key={wf} className="flex items-center justify-between text-[11px]">
              <span className="text-slate-600 dark:text-slate-400 font-medium">{WORKFLOW_LABELS[wf]}</span>
              <select className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-xs outline-none" value={llmSettings.workflowBinding[wf] || ''} onChange={e => handleBindWorkflow(wf, e.target.value)}>
                <option value="">-- 选择 --</option>
                {enabledProviders.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};