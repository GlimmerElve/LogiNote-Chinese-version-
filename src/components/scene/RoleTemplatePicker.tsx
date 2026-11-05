/**
 * 角色模板下拉弹层：列出全局共享的角色模板，支持选用与删除。
 *
 * 职责边界：
 * - 只负责「展示列表 / 选择 / 删除（含二次确认）」
 * - 「整体替换当前角色」的二次确认由调用方（SceneRoleEditor）负责，因为只有它知道当前角色是否有内容需保护
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, UserSquare2, Loader2 } from 'lucide-react';
import { RoleTemplate } from '../../types';
import { loadRoleTemplates, deleteRoleTemplate } from '../../services/scene/roleTemplateStore';

interface RoleTemplatePickerProps {
  /** 选中某个模板（调用方负责二次确认与替换） */
  onPick: (template: RoleTemplate) => void;
  /** 关闭弹层 */
  onClose: () => void;
}

export const RoleTemplatePicker: React.FC<RoleTemplatePickerProps> = ({ onPick, onClose }) => {
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** 拉取模板列表（按 useCount 降序） */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await loadRoleTemplates());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 点击外部关闭（不阻断列表内交互） */
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const handleDelete = async (id: string) => {
    await deleteRoleTemplate(id);
    setConfirmDeleteId(null);
    await refresh();
  };

  return (
    <div className="scene-template-picker" ref={rootRef}>
      <div className="scene-template-picker-head">
        <span>角色模板库</span>
        <span className="text-[10px] font-normal text-slate-400">{templates.length} 个</span>
      </div>

      <div className="scene-template-picker-body">
        {loading && (
          <div className="scene-template-empty">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>读取中…</span>
          </div>
        )}

        {!loading && templates.length === 0 && (
          <div className="scene-template-empty">
            <UserSquare2 className="w-3.5 h-3.5" />
            <span>还没有模板，先编辑好角色再点「存为模板」</span>
          </div>
        )}

        {!loading &&
          templates.map((t) => {
            const attrCount = t.attributes.filter((a) => a.enabled).length;
            const isConfirming = confirmDeleteId === t.id;
            return (
              <div key={t.id} className="scene-template-item">
                <button
                  type="button"
                  className="scene-template-item-main"
                  onClick={() => onPick(t)}
                  title="载入该模板（将整体替换当前角色）"
                >
                  <span className="scene-template-name">{t.name}</span>
                  <span className="scene-template-meta">
                    {attrCount} 个字段
                    {t.useCount > 0 && ` · 用过 ${t.useCount} 次`}
                  </span>
                </button>

                {isConfirming ? (
                  <div className="scene-template-confirm">
                    <button
                      type="button"
                      className="scene-btn scene-btn--danger scene-btn--tiny"
                      onClick={() => void handleDelete(t.id)}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="scene-btn scene-btn--ghost scene-btn--tiny"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="scene-icon-btn"
                    title="删除该模板"
                    onClick={() => setConfirmDeleteId(t.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};