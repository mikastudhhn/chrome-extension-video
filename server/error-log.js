import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Technical error records for reproducing failures, one JSON line each in
// `<directory>/<UTC day>.jsonl`. Never addresses, tokens, room codes,
// request IDs or text sent by clients; see docs/hosting.md.
export const ERROR_LOG_LIMITS = Object.freeze({ perDay: 300, perSignature: 20, recent: 50, stackLines: 8, textBytes: 600, entryBytes: 8192 });
export const dayKey = at => new Date(at).toISOString().slice(0, 10);
const ROOT = fileURLToPath(new URL('../', import.meta.url)); // stack paths are relative to the project

// Defensive: messages and stacks should not contain request data, but nothing
// that looks like an address, a member token or a UUID is ever written.
export function scrub(text, limit = ERROR_LOG_LIMITS.textBytes) {
  return String(text ?? '').slice(0, limit)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '<ip>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(?<![\w-])[\w-]{43}(?![\w-])/g, '<token>');
}

export function describeError(error) {
  const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 1 + ERROR_LOG_LIMITS.stackLines)
    .map(line => scrub(line.trim().replaceAll(`file://${ROOT}`, '').replaceAll(ROOT, ''), 200)) : [];
  return { name: scrub(error?.name || typeof error, 60), message: scrub(error?.message ?? error), stack };
}

// Keys and protocol identifiers of a rejected payload. Numbers and booleans
// stay (time, sequence, flags); strings stay only under protocol keys that
// carry fixed identifiers, any other string reports its length.
const IDENTIFIER_KEYS = new Set(['type', 'kind', 'phase', 'reason', 'lane', 'code', 'role', 'storage',
  'capabilities', 'requiredCapabilities', 'distribution', 'channel', 'platform', 'adapter']);
export function shapeOf(value, depth = 0, key = '') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return IDENTIFIER_KEYS.has(key) && /^[a-z][a-z0-9.-]{0,31}$/.test(value) ? value : `<string:${value.length}>`;
  if (Array.isArray(value)) {
    if (depth >= 4) return `<array:${value.length}>`;
    return [...value.slice(0, 5).map(item => shapeOf(item, depth + 1, key)), ...(value.length > 5 ? [`<+${value.length - 5}>`] : [])];
  }
  if (typeof value === 'object') {
    if (depth >= 4) return '<object>';
    const keys = Object.keys(value);
    return Object.fromEntries([...keys.slice(0, 24).map(name => [scrub(name, 32), shapeOf(value[name], depth + 1, name)]),
      ...(keys.length > 24 ? [['<more>', keys.length - 24]] : [])]);
  }
  return `<${typeof value}>`;
}

export class ErrorLog {
  constructor({ directory = null, now = Date.now, counters = null, context = () => ({}), onIncident = () => {}, report = console.error } = {}) {
    Object.assign(this, { directory, now, counters, context, onIncident, report });
    this.recent = [];
    this.day = null;
    this.signatures = new Map();
    this.written = Promise.resolve();
  }

  // Unexpected exceptions: a code defect until proven otherwise.
  exception(error, details = {}) {
    this.onIncident('error');
    return this.record({ kind: 'exception', ...details, error: describeError(error) });
  }

  // Protocol rejections point at a client/server mismatch worth reproducing.
  rejected(code, details = {}) { return this.record({ kind: 'rejected', code, ...details }); }

  // Synchronous: the process exits right after an uncaught exception.
  crash(error) {
    this.onIncident('crash');
    const entry = this.entry({ kind: 'crash', error: describeError(error) }, 'crash');
    if (!entry || !this.directory) return entry?.id ?? null;
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(join(this.directory, `${dayKey(this.now())}.jsonl`), `${JSON.stringify(entry)}\n`);
    } catch (failure) { this.report(`Fehlerprotokoll nicht geschrieben: ${failure.message}`); }
    return entry.id;
  }

  record(details) {
    const entry = this.entry(details, [details.kind, details.code, details.route, details.error?.name, details.error?.stack?.[0]].join('|'));
    if (!entry) return null;
    if (this.directory) {
      const file = join(this.directory, `${dayKey(Date.parse(entry.at))}.jsonl`);
      this.written = this.written.then(() => mkdir(this.directory, { recursive: true }))
        .then(() => appendFile(file, `${JSON.stringify(entry)}\n`))
        .catch(failure => this.report(`Fehlerprotokoll nicht geschrieben: ${failure.message}`));
    }
    return entry.id;
  }

  // Bounded per UTC day and per signature, so a scanner cannot fill the disk.
  entry(details, signature) {
    const at = this.now();
    if (dayKey(at) !== this.day) { this.day = dayKey(at); this.signatures.clear(); }
    const seen = this.signatures.get(signature) || 0;
    const total = [...this.signatures.values()].reduce((sum, value) => sum + value, 0);
    if (seen >= ERROR_LOG_LIMITS.perSignature || total >= ERROR_LOG_LIMITS.perDay) {
      if (this.counters) this.counters.errorLog.suppressed++;
      return null;
    }
    this.signatures.set(signature, seen + 1);
    if (this.counters) this.counters.errorLog.logged++;
    let entry = { at: new Date(at).toISOString(), id: randomBytes(4).toString('hex'), ...details, server: this.context() };
    if (JSON.stringify(entry).length > ERROR_LOG_LIMITS.entryBytes) entry = { ...entry, request: { truncated: true } };
    this.recent.push(entry);
    if (this.recent.length > ERROR_LOG_LIMITS.recent) this.recent.shift();
    return entry;
  }

  flush() { return this.written; }
}
