// External check of the relay server (.github/workflows/monitor.yml, every
// 15 minutes). A failed run makes GitHub send its failure notification.
// Checks: /health answers, the certificate is trusted and not about to
// expire, and the server reported no new incident since the previous run.
import tls from 'node:tls';
import { isIP } from 'node:net';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MONITOR_LIMITS = Object.freeze({ attempts: 3, retryMs: 20_000, timeoutMs: 10_000, certificateHours: 36, slowMs: 3000, fallbackMs: 20 * 60_000 });
// Caddy renews the ~6-day IP certificate with about two days left; below 36 hours renewal has failed.
export const INCIDENT_TEXT = Object.freeze({
  error: 'Unerwarteter Serverfehler (Details: npm run stats -- --errors).',
  crash: 'Der Serverprozess wurde nicht sauber beendet (Absturz oder Speicherlimit) und neu gestartet.',
  limits: 'Mehr als 500 Anfragen pro Stunde wurden von Limits abgewiesen – vermutlich ein Bot oder Angriff.',
  capacity: 'Der Server war ausgelastet und hat Anfragen abgelehnt.',
  disk: 'Weniger als 1 GB Speicherplatz frei.',
  memory: 'Der Serverprozess braucht ungewöhnlich viel Arbeitsspeicher.'
});
const failure = error => [error?.message, error?.cause?.code || error?.cause?.message].filter(Boolean).join(': ');

export async function checkHealth(origin, { fetchImpl = fetch, timeoutMs = MONITOR_LIMITS.timeoutMs, clock = performance } = {}) {
  const started = clock.now();
  try {
    const response = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    const ms = Math.round(clock.now() - started);
    if (!response.ok) return { ok: false, ms, problem: `/health antwortet mit Status ${response.status}.` };
    const body = await response.json().catch(() => null);
    if (body?.ok !== true || !Number.isInteger(body.protocol)) return { ok: false, ms, problem: '/health liefert keine gültige Antwort des Relays.' };
    return { ok: true, ms, protocol: body.protocol, incidents: body.incidents && typeof body.incidents === 'object' ? body.incidents : {} };
  } catch (error) {
    return { ok: false, ms: Math.round(clock.now() - started), problem: `/health nicht erreichbar (${failure(error)}).` };
  }
}

export function checkCertificate(origin, { connect = tls.connect, timeoutMs = MONITOR_LIMITS.timeoutMs } = {}) {
  const { hostname, port } = new URL(origin);
  const host = hostname.replace(/^\[|\]$/g, '');
  return new Promise(done => {
    const socket = connect({ host, port: Number(port || 443), ...(isIP(host) ? {} : { servername: host }), timeout: timeoutMs }, () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      done({ ok: socket.authorized, validTo: new Date(certificate.valid_to), issuer: certificate.issuer?.CN || '',
        ...(socket.authorized ? {} : { problem: `Zertifikat nicht vertrauenswürdig (${socket.authorizationError}).` }) });
    });
    socket.once('timeout', () => { socket.destroy(); done({ ok: false, problem: 'TLS-Verbindung: keine Antwort.' }); });
    socket.once('error', error => done({ ok: false, problem: `TLS-Verbindung fehlgeschlagen (${failure(error)}).` }));
  });
}

// Start of the previous completed monitor run: incidents after it are new.
export async function previousRun({ repository, token, fetchImpl = fetch } = {}) {
  if (!repository) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/monitor.yml/runs?status=completed&per_page=1`, {
      signal: AbortSignal.timeout(MONITOR_LIMITS.timeoutMs),
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) return null;
    const started = Date.parse((await response.json())?.workflow_runs?.[0]?.run_started_at);
    return Number.isFinite(started) ? started : null;
  } catch { return null; }
}

export function evaluate({ health, certificate, since, now }) {
  const problems = [], notes = [];
  if (!health.ok) problems.push(health.problem);
  else {
    notes.push(`/health: ok, Protokoll ${health.protocol}, ${health.ms} ms`);
    if (health.ms > MONITOR_LIMITS.slowMs) notes.push(`Langsame Antwort: ${health.ms} ms.`);
    for (const [reason, at] of Object.entries(health.incidents)) {
      const text = INCIDENT_TEXT[reason] || `Vorfall „${reason}“.`;
      const when = new Date(at).toISOString();
      if (Number.isFinite(at) && at > since) problems.push(`${text} (${when})`);
      else notes.push(`Bereits gemeldet: ${text} (${when})`);
    }
  }
  if (!certificate.ok) problems.push(certificate.problem);
  else {
    const hours = Math.floor((certificate.validTo.getTime() - now) / 3_600_000);
    const text = `Zertifikat gültig bis ${certificate.validTo.toISOString()} (noch ${hours} h, ${certificate.issuer})`;
    if (hours < MONITOR_LIMITS.certificateHours) problems.push(`${text}: die automatische Erneuerung hat nicht funktioniert.`);
    else notes.push(text);
  }
  return { problems, notes };
}

export async function monitor(origin, { attempts = MONITOR_LIMITS.attempts, retryMs = MONITOR_LIMITS.retryMs, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), repository, token, fetchImpl = fetch, connect } = {}) {
  const since = await previousRun({ repository, token, fetchImpl }) ?? now() - MONITOR_LIMITS.fallbackMs;
  let health, certificate;
  // A single lost request from the runner is not an outage.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    [health, certificate] = await Promise.all([checkHealth(origin, { fetchImpl }), checkCertificate(origin, { connect })]);
    if (health.ok && certificate.ok) break;
    if (attempt < attempts) await wait(retryMs);
  }
  return { ...evaluate({ health, certificate, since, now: now() }), since };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.argv[2]?.replace(/\/+$/, '');
  if (!origin || !/^https:\/\//.test(origin)) {
    console.error('::error::Serveradresse fehlt: Repository-Variable VIDEO_SYNC_SERVER (https://…) setzen.');
    process.exit(1);
  }
  const result = await monitor(origin, { repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
  for (const note of result.notes) console.log(note);
  for (const problem of result.problems) console.log(`::error::${problem}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, [`## ${result.problems.length ? '❌ Problem' : '✅ In Ordnung'}: ${origin}`, '',
      ...result.problems.map(problem => `- **${problem}**`), ...result.notes.map(note => `- ${note}`),
      '', `Neue Vorfälle seit ${new Date(result.since).toISOString()}.`, ''].join('\n'));
  }
  process.exitCode = result.problems.length ? 1 : 0;
}
