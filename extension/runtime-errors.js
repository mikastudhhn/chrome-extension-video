// @ts-check
/** @typedef {'protocol' | 'room' | 'connection' | 'cancelled' | 'extension' | 'permission' | 'input' | 'player' | 'action'} ErrorCategory */
// Wire-safe errors. Only these fields cross worker/runtime/HTTP boundaries.
/** @satisfies {Record<string, [ErrorCategory, boolean, string]>} */
const definitions = {
  INVALID_MESSAGE: ['protocol', false, 'Ungültige Synchronisationsdaten. Die Sitzung wurde pausiert.'],
  INVALID_RESPONSE: ['protocol', false, 'Der Server hat ungültige Verbindungsdaten geliefert.'],
  INCOMPATIBLE_PROTOCOL: ['protocol', false, 'Bitte den Verbindungsserver und beide Extensions aktualisieren.'],
  FORBIDDEN_ROLE: ['protocol', false, 'Diese Nachricht ist für diese Rolle nicht erlaubt.'],
  INVALID_SEQUENCE: ['protocol', false, 'Ungültige Befehlsreihenfolge.'],
  ROOM_REQUEST_EXPIRED: ['room', false, 'Der Verbindungsversuch ist abgelaufen. Bitte einen neuen Raum verwenden.'],
  ROOM_REQUEST_CONFLICT: ['room', false, 'Der Verbindungsversuch passt nicht zur ursprünglichen Anfrage.'],
  ROOM_SETUP_UNCERTAIN: ['room', false, 'Verbindungsaufbau unklar. Bitte eine neue Einladung verwenden.'],
  SERVER_DRAINING: ['connection', false, 'Der Server wird beendet. Bitte später einen neuen Raum erstellen.'],
  ROOM_CLOSED: ['room', false, 'Der Raum wurde beendet.'],
  ROOM_NOT_FOUND: ['room', false, 'Raum nicht gefunden oder bereits beendet.'],
  ROOM_FULL: ['room', false, 'Dieser Raum ist bereits mit zwei Personen belegt.'],
  SESSION_ENDED: ['room', false, 'Die Sitzung ist beendet. Bitte einen neuen Raum erstellen.'],
  PEER_MISSING: ['room', true, 'Die zweite Person ist noch nicht beigetreten.'],
  POLL_CONFLICT: ['connection', true, 'Es läuft bereits eine Verbindungsabfrage.'],
  RATE_LIMITED: ['connection', true, 'Zu viele Anfragen. Bitte kurz warten.'],
  SERVER_BUSY: ['connection', true, 'Der Server ist ausgelastet.'],
  SERVER_ERROR: ['connection', true, 'Server vorübergehend nicht erreichbar.'],
  NETWORK_ERROR: ['connection', true, 'Die Verbindung zum Server ist fehlgeschlagen. Bitte die Serveradresse und die Verbindung prüfen.'],
  TIMEOUT: ['connection', true, 'Der Server hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.'],
  ABORTED: ['cancelled', false, 'Verbindung beendet.'],
  QUEUE_FULL: ['connection', false, 'Zu viele unbestätigte Befehle. Bitte neu verbinden.'],
  WORKER_INTERRUPTED: ['connection', false, 'Die Hintergrundverbindung wurde unterbrochen. Bitte einen neuen Raum erstellen.'],
  RUNTIME_UNAVAILABLE: ['extension', true, 'Die Erweiterung antwortet nicht. Bitte das Popup erneut öffnen oder die Erweiterung neu laden.'],
  PERMISSION_DENIED: ['permission', false, 'Der Zugriff auf den Verbindungsserver wurde nicht erlaubt.'],
  INVALID_SERVER: ['input', false, 'Bitte eine HTTPS-Serveradresse oder einen lokalen Testserver angeben.'],
  INVALID_JSON: ['protocol', false, 'Ungültiges JSON.'],
  REQUEST_TOO_LARGE: ['protocol', false, 'Anfrage zu groß.'],
  FORBIDDEN_ORIGIN: ['permission', false, 'Diese Herkunft ist nicht freigegeben.'],
  NOT_FOUND: ['input', false, 'Nicht gefunden.'],
  PLAYER_TIMEOUT: ['player', true, 'Der Video-Tab antwortet nicht. Wir versuchen es erneut.'],
  ACTION_BUSY: ['action', true, 'Bitte kurz warten.'],
  ACTION_FAILED: ['action', false, 'Die Aktion konnte nicht abgeschlossen werden. Bitte erneut versuchen.']
};

/** @typedef {keyof typeof definitions} ErrorCode */
/** @typedef {{code: ErrorCode, category: ErrorCategory, retryable: boolean, message: string, status?: number}} ErrorPayload */
/** @param {unknown} value @returns {value is ErrorCode} */
const knownCode = value => typeof value === 'string' && Object.hasOwn(definitions, value);
/** @param {unknown} value @returns {Record<string, unknown>} */
const fields = value => value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};

/** @param {ErrorCode} code @param {unknown} [status] @returns {Error & ErrorPayload} */
export function fault(code, status) {
  if (!Object.hasOwn(definitions, code)) code = 'ACTION_FAILED';
  const [category, retryable, message] = definitions[code];
  return Object.assign(new Error(message), { code, category, retryable,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}) });
}

/** @param {unknown} input @param {ErrorCode} [fallback] @returns {Error & ErrorPayload} */
export function normalizeError(input, fallback = 'ACTION_FAILED') {
  const value = fields(input);
  if (knownCode(value.code)) {
    // Category and retry policy belong to our code contract, not remote text.
    const error = fault(value.code, value.status);
    if (value.code === 'ACTION_FAILED' && typeof value.message === 'string') error.message = value.message.slice(0, 500);
    return error;
  }
  const message = String(value.message || input || '');
  let code = fallback;
  if (value?.name === 'AbortError') code = 'ABORTED';
  else if (value?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(message)) code = 'TIMEOUT';
  else if (/failed to fetch|fetch failed|networkerror|network error|network request failed|load failed/i.test(message)) code = 'NETWORK_ERROR';
  else if (/receiving end does not exist|message port closed|extension context invalidated/i.test(message)) code = 'RUNTIME_UNAVAILABLE';
  else if (/Der Raum wurde beendet/i.test(message)) code = 'ROOM_CLOSED';
  else if (/Raum nicht gefunden|bereits beendet/i.test(message)) code = 'ROOM_NOT_FOUND';
  else if (/zwei Personen belegt/i.test(message)) code = 'ROOM_FULL';
  else if (/Sitzung ist beendet/i.test(message)) code = 'SESSION_ENDED';
  else if (/Zugriff.*nicht erlaubt|Freigabe.*nicht erteilt|user gesture/i.test(message)) code = 'PERMISSION_DENIED';
  else if (/Serveradresse/i.test(message)) code = 'INVALID_SERVER';
  else if (/Verbindungsserver.*Version/i.test(message)) code = 'INCOMPATIBLE_PROTOCOL';
  else if (/Zu viele Anfragen|\(429\)/i.test(message)) code = 'RATE_LIMITED';
  else if (/ausgelastet/i.test(message)) code = 'SERVER_BUSY';
  const error = fault(code, value?.status);
  if (code === 'ACTION_FAILED' && message) error.message = message.slice(0, 500);
  return error;
}

/** @param {unknown} value @returns {ErrorPayload} */
export function errorPayload(value) {
  const { code, category, retryable, message, status } = normalizeError(value);
  return { code, category, retryable, message, ...(status ? { status } : {}) };
}

/** @param {unknown} value @returns {{ok: false, error: string, failure: ErrorPayload}} */
export function errorResponse(value) {
  const failure = errorPayload(value);
  // Keep the historical string for older runtimes and tools.
  return { ok: false, error: failure.message, failure };
}

/** @param {unknown} input @param {ErrorCode} [fallback] @returns {Error & ErrorPayload} */
export function responseError(input, fallback = 'RUNTIME_UNAVAILABLE') {
  const response = fields(input);
  if (typeof fields(response.failure).code === 'string') return normalizeError(response.failure);
  if (typeof response?.error === 'string' && response.error) return normalizeError(response.error);
  return fault(fallback);
}

/** @param {unknown} input @param {number} status @returns {Error & ErrorPayload} */
export function httpError(input, status) {
  const response = fields(input), failure = fields(response.failure);
  // A server names a code; the text shown to the person is always our own.
  // Even ACTION_FAILED never carries a server-supplied message.
  if (knownCode(failure.code)) return fault(failure.code, status);
  /** @type {Partial<Record<number, ErrorCode>>} */
  const httpCodes = { 401: 'SESSION_ENDED', 403: 'PERMISSION_DENIED', 404: 'ROOM_NOT_FOUND',
    408: 'TIMEOUT', 409: 'POLL_CONFLICT', 429: 'RATE_LIMITED' };
  const fallback = httpCodes[status] || (status >= 500 ? 'SERVER_ERROR' : 'INVALID_RESPONSE');
  return normalizeError({ message: response?.error, status }, fallback);
}
