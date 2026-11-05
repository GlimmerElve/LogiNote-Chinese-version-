import React from 'react';
import { createRoot } from 'react-dom/client';
import { H5pLibraryPanel } from '../../src/components/scene/H5pLibraryPanel';
import '../../src/styles/design-tokens.css';
// Synthetic browser fixture. No Electron preload, user files, model or external service.
const fixture = { mode: 'ready', opens: 0, imports: 0, restarts: 0, cancelRestart: true, restarted: false };
(window as any).h5pFixture = fixture;
(window as any).electronAPI = { h5p: {
  list: async () => {
    if (fixture.mode === 'error') throw new Error('合成读取失败');
    return { packages: fixture.mode === 'empty' ? [] : [
      { id: 'a'.repeat(64), title: '概率与决策 · 互动练习', mainLibrary: 'H5P.Synthetic', libraries: ['H5P.Synthetic-1.0'], missing: [], bytes: 1234567, importedAt: '', resumeAvailable: !fixture.restarted, reportedCompleted: true, reportedScore: { raw: 1, max: 1 },
        progressError: fixture.mode === 'damaged' ? '进度读取失败，原记录保留。可备份后重新开始。' : undefined },
      { id: 'b'.repeat(64), title: '等待补齐的探索场景', mainLibrary: 'H5P.Missing', libraries: ['H5P.Missing-1.0'], missing: ['H5P.Missing-1.0'], bytes: 12345, importedAt: '' },
    ], errors: [] };
  },
  importPackage: async () => { fixture.imports++; return { canceled: true }; },
  open: async () => { fixture.opens++; await new Promise(resolve => setTimeout(resolve, 200)); return {}; },
  restart: async () => { fixture.restarts++; if (fixture.cancelRestart) return { canceled: true }; fixture.restarted = true; fixture.mode = 'ready'; return { backup: 'fixture-backup.json' }; },
} };
createRoot(document.getElementById('app')!).render(<H5pLibraryPanel />);
