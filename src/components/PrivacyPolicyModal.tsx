import React, { useRef, useId } from "react";
import { ShieldCheck, X, Lock, Database, Server } from "lucide-react";
import { useDialog } from './useDialog';

interface PrivacyPolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivacyPolicyModal: React.FC<PrivacyPolicyModalProps> = ({
  isOpen,
  onClose
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useDialog(isOpen, dialogRef, onClose);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} className="bg-[var(--ln-bg-surface)] text-[var(--ln-text-primary)] rounded-2xl shadow-2xl border border-[var(--ln-border)] w-full max-w-lg max-h-[90dvh] min-h-0 overflow-hidden flex flex-col" onClick={(event) => event.stopPropagation()}>
        {/* Header */}
        <div className="p-4 shrink-0 border-b border-[var(--ln-border)] flex items-center justify-between gap-3 bg-[var(--ln-bg-subtle)]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--ln-accent)]" aria-hidden="true" />
            <h2 id={headingId} className="text-sm font-bold text-[var(--ln-text-primary)]">
              隐私与本地数据
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭隐私说明"
            className="min-w-11 min-h-11 shrink-0 flex items-center justify-center rounded-lg text-[var(--ln-text-secondary)] hover:bg-[var(--ln-accent-soft)] focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div tabIndex={0} role="region" aria-label="隐私与本地数据说明正文" className="p-5 min-h-0 space-y-3.5 text-[13px] text-[var(--ln-text-secondary)] overflow-y-auto focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)] focus-visible:outline-offset-[-3px]">
          <div className="p-3 bg-[var(--ln-bg-subtle)] rounded-xl border border-[var(--ln-border-subtle)]">
            <h3 className="font-bold text-[var(--ln-text-primary)] mb-1 flex items-center gap-1.5">
              <Database className="w-4 h-4 text-[var(--ln-accent)]" aria-hidden="true" />
              数据保存在本机
            </h3>
            <p className="leading-relaxed">
              桌面版将笔记保存在本机 vault，学习记录、配置与审计信息保存在本机数据目录。浏览器版使用 IndexedDB 和 localStorage；清理浏览器数据可能移除这些内容。
            </p>
          </div>

          <div className="p-3 bg-[var(--ln-bg-subtle)] rounded-xl border border-[var(--ln-border-subtle)]">
            <h3 className="font-bold text-[var(--ln-text-primary)] mb-1 flex items-center gap-1.5">
              <Server className="w-4 h-4 text-[var(--ln-accent)]" aria-hidden="true" />
              使用 AI 时发送哪些内容
            </h3>
            <p className="leading-relaxed">
              使用 AI 功能时，当前输入和对话历史，以及按任务选取的相关笔记、学习记录或个人画像，可能发送到你配置的模型服务。网络传输方式取决于服务地址，请查看所用服务商的数据处理说明。
            </p>
          </div>

          <div className="p-3 bg-[var(--ln-bg-subtle)] rounded-xl border border-[var(--ln-border-subtle)]">
            <h3 className="font-bold text-[var(--ln-text-primary)] mb-1 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-[var(--ln-accent)]" aria-hidden="true" />
              配置、记录与备份
            </h3>
            <p className="leading-relaxed">
              API Key 随模型配置保存在本机。应用还会保存学习记录、必要审计信息和待确认任务的恢复记录。当前没有云端笔记同步；可在设置中管理本机数据目录或导出笔记，分享前请检查个人信息与密钥。
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 shrink-0 border-t border-[var(--ln-border)] bg-[var(--ln-bg-subtle)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-5 py-2 text-[13px] font-semibold rounded-xl bg-[var(--ln-accent)] text-white dark:text-[var(--ln-bg-surface)] shadow-sm hover:bg-[var(--ln-accent-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)] focus-visible:outline-offset-2 transition"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
};
