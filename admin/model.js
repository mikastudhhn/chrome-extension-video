// Period sums and the capacity verdict for the admin dashboard. Pure
// functions on the overview built by scripts/admin.js; no DOM, no network.

export const PERIODS = Object.freeze([[7, '7 Tage'], [30, '30 Tage'], [90, '90 Tage'], [365, '1 Jahr']]);
export const LIVE_STALE_MS = 60_000; // live.json is written every 15 seconds
// Sustained use of the busiest resource: below `idle` the server is far from
// its limits, from `tight` on it needs watching, from `over` it is too small.
export const CAPACITY = Object.freeze({ idle: 0.1, tight: 0.6, over: 0.8, eventLoopMs: 100 });

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Adds numbers key by key, also in nested records.
export function addUp(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = (typeof target[key] === 'number' ? target[key] : 0) + value;
    else if (isRecord(value)) addUp(target[key] = isRecord(target[key]) ? target[key] : {}, value);
  }
  return target;
}
const max = (values) => values.reduce((best, value) => Number.isFinite(value) && value > best ? value : best, -Infinity);
const finite = value => Number.isFinite(value) ? value : null;

export const dayOf = iso => String(iso).slice(0, 10);
export function cutoffDay(generatedAt, periodDays) {
  return new Date(Date.parse(`${dayOf(generatedAt)}T00:00:00Z`) - (periodDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function summarize(overview, periodDays) {
  const from = cutoffDay(overview.generatedAt, periodDays);
  const days = overview.days.filter(day => day.day >= from);
  const hours = overview.hours.filter(hour => dayOf(hour.at) >= from);
  const totals = days.reduce((sum, day) => addUp(sum, { rooms: day.rooms, durations: day.durations, closed: day.closed, controls: day.controls,
    sync: day.sync, playingMinutes: day.playingMinutes, responses: day.responses, limited: day.limited, limitedTotal: day.limitedTotal,
    unknownTraffic: day.unknownTraffic, codes: day.codes, clients: day.clients, reports: day.reports, errorLogged: day.errorLogged,
    starts: day.starts, crashes: day.crashes }), {});
  const featuresSince = overview.days.find(day => day.features)?.day ?? null;
  return { from, days, hours, totals, featuresSince };
}

// Funnel stages as counts and shares of created rooms.
export function funnel(totals) {
  const rooms = totals.rooms || {};
  const created = rooms.created || 0;
  return [['created', 'Raum erstellt'], ['joined', 'Einladung angenommen'], ['aligned', 'Szene ausgerichtet'], ['played', 'Gemeinsam abgespielt']]
    .map(([key, label]) => ({ key, label, value: rooms[key] || 0, share: created ? (rooms[key] || 0) / created : null }));
}

// What people use, with zero meaning "not used in this period".
export function features(totals) {
  const controls = totals.controls || {}, sync = totals.sync || {};
  const by = name => ({ host: controls[name]?.host || 0, guest: controls[name]?.guest || 0, other: controls[name]?.other || 0 });
  const total = name => Object.values(by(name)).reduce((sum, value) => sum + value, 0);
  return [
    { key: 'invite', label: 'Einladung erstellt', value: totals.rooms?.created || 0 },
    { key: 'join', label: 'Einladung angenommen', value: totals.rooms?.joined || 0 },
    { key: 'align', label: 'Szene ausgerichtet', value: sync.alignments || 0 },
    { key: 'play', label: 'Abspielen', value: total('play'), by: by('play') },
    { key: 'pause', label: 'Pause', value: total('pause'), by: by('pause') },
    { key: 'seek', label: 'Spulen', value: total('seek'), by: by('seek') },
    { key: 'realign', label: 'Neu ausrichten', value: sync.realignments || 0 },
    { key: 'report', label: 'Fehlerbericht gesendet', value: totals.reports || 0 }
  ];
}

// Each resource: the highest sustained value in the period against its limit.
// CPU uses hourly averages (short peaks are normal); memory and counts use peaks.
export function capacity(summary, live) {
  const { hours, days } = summary;
  const limits = live?.limits || {};
  const peak = key => finite(max([...hours.map(hour => hour.peaks?.[key]), ...days.map(day => day.peaks?.[key])]));
  const average = key => finite(max(hours.map(hour => hour.averages?.[key])));
  const cores = live?.relay?.cpuLimitCores ?? null;
  const items = [
    { key: 'relayCpu', label: 'Relay-Prozessor', value: average('relayCpuPercent'), limit: cores ? cores * 100 : null, unit: '%', hardware: true,
      note: 'höchster Stundendurchschnitt' },
    { key: 'relayMemory', label: 'Relay-Arbeitsspeicher', value: peak('rssMB'), limit: live?.relay?.memoryLimitMB ?? null, unit: 'MB', hardware: true },
    { key: 'hostCpu', label: 'Server-Prozessor', value: average('hostCpuPercent'), limit: 100, unit: '%', hardware: true, note: 'höchster Stundendurchschnitt' },
    { key: 'hostMemory', label: 'Server-Arbeitsspeicher', value: peak('hostMemoryPercent'), limit: 100, unit: '%', hardware: true },
    { key: 'eventLoop', label: 'Wartezeit im Relay (p99)', value: peak('eventLoopP99Ms'), limit: CAPACITY.eventLoopMs, unit: 'ms', hardware: true },
    { key: 'rooms', label: 'Gleichzeitige Räume', value: peak('activeRooms'), limit: limits.rooms ?? null, unit: '' },
    { key: 'inFlight', label: 'Gleichzeitige Anfragen', value: peak('inFlight'), limit: limits.maxInFlight ?? null, unit: '' },
    { key: 'connections', label: 'Offene Verbindungen', value: peak('connections'), limit: limits.maxConnections ?? null, unit: '' }
  ].map(item => ({ ...item, ratio: item.value !== null && item.limit ? item.value / item.limit : null }));
  const refused = summary.totals.codes?.SERVER_BUSY || 0;
  const ratios = items.map(item => item.ratio).filter(ratio => ratio !== null);
  const worst = ratios.length ? Math.max(...ratios) : null;
  let verdict = 'unknown';
  if (refused || (worst !== null && worst >= CAPACITY.over)) verdict = 'over';
  else if (worst !== null) verdict = worst >= CAPACITY.tight ? 'tight' : worst < CAPACITY.idle ? 'idle' : 'ok';
  return { items, worst, refused, verdict };
}

export const VERDICTS = Object.freeze({
  idle: { status: 'good', title: 'Viel Reserve', text: 'Der Server ist kaum ausgelastet. Mehr Leistung braucht ihr nicht.' },
  ok: { status: 'good', title: 'Passt', text: 'Die Auslastung liegt im gesunden Bereich.' },
  tight: { status: 'warning', title: 'Wird knapp', text: 'Eine Ressource liegt über 60 %. Beobachten und bei weiterem Wachstum größer buchen.' },
  over: { status: 'critical', title: 'Zu klein', text: 'Der Server ist an seiner Grenze oder hat Anfragen wegen Auslastung abgelehnt. Größer buchen oder Limits prüfen.' },
  unknown: { status: 'neutral', title: 'Noch keine Daten', text: 'Sobald der Relay Lastwerte geschrieben hat, erscheint hier die Bewertung.' }
});

export function liveAge(live, now) {
  const at = Date.parse(live?.at);
  return Number.isFinite(at) ? now - at : null;
}

const numberFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
export const formatNumber = value => value === null || value === undefined || !Number.isFinite(value) ? '–' : numberFormat.format(value);
export const formatPercent = ratio => ratio === null || !Number.isFinite(ratio) ? '–' : `${numberFormat.format(Math.round(ratio * 1000) / 10)} %`;
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '–';
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} Std. ${minutes % 60} Min.` : `${minutes} Min.`;
}
export function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'unbekannt';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `vor ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `vor ${minutes} Min.` : `vor ${Math.round(minutes / 60)} Std.`;
}
