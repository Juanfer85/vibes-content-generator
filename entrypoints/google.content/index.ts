import { Actions, BatchModes } from '../../lib/types';
import type { ExtensionMessage } from '../../lib/types';
import { setAborted } from './abortState';
import { handleImageMode, handleVideoMode } from './modeHandlers';

export default defineContentScript({
  // Google movio Flow de labs.google a flow.google.com (2026-09); se
  // mantienen los dos por si el dominio viejo sigue redirigiendo activo.
  matches: ['*://labs.google/*', '*://flow.google.com/*'],
  main() {
    browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
      // Only 2 actions matter to this content script — everything else
      // (NativeClick, GetBatchStatus, etc.) is background.ts's business.
      switch (message.action) {
        case Actions.StopBatch:
          setAborted(true);
          return;

        case Actions.SendPrompt: {
          setAborted(false);
          // Fire-and-forget — outcomes travel as their own later messages.
          const { prompt, mediaType, imageBase64, imageName, sceneNumber } = message;
          if (mediaType === BatchModes.Image) {
            handleImageMode(prompt, sceneNumber);
          } else {
            handleVideoMode(prompt, imageBase64, imageName, sceneNumber);
          }
          return;
        }

        default:
          return;
      }
    });
  },
});
