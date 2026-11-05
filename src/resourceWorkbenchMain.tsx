import { createRoot } from 'react-dom/client';
import { ResourceWorkbenchApp } from './components/ResourceWorkbenchApp';
import './resourceWorkbench.css';
import { applyWindowTheme, connectWindowAppearance } from './services/ui/windowAppearance';

const stopAppearance = connectWindowAppearance((window as any).electronAPI?.appearance,
  theme => applyWindowTheme(theme, document.documentElement),
  error => console.warn('[appearance] 工作台主题读取失败，保留当前主题', error));
window.addEventListener('pagehide', stopAppearance, { once: true });

createRoot(document.getElementById('root')!).render(<ResourceWorkbenchApp />);
