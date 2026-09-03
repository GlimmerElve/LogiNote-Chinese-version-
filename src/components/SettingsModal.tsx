import React, { useState, useEffect } from "react";
import { VaultSettings, SyncStatus, NoteItem, LlmSettings } from "../types";
import { LlmSettingsPanel } from "./LlmSettingsPanel";
import { loadLlmSettings, saveLlmSettings } from "../services/llmStorage";
import {
  Settings,
  Palette,
  Database,
  Download,
  ShieldCheck,
  RefreshCw,
  Folder,
  HardDrive,
  AlertTriangle,
  Trash2,
} from "lucide-react";

interface SettingsModalProps {
  settings: VaultSettings;
  onUpdateSettings: (s: Partial<VaultSettings>) => void;
  syncStatus: SyncStatus;
  onTriggerSync: () => void;
  notes: NoteItem[];
}

type UpdaterStatusState = {
  state: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onUpdateSettings,
  syncStatus,
  onTriggerSync,
  notes
}) => {
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(loadLlmSettings());
  useEffect(() => { saveLlmSettings(llmSettings); }, [llmSettings]);

  const [storageRoot, setStorageRoot] = useState<string>("");
  const [storageIsCustom, setStorageIsCustom] = useState<boolean>(false);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);

  const [appVersion, setAppVersion] = useState<string>("");
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatusState>({ state: 'idle' });

  const loadStorageRoot = async () => {
    try {
      const api = (window as any).electronAPI?.storage;
      if (api?.getRoot) {
        const info = await api.getRoot();
        setStorageRoot(info.root);
        setStorageIsCustom(!!info.custom);
      }
    } catch { /* ignore */ }
  };
  useEffect(() => { loadStorageRoot(); }, []);

  // 软件更新：获取当前版本 + 订阅状态推送
  useEffect(() => {
    const updater = (window as any).electronAPI?.updater;
    if (!updater) return;
    updater.getVersion().then((v: string) => setAppVersion(v)).catch(() => {});
    const unsubscribe = updater.onStatus((payload: any) => {
      if (payload && payload.state) setUpdaterStatus(payload as UpdaterStatusState);
    });
    return unsubscribe;
  }, []);

  const handleChooseStorageFolder = async () => {
    try {
      const api = (window as any).electronAPI?.storage;
      if (!api?.chooseFolder || !api?.setRoot) {
        setStorageMsg("仅桌面版支持自定义存储路径");
        return;
      }
      const folder = await api.chooseFolder();
      if (!folder) return;
      setStorageBusy(true);
      setStorageMsg(null);
      const migrate = window.confirm("是否把当前已有的笔记与个人数据迁移到新文件夹？\n\n确定=迁移旧数据；取消=从新文件夹重新开始");
      const res = await api.setRoot(folder, migrate);
      if (res.ok) {
        setStorageMsg("存储路径已更新，重启应用后生效");
        await loadStorageRoot();
      } else {
        setStorageMsg(res.error || "设置失败");
      }
    } catch (e: any) {
      setStorageMsg(e?.message || "设置失败");
    } finally {
      setStorageBusy(false);
    }
  };

  const handleCheckUpdate = async () => {
    const updater = (window as any).electronAPI?.updater;
    if (!updater) return;
    setUpdaterStatus({ state: 'checking' });
    const r = await updater.check();
    if (!r.ok) setUpdaterStatus({ state: 'error', message: r.message });
  };

  const handleDownloadUpdate = async () => {
    const updater = (window as any).electronAPI?.updater;
    if (!updater) return;
    const r = await updater.download();
    if (!r.ok) setUpdaterStatus({ state: 'error', message: r.message });
  };

  const handleQuitAndInstall = () => {
    (window as any).electronAPI?.updater?.quitAndInstall();
  };

  const colors: Array<{ id: VaultSettings["accentColor"]; name: string; bg: string }> = [
    { id: "indigo", name: "经典靛蓝", bg: "bg-indigo-600" },
    { id: "purple", name: "梦幻紫", bg: "bg-purple-600" },
    { id: "emerald", name: "薄荷绿", bg: "bg-emerald-600" },
    { id: "coral", name: "珊瑚橙", bg: "bg-[#FF8C69]" },
    { id: "rose", name: "玫瑰粉", bg: "bg-[#FB7185]" },
    { id: "amber", name: "日落金", bg: "bg-amber-600" },
    { id: "teal", name: "青蓝绿", bg: "bg-[#14B8A6]" },
    { id: "slate", name: "极简灰", bg: "bg-slate-800" }
  ];

  const handleResetData = async () => {
    try {
      const api = (window as any).electronAPI?.storage;
      if (!api?.reset) {
        setStorageMsg("仅桌面版支持清空数据");
        return;
      }
      const confirmed = window.confirm(
        "确定要清空所有数据吗？\n\n这会删除你的全部笔记、个人数据、复习记录和缓存，恢复到首次使用的初始状态。\n\n此操作不可撤销，建议先导出备份！"
      );
      if (!confirmed) return;
      setStorageBusy(true);
      setStorageMsg(null);
      const res = await api.reset();
      if (res.ok) {
        setStorageMsg("数据已清空，重启应用后将恢复初始化状态");
      } else {
        setStorageMsg(res.error || "清空失败");
      }
    } catch (e: any) {
      setStorageMsg(e?.message || "清空失败");
    } finally {
      setStorageBusy(false);
    }
  };

  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(notes, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `LogiNote_Vault_Backup_${new Date().toISOString().split("T")[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const updaterStatusText = (() => {
    switch (updaterStatus.state) {
      case 'checking': return '正在检查更新…';
      case 'available': return `发现新版本 ${updaterStatus.version || ''}`;
      case 'up-to-date': return '已是最新版本';
      case 'downloading': return `正在下载 ${Math.round(updaterStatus.percent || 0)}%`;
      case 'downloaded': return '更新已下载，点击「重启安装」生效';
      case 'error': return updaterStatus.message || '更新出错';
      default: return appVersion ? `当前版本 v${appVersion}` : '';
    }
  })();

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] p-6 bg-slate-50 dark:bg-slate-950 overflow-y-auto max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Settings className="w-5 h-5 text-blue-600" />
          系统外观与数据配置
        </h1>
        <p className="text-xs text-slate-500 mt-0.5">
          自定义 iOS 主题风格、数据存储路径与本地备份
        </p>
      </div>

      {/* iOS Accent Color System */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <Palette className="w-4 h-4 text-purple-500" />
          <span>iOS 外观与色彩系统</span>
        </h3>
        <p className="text-xs text-slate-500">选择应用的高亮主题色彩</p>
        <div className="flex flex-wrap gap-3 pt-1">
          {colors.map((c) => (
            <button key={c.id} onClick={() => onUpdateSettings({ accentColor: c.id })}
              className={`px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2 border transition ${
                settings.accentColor === c.id ? "border-blue-500 shadow-sm bg-slate-50 dark:bg-slate-800" : "border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50"}`}>
              <span className={`w-3.5 h-3.5 rounded-full ${c.bg}`} />
              <span className="text-slate-800 dark:text-slate-200">{c.name}</span>
            </button>
          ))}
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">编辑器正文字号</span>
            <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{settings.fontSize}px</span>
          </div>
          <input
            type="range"
            min={12}
            max={28}
            step={1}
            value={settings.fontSize}
            onChange={(e) => onUpdateSettings({ fontSize: Number(e.target.value) })}
            className="w-full accent-indigo-600"
          />
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>小 (12px)</span>
            <span>默认 (16px)</span>
            <span>大 (28px)</span>
          </div>
        </div>
      </div>

      {/* Data Storage & Backup */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-4">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <Database className="w-4 h-4 text-emerald-500" />
          <span>个人数据存储 (符合隐私协议)</span>
        </h3>
        <div className="space-y-3 text-xs">
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50">
            <div>
              <div className="font-semibold text-slate-800 dark:text-slate-200">打开数据目录（本地备份）</div>
              <p className="text-[11px] text-slate-500">打开 vault/ 与 user-state/ 所在文件夹，可手动拷贝备份</p>
            </div>
            <button onClick={onTriggerSync} className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white font-medium text-xs hover:bg-emerald-700 transition flex items-center gap-1">
              <Folder className="w-3.5 h-3.5" />
              <span>打开目录</span>
            </button>
          </div>
        </div>
      </div>

      {/* 数据存储路径 */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <HardDrive className="w-4 h-4 text-blue-500" />
          <span>数据存储路径</span>
        </h3>
        <p className="text-xs text-slate-500">自定义笔记与个人数据存放的文件夹（例如 D 盘）</p>

        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="text-slate-500 shrink-0">当前路径：</span>
            <span className="text-slate-800 dark:text-slate-200 break-all">{storageRoot || "加载中…"}</span>
            {storageIsCustom && (
              <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 text-[10px] font-medium">自定义</span>
            )}
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            数据分为「可分享内容」（{`vault/`}）与「个人数据」（{`user-state/`}）两个子文件夹；缓存、复习记忆等也会一并迁移。修改后需重启应用生效。
          </p>
        </div>

        {storageMsg && (
          <div className="flex items-start gap-1.5 p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{storageMsg}</span>
          </div>
        )}

        <button
          onClick={handleChooseStorageFolder}
          disabled={storageBusy}
          className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold shadow-sm hover:bg-blue-700 transition flex items-center gap-2 disabled:opacity-50"
        >
          {storageBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Folder className="w-4 h-4" />}
          <span>{storageBusy ? "处理中…" : "选择存储文件夹"}</span>
        </button>

        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            onClick={handleResetData}
            disabled={storageBusy}
            className="px-4 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 text-xs font-semibold border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40 transition flex items-center gap-2 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            <span>清空所有数据（恢复初始化）</span>
          </button>
        </div>
      </div>

      {/* LLM Settings Panel */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
        <LlmSettingsPanel llmSettings={llmSettings} onUpdate={setLlmSettings} />
      </div>

      {/* Local Backup Export */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <Download className="w-4 h-4 text-blue-600" />
          <span>本地数据导出与备份</span>
        </h3>
        <p className="text-xs text-slate-500">导出全部笔记为 JSON 归档文件，保存在本机用于备份或迁移</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <button onClick={handleExportJSON} className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold shadow-sm hover:bg-blue-700 transition flex items-center gap-2">
            <Download className="w-4 h-4" />
            <span>导出全部笔记 (JSON 备份)</span>
          </button>
        </div>
      </div>

      {/* Software Update */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-3">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <RefreshCw className="w-4 h-4 text-indigo-500" />
          <span>软件更新</span>
        </h3>
        <p className="text-xs text-slate-500">{updaterStatusText || "检查更新"}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <button onClick={handleCheckUpdate} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-sm hover:bg-indigo-700 transition flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 ${updaterStatus.state === 'checking' ? 'animate-spin' : ''}`} />
            <span>检查更新</span>
          </button>
          {updaterStatus.state === 'available' && (
            <button onClick={handleDownloadUpdate} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold shadow-sm hover:bg-emerald-700 transition flex items-center gap-2">
              <Download className="w-4 h-4" />
              <span>下载更新</span>
            </button>
          )}
          {updaterStatus.state === 'downloaded' && (
            <button onClick={handleQuitAndInstall} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold shadow-sm hover:bg-emerald-700 transition">
              <span>重启安装</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};