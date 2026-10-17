// Session-local RAM only: no disk storage, content scripts, network or raw objects.
// Explicit field selection happens before retention. Unknown text is discarded.
import { fault } from './runtime-errors.js';
export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 200, bytes: 32768, retentionMs: 30 * 60_000 });
const kinds = ['phase', 'transport', 'pause', 'alignment', 'player', 'rtt', 'failure'];
const phases = ['disconnected', 'connecting', 'aligning', 'synced', 'interrupted', 'ended'];
const reasons = ['network', 'player-timeout', 'player-changed', 'navigation', 'user', 'peer', 'reload', 'buffering'];
const adapters = new Map([['HTML5', 'html5'], ['Netflix · experimentell', 'netflix'], ['html5', 'html5'], ['netflix', 'netflix']]);
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value) ? value : undefined;

export class Diagnostics {
  constructor({ now = Date.now, schedule = (...args) => globalThis.setTimeout(...args), unschedule = id => globalThis.clearTimeout(id) } = {}) {
    Object.assign(this, { now, schedule, unschedule, timer: null });
    this.events = [];
    this.lastRttAt = -Infinity;
  }

  record(kind, fields = {}) {
    this.prune();
    if (!kinds.includes(kind)) return;
    const at = this.now();
    if (kind === 'rtt' && at - this.lastRttAt < 10_000) return;
    const event = diagnosticEvent(at, kind, fields);
    if (Object.keys(event).length === 2) return;
    if (kind === 'rtt') this.lastRttAt = at;
    this.events.push(event);
    while (this.events.length > DIAGNOSTIC_LIMITS.events || JSON.stringify(this.events).length > DIAGNOSTIC_LIMITS.bytes) this.events.shift();
    this.scheduleExpiry();
  }

  scheduleExpiry() {
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
    if (!this.events.length) return;
    this.timer = this.schedule(() => { this.timer = null; this.prune(); this.scheduleExpiry(); },
      Math.max(1, this.events[0].at + DIAGNOSTIC_LIMITS.retentionMs - this.now()));
    this.timer?.unref?.();
  }

  prune() {
    const now = this.now();
    this.events = this.events.filter(event => event.at <= now && now - event.at < DIAGNOSTIC_LIMITS.retentionMs);
  }

  export({ appVersion, engineVersion, protocol } = {}) {
    this.prune();
    return { schema: 1, storage: 'session-memory', retentionMs: DIAGNOSTIC_LIMITS.retentionMs,
      appVersion: version(appVersion), engineVersion: version(engineVersion),
      protocol: Number.isInteger(protocol) && protocol > 0 && protocol < 100 ? protocol : undefined,
      events: this.events.map(event => ({ ...event })) };
  }

  clear() { this.events = []; this.lastRttAt = -Infinity; this.scheduleExpiry(); }
}

function diagnosticEvent(at, kind, fields) {
  const event = { at, kind };
  if (phases.includes(fields.phase)) event.phase = fields.phase;
  if (reasons.includes(fields.reason)) event.reason = fields.reason;
  if (adapters.has(fields.adapter)) event.adapter = adapters.get(fields.adapter);
  if (['send', 'receive', 'open'].includes(fields.lane)) event.lane = fields.lane;
  if (typeof fields.reconnecting === 'boolean') event.reconnecting = fields.reconnecting;
  if (Number.isFinite(fields.rttMs) && fields.rttMs >= 0 && fields.rttMs < 60_000) event.rttMs = Math.round(fields.rttMs);
  if (typeof fields.code === 'string' && fault(fields.code).code === fields.code) event.code = fields.code;
  return event;
}

// Re-select fields at the file boundary; never serialize UI/session status.
export function serializeDiagnosticReport(report) {
  if (report?.schema !== 1 || report.storage !== 'session-memory' || !Array.isArray(report.events)) throw new Error('Unsupported diagnostic report');
  const events = [];
  for (const source of report.events.slice(-DIAGNOSTIC_LIMITS.events)) {
    if (!source || !kinds.includes(source.kind) || !Number.isSafeInteger(source.at) || source.at < 0) continue;
    const event = diagnosticEvent(source.at, source.kind, source);
    if (Object.keys(event).length > 2) events.push(event);
  }
  while (JSON.stringify(events).length > DIAGNOSTIC_LIMITS.bytes) events.shift();
  return JSON.stringify({ schema: 1, storage: 'session-memory', retentionMs: DIAGNOSTIC_LIMITS.retentionMs,
    appVersion: version(report.appVersion), engineVersion: version(report.engineVersion),
    protocol: Number.isInteger(report.protocol) && report.protocol > 0 && report.protocol < 100 ? report.protocol : undefined,
    events }, null, 2) + '\n';
}
