import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AI Content Generator',
    version: '1.0.34',
    // 'downloads' y 'offscreen' son nuevos (2026-09): 'downloads' hace
    // falta para materializar la imagen del start frame como archivo real
    // en disco (unica forma de interceptar el selector de archivo de
    // flow.google.com por protocolo -- ver NativeUploadFileMessage en
    // lib/types.ts); 'offscreen' hace falta porque downloads.download()
    // ignora el nombre de archivo pedido para un data: URL y hay que
    // convertirlo antes a blob: URL, que solo se puede crear en un
    // documento con DOM (ver downloadFile.ts).
    permissions: [
      'activeTab',
      'tabs',
      'storage',
      'alarms',
      'debugger',
      'downloads',
      'offscreen',
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
