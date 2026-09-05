import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AI Content Generator',
    version: '1.0.13',
    // 'downloads' es nuevo (2026-09): hace falta para materializar la
    // imagen del start frame como archivo real en disco (unica forma de
    // interceptar el selector de archivo de flow.google.com por protocolo
    // -- ver NativeUploadFileMessage en lib/types.ts).
    permissions: [
      'activeTab',
      'tabs',
      'storage',
      'alarms',
      'debugger',
      'downloads',
      'unlimitedStorage',
    ],
    host_permissions: [
      'https://*.vibes.ai/*',
      'https://*.fbcdn.net/*',
      'https://labs.google/*',
      'https://flow.google.com/*',
    ],
    browser_specific_settings: {
      gecko: {
        id: 'omniflowai@example.com',
        strict_min_version: '109.0',
      },
    },
  },
});
