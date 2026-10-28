// A report the person sends on purpose (Einstellungen → Synchronisationsdiagnose).
// Shared by the extension, which builds it, and the relay, which selects the
// same fields again before storing it: enumerated states, numbers, booleans,
// the filtered diagnostic events, versions and the person's own note. Never
// URLs, titles, room codes, tokens, tab/player/media IDs or page content.
import { serializeDiagnosticReport } from './diagnostics.js';
import { fault, httpError, normalizeError } from './runtime-errors.js';

export const REPORT_LIMITS = Object.freeze({ noteChars: 500, bodyBytes: 49_152, timeoutMs: 10_000 });
export const REPORT_ID = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const PHASES = ['disconnected', 'connecting', 'aligning', 'synced', 'interrupted', 'ended'];
const PLATFORMS = ['mac', 'windows', 'linux', 'chromeos', 'other'];
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(value) ? value : undefined;
const version = value => typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}){2,3}$/.test(value) ? value : undefined;
const bool = value => typeof value === 'boolean' ? value : undefined;
const whole = (value, max) => Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined;
const oneOf = list => value => list.includes(value) ? value : undefined;
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const SESSION = {
  phase: oneOf(PHASES), playerBound: bool, inRoom: bool, role: oneOf(['host', 'guest']), connected: bool, reconnecting: bool,
  syncPhase: name, rttMs: value => whole(value, 59_999), adapter: oneOf(['html5', 'netflix', 'other']),
  paused: bool, buffering: bool, blocked: bool,
  notice: value => typeof value === 'string' && fault(value).code === value ? value : undefined
};
const cleanSession = session => compact(Object.fromEntries(Object.entries(SESSION).map(([key, check]) => [key, check(session?.[key])])));

// Which build sent it; the same label the relay counts for room seats.
export function clientInfo(manifest, build, store) {
  return compact({ version: version(manifest?.version),
    distribution: store ? 'chrome-web-store' : build?.local ? 'development' : build?.source ? 'source' : 'github',
    channel: name(build?.channel) });
}

export function browserInfo(navigator = globalThis.navigator) {
  const brand = navigator?.userAgentData?.brands?.find(item => /^(Google Chrome|Chromium)$/.test(item.brand))?.version;
  const chrome = Number(brand || /Chrome\/(\d+)/.exec(navigator?.userAgent || '')?.[1]);
  const platform = String(navigator?.userAgentData?.platform || navigator?.platform || '').toLowerCase();
  return compact({ chrome: whole(chrome, 999),
    platform: /mac/.test(platform) ? 'mac' : /win/.test(platform) ? 'windows' : /cros|chrome os/.test(platform) ? 'chromeos' : /linux/.test(platform) ? 'linux' : 'other' });
}

// Popup/session status reduced to states that explain a failure.
export function sessionInfo(status) {
  const room = status?.room, local = status?.local;
  return cleanSession({ phase: status?.lifecycle?.phase, playerBound: status?.lifecycle?.playerBound, inRoom: !!room,
    role: room?.role, connected: room?.connected, reconnecting: room?.reconnecting, syncPhase: room?.state?.phase, rttMs: room?.rtt,
    adapter: local ? (local.adapter === 'HTML5' ? 'html5' : /netflix/i.test(local.adapter || '') ? 'netflix' : 'other') : undefined,
    paused: local?.paused, buffering: local?.buffering, blocked: local?.blocked, notice: status?.noticeError?.code });
}

export function sanitizeErrorReport(input) {
  if (input?.schema !== 1) throw fault('INVALID_MESSAGE', 400);
  let diagnostics;
  try { diagnostics = JSON.parse(serializeDiagnosticReport(input.diagnostics)); } catch { throw fault('INVALID_MESSAGE', 400); }
  // Control characters are removed; line breaks and tabs stay.
  const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, REPORT_LIMITS.noteChars) : '';
  return { schema: 1,
    client: compact({ version: version(input.client?.version), distribution: name(input.client?.distribution), channel: name(input.client?.channel) }),
    browser: compact({ chrome: whole(input.browser?.chrome, 999), platform: oneOf(PLATFORMS)(input.browser?.platform) }),
    session: cleanSession(input.session), diagnostics, ...(note ? { note } : {}) };
}

export function buildErrorReport({ diagnostics, status, client, browser, note }) {
  return sanitizeErrorReport({ schema: 1, client, browser, session: sessionInfo(status), diagnostics, note });
}

// Returns the report ID the person passes on, e.g. "K7Q2-9F3D".
export async function sendErrorReport(origin, report, fetchImpl = fetch) {
  let response, body;
  try {
    response = await fetchImpl(`${origin}/reports`, { method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(report),
      signal: AbortSignal.timeout(REPORT_LIMITS.timeoutMs) });
    body = await response.json().catch(() => null);
  } catch (error) { throw normalizeError(error, 'NETWORK_ERROR'); }
  if (!response.ok) throw httpError(body, response.status);
  if (body?.ok !== true || !REPORT_ID.test(body.id)) throw fault('INVALID_RESPONSE');
  return { id: body.id };
}
