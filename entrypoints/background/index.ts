import { Actions, SceneStatuses } from '../../lib/types';
import { Alarms } from '../../lib/constants';
import type { SceneStatus, ExtensionMessage } from '../../lib/types';
import { batchStore } from './batchStore';
import {
  runBatchSceneFrom,
  resetSceneTimeout,
  advanceAfterPendingWrite,
  markSceneErrorAndAdvance,
} from './sceneOrchestration';
import { nativeClick, nativeType, nativeUploadFile } from './nativeInput';
import { saveTempFileForUpload, scheduleTempCleanup } from './downloadFile';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (message: ExtensionMessage, sender) => {
    await batchStore.loaded;

    if (message.action === Actions.StartBatch) {
      const preCompleted = message.preCompletedSceneNumbers;
      const initialStatuses: Record<number, SceneStatus> = {};
      for (const n of preCompleted) initialStatuses[n] = SceneStatuses.Done;

      await batchStore.start({
        active: true,
        mode: message.mode,
        site: message.site,
        projectName: message.projectName,
        scenes: message.scenes,
        allSceneNumbers: [...preCompleted, ...message.scenes.map((s) => s.sceneNumber)].sort(
          (a, b) => a - b
        ),
        currentIndex: 0,
        sceneStatuses: initialStatuses,
        tabId: message.tabId,
        pendingWrite: null,
        logStack: [],
        lastLogSceneNumber: null,
      });
      runBatchSceneFrom(0);
      return { ok: true };
    }

    if (message.action === Actions.StopBatch) {
      if (batchStore.batch) {
        await batchStore.stop();
        browser.tabs
          .sendMessage(batchStore.batch.tabId, { action: Actions.StopBatch })
          .catch(() => {});
      }
      await browser.alarms.clear(Alarms.SceneTimeout);
      batchStore.broadcastStatus();
      return { ok: true };
    }

    if (message.action === Actions.GetBatchStatus) {
      return batchStore.getStatus();
    }

    // Persist content-script logs so a reopened popup restores the tree.
    if (message.action === Actions.Log) {
      await batchStore.pushLog(message);
      return;
    }

    if (message.action === Actions.DownloadMediaDirect) {
      const { urls, sceneNumber } = message;
      await resetSceneTimeout(2);
      if (batchStore.batch?.active) {
        await batchStore.setPendingWrite(sceneNumber, urls);
        batchStore.broadcastStatus();
      }
      return;
    }

    if (message.action === Actions.WriteDone) {
      const { sceneNumber } = message;
      if (batchStore.batch?.pendingWrite?.sceneNumber === sceneNumber) {
        await browser.alarms.clear(Alarms.SceneTimeout);
        await advanceAfterPendingWrite(sceneNumber);
      }
      return;
    }

    if (message.action === Actions.SceneFailed) {
      const { sceneNumber, reason, retryAfterMs } = message;
      if (
        batchStore.batch?.active &&
        batchStore.batch.sceneStatuses[sceneNumber] === SceneStatuses.Processing
      ) {
        await markSceneErrorAndAdvance(sceneNumber, reason, retryAfterMs);
      }
      return;
    }

    if (message.action === Actions.NativeClick) {
      const { x, y } = message;
      const tabId = batchStore.batch?.tabId ?? sender.tab?.id;
      if (!tabId) return;
      await nativeClick(tabId, x, y);
      return { ok: true };
    }

    if (message.action === Actions.NativeType) {
      const { text } = message;
      const tabId = batchStore.batch?.tabId ?? sender.tab?.id;
      if (!tabId) return;
      await nativeType(tabId, text);
      return { ok: true };
    }

    if (message.action === Actions.NativeUploadFile) {
      const { imageBase64, uploadName, x, y } = message;
      const tabId = batchStore.batch?.tabId ?? sender.tab?.id;
      console.log('[NativeUploadFile] pedido:', { uploadName, x, y, tabId });
      if (!tabId) return { ok: false };

      const saved = await saveTempFileForUpload(imageBase64, uploadName);
      if (!saved) {
        console.error('[NativeUploadFile] no se pudo materializar el archivo temporal');
        return { ok: false };
      }
      console.log('[NativeUploadFile] archivo temporal listo:', saved);

      const ok = await nativeUploadFile(tabId, x, y, saved.path);
      console.log('[NativeUploadFile] resultado de la intercepción:', ok);

      // OJO: el borrado NO puede ser inmediato. DOM.setFileInputFiles solo
      // hace que el input APUNTE al archivo en disco; Flow recien lee esos
      // bytes despues, cuando su propio JS procesa el change y los sube a su
      // backend. Borrarlo aca mismo dejaba a Flow sin nada que leer y la
      // subida moria en silencio -- la intercepcion reportaba exito, pero el
      // archivo nunca aparecia en la pestaña "Subidas" (confirmado en vivo el
      // 2026-09-05, con la unica excepcion de un intento temprano cuyo
      // borrado debe haber fallado, y que por eso SI se subio).
      scheduleTempCleanup(saved);
      // realFileName casi nunca es igual a uploadName -- Chrome le pone su
      // propio nombre al archivo temporal sin importar lo que se le pida
      // (ver downloadFile.ts). Es lo que Flow va a mostrar como titulo, asi
      // que el content script tiene que buscar ESE nombre despues, no el
      // que mando.
      return { ok, realFileName: saved.realFileName };
    }

    return;
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    await batchStore.loaded;
    const { batch } = batchStore;
    if (alarm.name === Alarms.SceneTimeout && batch?.active) {
      const scene = batch.scenes[batch.currentIndex];
      if (scene && batch.sceneStatuses[scene.sceneNumber] === SceneStatuses.Processing) {
        await markSceneErrorAndAdvance(scene.sceneNumber);
      }
    }
  });
});
