import React, { useState, useEffect, useRef } from "react";
import { VaultSettings, SyncStatus, NoteItem, LlmSettings, ResourceAuthContainer } from "../types";
import { LlmSettingsPanel } from "./LlmSettingsPanel";
import { loadLlmSettings, saveLlmSettings, ensureLlmSettingsLoaded, getLlmSettingsLoadState, retryLlmSettingsLoad, subscribeLlmSettingsLoad } from "../services/llmStorage";
import { useDialog } from "./useDialog";
import { AppSettingsFeedback, type AppSettingsFeedbackState } from './AppSettingsFeedback';
import { getLlmSettingsSaveState, subscribeLlmSettingsSave, retryLlmSettingsSave } from '../services/llmStorage';
import { AgentExecutionSettings } from './AgentExecutionSettings';
import { LearningCapacitySettings } from './LearningCapacitySettings';
import { RESOURCE_FORMAT_PREFERENCES, normalizeResourceFormatPreference } from '../services/resourceCuration';
import {
  Settings, Type, Database, Download, ShieldCheck, RefreshCw, Folder,
  HardDrive, AlertTriangle, Trash2, GlobeLock, ExternalLink, Bot, ListChecks, X, Gauge, ArrowLeft,
} from "lucide-react";

interface SettingsModalProps {
  initialSection?: 'learning';
  onBack?: () => void;
  backLabel?: string;
  settings: VaultSettings;
  onUpdateSettings: (s: Partial<VaultSettings>) => void;
  syncStatus: SyncStatus;
  onTriggerSync: () => void | Promise<void>;
  notes: NoteItem[];
  appSettingsState?: AppSettingsFeedbackState;
  onRetryAppSettingsLoad?: () => void;
  onRetryAppSettingsSave?: () => void;
}

type UpdaterStatusState = {
  state: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
};
type Feedback = { text: string; error?: boolean };
type Confirmation =
  | { kind: 'storage'; folder: string }
  | { kind: 'reset' }
  | { kind: 'remove-auth'; container: ResourceAuthContainer };
type SettingsElectronApi = {
  storage?: {
    recoverDocuments?(): Promise<{ ok: boolean; recovered?: number; skipped?: number; canceled?: boolean; error?: string }>;
    getRoot(): Promise<{ root: string; custom: boolean }>;
    chooseFolder(): Promise<string | null>;
    setRoot(folder: string, migrate: boolean): Promise<{ ok: boolean; error?: string }>;
    reset(): Promise<{ ok: boolean; error?: string }>;
  };
  resourceBrowser?: {
    listAuthContainers(): Promise<unknown[]>;
    openAuthContainer(id: string): Promise<{ ok: boolean; error?: string }>;
    removeAuthContainer(id: string): Promise<boolean>;
  };
  updater?: {
    getVersion(): Promise<string>;
    check(): Promise<{ ok: boolean; message?: string }>;
    download(): Promise<{ ok: boolean; message?: string }>;
    quitAndInstall(): void | Promise<void>;
    onStatus(callback: (payload: unknown) => void): () => void;
  };
};
const getSettingsApi = () => (window as unknown as { electronAPI?: SettingsElectronApi }).electronAPI;

const cardClass = 'p-4 sm:p-5 rounded-2xl bg-[var(--ln-bg-surface)] border border-[var(--ln-border)] shadow-sm space-y-3';
const headingClass = 'text-sm font-semibold text-[var(--ln-text-primary)] flex items-center gap-2';
const buttonClass = 'min-h-11 px-4 py-2 rounded-xl text-xs font-semibold transition-colors motion-reduce:transition-none inline-flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)] disabled:opacity-50 disabled:cursor-not-allowed';
const primaryClass = `${buttonClass} bg-[var(--ln-accent)] text-[var(--ln-bg-surface)] hover:bg-[var(--ln-accent-hover)]`;
const secondaryClass = `${buttonClass} border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-subtle)]`;
const dangerClass = `${buttonClass} border border-[var(--ln-danger)] bg-[var(--ln-bg-subtle)] text-[var(--ln-danger)]`;
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const accentOptions: ReadonlyArray<{
  value: NonNullable<VaultSettings['accentColor']>;
  label: string;
  swatch: string;
}> = [
  { value: 'emerald', label: '黛绿', swatch: '#2f5743' },
  { value: 'teal', label: '青绿', swatch: '#0f766e' },
  { value: 'indigo', label: '靛蓝', swatch: '#4338ca' },
  { value: 'purple', label: '紫藤', swatch: '#7e22ce' },
  { value: 'coral', label: '珊瑚', swatch: '#c2413b' },
  { value: 'rose', label: '玫瑰', swatch: '#be123c' },
  { value: 'amber', label: '琥珀', swatch: '#a16207' },
  { value: 'slate', label: '灰蓝', swatch: '#475569' },
];
export const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onUpdateSettings, syncStatus, onTriggerSync, notes, appSettingsState, onRetryAppSettingsLoad, onRetryAppSettingsSave, initialSection, onBack, backLabel = '返回学习计划' }) => {
  const learningSection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialSection === 'learning') {
      learningSection.current?.scrollIntoView?.({ block: 'start' });
      learningSection.current?.focus({ preventScroll: true });
    }
  }, [initialSection]);
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(() => loadLlmSettings());
  const [llmSaveState, setLlmSaveState] = useState(getLlmSettingsSaveState);
  const llmSaving = llmSaveState.saveState === 'saving';
  const llmSaveRetryRef = useRef<HTMLButtonElement>(null);
  const llmSaveRetryOrigin = useRef<Element | null>(null);
  const [llmLoadState, setLlmLoadState] = useState(getLlmSettingsLoadState);
  const llmReadReady = useRef(llmLoadState.status === 'ready');
  const llmLoadRetryRef = useRef<HTMLButtonElement>(null);
  const llmLoadRetryOrigin = useRef<Element | null>(null);
  const [storageRoot, setStorageRoot] = useState('');
  const [storageIsCustom, setStorageIsCustom] = useState(false);
  const [pendingStorageRoot, setPendingStorageRoot] = useState('');
  const [storageMsg, setStorageMsg] = useState<Feedback | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageBusy, setStorageBusy] = useState(false);
  const storageOperation = useRef(false);
  const storagePickerOrigin = useRef<HTMLButtonElement | null>(null);
  const restoreStoragePickerFocus = useRef(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryRequested, setDirectoryRequested] = useState(false);
  const directoryOperation = useRef(false);
  const [directoryMsg, setDirectoryMsg] = useState<Feedback | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const recoveryOperation = useRef(false);
  const [recoveryMsg, setRecoveryMsg] = useState<Feedback | null>(null);
  const [authContainers, setAuthContainers] = useState<ResourceAuthContainer[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authContainerBusyId, setAuthContainerBusyId] = useState('');
  const authOperation = useRef(false);
  const [authMsg, setAuthMsg] = useState<Feedback | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationState = useRef<Confirmation | null>(null);
  const [migrateData, setMigrateData] = useState(true);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const confirmationOperation = useRef(false);
  const [confirmationError, setConfirmationError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [appVersion, setAppVersion] = useState('');
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatusState>({ state: 'idle' });
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const updaterOperation = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const installOperation = useRef(false);
  const desktopStorage = Boolean(getSettingsApi()?.storage);
  const desktopUpdater = Boolean(getSettingsApi()?.updater);
  const preferenceSaving = appSettingsState?.saveState === 'saving';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const receive = () => {
      const value = getLlmSettingsLoadState();
      llmReadReady.current = value.status === 'ready';
      setLlmLoadState(value);
      if (value.status === 'ready') {
        const loaded = loadLlmSettings();
        setLlmSettings(loaded);
      }
    };
    const stop = subscribeLlmSettingsLoad(receive);
    receive();
    void ensureLlmSettingsLoaded().catch(() => {});
    return stop;
  }, []);
  useEffect(() => {
    const receive = () => {
      setLlmSaveState(getLlmSettingsSaveState());
      setLlmSettings(loadLlmSettings());
    };
    const stop = subscribeLlmSettingsSave(receive);
    receive();
    return stop;
  }, []);
  useEffect(() => {
    if (llmSaveState.saveState === 'error' && llmSaveRetryOrigin.current
      && (document.activeElement === document.body || document.activeElement === llmSaveRetryOrigin.current)) llmSaveRetryRef.current?.focus({ preventScroll: true });
  }, [llmSaveState.saveState]);
  useEffect(() => {
    if (llmLoadState.status === 'error' && llmLoadRetryOrigin.current
      && (document.activeElement === document.body || document.activeElement === llmLoadRetryOrigin.current)) llmLoadRetryRef.current?.focus({ preventScroll: true });
  }, [llmLoadState.status]);

  const openConfirmation = (value: Confirmation) => {
    if (confirmationState.current || confirmationOperation.current || storageOperation.current || authOperation.current || (value.kind !== 'remove-auth' && (getLlmSettingsSaveState().saveState === 'saving' || preferenceSaving))) return;
    confirmationState.current = value;
    if (value.kind !== 'storage') storagePickerOrigin.current = null;
    setConfirmation(value);
    setConfirmationError('');
    setMigrateData(true);
  };
  const closeConfirmation = () => {
    if (confirmationOperation.current) return;
    confirmationState.current = null;
    restoreStoragePickerFocus.current = Boolean(storagePickerOrigin.current);
    setConfirmation(null);
    setConfirmationError('');
  };
  useDialog(Boolean(confirmation), dialogRef, confirmationBusy ? undefined : closeConfirmation, 60);
  useEffect(() => {
    if (confirmation || storageBusy || confirmationBusy || !restoreStoragePickerFocus.current) return;
    restoreStoragePickerFocus.current = false;
    const origin = storagePickerOrigin.current;
    storagePickerOrigin.current = null;
    // Preserve the origin across the native picker and its disabled loading state.
    if (origin?.isConnected && !origin.disabled && !origin.closest('[inert]')) origin.focus({ preventScroll: true });
  }, [confirmation, storageBusy, confirmationBusy]);

  const persistLlmSettings = async (next: LlmSettings) => {
    if (!llmReadReady.current) return;
    setLlmSettings(next);
    try {
      await saveLlmSettings(next);
    } catch { /* Shared state retains the draft and recovery after this panel unmounts. */ }
  };

  const loadStorageRoot = async () => {
    const api = getSettingsApi()?.storage;
    if (!api?.getRoot) { setStorageLoading(false); return; }
    setStorageLoading(true);
    try {
      const info = await api.getRoot();
      if (!mounted.current) return;
      setStorageRoot(info.root);
      setStorageIsCustom(Boolean(info.custom));
      setStorageMsg(null);
    } catch (error) {
      if (mounted.current) setStorageMsg({ text: errorText(error, '读取存储路径失败，请重试'), error: true });
    } finally {
      if (mounted.current) setStorageLoading(false);
    }
  };
  useEffect(() => { void loadStorageRoot(); }, []);

  const loadAuthContainers = async () => {
    const api = getSettingsApi()?.resourceBrowser;
    if (!api?.listAuthContainers) { setAuthLoading(false); return; }
    setAuthLoading(true);
    try {
      const rows = await api.listAuthContainers();
      if (mounted.current) setAuthContainers(Array.isArray(rows) ? rows.filter((row): row is ResourceAuthContainer => {
        if (!row || typeof row !== 'object') return false;
        const value = row as Partial<ResourceAuthContainer>;
        return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.origin === 'string';
      }) : []);
    } catch (error) {
      if (mounted.current) setAuthMsg({ text: errorText(error, '读取网站登录数据失败，请重试'), error: true });
    } finally {
      if (mounted.current) setAuthLoading(false);
    }
  };
  useEffect(() => { void loadAuthContainers(); }, []);

  const handleOpenAuthContainer = async (container: ResourceAuthContainer) => {
    const api = getSettingsApi()?.resourceBrowser;
    if (!api?.openAuthContainer || authOperation.current || confirmationState.current) return;
    authOperation.current = true;
    setAuthContainerBusyId(container.id);
    setAuthMsg(null);
    try {
      const result = await api.openAuthContainer(container.id);
      if (mounted.current) setAuthMsg(result?.ok
        ? { text: `已打开 ${container.name} 的隔离登录窗口` }
        : { text: result?.error || '打开登录容器失败', error: true });
    } catch (error) {
      if (mounted.current) setAuthMsg({ text: errorText(error, '打开登录容器失败'), error: true });
    } finally {
      authOperation.current = false;
      if (mounted.current) { setAuthContainerBusyId(''); void loadAuthContainers(); }
    }
  };

  useEffect(() => {
    const updater = getSettingsApi()?.updater;
    if (!updater) return;
    void updater.getVersion().then((version) => { if (mounted.current) setAppVersion(version); }).catch(() => {});
    return updater.onStatus((payload) => {
      if (mounted.current && payload && typeof payload === 'object' && 'state' in payload) setUpdaterStatus(payload as UpdaterStatusState);
    });
  }, []);

  const handleChooseStorageFolder = async (origin?: HTMLButtonElement) => {
    const api = getSettingsApi()?.storage;
    if (storageOperation.current || confirmationState.current || authOperation.current || getLlmSettingsSaveState().saveState === 'saving' || preferenceSaving) return;
    if (!api?.chooseFolder || !api?.setRoot) {
      setStorageMsg({ text: '仅桌面版支持自定义存储路径' });
      return;
    }
    storageOperation.current = true;
    storagePickerOrigin.current = origin || null;
    restoreStoragePickerFocus.current = false;
    setStorageBusy(true);
    setStorageMsg(null);
    try {
      const folder = await api.chooseFolder();
      if (mounted.current && folder) {
        // The picker is complete; the confirmation takes over operation ownership.
        storageOperation.current = false;
        openConfirmation({ kind: 'storage', folder });
      } else if (mounted.current) restoreStoragePickerFocus.current = true;
    } catch (error) {
      if (mounted.current) {
        restoreStoragePickerFocus.current = true;
        setStorageMsg({ text: errorText(error, '选择存储文件夹失败'), error: true });
      }
    } finally {
      storageOperation.current = false;
      if (mounted.current) setStorageBusy(false);
    }
  };

  const handleConfirm = async () => {
    const current = confirmationState.current;
    if (!current || confirmationOperation.current) return;
    confirmationOperation.current = true;
    setConfirmationBusy(true);
    setConfirmationError('');
    try {
      if (current.kind === 'storage') {
        const api = getSettingsApi()?.storage;
        if (!api?.setRoot) throw new Error('仅桌面版支持自定义存储路径');
        const result = await api.setRoot(current.folder, migrateData);
        if (!result?.ok) throw new Error(result?.error || '存储路径未保存，请重试');
        if (mounted.current) {
          setPendingStorageRoot(current.folder);
          setStorageMsg({ text: '存储路径已保存，重启应用后生效' });
        }
      } else if (current.kind === 'reset') {
        const api = getSettingsApi()?.storage;
        if (!api?.reset) throw new Error('仅桌面版支持清空数据');
        const result = await api.reset();
        if (!result?.ok) throw new Error(result?.error || '清空失败，请重试');
        if (mounted.current) setStorageMsg({ text: '数据已清空，请重启应用以恢复初始化状态' });
      } else {
        const api = getSettingsApi()?.resourceBrowser;
        if (!api?.removeAuthContainer) throw new Error('仅桌面版支持删除网站登录数据');
        const removed = await api.removeAuthContainer(current.container.id);
        if (!removed) throw new Error('删除登录数据失败，请重试');
        if (mounted.current) {
          setAuthMsg({ text: `已删除 ${current.container.name} 的本地登录数据` });
          await loadAuthContainers();
        }
      }
      if (mounted.current) {
        restoreStoragePickerFocus.current = Boolean(storagePickerOrigin.current);
        confirmationState.current = null;
        setConfirmation(null);
      }
    } catch (error) {
      if (mounted.current) setConfirmationError(errorText(error, '操作失败，请重试'));
    } finally {
      confirmationOperation.current = false;
      if (mounted.current) setConfirmationBusy(false);
    }
  };

  const handleOpenDirectory = async () => {
    if (directoryOperation.current) return;
    directoryOperation.current = true;
    setDirectoryBusy(true);
    setDirectoryRequested(true);
    setDirectoryMsg(null);
    try { await onTriggerSync(); }
    catch (error) { if (mounted.current) setDirectoryMsg({ text: errorText(error, '打开数据目录失败'), error: true }); }
    finally { directoryOperation.current = false; if (mounted.current) setDirectoryBusy(false); }
  };

  const handleRecoverDocuments = async () => {
    if (recoveryOperation.current || storageOperation.current || confirmationOperation.current) return;
    const recover = getSettingsApi()?.storage?.recoverDocuments;
    if (!recover) { setRecoveryMsg({ text: '请重启更新后的桌面版以恢复资料', error: true }); return; }
    recoveryOperation.current = true;
    setRecoveryBusy(true); setRecoveryMsg(null);
    try {
      const result = await recover();
      if (!result.ok) throw new Error(result.error || '恢复资料失败');
      if (mounted.current) setRecoveryMsg({ text: result.canceled ? '已取消，未修改资料清单。'
        : result.recovered ? `已补录 ${result.recovered} 个文件，归入资料库“待整理”；索引未自动启动。`
        : `未发现可补录文件${result.skipped ? `，跳过 ${result.skipped} 项不支持、冲突或不安全的文件` : ''}。` });
    } catch (error) {
      if (mounted.current) setRecoveryMsg({ text: errorText(error, '恢复资料失败'), error: true });
    } finally { recoveryOperation.current = false; if (mounted.current) setRecoveryBusy(false); }
  };

  const handleUpdaterAction = async (action: 'check' | 'download') => {
    const updater = getSettingsApi()?.updater;
    if (!updater || updaterOperation.current || installOperation.current || updaterStatus.state === 'downloading') return;
    updaterOperation.current = true;
    setUpdaterBusy(true);
    setUpdaterStatus({ state: action === 'check' ? 'checking' : 'downloading', percent: 0 });
    try {
      const result = await updater[action]();
      if (mounted.current) {
        if (!result?.ok) setUpdaterStatus({ state: 'error', message: result?.message || '更新失败，请重试' });
        else if (action === 'check') setUpdaterStatus((previous) => previous.state === 'checking' ? { state: 'idle', message: result.message || '检查完成' } : previous);
      }
    } catch (error) {
      if (mounted.current) setUpdaterStatus({ state: 'error', message: errorText(error, '更新失败，请重试') });
    } finally {
      updaterOperation.current = false;
      if (mounted.current) setUpdaterBusy(false);
    }
  };

  const handleQuitAndInstall = async () => {
    const updater = getSettingsApi()?.updater;
    if (!updater || installOperation.current || updaterOperation.current) return;
    installOperation.current = true;
    setInstalling(true);
    setInstallError('');
    try { await updater.quitAndInstall(); }
    catch (error) {
      installOperation.current = false;
      if (mounted.current) {
        setInstalling(false);
        setInstallError(errorText(error, '重启安装失败，请重试'));
      }
    }
  };

  const updaterStatusText = (() => {
    switch (updaterStatus.state) {
      case 'checking': return '正在检查更新…';
      case 'available': return `发现新版本 ${updaterStatus.version || ''}`;
      case 'up-to-date': return '已是最新版本';
      case 'downloading': return `正在下载 ${Math.round(updaterStatus.percent || 0)}%`;
      case 'downloaded': return '更新已下载，重启安装后生效；请先保存正在编辑的内容。';
      case 'error': return updaterStatus.message || '更新出错，请重试';
      default: return updaterStatus.message || (desktopUpdater ? (appVersion ? `当前版本 v${appVersion}` : '可检查是否有新版本') : '请在桌面版中检查软件更新');
    }
  })();
  const confirmationTitle = confirmation?.kind === 'storage' ? '更改数据存储路径'
    : confirmation?.kind === 'reset' ? '清空所有数据' : '删除网站登录数据';
  const confirmationLabel = confirmationError ? '重试' : confirmation?.kind === 'storage' ? '确认更改路径'
    : confirmation?.kind === 'reset' ? '确认清空所有数据' : '确认删除登录数据';
  const updatePending = updaterBusy || installing || updaterStatus.state === 'checking' || updaterStatus.state === 'downloading';

  return (
    <div className="settings-page flex-1 min-w-0 h-full p-4 sm:p-6 bg-[var(--ln-bg-app)] overflow-y-auto max-w-4xl mx-auto space-y-6 text-[var(--ln-text-secondary)]">
      <div inert={confirmation ? true : undefined} className="space-y-6">
        <header className={onBack ? 'sticky -top-4 sm:-top-6 z-10 bg-[var(--ln-bg-app)] py-3 flex flex-wrap items-center justify-between gap-3' : undefined}>
          <div>
          <h1 className="text-xl font-bold text-[var(--ln-text-primary)] flex items-center gap-2"><Settings className="w-5 h-5 text-[var(--ln-accent)]" />外观与数据设置</h1>
          <p className="text-xs mt-1">调整编辑器、模型配置与本地数据管理。</p>
          </div>
          {onBack && <button type="button" className={secondaryClass} onClick={onBack}><ArrowLeft className="w-4 h-4" aria-hidden="true" />{backLabel}</button>}
        </header>

        {appSettingsState && <AppSettingsFeedback state={appSettingsState} onRetryLoad={onRetryAppSettingsLoad} onRetrySave={onRetryAppSettingsSave} />}
        <fieldset disabled={appSettingsState && appSettingsState.loadState !== 'ready'} className="space-y-6 min-w-0 disabled:opacity-60">
        <legend className="sr-only">外观与资源收录设置</legend>
        <section className={cardClass} aria-labelledby="settings-appearance-title">
          <h2 id="settings-appearance-title" className={headingClass}><Type className="w-4 h-4 text-[var(--ln-accent)]" />编辑器外观</h2>
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="text-xs font-semibold mb-2">界面明暗</legend>
            {([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([value, label]) => <label key={value}
              className={`min-h-11 px-2 py-2 rounded-xl border text-xs flex items-center justify-center gap-2 cursor-pointer ${settings.theme === value ? 'border-[var(--ln-accent)] bg-[var(--ln-accent-soft)]' : 'border-[var(--ln-border)]'}`}>
              <input type="radio" name="settings-theme" value={value} checked={settings.theme === value} onChange={() => onUpdateSettings({ theme: value })} className="accent-[var(--ln-accent)]" />{label}
            </label>)}
          </fieldset>
          <fieldset>
            <legend className="text-xs font-semibold mb-2">主题色</legend>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {accentOptions.map(({ value, label, swatch }) => {
                const selected = (settings.accentColor || 'emerald') === value;
                return <label key={value}
                  className={`min-h-11 px-3 py-2 rounded-xl border text-xs flex items-center gap-2 cursor-pointer transition-colors motion-reduce:transition-none ${selected ? 'border-[var(--ln-accent)] bg-[var(--ln-accent-soft)] text-[var(--ln-text-primary)]' : 'border-[var(--ln-border)] hover:bg-[var(--ln-bg-subtle)]'}`}>
                  <input type="radio" name="settings-accent" value={value} checked={selected} onChange={() => onUpdateSettings({ accentColor: value })} className="sr-only" />
                  <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 border border-black/10 ${selected ? 'ring-2 ring-offset-2 ring-[var(--ln-accent)] ring-offset-[var(--ln-bg-surface)]' : ''}`} style={{ backgroundColor: swatch }} />
                  <span className="font-medium">{label}</span>
                  {value === 'emerald' && <span className="ml-auto text-[10px] text-[var(--ln-text-muted)]">默认</span>}
                </label>;
              })}
            </div>
          </fieldset>
          <div className="flex items-center gap-3 pt-1">
            <label htmlFor="settings-custom-accent" className="text-xs font-semibold">自定义主题色</label>
            <input id="settings-custom-accent" type="color" aria-describedby="settings-custom-accent-hint"
              value={/^#[\da-f]{6}$/iu.test(settings.accentColor || '') ? settings.accentColor : '#2f5743'}
              onChange={event => onUpdateSettings({ accentColor: event.target.value.toUpperCase() as `#${string}` })}
              className="w-12 h-11 p-1 rounded-lg border border-[var(--ln-border)] bg-[var(--ln-bg-surface)]" />
            <output htmlFor="settings-custom-accent" className="text-xs text-[var(--ln-text-secondary)]">{settings.accentColor?.startsWith('#') ? settings.accentColor : '选择任意颜色'}</output>
          </div>
          <p id="settings-custom-accent-hint" className="text-xs text-[var(--ln-text-muted)]">明暗模式会适配颜色亮度，保证文字清晰。</p>
          <div className="pt-1">
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="settings-font-size" className="text-xs font-semibold">编辑器正文字号</label>
              <output htmlFor="settings-font-size" className="text-xs font-semibold text-[var(--ln-accent)]">{settings.fontSize}px</output>
            </div>
            <input id="settings-font-size" type="range" min={12} max={28} step={1} value={settings.fontSize} onChange={(event) => onUpdateSettings({ fontSize: Number(event.target.value) })} aria-valuetext={`${settings.fontSize} 像素`} className="w-full min-h-11 accent-[var(--ln-accent)]" />
            <div className="flex justify-between text-[11px] mt-1"><span>小 (12px)</span><span>默认 (16px)</span><span>大 (28px)</span></div>
          </div>
        </section>

        <div ref={learningSection} tabIndex={-1} className="scroll-mt-24 outline-none" aria-label="学习偏好">
          <LearningCapacitySettings settings={settings} notes={notes} onUpdate={onUpdateSettings} />
        </div>
        <section className={cardClass} aria-labelledby="settings-resource-title">
          <h2 id="settings-resource-title" className={headingClass}><Bot className="w-4 h-4 text-[var(--ln-accent)]" />Agent 资源收录方式</h2>
          <p className="text-xs leading-relaxed">选择自动收录学习资源，或先在资源工作台筛选确认。修改后立即生效。</p>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Agent 资源收录方式</legend>
            {(['review', 'auto'] as const).map((mode) => (
              <label key={mode} className={`cursor-pointer p-3.5 rounded-xl border text-xs ${(settings.resourceCollectionMode || 'review') === mode ? 'border-[var(--ln-accent)] bg-[var(--ln-accent-soft)]' : 'border-[var(--ln-border)]'}`}>
                <span className="flex items-center gap-2 font-semibold text-[var(--ln-text-primary)]">
                  <input type="radio" name="settings-resource-mode" value={mode} checked={(settings.resourceCollectionMode || 'review') === mode} onChange={() => onUpdateSettings({ resourceCollectionMode: mode })} className="accent-[var(--ln-accent)]" />
                  {mode === 'review' ? <ListChecks className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  {mode === 'review' ? '筛选确认后收录' : '自动推荐并收录'}
                </span>
                <span className="block mt-2 text-[11px] leading-relaxed">{mode === 'review' ? '你选择 URL、排除项和下载项，最终确认后写入项目。默认且控制最充分。' : '按历史选择和使用反馈自动收录资源；公开附件默认下载到本地资料库并绑定项目，无需再次确认。网页、需登录验证或下载失败项保留链接，不自动登录。'}</span>
              </label>
            ))}
          </fieldset>
          {settings.resourceCollectionMode === 'auto' && <p className="flex items-start gap-2 p-3 rounded-xl bg-[var(--ln-accent-soft)] text-xs leading-relaxed"><ShieldCheck className="w-4 h-4 shrink-0 text-[var(--ln-accent)]" /><span>该选项持续授权资源收录及公开附件下载入本地资料库（单文件最多 100 MB），不上传文件到云端。已认可站点的登录/验证资源仅保留链接；收费、失效、已排除或无关候选仍跳过。可随时切回筛选模式。</span></p>}
          <label className="block text-xs font-medium" htmlFor="resource-format-preference">自动资源偏好</label>
          <select id="resource-format-preference" value={normalizeResourceFormatPreference(settings.resourceFormatPreference)}
            onChange={event => onUpdateSettings({ resourceFormatPreference: normalizeResourceFormatPreference(event.target.value) })}
            className="w-full min-h-11 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-primary)] px-3 text-sm text-[var(--ln-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
            aria-describedby="resource-mix-help">
            {Object.entries(RESOURCE_FORMAT_PREFERENCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <p id="resource-mix-help" className="text-xs leading-relaxed text-[var(--ln-text-secondary)]">每轮最多 10 项：保留概念解释、视频、案例和论文，另预留 2 项下载资料。明确偏好可占 5 项；跟随反馈时逐步调整比例。找不到合格资料就少收，可下载附件自动入库，失败保留链接。</p>
        </section>

        </fieldset>

        <section className={cardClass} aria-labelledby="settings-backup-directory-title">
          <h2 id="settings-backup-directory-title" className={headingClass}><Database className="w-4 h-4 text-[var(--ln-accent)]" />本地数据与备份</h2>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-[var(--ln-bg-subtle)]">
            <div><p className="text-xs font-semibold text-[var(--ln-text-primary)]">打开数据目录</p><p className="text-xs mt-1 leading-relaxed">手动备份或换电脑时，请复制此目录的完整内容，不要只复制三个文件夹。</p></div>
            <button type="button" onClick={handleOpenDirectory} disabled={directoryBusy || !desktopStorage} className={`${primaryClass} shrink-0`}><Folder className="w-4 h-4" />{directoryBusy ? '正在打开…' : '打开目录'}</button>
          </div>
          {!desktopStorage && <p className="text-xs">浏览器版数据保存在当前浏览器中；完整数据目录管理需使用桌面版。</p>}
          {directoryMsg && <p role={directoryMsg.error ? 'alert' : 'status'} className="text-xs text-[var(--ln-danger)]">{directoryMsg.text}</p>}
          {directoryRequested && !directoryBusy && !directoryMsg && syncStatus.statusText && <p role={syncStatus.error || syncStatus.statusText.includes('失败') ? 'alert' : 'status'} className="text-xs leading-relaxed">{syncStatus.statusText}</p>}
          <details className="text-xs leading-relaxed">
            <summary className="cursor-pointer rounded py-2 font-semibold text-[var(--ln-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]">手动迁移要复制哪些内容？</summary>
            <div className="space-y-2 pt-2">
              <p>先完全退出两台电脑上的软件，并备份目标目录，再将旧电脑数据目录的完整内容复制到新电脑实际使用的数据目录；不是复制到程序安装目录，也不要多套一层文件夹。</p>
              <p>至少不要遗漏 vault/、user-state/、documents/、rag-index/、h5p/，以及根目录下的 note-embeddings.json、textbook-reference-embeddings.json（如存在）。资料清单和论证等数据在 rag-index/，不能全部当作缓存丢弃；H5P 个人进度在 user-state/h5p/。最稳妥的方式是复制整个数据目录。</p>
              <p>数据可能含模型密钥和个人学习记录，请仅用于自己的设备，不要公开分享。旧电脑的路径配置不要照搬；新电脑请核对本页当前路径。</p>
            </div>
          </details>
          <div className="flex flex-col gap-3 border-t border-[var(--ln-border-subtle)] pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-semibold text-[var(--ln-text-primary)]">恢复遗漏资料</p><p className="mt-1 text-xs leading-relaxed">扫描 documents/，确认后补录未登记文件；不覆盖现有资料，不自动建立索引。无法还原丢失的原名称、分类或项目绑定。</p></div>
            <button type="button" onClick={handleRecoverDocuments} disabled={recoveryBusy || storageBusy || confirmationBusy || !desktopStorage} aria-busy={recoveryBusy} className={`${secondaryClass} shrink-0`}><RefreshCw className={`h-4 w-4 ${recoveryBusy ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />{recoveryBusy ? '正在扫描或补录…' : '扫描并恢复'}</button>
          </div>
          {recoveryMsg && <p role={recoveryMsg.error ? 'alert' : 'status'} className={`text-xs leading-relaxed ${recoveryMsg.error ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-accent)]'}`}>{recoveryMsg.text}</p>}
        </section>

        <section className={cardClass} aria-labelledby="settings-storage-title">
          <h2 id="settings-storage-title" className={headingClass}><HardDrive className="w-4 h-4 text-[var(--ln-accent)]" />数据存储路径</h2>
          <p className="text-xs">自定义笔记与个人数据存放的文件夹（例如 D 盘）。</p>
          <div className="p-3 rounded-xl bg-[var(--ln-bg-subtle)] space-y-2 text-xs">
            <div className="flex items-start gap-2"><Folder className="w-4 h-4 shrink-0" /><span className="shrink-0">当前路径：</span><span className="text-[var(--ln-text-primary)] break-all">{storageRoot || (storageLoading ? '加载中…' : desktopStorage ? '暂时无法读取' : '浏览器本机存储')}</span>{storageIsCustom && <span className="shrink-0 text-[var(--ln-accent)]">自定义</span>}</div>
            {pendingStorageRoot && <p className="break-all text-[var(--ln-accent)]">下次启动使用：{pendingStorageRoot}</p>}
            <p className="leading-relaxed">此目录还包含上传资料、资料清单和索引。选择迁移时会一并复制现有目录内容，修改路径需重启应用生效。</p>
          </div>
          {storageMsg && <p role={storageMsg.error ? 'alert' : 'status'} className={`text-xs leading-relaxed ${storageMsg.error ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-accent)]'}`}>{storageMsg.text}</p>}
          {desktopStorage && !storageRoot && !storageLoading && <button type="button" onClick={() => void loadStorageRoot()} className={secondaryClass}>重试读取路径</button>}
          <button type="button" onClick={(event) => handleChooseStorageFolder(event?.currentTarget)} disabled={storageBusy || recoveryBusy || llmSaving || preferenceSaving || Boolean(authContainerBusyId) || !desktopStorage} className={primaryClass}>{storageBusy ? <RefreshCw className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Folder className="w-4 h-4" />}{storageBusy ? '正在选择文件夹…' : '选择存储文件夹'}</button>
          {(llmSaving || preferenceSaving) && <p role="status" className="text-xs">设置保存完成后可更改路径或清空数据。</p>}
          <div className="pt-3 border-t border-[var(--ln-border-subtle)] space-y-2">
            <p className="text-xs leading-relaxed">清空会删除全部笔记、个人数据、复习记录和缓存。请先完成备份。</p>
            <button type="button" onClick={() => openConfirmation({ kind: 'reset' })} disabled={storageBusy || recoveryBusy || llmSaving || preferenceSaving || Boolean(authContainerBusyId) || !desktopStorage} className={dangerClass}><Trash2 className="w-4 h-4" />清空所有数据（恢复初始化）</button>
          </div>
        </section>

        <section className={cardClass} aria-labelledby="settings-auth-title">
          <h2 id="settings-auth-title" className={headingClass}><GlobeLock className="w-4 h-4 text-[var(--ln-accent)]" />资源网站登录容器</h2>
          <p className="text-xs leading-relaxed">只有明确授权的网站才会出现在这里。不同站点使用独立 Cookie 容器；登录信息不会交给 Agent、LLM、Python 或分享数据。</p>
          {authMsg && <p role={authMsg.error ? 'alert' : 'status'} className={`text-xs ${authMsg.error ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-accent)]'}`}>{authMsg.text}</p>}
          {authMsg?.error && <button type="button" onClick={() => { setAuthMsg(null); void loadAuthContainers(); }} disabled={authLoading} className={secondaryClass}>重新读取登录容器</button>}
          {authLoading ? <p role="status" className="text-xs">正在读取已授权网站…</p> : authContainers.length === 0 ? <p className="p-3 rounded-xl bg-[var(--ln-bg-subtle)] text-xs">暂无已授权网站</p> : <div className="space-y-2">{authContainers.map((container) => (
            <div key={container.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-[var(--ln-bg-subtle)]">
              <div className="min-w-0"><p className="font-semibold text-xs text-[var(--ln-text-primary)] break-words">{container.name}</p><p className="text-[11px] mt-1 break-all">{container.origin} · 最近使用 {new Date(container.lastUsedAt).toLocaleString()}</p></div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button type="button" onClick={() => handleOpenAuthContainer(container)} disabled={Boolean(authContainerBusyId)} aria-label={`打开 ${container.name} 登录窗口`} className={primaryClass}><ExternalLink className="w-4 h-4" />{authContainerBusyId === container.id ? '正在打开…' : '打开'}</button>
                <button type="button" onClick={() => openConfirmation({ kind: 'remove-auth', container })} disabled={Boolean(authContainerBusyId)} aria-label={`删除 ${container.name} 的登录数据`} className={dangerClass}><Trash2 className="w-4 h-4" />删除登录数据</button>
              </div>
            </div>
          ))}</div>}
        </section>

        <fieldset disabled={appSettingsState && appSettingsState.loadState !== 'ready'} className="min-w-0 disabled:opacity-60">
          <legend className="sr-only">{'Agent \u6267\u884c\u7b56\u7565'}</legend>
          <section className={cardClass} aria-labelledby="settings-agent-budget-title">
            <h2 id="settings-agent-budget-title" className={headingClass}><Gauge className="w-4 h-4 text-[var(--ln-accent)]" />Agent 执行策略</h2>
            <AgentExecutionSettings settings={settings} onUpdate={onUpdateSettings}
              disabled={Boolean(appSettingsState && appSettingsState.loadState !== 'ready')} />
          </section>
        </fieldset>

        <section className={cardClass} aria-label="AI 模型配置" aria-busy={llmSaving || llmLoadState.status === 'loading'}>
          {llmLoadState.status === 'error' ? <div role="alert" className="space-y-2 text-xs leading-relaxed">
            <p className="text-[var(--ln-danger)]">{llmLoadState.error} 读取成功前不能修改或调用该配置。</p>
            <button ref={llmLoadRetryRef} type="button" className={secondaryClass} onClick={() => {
              llmLoadRetryOrigin.current = document.activeElement;
              void retryLlmSettingsLoad().catch(() => {});
            }}>重新读取模型配置</button>
          </div> : llmLoadState.status !== 'ready' && <p role="status" className="text-xs">正在读取模型配置…</p>}
          <fieldset disabled={llmLoadState.status !== 'ready'} className="min-w-0 disabled:opacity-60">
            <legend className="sr-only">AI 模型配置</legend>
            <LlmSettingsPanel llmSettings={llmSettings} onUpdate={persistLlmSettings} />
          </fieldset>
          {llmSaving && <p role="status" className="text-xs">正在保存模型配置…</p>}
          {llmSaveState.saveState === 'saved' && <p role="status" className="text-xs text-[var(--ln-accent)]">模型配置已保存到本机</p>}
          {llmSaveState.saveState === 'error' && <><p role="alert" className="text-xs leading-relaxed text-[var(--ln-danger)]">{llmSaveState.saveError}</p>
            <button ref={llmSaveRetryRef} type="button" onClick={() => { llmSaveRetryOrigin.current = document.activeElement; return retryLlmSettingsSave().catch(() => {}); }} className={secondaryClass}>重试保存模型配置</button></>}
        </section>


        <section className={cardClass} aria-labelledby="settings-updater-title" aria-busy={updatePending}>
          <h2 id="settings-updater-title" className={headingClass}><RefreshCw className="w-4 h-4 text-[var(--ln-accent)]" />软件更新</h2>
          <p role={updaterStatus.state === 'error' ? 'alert' : 'status'} className={`text-xs leading-relaxed ${updaterStatus.state === 'error' ? 'text-[var(--ln-danger)]' : ''}`}>{updaterStatusText}</p>
          {installError && <p role="alert" className="text-xs text-[var(--ln-danger)]">{installError}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => handleUpdaterAction('check')} disabled={!desktopUpdater || updatePending} className={primaryClass}><RefreshCw className={`w-4 h-4 ${updaterStatus.state === 'checking' ? 'animate-spin motion-reduce:animate-none' : ''}`} />{updaterStatus.state === 'checking' ? '正在检查…' : '检查更新'}</button>
            {updaterStatus.state === 'available' && <button type="button" onClick={() => handleUpdaterAction('download')} disabled={updatePending} className={primaryClass}><Download className="w-4 h-4" />下载更新</button>}
            {updaterStatus.state === 'downloaded' && <button type="button" onClick={handleQuitAndInstall} disabled={updatePending} className={primaryClass}>{installing ? '正在重启…' : '重启安装'}</button>}
          </div>
        </section>
      </div>

      {confirmation && <div className="settings-confirmation-backdrop fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeConfirmation(); }}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-confirmation-title" aria-describedby="settings-confirmation-description" aria-busy={confirmationBusy} tabIndex={-1} className="settings-confirmation w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-[var(--ln-bg-surface)] border border-[var(--ln-border)] shadow-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3"><h2 id="settings-confirmation-title" className="text-base font-semibold text-[var(--ln-text-primary)]">{confirmationTitle}</h2><button type="button" aria-label="关闭确认窗口" onClick={closeConfirmation} disabled={confirmationBusy} className={`${secondaryClass} px-3`}><X className="w-4 h-4" /></button></div>
          {confirmation.kind === 'storage' ? <>
            <p id="settings-confirmation-description" className="text-xs leading-relaxed">确认后保存新路径，重启应用后生效。取消将保留当前设置。</p>
            <p className="p-3 rounded-xl bg-[var(--ln-bg-subtle)] text-xs break-all">目标文件夹：{confirmation.folder}</p>
            <fieldset disabled={confirmationBusy} className="space-y-2 text-xs"><legend className="mb-2 font-semibold text-[var(--ln-text-primary)]">现有数据如何处理</legend>
              <label className="flex items-start gap-2 p-3 rounded-xl border border-[var(--ln-border)] cursor-pointer"><input type="radio" name="storage-migration" checked={migrateData} onChange={() => setMigrateData(true)} className="mt-0.5 accent-[var(--ln-accent)]" /><span><span className="block font-semibold">迁移现有数据（推荐）</span><span className="block mt-1 leading-relaxed">将当前笔记、个人数据、缓存与复习记忆迁移到目标文件夹。</span></span></label>
              <label className="flex items-start gap-2 p-3 rounded-xl border border-[var(--ln-border)] cursor-pointer"><input type="radio" name="storage-migration" checked={!migrateData} onChange={() => setMigrateData(false)} className="mt-0.5 accent-[var(--ln-accent)]" /><span><span className="block font-semibold">使用目标文件夹，不迁移现有数据</span><span className="block mt-1 leading-relaxed">目标为空时将从初始状态开始；原文件夹中的数据仍保留。</span></span></label>
            </fieldset>
          </> : <p id="settings-confirmation-description" className="text-xs leading-relaxed">{confirmation.kind === 'reset' ? '此操作将删除全部笔记、个人数据、复习记录、网站登录数据和缓存，无法撤销。请先完成备份，再确认清空。' : `将删除 ${confirmation.container.name}（${confirmation.container.origin}）保存在本机的 Cookie 与登录数据。下次访问可能需要重新登录。`}</p>}
          {confirmationError && <p role="alert" className="flex items-start gap-2 text-xs text-[var(--ln-danger)]"><AlertTriangle className="w-4 h-4 shrink-0" />{confirmationError}</p>}
          {confirmationBusy && <p role="status" className="text-xs">正在处理，请稍候…</p>}
          <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={closeConfirmation} disabled={confirmationBusy} className={secondaryClass}>取消</button><button type="button" onClick={handleConfirm} disabled={confirmationBusy} className={confirmation.kind === 'storage' ? primaryClass : dangerClass}>{confirmationBusy ? '正在处理…' : confirmationLabel}</button></div>
        </div>
      </div>}
    </div>
  );
};
