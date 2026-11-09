import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import '../styles/design-tokens.css';
import { InteractiveApp } from './InteractiveApp';

createRoot(document.getElementById('root')!).render(<InteractiveApp />);
