import { Diagnostics } from './diagnostics.js';
import { PROTOCOL } from './protocol.js';
import { errorResponse } from './runtime-errors.js';
import { Connection } from './connection.js';
import { SessionLifecycle } from './session-lifecycle.js';
// Only the local builder enables session checkpoints for development reloads.
const DEVELOPMENT = false;

const diagnostics = new Diagnostics();
const session = new SessionLifecycle({
  diagnose: (kind, fields) => diagnostics.record(kind, fields),
  development: DEVELOPMENT,
  requestPlayer: message => chrome.runtime.sendMessage({ ...message, target: 'background', type: 'player' }),
  connect: (...args) => new Connection(...args),
  changed: () => { void chrome.runtime.sendMessage({ target: 'session-observers', type: 'session-changed' }).catch(() => {}); }
});
export const status = () => ({ ...session.status(), diagnosticsAvailable: true });
export const observePlayerStatus = () => session.handle({ action: 'status', observePlayer: true });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // The only message accepted from a web page context: this extension's own
  // bridge in the connected video document. It carries no data; tab and
  // document come from Chrome's sender record and must match the selection.
  if (message?.target === 'offscreen' && message.action === 'player-wake' && sender.id === chrome.runtime.id && sender.tab) {
    session.playerWake({ tabId: sender.tab.id, documentId: sender.documentId });
    return;
  }
  if (sender.id !== chrome.runtime.id || (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) || message.target !== 'offscreen') return;
  if (message.action === 'diagnostics-export') {
    respond({ ok: true, result: diagnostics.export({ appVersion: message.appVersion, engineVersion: message.engineVersion, protocol: PROTOCOL }) });
    return;
  }
  if (message.action === 'diagnostics-clear') { diagnostics.clear(); respond({ ok: true, result: { cleared: true } }); return; }
  session.handle(message).then(result => respond({ ok: true, result: { ...result, diagnosticsAvailable: true } }), error => respond(errorResponse(error)));
  return true;
});
