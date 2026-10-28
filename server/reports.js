import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHORT_CODE_ALPHABET } from '../extension/protocol.js';
import { fault } from '../extension/runtime-errors.js';
import { dayKey } from './error-log.js';

// Error reports a person sent from the popup (extension/error-report.js), one
// file each in `<directory>/<UTC day>-<ID>.json`, kept 30 days (usage-stats.js).
export const REPORT_STORE_LIMITS = Object.freeze({ perDay: 200, recent: 20 });

// Eight characters from the invitation alphabet (no 0/O, 1/I), e.g. K7Q2-9F3D.
export function reportId(bytes = randomBytes(8)) {
  const text = [...bytes].map(byte => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4, 8)}`;
}

export class ReportStore {
  constructor({ directory = null, now = Date.now, counters = null, onIncident = () => {}, report = console.error } = {}) {
    Object.assign(this, { directory, now, counters, onIncident, report });
    this.recent = [];
    this.day = null;
    this.count = 0;
    this.written = Promise.resolve();
  }

  // `report` is already sanitized; `client` is the server's build label.
  save(report, server = {}) {
    const at = this.now();
    if (dayKey(at) !== this.day) { this.day = dayKey(at); this.count = 0; }
    if (this.count >= REPORT_STORE_LIMITS.perDay) throw fault('RATE_LIMITED', 429);
    this.count++;
    const id = reportId();
    const entry = { id, at: new Date(at).toISOString(), ...report, server };
    this.recent.push(entry);
    if (this.recent.length > REPORT_STORE_LIMITS.recent) this.recent.shift();
    if (this.counters) this.counters.reports++;
    if (this.directory) {
      const file = join(this.directory, `${this.day}-${id}.json`);
      this.written = this.written.then(() => mkdir(this.directory, { recursive: true }))
        .then(() => writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'wx' }))
        .catch(error => this.report(`Fehlerbericht nicht gespeichert: ${error.message}`));
    }
    this.onIncident('report');
    return id;
  }

  flush() { return this.written; }
}
