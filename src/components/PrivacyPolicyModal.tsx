import React from "react";
import { ShieldCheck, X, Lock, CheckCircle, Database, Server } from "lucide-react";

interface PrivacyPolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivacyPolicyModal: React.FC<PrivacyPolicyModalProps> = ({
  isOpen,
  onClose
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between bg-emerald-50/50 dark:bg-emerald-950/30">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              数据隐私保护与合规协议 (Privacy Protocol)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-3.5 text-xs text-slate-600 dark:text-slate-300 overflow-y-auto max-h-[70vh]">
          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700">
            <h3 className="font-bold text-slate-900 dark:text-slate-100 mb-1 flex items-center gap-1.5">
              <Database className="w-4 h-4 text-emerald-500" />
              1. 本地优先存储 (Client-First Local Vault)
            </h3>
            <p className="leading-relaxed">
              您的全部学习笔记、双向链接逻辑与时序任务默认存放在浏览器的 IndexedDB 独占离线数据库中，无需依赖外部数据通道即可完整工作。
            </p>
          </div>

          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700">
            <h3 className="font-bold text-slate-900 dark:text-slate-100 mb-1 flex items-center gap-1.5">
              <Server className="w-4 h-4 text-blue-500" />
              2. 安全云端同步与网络数据传输协议
            </h3>
            <p className="leading-relaxed">
              云端同步传输遵循标准 RESTful/HTTPS/TLS 协议。除非用户主动在系统设置中开启动态同步，系统绝不会自动上报您的私有 Markdown 笔记。
            </p>
          </div>

          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700">
            <h3 className="font-bold text-slate-900 dark:text-slate-100 mb-1 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-purple-500" />
              3. AI 逻辑分词隐私约束
            </h3>
            <p className="leading-relaxed">
              使用具有逻辑辨识功能的 AI 智能长文本分词服务时，仅在您手动触发“AI 逻辑分词”或“划词建链”按钮时将选中段落通过服务端代理传输，处理完成后不保留临时会话日志。
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 transition"
          >
            知晓并同意协议
          </button>
        </div>
      </div>
    </div>
  );
};
