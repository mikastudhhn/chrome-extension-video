// @ts-check
import { normalizeError } from './runtime-errors.js';

/** @param {unknown} value @returns {string} */
export function readableError(value) { return normalizeError(value).message; }

/**
 * @typedef {{action: 'create' | 'join', title: string, detail: string,
 *   retry: boolean, editServer: boolean, editInvitation: boolean}} RoomErrorView
 */
/** @param {unknown} error @param {'create' | 'join'} action @param {string} server @returns {RoomErrorView} */
export function describeRoomError(error, action, server) {
  const failure = normalizeError(error);
  const code = failure.code;
  let address = '', local = false;
  try { const url = new URL(server); address = url.host; local = ['localhost', '127.0.0.1'].includes(url.hostname); } catch {}
  const result = { action, title: action === 'join' ? 'Beitritt nicht möglich' : 'Raum konnte nicht erstellt werden',
    detail: readableError(failure), retry: failure.retryable, editServer: false, editInvitation: false };
  if (code === 'NETWORK_ERROR') return { ...result,
    title: local ? 'Lokaler Server nicht erreichbar' : 'Server nicht erreichbar', editServer: true,
    detail: local ? `Keine Verbindung zu ${address}. Prüfe, ob der lokale Server läuft, und versuche es erneut.`
      : `Keine Verbindung${address ? ` zu ${address}` : ''}. Prüfe deine Internetverbindung oder die Serveradresse.` };
  if (code === 'TIMEOUT') return { ...result, title: 'Server antwortet nicht', editServer: true,
    detail: 'Der Verbindungsaufbau dauert zu lange. Bitte kurz warten und erneut versuchen.' };
  if (code === 'ROOM_SETUP_UNCERTAIN') return { ...result, title: 'Verbindungsaufbau unklar', retry: false, editInvitation: action === 'join',
    detail: action === 'join' ? 'Der Beitritt könnte bereits erfolgt sein. Lass dir eine Einladung zu einem neuen Raum geben.'
      : 'Der Raum könnte bereits erstellt sein. Erstelle einen neuen Raum und teile nur dessen Einladung.' };
  if (code === 'ROOM_NOT_FOUND') return { ...result, title: 'Raum nicht gefunden', retry: false, editInvitation: true,
    detail: 'Diese Einladung ist nicht mehr gültig oder der Raum wurde beendet. Lass dir eine neue Einladung geben.' };
  if (code === 'ROOM_FULL') return { ...result, title: 'Dieser Raum ist voll', retry: false,
    detail: 'Es können genau zwei Personen teilnehmen. Bitte einen neuen Raum verwenden.' };
  if (code === 'PERMISSION_DENIED') return { ...result, title: 'Serverzugriff erlauben',
    detail: 'Ohne die Chrome-Freigabe kann keine Verbindung entstehen. Erneut versuchen und den Zugriff erlauben.' };
  if (code === 'INVALID_SERVER') return { ...result, title: 'Serveradresse prüfen', retry: false, editServer: true };
  if (code === 'INCOMPATIBLE_PROTOCOL') return { ...result, title: 'Server und Extension passen nicht zusammen', retry: false, editServer: true,
    detail: 'Bitte den Verbindungsserver aktualisieren oder die richtige Serveradresse verwenden.' };
  if (['RATE_LIMITED', 'SERVER_BUSY'].includes(code)) return { ...result, title: 'Bitte kurz warten',
    detail: 'Der Server ist gerade ausgelastet. Versuche es in einer Minute erneut.' };
  return result;
}
