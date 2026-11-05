import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import { CommunityApp } from './CommunityApp';
import './community.css';
import './community-flows.css';
createRoot(document.getElementById('root')!).render(<CommunityApp />);
