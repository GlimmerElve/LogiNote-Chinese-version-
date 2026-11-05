import { createRoot } from 'react-dom/client';
import ArgumentEditorApp from './ArgumentEditorApp';
import './index.css';
import 'katex/dist/katex.min.css';
import { applyWindowTheme, connectWindowAppearance } from './services/ui/windowAppearance';

const stopAppearance = connectWindowAppearance((window as any).electronAPI?.appearance,
  theme => applyWindowTheme(theme, document.documentElement),
  error => console.warn('[appearance] 编辑器主题读取失败，保留当前主题', error));
window.addEventListener('pagehide', stopAppearance, { once: true });

// Electron 无边框窗口适配（编辑器窗口同样为无边框，注入 class 供边框拖拽热区等样式生效）
if ((window as any).electronAPI?.isElectron) {
  document.documentElement.classList.add('electron-app');
}

createRoot(document.getElementById('root')!).render(<ArgumentEditorApp />);
