import { App, type RestoredListenerEvent } from '@capacitor/app';
import { Camera, CameraResultType, CameraSource, type Photo } from '@capacitor/camera';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { configureMobilePlatform, type MobilePlatform } from '../../../src/mobile-prototype/mobile-platform';

const recorder = registerPlugin<NonNullable<MobilePlatform['recorder']>>('ClassroomRecorder');
const photoHandlers = new Set<(file: File) => void>();
const pendingPhotos: File[] = [];
const handles: PluginListenerHandle[] = [];
let installation: Promise<void> | undefined;

function isCancellation(error: unknown) {
  const detail = error as { message?: string; code?: string } | undefined;
  return /cancel(?:led|ed)?|no image picked/i.test(detail?.message || '') || detail?.code === 'OS-PLUG-CAMR-0006';
}

async function photoFile(photo: Photo): Promise<File> {
  const source = photo.webPath || (photo.path ? Capacitor.convertFileSrc(photo.path) : undefined);
  if (!source) throw new Error('相机没有返回可读取的照片。');
  const url = new URL(source, window.location.href);
  if (url.origin !== window.location.origin && url.protocol !== 'blob:' && url.protocol !== 'data:') {
    throw new Error('照片不是本机资源。');
  }
  const response = await fetch(url.href);
  if (!response.ok) throw new Error('照片暂时无法读取，请重新拍摄。');
  const blob = await response.blob();
  const format = /^(jpeg|jpg|png|gif|webp|heic)$/i.test(photo.format) ? photo.format.toLowerCase() : 'jpeg';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([blob], `课堂照片-${stamp}.${format === 'jpeg' ? 'jpg' : format}`, {
    type: blob.type.startsWith('image/') ? blob.type : `image/${format === 'jpg' ? 'jpeg' : format}`,
    lastModified: Date.now(),
  });
}

function emitRestoredPhoto(file: File) {
  if (!photoHandlers.size) { pendingPhotos.push(file); return; }
  // One capture belongs to one active UI owner; do not duplicate it across subscriptions.
  const handler = photoHandlers.values().next().value;
  if (handler) handler(file);
}

async function restoredCamera(event: RestoredListenerEvent) {
  if (event.pluginId !== 'Camera' || event.methodName !== 'getPhoto') return;
  if (!event.success) {
    if (!isCancellation(event.error)) window.dispatchEvent(new CustomEvent('loginote:native-error', { detail: { message: event.error?.message || '相机恢复失败，请重新拍摄。' } }));
    return;
  }
  try { emitRestoredPhoto(await photoFile(event.data as Photo)); }
  catch (error) {
    window.dispatchEvent(new CustomEvent('loginote:native-error', { detail: { message: error instanceof Error ? error.message : '恢复的照片无法读取。' } }));
  }
}

/** Installs bridges only. No startup microphone, notification or camera permission request. */
export function installAndroidPlatform(): Promise<void> {
  return installation ||= install();
}

async function install() {
  if (Capacitor.getPlatform() !== 'android') {
    configureMobilePlatform({ isNative: false });
    return;
  }
  document.documentElement.dataset.platform = 'android';
  configureMobilePlatform({
    isNative: true,
    recorder,
    fileUrl: uri => Capacitor.convertFileSrc(uri),
    takePhoto: async () => {
      try {
        const photo = await Camera.getPhoto({
          resultType: CameraResultType.Uri,
          source: CameraSource.Prompt,
          quality: 85,
          correctOrientation: true,
          allowEditing: false,
          saveToGallery: false,
          promptLabelHeader: '拍照记录',
          promptLabelPhoto: '从相册选择',
          promptLabelPicture: '拍照',
          promptLabelCancel: '取消',
        });
        return await photoFile(photo);
      } catch (error) {
        if (isCancellation(error)) return undefined;
        throw error;
      }
    },
    onRestoredPhoto: handler => {
      photoHandlers.add(handler);
      if (pendingPhotos.length) {
        const files = pendingPhotos.splice(0);
        for (const file of files) handler(file);
      }
      return () => { photoHandlers.delete(handler); };
    },
  });
  // Register the restoration listener before rendering the React UI, then buffer the file.
  handles.push(await App.addListener('appRestoredResult', restoredCamera));
  handles.push(await App.addListener('appStateChange', state => {
    if (state.isActive) window.dispatchEvent(new CustomEvent('loginote:native-resume'));
  }));
  handles.push(await App.addListener('backButton', () => {
    const detail = { handled: false };
    window.dispatchEvent(new CustomEvent('loginote:native-back', { detail }));
    if (!detail.handled) void App.minimizeApp().catch(() => { /* Never exit/kill an active recorder. */ });
  }));
  handles.push(await Keyboard.addListener('keyboardWillShow', info => {
    window.dispatchEvent(new CustomEvent('loginote:native-keyboard', { detail: { visible: true, height: info.keyboardHeight } }));
  }));
  handles.push(await Keyboard.addListener('keyboardWillHide', () => {
    window.dispatchEvent(new CustomEvent('loginote:native-keyboard', { detail: { visible: false, height: 0 } }));
  }));
}

export async function disposeAndroidPlatform() {
  await Promise.all(handles.splice(0).map(handle => handle.remove()));
  photoHandlers.clear(); installation = undefined;
}
