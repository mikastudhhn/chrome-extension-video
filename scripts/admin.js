// `npm run admin [-- --port 8790] [-- --no-open]`: the admin dashboard (admin/)
// on this computer. It reads the relay's statistics over SSH with the
// read-only deploy/admin-read.sh (VIDEO_SYNC_SSH, default host alias
// `video-sync`; docs/hosting.md), so the server opens no port for it. The page
// listens on 127.0.0.1 only.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import { p95 } from './server-stats.js';
import { DELIVERY_BUCKETS, LATENCY_BUCKETS } from '../server/operating-counters.js';

export const ADMIN_LIMITS = Object.freeze({ port: 8790, overviewCacheMs: 60_000, liveCacheMs: 5_000, remoteTimeoutMs: 30_000 });
const SECTIONS = ['usage', 'load', 'live', 'errors', 'reports'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Static files by URL; nothing else is served.
const FILES = {
  '/': 'admin/index.html', '/app.js': 'admin/app.js', '/model.js': 'admin/model.js', '/charts.js': 'admin/charts.js',
  '/admin.css': 'admin/admin.css', '/tokens.css': 'extension/tokens.css', '/components.css': 'extension/components.css'
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin'
};

// The only commands the dashboard runs; a restricted key allows nothing else.
export const remoteCommand = (request, directory = '/opt/video-sync') => `${directory}/deploy/admin-read.sh ${request}`;

export function parseSections(text) {
  const sections = Object.fromEntries(SECTIONS.map(name => [name, []]));
  let current = null;
  for (const line of text.split('\n')) {
    const marker = /^--- (\w+)$/.exec(line);
    if (marker && Object.hasOwn(sections, marker[1])) { current = marker[1]; continue; }
    if (!current || !line.trim()) continue;
    try { sections[current].push(JSON.parse(line)); } catch { /* a line cut off while being written */ }
  }
  return sections;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numbers = (value, keys) => Object.fromEntries(keys.map(key => [key, Number.isFinite(value?.[key]) ? value[key] : 0]));
const sumOf = value => Object.values(record(value) ? value : {}).reduce((total, item) => total + (Number.isFinite(item) ? item : 0), 0);
const ACTORS = ['host', 'guest', 'other'];

// One usage file (server/usage-stats.js) in the fields the page shows.
export function normalizeDay(raw) {
  const t = record(raw.totals) ? raw.totals : {};
  return {
    day: raw.day, commit: raw.commit, starts: raw.starts ?? 0, crashes: raw.crashes ?? 0,
    rooms: numbers(t.rooms, ['created', 'joined', 'unusedInvitations', 'aligned', 'played']),
    durations: numbers(t.durations, ['under10m', 'under1h', 'under3h', 'longer']),
    closed: numbers(t.closed, ['leave', 'idle', 'expired', 'overflow', 'shutdown', 'other']),
    controls: Object.fromEntries(['play', 'pause', 'seek'].map(name => [name, numbers(t.controls?.[name], ACTORS)])),
    sync: numbers(t.sync, ['alignments', 'realignments', 'interruptions', 'resyncRequests', 'bufferingWaits']),
    playingMinutes: Math.round((Number.isFinite(t.playingMs) ? t.playingMs : 0) / 60_000),
    features: record(t.controls), // counted since the relay knows them
    deliveryP95: p95(t.delivery, DELIVERY_BUCKETS), apiP95: p95(t.apiLatency, LATENCY_BUCKETS),
    responses: numbers(t.responses, ['success', 'rejected', 'failed']),
    limited: record(t.limited) ? { ...t.limited } : {}, limitedTotal: sumOf(t.limited),
    unknownTraffic: t.traffic?.unknown ?? 0, codes: record(t.codes) ? { ...t.codes } : {}, clients: record(t.clients) ? { ...t.clients } : {},
    reports: Number.isFinite(t.reports) ? t.reports : 0, errorLogged: t.errorLog?.logged ?? 0,
    peaks: record(raw.peaks) ? { ...raw.peaks } : {}, minDiskFreeMB: raw.minDiskFreeMB ?? null
  };
}

// Hourly load files (server/load-metrics.js) as one sorted series.
export function normalizeHours(files) {
  const hours = [];
  for (const file of files) {
    if (file?.schema !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(file.day) || !record(file.hours)) continue;
    for (const [hour, entry] of Object.entries(file.hours)) {
      if (/^\d{2}$/.test(hour) && record(entry)) hours.push({ at: `${file.day}T${hour}:00:00Z`, peaks: { ...entry.peaks }, averages: { ...entry.averages } });
    }
  }
  return hours.sort((a, b) => a.at.localeCompare(b.at));
}

const reportSummary = report => ({ id: report.id, at: report.at, client: report.client, phase: report.session?.phase ?? null,
  notice: report.session?.notice ?? null, note: typeof report.note === 'string' ? report.note : '' });

export function buildOverview(sections, now = Date.now()) {
  const live = sections.live.at(-1) ?? null;
  return {
    generatedAt: new Date(now).toISOString(), live,
    days: sections.usage.filter(day => day?.schema === 1 && typeof day.day === 'string').sort((a, b) => a.day.localeCompare(b.day)).map(normalizeDay),
    hours: normalizeHours(sections.load),
    errors: sections.errors.filter(record).slice(-50).reverse(),
    reports: sections.reports.filter(report => record(report) && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(report.id))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).map(reportSummary)
  };
}

// Only requests addressed to this computer: a foreign Host header means
// another site resolved its name to 127.0.0.1 (DNS rebinding).
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

export function createAdminServer({ remote, now = Date.now, root = ROOT } = {}) {
  const cache = new Map();
  const cached = (key, ttl, load) => {
    const entry = cache.get(key);
    if (entry && (entry.pending || now() - entry.at < ttl)) return entry.promise;
    const promise = load();
    const next = { at: now(), promise, pending: true };
    cache.set(key, next);
    promise.then(() => { next.pending = false; next.at = now(); }, () => cache.delete(key));
    return promise;
  };
  return http.createServer(async (request, response) => {
    for (const [name, value] of Object.entries(HEADERS)) response.setHeader(name, value);
    const send = (status, type, body) => { response.setHeader('Content-Type', type); response.writeHead(status).end(body); };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    if (!LOCAL_HOST.test(request.headers.host || '')) { json(421, { error: 'Nur über 127.0.0.1 erreichbar.' }); return; }
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); json(405, { error: 'Nur GET.' }); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/overview') {
        const fresh = url.searchParams.has('fresh');
        if (fresh) cache.delete('overview');
        json(200, await cached('overview', ADMIN_LIMITS.overviewCacheMs, async () => buildOverview(parseSections(await remote(remoteCommand('overview'))), now())));
        return;
      }
      if (url.pathname === '/api/live') {
        const live = await cached('live', ADMIN_LIMITS.liveCacheMs, async () => parseSections(`--- live\n${await remote(remoteCommand('live'))}`).live.at(-1) ?? null);
        json(200, { live }); return;
      }
      if (url.pathname === '/api/report') {
        const id = String(url.searchParams.get('id') || '').toUpperCase();
        if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id)) { json(400, { error: 'Bericht-ID im Format K7Q2-9F3D.' }); return; }
        json(200, JSON.parse(await remote(remoteCommand(`report ${id}`)))); return;
      }
      const file = FILES[url.pathname];
      if (!file) { json(404, { error: 'Nicht gefunden.' }); return; }
      send(200, TYPES[extname(file)], await readFile(resolve(root, file)));
    } catch (error) {
      json(502, { error: `Server nicht lesbar: ${error.message}` });
    }
  });
}

// SSH with one shared connection, so refreshing does not log in again.
export function sshRemote(host, { controlDirectory } = {}) {
  const options = ['-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDirectory}/%C`, '-o', 'ControlPersist=120'];
  const run = command => new Promise((done, fail) => {
    execFile('ssh', [...options, host, command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: ADMIN_LIMITS.remoteTimeoutMs },
      (error, stdout, stderr) => error ? fail(new Error(stderr.trim() || error.message)) : done(stdout));
  });
  run.close = () => new Promise(done => execFile('ssh', [...options, '-O', 'exit', host], () => done()));
  return run;
}

export function parseArguments(argv) {
  const options = { port: ADMIN_LIMITS.port, open: true };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--no-open') options.open = false;
    else if (argv[index] === '--port') {
      options.port = Number(argv[++index]);
      if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('--port braucht eine Zahl von 1024 bis 65535.');
    } else throw new Error(`Unbekannte Option: ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const host = process.env.VIDEO_SYNC_SSH || 'video-sync';
  // A short path: macOS limits socket paths to 104 bytes.
  const controlDirectory = mkdtempSync('/tmp/vs-admin-');
  const remote = sshRemote(host, { controlDirectory });
  const server = createAdminServer({ remote });
  const stop = async () => { server.close(); await remote.close(); rmSync(controlDirectory, { recursive: true, force: true }); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('error', error => { console.error(`Dashboard nicht gestartet: ${error.message}`); process.exit(1); });
  server.listen(options.port, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${options.port}/`;
    console.log(`Admin-Dashboard: ${address} (Daten über ssh ${host}). Beenden mit Strg+C.`);
    if (options.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [address], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  });
}
