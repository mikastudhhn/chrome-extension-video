import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdir, readFile, rename, statfs as fsStatfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKey } from './error-log.js';

// Server load for the admin dashboard (scripts/admin.js, docs/hosting.md):
// `<directory>/live.json` every 15 seconds and hourly peaks and averages in
// `<directory>/load/<UTC day>.json`, kept 30 days (usage-stats.js prunes).
// Process, container and host figures and aggregate room counts only.
export const LOAD_LIMITS = Object.freeze({ loadDays: 30, flushMs: 300_000, eventLoopResolutionMs: 10 });
export const LOAD_PEAKS = Object.freeze(['activeRooms', 'joinedRooms', 'activeMembers', 'parkedPolls', 'inFlight', 'connections',
  'relayCpuPercent', 'rssMB', 'eventLoopP99Ms', 'eventLoopMaxMs', 'hostCpuPercent', 'hostMemoryPercent']);
export const LOAD_AVERAGES = Object.freeze(['relayCpuPercent', 'eventLoopUtilization', 'hostCpuPercent', 'hostStealPercent', 'hostMemoryPercent']);

const MB = 1048576;
const round = (value, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const iso = at => new Date(at).toISOString();

// Linux sources; on other systems (development) the figures stay null.
export function parseProcStat(text) {
  const rows = text.split('\n');
  const line = rows.find(row => row.startsWith('cpu '));
  if (!line) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  return { busy: user + nice + system + irq + softirq + steal, idle: idle + iowait, steal, cpus: rows.filter(row => /^cpu\d+ /.test(row)).length };
}
export function parseMeminfo(text) {
  const kilobytes = name => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
  const total = kilobytes('MemTotal'), available = kilobytes('MemAvailable');
  return total > 0 && Number.isFinite(available) ? { total: total * 1024, available: available * 1024 } : null;
}
// cgroup v2 `cpu.max` ("quota period" or "max period") in cores, null without a limit.
export function parseCpuMax(text) {
  const [quota, period] = text.trim().split(/\s+/).map(Number);
  return quota > 0 && period > 0 ? quota / period : null;
}
const parseBytes = text => { const value = Number(text.trim()); return Number.isFinite(value) ? value : null; }; // `max` → null

// The histogram records timer intervals; the delay is what exceeds the resolution.
function eventLoopMonitor(resolution = LOAD_LIMITS.eventLoopResolutionMs) {
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  let utilization = performance.eventLoopUtilization();
  const delay = value => Math.max(0, value / 1e6 - resolution);
  return {
    read() {
      const next = performance.eventLoopUtilization();
      const result = { p99Ms: histogram.count ? delay(histogram.percentile(99)) : 0, maxMs: histogram.count ? delay(histogram.max) : 0,
        utilization: performance.eventLoopUtilization(next, utilization).utilization };
      utilization = next;
      histogram.reset();
      return result;
    },
    stop() { histogram.disable(); }
  };
}

export class LoadMetrics {
  constructor({ directory = null, now = Date.now, rooms, counters, connections = () => 0, limits = {}, commit = 'unknown',
    incidents = () => ({}), statfs = fsStatfs, read = path => readFile(path, 'utf8'), cpuUsage = () => process.cpuUsage(),
    memory = () => process.memoryUsage(), eventLoop = null, report = console.error } = {}) {
    Object.assign(this, { directory, now, rooms, counters, connections, limits, commit, incidents, statfs, read, cpuUsage, memory, report });
    this.eventLoop = eventLoop || eventLoopMonitor();
    this.startedAt = now();
    this.current = null; // latest live snapshot
    this.values = {}; // latest figures, flat
    this.previous = null;
    this.day = dayKey(this.startedAt);
    this.hours = {};
    this.flushedAt = this.startedAt;
    this.writing = Promise.resolve();
    this.failing = false;
  }

  get loadDirectory() { return this.directory && join(this.directory, 'load'); }
  dayPath() { return join(this.loadDirectory, `${this.day}.json`); }

  // Continues today's hours after a restart.
  async start() {
    if (!this.directory) return;
    await mkdir(this.loadDirectory, { recursive: true });
    const previous = await readFile(join(this.loadDirectory, `${this.day}.json`), 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.schema === 1 && previous.day === this.day && previous.hours && typeof previous.hours === 'object') {
      for (const [hour, entry] of Object.entries(previous.hours)) {
        if (!/^\d{2}$/.test(hour) || !entry || typeof entry !== 'object') continue;
        const sums = {}, weights = {};
        for (const key of LOAD_AVERAGES) {
          const weight = entry.weights?.[key], average = entry.averages?.[key];
          if (Number.isFinite(weight) && Number.isFinite(average)) { sums[key] = average * weight; weights[key] = weight; }
        }
        const peaks = Object.fromEntries(LOAD_PEAKS.filter(key => Number.isFinite(entry.peaks?.[key])).map(key => [key, entry.peaks[key]]));
        this.hours[hour] = { samples: Number.isFinite(entry.samples) ? entry.samples : 0, peaks, sums, weights };
      }
    }
  }

  async stop() {
    this.eventLoop.stop();
    if (this.directory) await this.write(this.dayFile(), this.dayPath());
  }

  // Every 15 seconds from the server's cleanup timer.
  async sample() {
    if (this.sampling) return; // a slow disk must not overlap two samples
    this.sampling = true;
    try { await this.measure(); } finally { this.sampling = false; }
  }

  async measure() {
    const at = this.now();
    const ignore = () => null;
    const [stat, meminfo, load1, cpuLimit, memoryCurrent, memoryLimit, diskFree] = await Promise.all([
      this.read('/proc/stat').then(parseProcStat, ignore),
      this.read('/proc/meminfo').then(parseMeminfo, ignore),
      this.read('/proc/loadavg').then(text => round(Number(text.split(' ')[0]), 2), ignore),
      this.read('/sys/fs/cgroup/cpu.max').then(parseCpuMax, ignore),
      this.read('/sys/fs/cgroup/memory.current').then(parseBytes, ignore),
      this.read('/sys/fs/cgroup/memory.max').then(parseBytes, ignore),
      this.directory ? this.statfs(this.directory).then(({ bavail, bsize }) => Number(bavail) * Number(bsize), ignore) : null
    ]);
    const cpu = this.cpuUsage(), memory = this.memory(), loop = this.eventLoop.read();
    const previous = this.previous;
    this.previous = { at, cpu, stat };
    const elapsedMs = previous ? at - previous.at : 0;
    const relayCpuPercent = elapsedMs > 0 ? (cpu.user + cpu.system - previous.cpu.user - previous.cpu.system) / 10 / elapsedMs : null;
    let hostCpuPercent = null, hostStealPercent = null;
    const total = stat && previous?.stat ? stat.busy + stat.idle - previous.stat.busy - previous.stat.idle : 0;
    if (total > 0) {
      hostCpuPercent = (stat.busy - previous.stat.busy) / total * 100;
      hostStealPercent = (stat.steal - previous.stat.steal) / total * 100;
    }
    const status = this.rooms.status();
    this.current = {
      schema: 1, at: iso(at), commit: this.commit, startedAt: iso(this.startedAt),
      rooms: { activeRooms: status.activeRooms, joinedRooms: status.joinedRooms, activeMembers: status.activeMembers,
        parkedPolls: status.parkedPolls, queuedMB: round(status.queuedBytes / MB, 2) },
      requests: { inFlight: this.counters.inFlight, connections: this.connections() },
      relay: { cpuPercent: round(relayCpuPercent), cpuLimitCores: cpuLimit, rssMB: round(memory.rss / MB), heapMB: round(memory.heapUsed / MB),
        memoryMB: memoryCurrent === null ? null : round(memoryCurrent / MB), memoryLimitMB: memoryLimit === null ? null : round(memoryLimit / MB),
        eventLoopP99Ms: round(loop.p99Ms), eventLoopMaxMs: round(loop.maxMs), eventLoopUtilization: round(loop.utilization, 3) },
      host: { cpus: stat?.cpus || null, cpuPercent: round(hostCpuPercent), stealPercent: round(hostStealPercent), load1,
        memoryTotalMB: meminfo ? Math.round(meminfo.total / MB) : null, memoryAvailableMB: meminfo ? Math.round(meminfo.available / MB) : null,
        diskFreeMB: diskFree === null ? null : Math.round(diskFree / MB) },
      limits: this.limits, incidents: this.incidents()
    };
    const { rooms, requests, relay, host } = this.current;
    this.values = { ...rooms, ...requests, relayCpuPercent: relay.cpuPercent, rssMB: relay.rssMB, eventLoopP99Ms: relay.eventLoopP99Ms,
      eventLoopMaxMs: relay.eventLoopMaxMs, eventLoopUtilization: relay.eventLoopUtilization, hostCpuPercent: host.cpuPercent,
      hostStealPercent: host.stealPercent, hostMemoryPercent: meminfo ? round((meminfo.total - meminfo.available) / meminfo.total * 100) : null };
    const day = dayKey(at);
    if (day !== this.day) {
      if (this.directory) void this.write(this.dayFile(), this.dayPath());
      Object.assign(this, { day, hours: {}, flushedAt: at });
    }
    this.aggregate(new Date(at).toISOString().slice(11, 13), this.values);
    if (!this.directory) return;
    const writes = [this.write(this.current, join(this.directory, 'live.json'))];
    if (at - this.flushedAt >= LOAD_LIMITS.flushMs) { this.flushedAt = at; writes.push(this.write(this.dayFile(), this.dayPath())); }
    await Promise.all(writes);
  }

  aggregate(hour, values) {
    const entry = this.hours[hour] ??= { samples: 0, peaks: {}, sums: {}, weights: {} };
    entry.samples++;
    for (const key of LOAD_PEAKS) if (Number.isFinite(values[key])) entry.peaks[key] = Math.max(entry.peaks[key] ?? 0, values[key]);
    for (const key of LOAD_AVERAGES) {
      if (!Number.isFinite(values[key])) continue;
      entry.sums[key] = (entry.sums[key] ?? 0) + values[key];
      entry.weights[key] = (entry.weights[key] ?? 0) + 1;
    }
  }

  dayFile() {
    const hours = Object.fromEntries(Object.entries(this.hours).sort(([a], [b]) => a.localeCompare(b)).map(([hour, entry]) => [hour, {
      samples: entry.samples, peaks: { ...entry.peaks }, weights: { ...entry.weights },
      averages: Object.fromEntries(Object.entries(entry.sums).map(([key, sum]) => [key, round(sum / entry.weights[key], 3)]))
    }]));
    return { schema: 1, day: this.day, commit: this.commit, updatedAt: iso(this.now()), hours };
  }

  // Atomic replace, serialized; a broken volume is reported once until it recovers.
  write(value, file) {
    this.writing = this.writing.then(async () => {
      await mkdir(this.loadDirectory, { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(value)}\n`);
      await rename(`${file}.tmp`, file);
      this.failing = false;
    }).catch(error => {
      if (!this.failing) this.report(`Lastwerte nicht geschrieben: ${error.message}`);
      this.failing = true;
    });
    return this.writing;
  }
}
