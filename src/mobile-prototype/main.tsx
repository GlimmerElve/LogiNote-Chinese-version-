import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import '../styles/design-tokens.css';
import { MobilePrototype } from './MobilePrototype';
import './mobile.css';
import './simple-discovery.css';
import './secondary-pages.css';

createRoot(document.getElementById('root')!).render(<MobilePrototype />);
