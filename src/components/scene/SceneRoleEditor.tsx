/**
 * 单角色编辑器：编辑 NPC 名称与模块化属性字段（可增删、可开关）。
 *
 * 设计说明：
 * - 关闭（enabled=false）的字段不参与 prompt 拼装，但保留在数据中便于再次开启。
 * - 「添加字段」提供 ROLE_ATTRIBUTE_PRESETS 预设下拉，也允许自定义字段名。
 * - 每个字段以卡片呈现，内容栏按字段名给出引导文案（降低「不知道填什么」的空白焦虑）。
 * - 模板能力内聚在此组件：自身读写 roleTemplateStore，对外 props 契约保持不变。
 *   载入模板会整体替换当前角色，覆盖前二次确认。
 */

import React, { useState } from 'react';
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  FolderDown,
  BookmarkPlus,
  Check,
  X,
} from 'lucide-react';
import { RoleSpec, RoleAttribute, RoleTemplate, ROLE_ATTRIBUTE_PRESETS } from '../../types';
import { RoleTemplatePicker } from './RoleTemplatePicker';
import { saveRoleTemplate, bumpRoleUseCount } from '../../services/scene/roleTemplateStore';

interface SceneRoleEditorProps {
  role: RoleSpec;
  onChange: (role: RoleSpec) => void;
  /**
   * 编辑器形态（可选，缺省 'npc' → S1 行为完全不变）：
   * - `'npc'`：对话对手，预设字段为身份 / 性格特点 / 初始立场等
   * - `'assistant'`：S4 推导助理，预设字段为语气 / 性格 / 知识水平等，
   *   并在顶部展示**不可编辑的功能约束**（只给下一步、不推翻引擎判定、不给完整参考解）
   */
  variant?: 'npc' | 'assistant';
}

/** S4 助理的固定功能约束（不可编辑，由系统提示词强制） */
const ASSISTANT_FIXED_CONSTRAINTS: string[] = [
  '只给当前步骤或下一步骤的解法，不给最终答案',
  '不得推翻计算引擎的等价性结论，只做解释与建议',
  '不直接给出完整参考解步骤表',
];

/** S4 助理的可调字段预设（与 SCENE_COMPUTE_GENERATE_PROMPT 的 role 输出一致） */
const ASSISTANT_ATTRIBUTE_PRESETS: string[] = [
  '语气',
  '性格',
  '知识水平',
  '讲解详略',
  '语言风格',
];

/** 生成属性字段 id */
function nextAttrId(): string {
  return `attr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 常见字段的内容引导：告诉用户这一栏该写什么，而不是只有一句「字段内容」 */
const VALUE_HINTS: Record<string, string> = {
  身份: '他是谁？如：带过三个项目、刚被空降来的技术负责人',
  性格特点: '如：急躁但讲道理，吃软不吃硬，讨厌被套话',
  说话风格: '如：短句为主，爱用反问，偶尔夹一句自嘲',
  初始立场: '他起初怎么看这件事？如：认定方案不可行',
  隐藏目标: '他不会说出口的诉求，如：想借此拿到更多预算',
  背景故事: '塑造他当前观点的关键经历',
  知识水平: '他对该领域的掌握程度，如：懂业务但不懂技术细节',
  情绪状态: '他此刻的心情，如：被上级催得很紧，容易发火',
  目的: '他想在这次对话中达成什么',
  表达风格: '他爱怎么说，如：先给结论再讲理由',
  // S4 助理专用
  语气: '如：平和鼓励为主，指出问题时不打击信心',
  性格: '如：耐心严谨，重视推导过程的合理性',
  讲解详略: '如：先给关键思路，再补充必要推导细节',
  语言风格: '如：简洁清晰，公式与文字结合说明',
};

/** 取字段内容栏的引导文案；未知字段名给通用提示 */
function valueHint(key: string): string {
  return VALUE_HINTS[key] || `「${key}」的具体描述（越具体，角色越稳定）`;
}

export const SceneRoleEditor: React.FC<SceneRoleEditorProps> = ({ role, onChange, variant = 'npc' }) => {
  const isAssistant = variant === 'assistant';
  /** 预设字段按形态切换；自定义字段入口两种形态都保留 */
  const presets = isAssistant ? ASSISTANT_ATTRIBUTE_PRESETS : ROLE_ATTRIBUTE_PRESETS;
  const [expanded, setExpanded] = useState(true);
  const [customKey, setCustomKey] = useState('');
  /** 模板弹层开关 */
  const [showPicker, setShowPicker] = useState(false);
  /** 待确认载入的模板（覆盖前二次确认） */
  const [pendingTemplate, setPendingTemplate] = useState<RoleTemplate | null>(null);
  /** 「存为模板」的命名输入（null = 未展开） */
  const [savingName, setSavingName] = useState<string | null>(null);

  const enabledCount = role.attributes.filter((a) => a.enabled).length;
  /** 当前角色是否已有内容（决定载入模板时是否需要确认） */
  const hasContent = role.name.trim().length > 0 || role.attributes.length > 0;

  const updateAttr = (id: string, patch: Partial<RoleAttribute>) => {
    onChange({
      ...role,
      attributes: role.attributes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  };

  const removeAttr = (id: string) => {
    onChange({ ...role, attributes: role.attributes.filter((a) => a.id !== id) });
  };

  const addAttr = (key: string) => {
    const name = key.trim();
    if (!name) return;
    // 同名不重复添加，避免 prompt 中出现重复字段
    if (role.attributes.some((a) => a.key === name)) return;
    onChange({
      ...role,
      attributes: [...role.attributes, { id: nextAttrId(), key: name, value: '', enabled: true }],
    });
    setCustomKey('');
  };

  /** 真正执行模板替换（整体替换角色名与全部字段） */
  const applyTemplate = (template: RoleTemplate) => {
    onChange({
      id: role.id,
      name: template.name,
      attributes: template.attributes.map((a) => ({ ...a })),
    });
    void bumpRoleUseCount(template.id);
    setPendingTemplate(null);
    setShowPicker(false);
  };

  const handlePick = (template: RoleTemplate) => {
    if (hasContent) {
      setPendingTemplate(template);
      setShowPicker(false);
      return;
    }
    applyTemplate(template);
  };

  const handleSaveTemplate = async () => {
    const name = (savingName || '').trim();
    if (!name) return;
    await saveRoleTemplate({ name, attributes: role.attributes });
    setSavingName(null);
  };

  return (
    <div className="scene-role-editor">
      <button className="scene-section-toggle" onClick={() => setExpanded(!expanded)} type="button">
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span>{isAssistant ? '助理设定' : '角色设定'}</span>
        <span className="text-[10px] font-normal text-slate-400">
          {enabledCount}/{role.attributes.length} 个字段启用
        </span>
      </button>

      {expanded && (
        <div className="scene-role-body">
          {/*
            助理固定约束（只读展示）。
            这是「功能底线」，由系统提示词强制，用户不可编辑；
            下方可调字段只影响表达风格，冲突时以本节为准
            （运行时体现在 buildAssistantSection 的声明中）。
          */}
          {isAssistant && (
            <div className="scene-assistant-constraints">
              <span className="scene-assistant-constraints-title">功能约束（不可修改）</span>
              <ul className="scene-assistant-constraints-list">
                {ASSISTANT_FIXED_CONSTRAINTS.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 模板入口：从模板载入 / 存为模板 */}
          <div className="scene-role-toolbar">
            <button
              type="button"
              className="scene-btn scene-btn--ghost scene-btn--tiny"
              onClick={() => {
                setShowPicker((v) => !v);
                setPendingTemplate(null);
              }}
            >
              <FolderDown className="w-3 h-3" />
              从模板载入
            </button>
            <button
              type="button"
              className="scene-btn scene-btn--ghost scene-btn--tiny"
              onClick={() => setSavingName(role.name || '')}
              disabled={role.attributes.length === 0}
              title={role.attributes.length === 0 ? '先添加至少一个字段' : '把当前角色存为可复用模板'}
            >
              <BookmarkPlus className="w-3 h-3" />
              存为模板
            </button>
          </div>

          {/* 存为模板：命名输入 */}
          {savingName !== null && (
            <div className="scene-template-save">
              <input
                className="scene-input"
                value={savingName}
                placeholder="模板名，如「严厉的导师」"
                autoFocus
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSaveTemplate();
                  }
                  if (e.key === 'Escape') setSavingName(null);
                }}
              />
              <button
                type="button"
                className="scene-btn scene-btn--primary scene-btn--tiny"
                onClick={() => void handleSaveTemplate()}
                disabled={!savingName.trim()}
              >
                <Check className="w-3 h-3" />
                保存
              </button>
              <button
                type="button"
                className="scene-btn scene-btn--ghost scene-btn--tiny"
                onClick={() => setSavingName(null)}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 模板列表弹层 */}
          {showPicker && (
            <RoleTemplatePicker onPick={handlePick} onClose={() => setShowPicker(false)} />
          )}

          {/* 载入模板的二次确认（整体替换，不可撤销） */}
          {pendingTemplate && (
            <div className="scene-template-confirm-bar">
              <span className="scene-template-confirm-text">
                载入「{pendingTemplate.name}」将
                <strong>整体替换</strong>
                当前角色的 {role.attributes.length} 个字段，此操作不可撤销。
              </span>
              <div className="scene-template-confirm-actions">
                <button
                  type="button"
                  className="scene-btn scene-btn--danger scene-btn--tiny"
                  onClick={() => applyTemplate(pendingTemplate)}
                >
                  确认替换
                </button>
                <button
                  type="button"
                  className="scene-btn scene-btn--ghost scene-btn--tiny"
                  onClick={() => setPendingTemplate(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="scene-field-row">
            <label className="scene-field-label">{isAssistant ? '助理名称' : '角色名称'}</label>
            <input
              className="scene-input"
              value={role.name}
              placeholder={isAssistant ? '如：推导助理' : 'NPC 的姓名或称谓'}
              onChange={(e) => onChange({ ...role, name: e.target.value })}
            />
          </div>

          <div className="scene-attr-cards">
            {role.attributes.map((attr) => (
              <div key={attr.id} className={`scene-attr-card ${attr.enabled ? '' : 'is-off'}`}>
                <div className="scene-attr-head">
                  {/* 开关：关闭后该字段不参与 prompt 拼装 */}
                  <button
                    type="button"
                    className={`scene-attr-switch ${attr.enabled ? 'is-on' : ''}`}
                    onClick={() => updateAttr(attr.id, { enabled: !attr.enabled })}
                    title={attr.enabled ? '点击停用该字段' : '点击启用该字段'}
                  >
                    <span className="scene-attr-switch-dot" />
                  </button>
                  <input
                    className="scene-attr-key"
                    value={attr.key}
                    placeholder="字段名"
                    onChange={(e) => updateAttr(attr.id, { key: e.target.value })}
                  />
                  <button
                    type="button"
                    className="scene-icon-btn"
                    onClick={() => removeAttr(attr.id)}
                    title="删除该字段"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <textarea
                  className="scene-textarea scene-attr-value"
                  value={attr.value}
                  rows={2}
                  placeholder={valueHint(attr.key)}
                  onChange={(e) => updateAttr(attr.id, { value: e.target.value })}
                />
              </div>
            ))}

            {role.attributes.length === 0 && (
              <p className="text-xs text-slate-400 py-2">
                {isAssistant ? '尚未设定助理字段，可从下方添加' : '尚未设定角色字段，可从下方添加'}
              </p>
            )}
          </div>

          <div className="scene-attr-add">
            <span className="text-[11px] text-slate-500">
              {isAssistant ? '调整助理风格（也可自定义补充字段）：' : '添加字段：'}
            </span>
            <div className="scene-preset-chips">
              {presets.filter((p) => !role.attributes.some((a) => a.key === p)).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="scene-chip"
                  onClick={() => addAttr(preset)}
                >
                  <Plus className="w-3 h-3" />
                  {preset}
                </button>
              ))}
            </div>
            <div className="scene-attr-custom">
              <input
                className="scene-input"
                value={customKey}
                placeholder="自定义字段名"
                onChange={(e) => setCustomKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addAttr(customKey);
                  }
                }}
              />
              <button
                type="button"
                className="scene-btn scene-btn--ghost"
                onClick={() => addAttr(customKey)}
                disabled={!customKey.trim()}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};