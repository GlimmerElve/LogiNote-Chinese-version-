import { createRoot } from 'react-dom/client';
import { CognitionManager } from './components/CognitionManager';
import './index.css';
import './components/CognitionManager.css';
import { applyWindowTheme, connectWindowAppearance } from './services/ui/windowAppearance';
import { cognitionWindowApi } from './services/cognition/managerWindow';

const stop = connectWindowAppearance(cognitionWindowApi()?.appearance, theme => applyWindowTheme(theme, document.documentElement));
window.addEventListener('pagehide', stop, { once: true });
createRoot(document.getElementById('root')!).render(<CognitionManager />);
