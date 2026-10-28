import { mkdir, readFile, readdir, rename, rm, statfs as fsStatfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKey } from './error-log.js';

// Daily usage sums in `<directory>/usage/<UTC day>.json`: only the fixed
// counter categories of OperatingCounters plus peaks. Nothing per person,
// address, room or request. Without a directory everything stays in memory.
export const USAGE_LIMITS = Object.freeze({
  flushMs: 300_000, // a crash loses at most five minutes of counts
  usageDays: 400,
  errorDays: 30, // error log and error reports
  incidentMs: 86_400_000, // /health reports incidents of the last 24 hours
  limitedPerHour: 500, // rejected by admission limits: likely a bot or an attack
  diskFreeMB: 1024,
  rssMB: 200 // the container limit is 256 MB
});
// Reasons are fixed words; /health exposes their latest time only.
export const INCIDENTS = Object.freeze(['error', 'crash', 'limits', 'capacity', 'disk', 'memory', 'report']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// a - b, key by key; counters only grow within one process.
export function difference(a, b = {}) {
  return Object.fromEntries(Object.entries(a).map(([key, value]) =>
    [key, isRecord(value) ? difference(value, isRecord(b[key]) ? b[key] : {}) : value - (Number.isFinite(b[key]) ? b[key] : 0)]));
}
export function sum(a = {}, b = {}) {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    result[key] = isRecord(value) ? sum(isRecord(a[key]) ? a[key] : {}, value) : (Number.isFinite(a[key]) ? a[key] : 0) + value;
  }
  return result;
}
const emptyPeaks = () => ({ activeRooms: 0, joinedRooms: 0, activeMembers: 0, rssMB: 0 });

export class UsageStats {
  constructor({ directory = null, now = Date.now, counters, rooms, commit = 'unknown', statfs = fsStatfs,
    rss = () => process.memoryUsage().rss, report = console.error } = {}) {
    Object.assign(this, { directory, now, counters, rooms, commit, statfs, rss, report });
    this.incidents = {};
    this.writing = Promise.resolve();
    this.begin(dayKey(now()), { starts: 1 });
    this.hour = { at: now(), limited: 0, busy: 0, alerted: new Set() };
  }

  begin(day, { carried = {}, peaks = emptyPeaks(), starts = 0, crashes = 0, minDiskFreeMB = null } = {}) {
    Object.assign(this, { day, carried, peaks, starts, crashes, minDiskFreeMB, base: this.counters.totals(), flushedAt: this.now() });
  }

  get usageDirectory() { return this.directory && join(this.directory, 'usage'); }
  get marker() { return this.directory && join(this.directory, 'running'); }

  // Continues today's file after a restart. A marker left by a process that
  // did not shut down cleanly (crash, OOM kill) counts as a crash incident.
  async start() {
    if (!this.directory) return;
    await mkdir(this.usageDirectory, { recursive: true });
    const previous = await readFile(join(this.usageDirectory, `${this.day}.json`), 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.schema === 1 && previous.day === this.day && isRecord(previous.totals)) {
      this.begin(this.day, { carried: previous.totals, peaks: { ...emptyPeaks(), ...previous.peaks },
        starts: (previous.starts || 0) + 1, crashes: previous.crashes || 0, minDiskFreeMB: previous.minDiskFreeMB ?? null });
    }
    if (await readFile(this.marker).then(() => true, () => false)) { this.crashes++; this.incident('crash'); }
    await writeFile(this.marker, `${new Date(this.now()).toISOString()}\n`);
    await this.prune();
    await this.flush();
  }

  async stop() {
    await this.flush();
    if (this.marker) await rm(this.marker, { force: true });
  }

  incident(reason) { if (INCIDENTS.includes(reason)) this.incidents[reason] = this.now(); }

  recentIncidents() {
    const since = this.now() - USAGE_LIMITS.incidentMs;
    return Object.fromEntries(Object.entries(this.incidents).filter(([, at]) => at >= since));
  }

  // Every 15 seconds from the server's cleanup timer.
  tick() {
    const now = this.now();
    if (dayKey(now) !== this.day) {
      const finished = this.summary();
      this.begin(dayKey(now));
      this.write(finished);
      void this.prune();
    }
    const status = this.rooms.status();
    const rssMB = Math.round(this.rss() / 1048576);
    for (const [key, value] of Object.entries({ activeRooms: status.activeRooms, joinedRooms: status.joinedRooms, activeMembers: status.activeMembers, rssMB })) {
      this.peaks[key] = Math.max(this.peaks[key] || 0, value);
    }
    if (rssMB > USAGE_LIMITS.rssMB) this.incident('memory');
    // Rolling hour for admission limits and capacity refusals.
    const limited = Object.values(this.counters.limited).reduce((total, value) => total + value, 0);
    const busy = this.counters.codes.SERVER_BUSY || 0;
    if (now - this.hour.at >= 3_600_000) this.hour = { at: now, limited, busy, alerted: new Set() };
    if (limited - this.hour.limited >= USAGE_LIMITS.limitedPerHour) this.alertOnce('limits');
    if (busy > this.hour.busy) this.alertOnce('capacity');
    if (now - this.flushedAt >= USAGE_LIMITS.flushMs) void this.flush();
  }

  alertOnce(reason) {
    if (this.hour.alerted.has(reason)) return;
    this.hour.alerted.add(reason);
    this.incident(reason);
  }

  summary() {
    return { schema: 1, day: this.day, commit: this.commit, updatedAt: new Date(this.now()).toISOString(),
      starts: this.starts, crashes: this.crashes, totals: sum(this.carried, difference(this.counters.totals(), this.base)),
      peaks: { ...this.peaks }, minDiskFreeMB: this.minDiskFreeMB };
  }

  async flush() {
    this.flushedAt = this.now();
    if (!this.directory) return;
    try {
      const { bavail, bsize } = await this.statfs(this.directory);
      const free = Math.round(Number(bavail) * Number(bsize) / 1048576);
      this.minDiskFreeMB = this.minDiskFreeMB === null ? free : Math.min(this.minDiskFreeMB, free);
      if (free < USAGE_LIMITS.diskFreeMB) this.incident('disk');
    } catch { /* free space is informative only */ }
    await this.write(this.summary());
  }

  // Atomic replace; writes are serialized so a slow disk cannot reorder days.
  write(summary) {
    if (!this.directory) return Promise.resolve();
    const file = join(this.usageDirectory, `${summary.day}.json`);
    this.writing = this.writing.then(async () => {
      await mkdir(this.usageDirectory, { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(summary)}\n`);
      await rename(`${file}.tmp`, file);
    }).catch(error => this.report(`Nutzungsstatistik nicht geschrieben: ${error.message}`));
    return this.writing;
  }

  async prune() {
    if (!this.directory) return;
    const today = Date.parse(`${this.day}T00:00:00Z`);
    for (const [folder, days] of [['usage', USAGE_LIMITS.usageDays], ['errors', USAGE_LIMITS.errorDays], ['reports', USAGE_LIMITS.errorDays]]) {
      const names = await readdir(join(this.directory, folder)).catch(() => []);
      for (const name of names) {
        const day = /^(\d{4}-\d{2}-\d{2})(?:-[A-Z2-9]{4}-[A-Z2-9]{4})?\.jsonl?$/.exec(name)?.[1];
        if (day && today - Date.parse(`${day}T00:00:00Z`) >= days * 86_400_000) await rm(join(this.directory, folder, name), { force: true });
      }
    }
  }
}
