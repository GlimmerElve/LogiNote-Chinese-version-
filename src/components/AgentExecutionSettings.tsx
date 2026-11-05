import React, { useEffect, useId, useState } from 'react';
import type { VaultSettings } from '../types';
import { ABSOLUTE_MAX_AGENT_TOOL_CALLS, MIN_AGENT_TOOL_CALLS, normalizeAgentExecutionMode,
  normalizeAgentToolCallLimit, resolveAgentExecutionPolicy } from '../services/agent/executionPolicy';
import './AgentExecutionSettings.css';

const presets = [
  { mode: 'economy', label: '经济', calls: 6 },
  { mode: 'standard', label: '标准', calls: 12 },
  { mode: 'deep', label: '深度', calls: 24 },
] as const;

export function AgentExecutionSettings({ settings, onUpdate, disabled = false }: {
  settings: VaultSettings; onUpdate: (patch: Partial<VaultSettings>) => void; disabled?: boolean;
}) {
  const id = useId();
  const mode = normalizeAgentExecutionMode(settings.agentExecutionMode);
  const saved = normalizeAgentToolCallLimit(settings.agentToolCallLimit);
  const effective = resolveAgentExecutionPolicy(mode, undefined, saved).maxToolCalls;
  const [draft, setDraft] = useState(effective);
  useEffect(() => { setDraft(effective); }, [effective, mode, saved]);
  const custom = draft !== resolveAgentExecutionPolicy(mode).maxToolCalls;
  const commit = (value: number) => {
    const limit = normalizeAgentToolCallLimit(value);
    if (!disabled && limit !== undefined && limit !== saved) onUpdate({ agentToolCallLimit: limit });
  };
  const progress = (draft - MIN_AGENT_TOOL_CALLS) / (ABSOLUTE_MAX_AGENT_TOOL_CALLS - MIN_AGENT_TOOL_CALLS) * 100;
  return <div className="agent-budget">
    <div className="agent-budget-presets" role="group" aria-label="执行预算预设">
      {presets.map(preset => <button key={preset.mode} type="button" disabled={disabled}
        aria-pressed={!custom && mode === preset.mode} onClick={() => {
          if (disabled) return;
          setDraft(preset.calls); onUpdate({ agentExecutionMode: preset.mode, agentToolCallLimit: preset.calls });
        }}>
        <span>{preset.label}</span><span className="agent-budget-preset-count">{preset.calls} 次</span>
      </button>)}
    </div>
    <div className="agent-budget-label-row">
      <label htmlFor={id}>工具调用预算{custom && <span className="agent-budget-custom">自定义</span>}</label>
      <output htmlFor={id} className="agent-budget-value"><strong>{draft}</strong><span>次 / 请求</span></output>
    </div>
    <input id={id} type="range" className="agent-budget-slider" min={MIN_AGENT_TOOL_CALLS}
      max={ABSOLUTE_MAX_AGENT_TOOL_CALLS} step={1} value={draft} disabled={disabled}
      aria-valuetext={`${draft} 次工具调用`} aria-describedby={`${id}-hint`}
      style={{ '--agent-budget-progress': `${progress}%` } as React.CSSProperties}
      onChange={event => setDraft(Number(event.target.value))}
      onPointerUp={event => commit(Number(event.currentTarget.value))}
      onPointerCancel={event => commit(Number(event.currentTarget.value))}
      onBlur={event => commit(Number(event.currentTarget.value))}
      onKeyUp={event => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
          commit(Number(event.currentTarget.value));
      }} />
    <div className="agent-budget-scale" aria-hidden="true"><span>{MIN_AGENT_TOOL_CALLS} 次</span><span>{ABSOLUTE_MAX_AGENT_TOOL_CALLS} 次</span></div>
    <p id={`${id}-hint`} className="agent-budget-hint">仅对新请求生效，不改变写入权限。{draft > 24 && '较高预算可能增加等待与模型用量。'}</p>
  </div>;
}
