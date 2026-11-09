import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.loginote.mobile',
  appName: 'LogiNote',
  webDir: 'dist',
  backgroundColor: '#f8f8f4',
  android: { backgroundColor: '#f8f8f4', allowMixedContent: false, minWebViewVersion: 100 },
  plugins: {
    SystemBars: { style: 'LIGHT', insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
    SplashScreen: { launchAutoHide: true },
  },
};
export default config;
