// Exercises two real authenticated HTTP clients for four hours by default.
// This measures the relay, not Chrome/player behavior or a streaming provider.
import { mkdir, writeFile } from 'node:fs/promises';
import { Signaling } from '../extension/signaling.js';
// No default: never load the personal relay on localhost:8787 by accident.
const base = process.env.TEST_SERVER;
if (!base) throw new Error('Set TEST_SERVER to the relay under test, e.g. TEST_SERVER=https://203.0.113.10');
const seconds = Number(process.env.SOAK_SECONDS || 14_400);
if (!Number.isFinite(seconds) || seconds < 10 || seconds > 86_400) throw new Error('SOAK_SECONDS must be 10..86400');
const started = Date.now();
const errors = [], latencies = [];
let count = 0, retries = 0, lastResponse = started, maxGapMs = 0;
const status = value => { if (value.reconnecting) retries++; };
const host = new Signaling(base, event => {
  if (event.message?.type === 'ping') host.send({ type: 'pong', sent: event.message.sent, received: Date.now() });
}, error => errors.push(error.message), status);
const guest = new Signaling(base, event => {
  if (event.message?.type !== 'pong') return;
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - lastResponse); lastResponse = now;
  latencies.push(now - event.message.sent); count++;
}, error => errors.push(error.message), status);
let timer, progress;
try {
  const member = await host.open(); await guest.open(member.code);
  host.poll(); guest.poll();
  timer = setInterval(() => {
    guest.send({ type: 'sample', sample: { time: (Date.now() - started) / 1000, duration: 100_000, mediaId: 'soak', paused: false, buffering: false } });
    guest.send({ type: 'ping', sent: Date.now() });
    host.send({ type: 'state', state: { phase: 'aligning', epoch: 0, revision: 0, at: Date.now(), position: 0,
      playing: false, wantsPlay: false, waiting: false, anchors: {},
      members: { host: { present: true, ready: false, blocked: false }, guest: { present: true, ready: false, blocked: false } } } });
  }, 350);
  progress = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.floor((Date.now() - started) / 1000), roundTrips: count, retries, errors: errors.length })), 60_000);
  while (Date.now() - started < seconds * 1000 && !errors.length) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (Date.now() - lastResponse > 15_000) errors.push('No round trip for 15 seconds');
  }
} finally {
  clearInterval(timer); clearInterval(progress);
  await host.close(); await guest.close();
}
latencies.sort((a, b) => a - b);
const percentile = fraction => latencies[Math.floor((latencies.length - 1) * fraction)] ?? null;
const result = { server: base, seconds: (Date.now() - started) / 1000, roundTrips: count,
  medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxGapMs, retries, errors,
  passed: !errors.length && count >= seconds * 2 && percentile(0.99) < 500 };
await mkdir('test-results', { recursive: true });
await writeFile('test-results/soak.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
