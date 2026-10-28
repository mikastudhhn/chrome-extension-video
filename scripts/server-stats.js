// `npm run stats [-- --days 14] [-- --errors 10] [-- --json]`: daily usage sums,
// the latest error entries and error reports of the relay server, read over
// SSH (VIDEO_SYNC_SSH, default host alias `video-sync`; docs/hosting.md).
// `--reports` lists the latest reports, `--report K7Q2-9F3D` shows one.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DURATION_BUCKETS, DELIVERY_BUCKETS, LATENCY_BUCKETS } from '../server/operating-counters.js';

const SEPARATOR = '--- errors', REPORTS = '--- reports';
const REPORT_ID = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const container = (script, directory = '/opt/video-sync') =>
  `cd ${directory} && docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T app sh -c '${script}'`;
// Runs inside the app container; reads only the data volume.
export const remoteCommand = (errorDays, directory) => container(
  `for f in /data/usage/*.json; do [ -f "$f" ] && cat "$f"; done; echo "${SEPARATOR}"; ` +
  `ls /data/errors/*.jsonl 2>/dev/null | tail -n ${errorDays} | while read -r f; do cat "$f"; done; echo "${REPORTS}"; ` +
  'ls /data/reports/*.json 2>/dev/null | tail -n 20 | while read -r f; do cat "$f"; done', directory);
export function reportCommand(id, directory) {
  if (!REPORT_ID.test(id)) throw new Error('Bericht-ID im Format K7Q2-9F3D angeben.');
  return container(`cat /data/reports/*-${id}.json`, directory);
}

export function parseDump(text) {
  const [rest = '', reports = ''] = text.split(`${REPORTS}\n`);
  const [usage = '', errors = ''] = rest.split(`${SEPARATOR}\n`);
  const parse = block => block.split('\n').filter(line => line.trim()).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { days: parse(usage).filter(day => day.schema === 1).sort((a, b) => a.day.localeCompare(b.day)), errors: parse(errors),
    reports: parse(reports).filter(report => REPORT_ID.test(report.id)).sort((a, b) => a.at.localeCompare(b.at)) };
}

const total = values => Object.values(values || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
const labels = { under10m: '<10m', under1h: '<1h', under3h: '<3h', under10ms: '<10 ms', under50ms: '<50 ms', under200ms: '<200 ms',
  under250ms: '<250 ms', under1s: '<1 s', under5s: '<5 s', longer: '≥' };
// The bucket that contains the 95th percentile, e.g. "<250 ms".
export function p95(histogram, buckets) {
  const count = total(histogram);
  if (!count) return '–';
  let seen = 0;
  for (const [index, [name]] of buckets.entries()) {
    seen += histogram[name] || 0;
    if (seen >= count * 0.95) return name === 'longer' ? `≥${labels[buckets[index - 1][0]].slice(1)}` : labels[name];
  }
  return '–';
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => String(cell).padStart(column ? widths[column] : 0).padEnd(column ? 0 : widths[column])).join('  '));
}

export function renderDays(days) {
  if (!days.length) return ['Noch keine Nutzungsdaten.'];
  const rows = [['Tag', 'Räume', 'beigetr.', 'ungenutzt', 'max.', 'Dauer <10m/<1h/<3h/länger', 'Ende verl./inakt./abgel.',
    'Zustellung p95', 'API p95', 'Fehler', 'Limits', 'Unbek.', 'Starts/Abst.']];
  for (const day of days) {
    const t = day.totals || {};
    rows.push([day.day, t.rooms?.created ?? 0, t.rooms?.joined ?? 0, t.rooms?.unusedInvitations ?? 0, day.peaks?.joinedRooms ?? 0,
      DURATION_BUCKETS.map(([name]) => t.durations?.[name] ?? 0).join('/'),
      [t.closed?.leave ?? 0, t.closed?.idle ?? 0, t.closed?.expired ?? 0].join('/'),
      p95(t.delivery, DELIVERY_BUCKETS), p95(t.apiLatency, LATENCY_BUCKETS), t.responses?.failed ?? 0, total(t.limited),
      t.traffic?.unknown ?? 0, `${day.starts ?? 0}/${day.crashes ?? 0}`]);
  }
  const sums = key => days.reduce((result, day) => {
    for (const [name, value] of Object.entries(day.totals?.[key] || {})) result[name] = (result[name] || 0) + value;
    return result;
  }, {});
  const list = values => Object.entries(values).filter(([, value]) => value).sort((a, b) => b[1] - a[1])
    .map(([name, value]) => `${name} ${value}`).join(', ') || '–';
  const last = days.at(-1);
  return [...table(rows), '',
    `Extension-Versionen (Plätze): ${list(sums('clients'))}`,
    `Fehlercodes der Antworten: ${list(sums('codes'))}`,
    `Abgewiesen nach Limit: ${list(sums('limited'))}`,
    `Fehlerprotokoll: ${days.reduce((sum, day) => sum + (day.totals?.errorLog?.logged ?? 0), 0)} Einträge, ` +
      `${days.reduce((sum, day) => sum + (day.totals?.errorLog?.suppressed ?? 0), 0)} wegen Obergrenze nicht gespeichert`,
    `Zuletzt: Commit ${last.commit}, Arbeitsspeicher max. ${last.peaks?.rssMB ?? '–'} MB, freier Speicher min. ${last.minDiskFreeMB ?? '–'} MB, Stand ${last.updatedAt}`];
}

export function renderErrors(errors) {
  if (!errors.length) return ['Keine Fehlereinträge.'];
  return errors.flatMap(entry => {
    const head = `${entry.at}  ${entry.id}  ${entry.kind}${entry.code ? ` ${entry.code}` : ''}  ${entry.method || ''} ${entry.route || ''} ${entry.status || ''}`.trim();
    const detail = [];
    if (entry.error) detail.push(`${entry.error.name}: ${entry.error.message}`, ...(entry.error.stack || []).map(line => `  ${line}`));
    if (entry.member) detail.push(`Mitglied: ${JSON.stringify(entry.member)}`);
    if (entry.request) detail.push(`Anfrage: ${JSON.stringify(entry.request)}`);
    if (entry.server) detail.push(`Server: ${JSON.stringify(entry.server)}`);
    return [head, ...detail.map(line => `    ${line}`), ''];
  });
}

const client = value => [value?.distribution, value?.channel, value?.version].filter(Boolean).join('/') || 'unbekannt';
export function renderReports(reports) {
  if (!reports.length) return ['Keine Fehlerberichte.'];
  return reports.map(report => `${report.id}  ${report.at}  ${client(report.client)}  ${report.session?.phase || '–'}` +
    `${report.session?.notice ? ` ${report.session.notice}` : ''}  ${(report.note || '').replace(/\s+/g, ' ').slice(0, 60)}`);
}

// One report with its diagnostic timeline, for reproducing what happened.
export function renderReport(report) {
  const time = at => new Date(at).toISOString().slice(11, 23);
  const events = report.diagnostics?.events || [];
  return [`Fehlerbericht ${report.id} vom ${report.at}`,
    `Build: ${client(report.client)} · Chrome ${report.browser?.chrome ?? '?'} · ${report.browser?.platform ?? '?'} · Server ${report.server?.commit ?? '?'}`,
    `Zustand: ${Object.entries(report.session || {}).map(([key, value]) => `${key}=${value}`).join(' ') || '–'}`,
    `Notiz: ${report.note || '–'}`, '',
    `Diagnose (${events.length} Ereignisse, Protokoll ${report.diagnostics?.protocol ?? '?'}, Engine ${report.diagnostics?.engineVersion ?? '?'}):`,
    ...events.map(event => `  ${time(event.at)}  ${event.kind.padEnd(9)} ${Object.entries(event).filter(([key]) => !['at', 'kind'].includes(key))
      .map(([key, value]) => `${key}=${value}`).join(' ')}`)];
}

export function parseArguments(argv) {
  const options = { days: 14, errors: 10, json: false, reports: false, report: null };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--json') options.json = true;
    else if (name === '--reports') options.reports = true;
    else if (name === '--report') {
      options.report = String(argv[++index] || '').toUpperCase();
      if (!REPORT_ID.test(options.report)) throw new Error('--report braucht eine Bericht-ID im Format K7Q2-9F3D.');
    }
    else if (name === '--days' || name === '--errors') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 400) throw new Error(`${name} braucht eine Zahl von 0 bis 400.`);
      options[name.slice(2)] = value;
    } else throw new Error(`Unbekannte Option: ${name}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const host = process.env.VIDEO_SYNC_SSH || 'video-sync';
  const remote = command => {
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', host, command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      console.error(`Server nicht lesbar über ssh ${host}: ${result.error?.message || result.stderr.trim() || `Exit-Status ${result.status}`}`);
      process.exit(1);
    }
    return result.stdout;
  };
  if (options.report) {
    const report = JSON.parse(remote(reportCommand(options.report)));
    console.log(options.json ? JSON.stringify(report, null, 2) : renderReport(report).join('\n'));
  } else {
    // Error entries of the last seven days; the server keeps 30.
    const { days, errors, reports } = parseDump(remote(remoteCommand(7)));
    const shown = { days: days.slice(-options.days), errors: errors.slice(-options.errors), reports };
    if (options.json) console.log(JSON.stringify(shown, null, 2));
    else if (options.reports) console.log(renderReports(reports).join('\n'));
    else console.log([...renderDays(shown.days), '', `Letzte Fehlereinträge (${shown.errors.length}):`, ...renderErrors(shown.errors),
      `Letzte Fehlerberichte (${reports.length}, Details: npm run stats -- --report <ID>):`, ...renderReports(reports)].join('\n'));
  }
}
