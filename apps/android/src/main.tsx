import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import '../../../src/styles/design-tokens.css';
import { InteractiveApp } from '../../../src/mobile-prototype/InteractiveApp';
import { installAndroidPlatform } from './native-platform';
import './native.css';

const root = createRoot(document.getElementById('root')!);
void installAndroidPlatform().then(() => root.render(<InteractiveApp />)).catch(error => {
  console.error('Android bridge initialization failed', error);
  root.render(<main className="android-startup-error" role="alert"><h1>启动失败</h1><p>移动能力暂未就绪，请重新打开应用。</p><button onClick={() => window.location.reload()}>重试</button></main>);
});
