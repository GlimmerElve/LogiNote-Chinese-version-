import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import { createSceneInteractionPackStore } from './sceneInteractionPackStore';
import { createScenePackImporter, inspectScenePackImport, SCENE_PACK_IMPORT_LIMIT } from './sceneInteractionPackImport';

/** Same production boundary for the app and the isolated native acceptance client. */
export function registerSceneInteractionPackIpc(ipc: Pick<IpcMain, 'handle'>, options: { root: string; seed?: string; refreshSeed?: boolean;
  allowed?: (event: IpcMainInvokeEvent) => boolean; parent?: () => BrowserWindow | null; current?: () => string;
  dialogs?: Pick<typeof import('electron').dialog, 'showOpenDialog' | 'showMessageBox'> }) {
  const store = createSceneInteractionPackStore(options.root, options.seed, { refreshSeed: options.refreshSeed });
  const importer = createScenePackImporter(options.root); let importing = false;
  ipc.handle('scene-interaction-packs:list', () => store.list());
  ipc.handle('scene-interaction-packs:load', (_event, reference) => store.load(reference));
  ipc.handle('scene-interaction-packs:read-material', (_event, reference, id) => store.readMaterial(reference, id));
  ipc.handle('scene-interaction-packs:import', async event => {
    if (!options.allowed?.(event)) throw Error('当前窗口或应用状态不允许安装 S2 交互包');
    if (importing) throw Error('正在导入 S2 交互包，请等待完成');
    importing = true;
    const epoch = options.current?.(), current = () => !!options.allowed?.(event) && options.current?.() === epoch;
    try {
      const dialog = options.dialogs || (await import('electron')).dialog;
      const picked = await dialog.showOpenDialog(options.parent?.()!, { title: '导入或更新 S2 交互包', properties: ['openFile'], filters: [{ name: 'S2 交互包 ZIP', extensions: ['zip'] }] });
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
      const handle = await fs.open(picked.filePaths[0], 'r');
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > SCENE_PACK_IMPORT_LIMIT) throw Error('请选择 16 MiB 以内的 S2 ZIP 包');
        bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) throw Error('S2 文件读取不完整'); offset += chunk.bytesRead; }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('文件读取期间已变化，请重新导入');
      } finally { await handle.close(); }
      const { manifest } = await inspectScenePackImport(bytes);
      const confirm = await dialog.showMessageBox(options.parent?.()!, { type: 'warning', title: '安装可信 S2 交互包',
        message: `安装“${manifest.name}” ${manifest.version}？`,
        detail: 'S2 包包含可执行 JavaScript，与应用主窗口处于相同信任级别，不是 H5P 隔离沙箱。只安装你信任来源的包；结构校验不等于代码安全审计。\n新版并存，新场景可立即选择，正在运行的场景和已有进度继续使用原版；不会自动迁移、删除旧版或调用模型。',
        buttons: ['取消', '信任并安装'], defaultId: 0, cancelId: 0, noLink: true });
      if (confirm.response !== 1) return { canceled: true };
      if (!current()) throw Error('应用状态已变化，未安装交互包');
      // Complete seed initialization before publishing: the new package must be
      // discoverable even when the managed directory did not previously exist.
      await store.list();
      return await importer.install(bytes, current);
    } finally { importing = false; }
  });
  return { ...store, busy: () => importing || importer.busy() };
}
