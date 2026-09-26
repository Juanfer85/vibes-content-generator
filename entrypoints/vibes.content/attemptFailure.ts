// Canal para que un intento de generacion diga POR QUE fallo, sin duplicar el
// mensaje SceneFailed (que avanza el lote): createGenerateAttempt deja aqui el
// motivo y generateWithRetries lo lee al reportar el fallo, una sola vez.
let reason: string | null = null;

export const setAttemptFailure = (r: string | null) => {
  reason = r;
};

export const takeAttemptFailure = (): string | null => {
  const r = reason;
  reason = null;
  return r;
};
