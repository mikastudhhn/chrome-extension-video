// Admin dashboard page, served by scripts/admin.js on 127.0.0.1. Every value
// comes from the relay's aggregate statistics; all text goes through textContent.
import { bars, columns, lines, meter, tableView } from './charts.js';
import { PERIODS, LIVE_STALE_MS, VERDICTS, capacity, features, formatAge, formatDuration, formatNumber, formatPercent, funnel, liveAge, summarize } from './model.js';

const $ = id => document.getElementById(id);
const OVERVIEW_MS = 300_000, LIVE_MS = 15_000;
const COLORS = { host: 'var(--series-1)', guest: 'var(--series-2)', other: 'var(--series-3)' };
const ROLES = [{ key: 'host', label: 'Gastgeber', color: COLORS.host }, { key: 'guest', label: 'Gast', color: COLORS.guest }, { key: 'other', label: 'Automatisch', color: COLORS.other }];
const STATUS_ICON = { good: '✓', warning: '!', critical: '✕', neutral: '–' };
const state = { overview: null, live: null, period: 30 };

const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
theme();
dark.addEventListener('change', theme);

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const date = day => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;
const hourTitle = at => `${date(at.slice(0, 10))} ${at.slice(11, 13)}:00–${at.slice(11, 13)}:59 UTC`;

function status(parent, kind, label) {
  const badge = element('span', '', `status-badge status-${kind}`);
  badge.append(element('span', STATUS_ICON[kind], 'status-icon'), element('span', label));
  parent.append(badge);
  return badge;
}

function tile(parent, label, value, sub = '') {
  const box = element('div', '', 'tile');
  box.append(element('span', label, 'tile-label'), element('span', value, 'tile-value'));
  if (sub) box.append(element('span', sub, 'tile-sub'));
  parent.append(box);
}

function empty(parent, text) { parent.replaceChildren(element('p', text, 'hint')); }

function renderPeriods() {
  const group = $('periods');
  group.replaceChildren();
  for (const [days, label] of PERIODS) {
    const button = element('button', label, 'period');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(days === state.period));
    button.addEventListener('click', () => { state.period = days; renderPeriods(); render(); });
    group.append(button);
  }
}

function renderHeader() {
  const live = state.live ?? state.overview?.live;
  const age = liveAge(live, Date.now());
  const parts = [live ? `Commit ${live.commit}, gestartet ${new Date(live.startedAt).toLocaleString('de-DE')}` : 'Keine Live-Daten',
    `Statistik ${state.overview ? `vom ${new Date(state.overview.generatedAt).toLocaleTimeString('de-DE')}` : 'wird geladen'}`];
  $('server-line').textContent = parts.join(' · ');
  $('live-age').textContent = live ? `Stand ${formatAge(age)}` : '';
  const problem = $('problem');
  if (live && age > LIVE_STALE_MS) {
    problem.textContent = `Die Live-Werte sind ${formatAge(age)} geschrieben worden. Läuft der Relay? (docker compose ps auf dem Server)`;
    problem.hidden = false;
  } else if (!problem.dataset.error) problem.hidden = true;
}

function renderCapacity(summary, live) {
  const result = capacity(summary, live);
  const verdict = VERDICTS[result.verdict];
  const box = $('verdict');
  box.replaceChildren();
  status(box, verdict.status, verdict.title);
  box.append(element('p', result.refused ? `${verdict.text} ${result.refused} Anfragen wurden wegen Auslastung abgelehnt.` : verdict.text));
  const list = $('capacity');
  list.replaceChildren();
  for (const item of result.items) {
    const row = element('div', '', 'capacity-row');
    const kind = item.ratio === null ? 'neutral' : item.ratio >= 0.8 ? 'critical' : item.ratio >= 0.6 ? 'warning' : 'good';
    row.append(element('span', item.label, 'capacity-label'));
    meter(row, item.ratio, kind);
    const unit = item.unit ? ` ${item.unit}` : '';
    row.append(element('span', item.value === null ? '–' : `${formatNumber(item.value)}${unit} von ${formatNumber(item.limit)}${unit}`, 'capacity-value'),
      element('span', formatPercent(item.ratio), 'capacity-ratio'));
    if (item.note) row.title = item.note;
    list.append(row);
  }
}

function renderLive(live) {
  const box = $('live');
  box.replaceChildren();
  if (!live) { empty(box, 'Der Relay hat noch keine Live-Werte geschrieben.'); return; }
  const { rooms, requests, relay, host } = live;
  tile(box, 'Offene Räume', formatNumber(rooms.activeRooms), `${formatNumber(rooms.joinedRooms)} mit zwei Personen`);
  tile(box, 'Verbundene Personen', formatNumber(rooms.activeMembers));
  tile(box, 'Anfragen gerade', formatNumber(requests.inFlight), `${formatNumber(requests.connections)} Verbindungen`);
  tile(box, 'Relay-Prozessor', relay.cpuPercent === null ? '–' : `${formatNumber(relay.cpuPercent)} %`, relay.cpuLimitCores ? `Limit ${formatNumber(relay.cpuLimitCores)} Kern` : '');
  tile(box, 'Relay-Speicher', `${formatNumber(relay.rssMB)} MB`, relay.memoryLimitMB ? `Limit ${formatNumber(relay.memoryLimitMB)} MB` : '');
  tile(box, 'Wartezeit im Relay', `${formatNumber(relay.eventLoopP99Ms)} ms`, `p99, max. ${formatNumber(relay.eventLoopMaxMs)} ms`);
  tile(box, 'Server-Prozessor', host.cpuPercent === null ? '–' : `${formatNumber(host.cpuPercent)} %`,
    `${formatNumber(host.cpus)} Kerne${host.stealPercent ? `, ${formatNumber(host.stealPercent)} % vom Hoster belegt` : ''}`);
  const used = host.memoryTotalMB ? (host.memoryTotalMB - host.memoryAvailableMB) / host.memoryTotalMB : null;
  tile(box, 'Server-Speicher', formatPercent(used), host.memoryTotalMB ? `von ${formatNumber(host.memoryTotalMB / 1024)} GB` : '');
  tile(box, 'Freier Plattenplatz', host.diskFreeMB === null ? '–' : `${formatNumber(host.diskFreeMB / 1024)} GB`);
}

// Every hour of the period, so gaps (server down) stay visible.
function hourly(summary) {
  const byHour = new Map(summary.hours.map(hour => [hour.at, hour]));
  const start = Math.max(Date.parse(`${summary.from}T00:00:00Z`), Date.now() - 30 * 86_400_000);
  const first = summary.hours.find(hour => Date.parse(hour.at) >= start);
  if (!first) return [];
  const result = [];
  for (let at = Date.parse(first.at); at <= Date.now(); at += 3_600_000) {
    const key = new Date(at).toISOString().slice(0, 13) + ':00:00Z';
    result.push(byHour.get(key) ?? { at: key, peaks: {}, averages: {} });
  }
  return result;
}

function renderLoad(summary) {
  const hours = hourly(summary);
  const cpu = $('load-cpu'), rooms = $('load-rooms');
  cpu.replaceChildren(); rooms.replaceChildren();
  if (!hours.length) { empty(cpu, 'Noch keine Stundenwerte.'); return; }
  const labels = hours.map(hour => hour.at);
  const short = labels.length > 48 ? at => date(at.slice(0, 10)) : at => `${at.slice(11, 13)}:00`;
  const value = (hour, group, key) => Number.isFinite(hour[group][key]) ? hour[group][key] : null;
  cpu.append(element('h3', 'Prozessor (Stundendurchschnitt) und Server-Speicher (Spitze), in Prozent', 'subtitle'));
  lines(cpu, { labels, short, title: hourTitle, top: 100, format: value => `${formatNumber(value)} %`, series: [
    { label: 'Relay-Prozessor', color: 'var(--series-1)', values: hours.map(hour => value(hour, 'averages', 'relayCpuPercent')) },
    { label: 'Server-Prozessor', color: 'var(--series-2)', values: hours.map(hour => value(hour, 'averages', 'hostCpuPercent')) },
    { label: 'Server-Speicher', color: 'var(--series-3)', values: hours.map(hour => value(hour, 'peaks', 'hostMemoryPercent')) }] });
  rooms.append(element('h3', 'Gleichzeitig offene Räume (Spitze pro Stunde)', 'subtitle'));
  columns(rooms, { labels, short, title: hourTitle, format: formatNumber, height: 140,
    series: [{ label: 'Räume', color: 'var(--series-1)', values: hours.map(hour => hour.peaks.activeRooms ?? 0) }] });
}

function renderUsage(summary) {
  const { totals, days } = summary;
  const box = $('usage-tiles');
  box.replaceChildren();
  tile(box, 'Räume erstellt', formatNumber(totals.rooms?.created ?? 0));
  tile(box, 'Gemeinsam abgespielt', formatNumber(totals.rooms?.played ?? 0), 'Räume');
  tile(box, 'Gemeinsame Abspielzeit', formatDuration(totals.playingMinutes ?? 0), 'Summe über alle Räume');
  tile(box, 'Aktive Tage', formatNumber(days.filter(day => day.rooms.joined).length), `von ${days.length} mit Daten`);
  const chart = $('usage-days');
  chart.replaceChildren();
  if (!days.length) { empty(chart, 'Noch keine Tageswerte.'); return; }
  columns(chart, { labels: days.map(day => day.day), short: date, title: day => new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE'), format: formatNumber,
    series: [{ label: 'Erstellt', color: 'var(--series-1)', values: days.map(day => day.rooms.created) },
      { label: 'Beigetreten', color: 'var(--series-2)', values: days.map(day => day.rooms.joined) },
      { label: 'Gemeinsam abgespielt', color: 'var(--series-3)', values: days.map(day => day.rooms.played) }] });
}

function renderFunnel(summary) {
  const box = $('funnel');
  box.replaceChildren();
  const stages = funnel(summary.totals);
  bars(box, { rows: stages.map(stage => ({ label: stage.label, value: stage.value,
    display: stage.share === null ? formatNumber(stage.value) : `${formatNumber(stage.value)} · ${formatPercent(stage.share)}` })),
  colors: ['var(--ordinal-1)', 'var(--ordinal-2)', 'var(--ordinal-3)', 'var(--ordinal-4)'], format: formatNumber });
}

function renderFeatures(summary) {
  $('features-since').textContent = summary.featuresSince
    ? `Funktionen werden seit dem ${new Date(`${summary.featuresSince}T12:00:00Z`).toLocaleDateString('de-DE')} gezählt. „Nicht genutzt“ heißt: im Zeitraum kein einziges Mal.`
    : 'Funktionen werden gezählt, sobald der neue Relay läuft.';
  const box = $('features');
  box.replaceChildren();
  const list = features(summary.totals);
  bars(box, { rows: list.map(item => ({ label: item.label, value: item.value, display: item.value ? formatNumber(item.value) : 'nicht genutzt' })), format: formatNumber });
  const controls = $('controls');
  controls.replaceChildren();
  bars(controls, { rows: list.filter(item => item.by), segments: ROLES, format: formatNumber });
}

const DURATIONS = [['under10m', 'unter 10 Min.'], ['under1h', '10 bis 60 Min.'], ['under3h', '1 bis 3 Std.'], ['longer', 'über 3 Std.']];
const ENDINGS = [['leave', 'Verlassen'], ['idle', 'Inaktiv (Verbindung weg)'], ['expired', 'Abgelaufen'], ['overflow', 'Überlauf'], ['shutdown', 'Server-Neustart'], ['other', 'Sonstiges']];
function renderRooms(summary) {
  for (const [id, list, values] of [['durations', DURATIONS, summary.totals.durations], ['endings', ENDINGS, summary.totals.closed]]) {
    const box = $(id);
    box.replaceChildren();
    bars(box, { rows: list.map(([key, label]) => ({ label, value: values?.[key] ?? 0 })), format: formatNumber });
  }
}

function renderQuality(summary) {
  const box = $('quality');
  box.replaceChildren();
  if (!summary.days.length) { empty(box, 'Noch keine Tageswerte.'); return; }
  const headers = ['Tag', 'Zustellung p95', 'API p95', 'Unterbrechungen', 'Neu ausgerichtet', 'Puffern', 'Serverfehler', 'Abgewiesen', 'Unbekannte Anfragen', 'Neustarts / Abstürze'];
  const rows = [...summary.days].reverse().map(day => [date(day.day), day.deliveryP95, day.apiP95, formatNumber(day.sync.interruptions),
    formatNumber(day.sync.realignments), formatNumber(day.sync.bufferingWaits), formatNumber(day.responses.failed), formatNumber(day.limitedTotal),
    formatNumber(day.unknownTraffic), `${day.starts} / ${day.crashes}`]);
  const table = element('table', '', 'data-table');
  const head = document.createElement('tr');
  for (const header of headers) head.append(element('th', header));
  table.append(element('thead'), element('tbody'));
  table.tHead.append(head);
  for (const row of rows) {
    const line = document.createElement('tr');
    row.forEach((cell, index) => line.append(element(index ? 'td' : 'th', cell)));
    table.tBodies[0].append(line);
  }
  const scroll = element('div', '', 'table-scroll');
  scroll.append(table);
  box.append(scroll, element('p', 'Unbekannte Anfragen sind meist Bots, die Adressen wie /wp-login.php ausprobieren. Abgewiesen zählt Anfragen über einem Limit.', 'hint'));
  const codes = Object.entries(summary.totals.codes || {}).sort((a, b) => b[1] - a[1]);
  if (codes.length) tableView(box, ['Fehlercode', 'Anzahl'], codes.map(([code, count]) => [code, formatNumber(count)]));
}

function renderVersions(summary) {
  const box = $('versions');
  box.replaceChildren();
  const clients = Object.entries(summary.totals.clients || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]);
  if (!clients.length) { empty(box, 'Im Zeitraum keine Räume.'); return; }
  bars(box, { rows: clients.map(([label, value]) => ({ label, value })), format: formatNumber });
}

const INCIDENTS = { error: 'Unerwarteter Serverfehler', crash: 'Absturz mit Neustart', limits: 'Viele Anfragen abgewiesen (Bot oder Angriff)',
  capacity: 'Wegen Auslastung abgelehnt', disk: 'Wenig Plattenplatz', memory: 'Hoher Speicherverbrauch', report: 'Neuer Fehlerbericht' };
function renderIncidents(live) {
  const box = $('incidents');
  box.replaceChildren();
  const entries = Object.entries(live?.incidents || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { status(box, 'good', 'Keine Vorfälle'); return; }
  const list = element('ul', '', 'plain-list');
  for (const [reason, at] of entries) {
    const item = element('li');
    status(item, reason === 'report' ? 'warning' : 'critical', INCIDENTS[reason] || reason);
    item.append(element('span', new Date(at).toLocaleString('de-DE'), 'hint'));
    list.append(item);
  }
  box.append(list);
}

function renderErrors(errors) {
  const box = $('errors');
  box.replaceChildren();
  if (!errors.length) { empty(box, 'Keine Einträge in den letzten 7 Tagen.'); return; }
  for (const entry of errors.slice(0, 20)) {
    const details = element('details', '', 'log-entry');
    const summary = element('summary', `${new Date(entry.at).toLocaleString('de-DE')} · ${entry.kind}${entry.code ? ` ${entry.code}` : ''} · ${entry.route || ''} ${entry.status || ''}`);
    details.append(summary, element('pre', JSON.stringify(entry, null, 2)));
    box.append(details);
  }
}

function renderReports(reports) {
  const box = $('reports');
  box.replaceChildren();
  if (!reports.length) { empty(box, 'Keine Fehlerberichte in den letzten 30 Tagen.'); return; }
  const client = value => [value?.distribution, value?.channel, value?.version].filter(Boolean).join('/') || 'unbekannt';
  for (const report of reports) {
    const row = element('div', '', 'report-row');
    const open = element('button', report.id, 'text-button');
    open.type = 'button';
    open.addEventListener('click', () => void showReport(report.id));
    row.append(open, element('span', `${new Date(report.at).toLocaleString('de-DE')} · ${client(report.client)} · ${report.phase || '–'}${report.notice ? ` ${report.notice}` : ''}`, 'hint'),
      element('span', report.note || '', 'report-note'));
    box.append(row);
  }
}

async function showReport(id) {
  const target = $('report');
  target.hidden = false;
  target.textContent = `Lade ${id} …`;
  try {
    const response = await fetch(`/api/report?id=${encodeURIComponent(id)}`);
    const report = await response.json();
    if (!response.ok) throw new Error(report.error);
    const time = at => new Date(at).toISOString().slice(11, 23);
    const events = report.diagnostics?.events || [];
    target.textContent = [`Fehlerbericht ${report.id} vom ${report.at}`, `Notiz: ${report.note || '–'}`,
      `Zustand: ${Object.entries(report.session || {}).map(([key, value]) => `${key}=${value}`).join(' ') || '–'}`, '',
      ...events.map(event => `${time(event.at)}  ${String(event.kind).padEnd(9)} ${Object.entries(event).filter(([key]) => !['at', 'kind'].includes(key))
        .map(([key, value]) => `${key}=${value}`).join(' ')}`)].join('\n');
  } catch (error) { target.textContent = `Bericht nicht lesbar: ${error.message}`; }
}

function render() {
  const overview = state.overview;
  renderHeader();
  if (!overview) return;
  const summary = summarize(overview, state.period);
  const live = state.live ?? overview.live;
  renderCapacity(summary, live);
  renderLive(live);
  renderLoad(summary);
  renderUsage(summary);
  renderFunnel(summary);
  renderFeatures(summary);
  renderRooms(summary);
  renderQuality(summary);
  renderVersions(summary);
  renderIncidents(live);
  renderErrors(overview.errors);
  renderReports(overview.reports);
}

async function load(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({ error: `Status ${response.status}` }));
  if (!response.ok) throw new Error(body.error);
  return body;
}

function showProblem(error) {
  const problem = $('problem');
  if (error) { problem.textContent = error.message; problem.dataset.error = '1'; problem.hidden = false; }
  else { delete problem.dataset.error; problem.hidden = true; }
}

async function refreshOverview(fresh = false) {
  const main = $('main');
  main.setAttribute('aria-busy', 'true');
  main.classList.add('loading');
  try {
    state.overview = await load(`/api/overview${fresh ? '?fresh=1' : ''}`);
    state.live = state.overview.live;
    showProblem(null);
  } catch (error) { showProblem(error); }
  main.classList.remove('loading');
  main.setAttribute('aria-busy', 'false');
  render();
}

async function refreshLive() {
  try {
    const { live } = await load('/api/live');
    if (live) state.live = live;
    if (state.overview) { renderLive(state.live); renderIncidents(state.live); }
    renderHeader();
  } catch (error) { showProblem(error); }
}

let resizeTimer = null;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 200); });
$('refresh').addEventListener('click', () => void refreshOverview(true));
renderPeriods();
await refreshOverview();
setInterval(() => void refreshLive(), LIVE_MS);
setInterval(() => void refreshOverview(), OVERVIEW_MS);
