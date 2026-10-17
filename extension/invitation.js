import { ROOM_CODE } from './protocol.js';
export function serverOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Bitte eine vollständige Serveradresse eingeben, zum Beispiel https://sync.example.de.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Verwende eine HTTPS-Serveradresse ohne Pfad oder einen lokalen Testserver.');
  }
  return url.origin;
}

export function parseInvitation(value, fallbackServer) {
  const text = value.trim();
  const compact = text.replace(/\s/g, '');
  if (ROOM_CODE.test(compact.toUpperCase())) return { code: compact.toUpperCase(), server: serverOrigin(fallbackServer) };
  const codes = [...text.matchAll(/^Raumcode:\s*(\S+)\s*$/gm)].filter(match => ROOM_CODE.test(match[1].toUpperCase()));
  const servers = [...text.matchAll(/^Server:\s*(\S+)\s*$/gm)];
  if (codes.length !== 1 || servers.length !== 1) throw new Error('Füge die vollständige Einladung oder den 6-stelligen Raumcode ein.');
  return { code: codes[0][1].toUpperCase(), server: serverOrigin(servers[0][1]) };
}

export function createInvitation(code, server) {
  if (!ROOM_CODE.test(code)) throw new Error('Der Raum ist noch nicht bereit.');
  return `Video Sync\nRaumcode: ${code}\nServer: ${serverOrigin(server)}`;
}
