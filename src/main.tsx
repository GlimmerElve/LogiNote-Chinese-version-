import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { WindowResizeHandles } from './components/WindowResizeHandles.tsx';
import './index.css';
import 'katex/dist/katex.min.css';

// Electron 无边框窗口适配：仅桌面环境注入 class，浏览器 web 模式不受影响
if ((window as any).electronAPI?.isElectron) {
  document.documentElement.classList.add('electron-app');
}

// 注意：移除 StrictMode 以规避 React 19 开发模式 effect 双挂载，
// 否则 ForceGraph3D 会被 创建→_destructor()→再创建，WebGL 上下文可能异常导致图谱透明。
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <WindowResizeHandles />
  </>,
);
