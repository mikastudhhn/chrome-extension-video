import http from 'node:http';
import { isIP } from 'node:net';
import { RoomRequests } from './room-requests.js';
import { OperatingCounters } from './operating-counters.js';
import { ErrorLog, shapeOf } from './error-log.js';
import { UsageStats } from './usage-stats.js';
import { ReportStore } from './reports.js';
import { sanitizeErrorReport, REPORT_LIMITS } from '../extension/error-report.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join } from 'node:path';
import { Rooms, RoomError, publicEvent } from './rooms.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';
import { errorResponse, fault } from '../extension/runtime-errors.js';

const root = resolve(fileURLToPath(new URL('../demo/', import.meta.url)));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webm': 'video/webm', '.svg': 'image/svg+xml' };
const PUBLIC_ASSET = /^\/(?:$|index\.html(?:\?|$)|style\.css(?:\?|$)|demo\.js(?:\?|$)|scene-[ab]\.webm(?:\?|$))/;
// Rejections that point at a client/server mismatch get an error log entry
// with the payload's shape; ordinary ends, limits and bots are only counted.
const LOGGED_REJECTIONS = new Set(['INVALID_MESSAGE', 'INVALID_SEQUENCE', 'INCOMPATIBLE_PROTOCOL', 'ROOM_REQUEST_CONFLICT', 'FORBIDDEN_ROLE']);

// Documented in docs/hosting.md and docs/protocol.md. Address limits count an
// IPv4 address or an IPv6 /64. Without TRUST_PROXY, loopback clients (local
// development and tests) are exempt from per-address limits only.
export const SERVER_LIMITS = Object.freeze({
  bodyTimeoutMs: 10_000, // a body must arrive completely within 10 s (answered with 408 TIMEOUT)
  requestTimeoutMs: 15_000, // backstop for the whole request; long-poll waiting is response time and not counted
  headersTimeoutMs: 10_000,
  // Longer than the reverse proxy's idle upstream keep-alive (Caddy: 2 min), so
  // the proxy always closes an idle connection first and never reuses one that
  // Node is closing at that moment (a 502 on a non-retried POST).
  keepAliveTimeoutMs: 125_000,
  connectionsCheckingIntervalMs: 1000,
  maxHeaderBytes: 8192,
  maxConnections: 1024,
  maxInFlight: 512,
  relayBodyBytes: 16_384,
  handshakeBodyBytes: 4096,
  floodRatePerSecond: 50, // token bucket per address, before any parsing
  floodBurst: 200,
  requestsPerClient: 16, // concurrent non-poll requests per address, charged before reading a body
  pollsPerClient: 8, // concurrent long polls per address
  admissionsPerMinute: 30, // create/join attempts per address
  relaysPerMinute: 1200, // per member
  pollsPerMinute: 1200, // per member
  lookupFailuresPerClient: 10, // failed join lookups per address per minute
  lookupFailureRatePerSecond: 1, // failed join lookups for all addresses together
  lookupFailureBurst: 30,
  reportBodyBytes: REPORT_LIMITS.bodyBytes, // error report from the popup
  reportsPerHour: 5 // per address; 200 per day for all addresses (server/reports.js)
});

// `dataDirectory` keeps daily usage sums and the error log (docs/hosting.md);
// without it both stay in memory. `commit` names the deployed source.
export function createServer({ rooms = new Rooms(), env = process.env, pollTimeoutMs = 20_000, requestLimit = 2000, rateLimitEntries = 5000,
  maxInFlight = SERVER_LIMITS.maxInFlight, now = Date.now, limits = {}, dataDirectory = null, commit = 'unknown', statfs, report } = {}) {
  const config = { ...SERVER_LIMITS, maxInFlight, ...limits };
  const trustProxy = env.TRUST_PROXY === '1';
  const rateLimits = new Map(), buckets = new Map(), active = new Map();
  const lookupBudget = { tokens: config.lookupFailureBurst, at: now() };
  const counters = new OperatingCounters();
  rooms.counters = counters;
  const started = now();
  const usage = new UsageStats({ directory: dataDirectory, now, counters, rooms, commit, statfs, report });
  const errors = new ErrorLog({ directory: dataDirectory && join(dataDirectory, 'errors'), now, counters, report,
    onIncident: reason => usage.incident(reason), context: () => {
      const { activeRooms, joinedRooms, activeMembers, queuedBytes } = rooms.status();
      return { commit, uptimeS: Math.round((now() - started) / 1000), rssMB: Math.round(process.memoryUsage().rss / 1048576),
        inFlight: counters.inFlight, activeRooms, joinedRooms, activeMembers, queuedBytes };
    } });
  const reports = new ReportStore({ directory: dataDirectory && join(dataDirectory, 'reports'), now, counters, report,
    onIncident: reason => usage.incident(reason) });
  const roomRequests = new RoomRequests({ now, limit: requestLimit, replayed: () => counters.replays++ });
  let draining = false, shutdown;
  const sockets = new Set();
  const server = http.createServer({
    requestTimeout: config.requestTimeoutMs, headersTimeout: config.headersTimeoutMs, keepAliveTimeout: config.keepAliveTimeoutMs,
    connectionsCheckingInterval: config.connectionsCheckingIntervalMs, maxHeaderSize: config.maxHeaderBytes
  }, async (request, response) => {
    const route = routeName(request.method, request.url);
    const finish = counters.begin(route);
    response.once('finish', () => finish(response.statusCode, false, response.failureCode));
    response.once('close', () => finish(response.statusCode, !response.writableFinished, response.failureCode));
    if (draining || counters.inFlight > config.maxInFlight) {
      json(response, 503, errorResponse(fault(draining ? 'SERVER_DRAINING' : 'SERVER_BUSY', 503))); return;
    }
    // Cheap admission before routing, authentication, body or JSON work.
    const address = clientAddress(request, trustProxy);
    const exempt = !trustProxy && loopback(address);
    const client = addressKey(address);
    if (!exempt) {
      const admitted = take(buckets, client, config.floodRatePerSecond, config.floodBurst);
      if (admitted !== true) {
        if (admitted === false) counters.limited.flood++;
        json(response, admitted ? 503 : 429, errorResponse(admitted ? fault('SERVER_BUSY', 503) : fault('RATE_LIMITED', 429))); return;
      }
      const lane = `${/^\/events(?:\?|$)/.test(request.url) ? 'poll' : 'request'}\n${client}`;
      const running = active.get(lane) || 0;
      if (running >= (lane.startsWith('poll') ? config.pollsPerClient : config.requestsPerClient)) {
        counters.limited.concurrency++;
        json(response, 429, errorResponse(fault('RATE_LIMITED', 429))); return;
      }
      active.set(lane, running + 1);
      response.once('close', () => { const left = active.get(lane) - 1; if (left > 0) active.set(lane, left); else active.delete(lane); });
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    // Extension requests have explicit host permissions. Web origins require an allowlist.
    const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
    const publicAsset = request.method === 'GET' && PUBLIC_ASSET.test(request.url);
    if (origin && !publicAsset && !extensionOrigin && !allowedOrigins.includes(origin)) {
      json(response, 403, errorResponse(fault('FORBIDDEN_ORIGIN', 403))); return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.writeHead(204).end(); return;
    }
    // Error context: the authenticated member and the parsed payload, if any.
    let member = null, payload;
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health' && request.method === 'GET') {
        // `incidents`: latest time per fixed reason in the last 24 hours, for the external monitor.
        json(response, 200, { ok: true, protocol: PROTOCOL, capabilities: CAPABILITIES, roomRequests: roomRequests.offer(), incidents: usage.recentIncidents() }); return;
      }
      if (request.method === 'POST' && (url.pathname === '/rooms' || /^\/rooms\/[A-Z2-9]{6}\/join$/.test(url.pathname))) {
        // Known successful replays do not consume the shared-IP admission budget.
        // New mutations and rejected handshakes still do; lookup never creates a room.
        let charged = false, seat;
        const admit = () => { charged = true; limitRequests(client, config.admissionsPerMinute, 'admission'); };
        try {
          const handshake = payload = await body(request, response, config.handshakeBodyBytes, config.bodyTimeoutMs);
          if (draining) throw fault('SERVER_DRAINING', 503);
          seat = roomRequests.run(handshake, url.pathname, rooms, () => {
            admit();
            return url.pathname === '/rooms' ? rooms.create(handshake, exempt ? undefined : client) : lookup(url.pathname.split('/')[2], handshake);
          });
        } catch (error) {
          if (!charged) admit();
          throw error;
        }
        json(response, 201, { ...seat, protocol: PROTOCOL, capabilities: CAPABILITIES }); return;
      }
      if (request.method === 'POST' && url.pathname === '/reports') {
        if (!exempt) limitRequests(`report:${client}`, config.reportsPerHour, 'reports', 3_600_000);
        payload = await body(request, response, config.reportBodyBytes, config.bodyTimeoutMs);
        const id = reports.save(sanitizeErrorReport(payload), { commit, uptimeS: Math.round((now() - started) / 1000) });
        json(response, 201, { ok: true, id }); return;
      }
      if (['/events', '/relay', '/leave'].includes(url.pathname)) {
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        member = rooms.authenticate(token);
        if (request.method === 'GET' && url.pathname === '/events') {
          limitRequests(`events:${member.token}`, config.pollsPerMinute, 'polls');
          const abort = new AbortController();
          response.on('close', () => abort.abort());
          const events = await rooms.poll(member, Number(url.searchParams.get('after') || 0), abort.signal, pollTimeoutMs);
          if (!response.destroyed) json(response, 200, { events: events.map(event => publicEvent(event, rooms.now())) });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/relay') {
          limitRequests(`relay:${member.token}`, config.relaysPerMinute, 'relay');
          payload = await body(request, response, config.relayBodyBytes, config.bodyTimeoutMs);
          rooms.relayData(member, payload);
          json(response, 200, { ok: true }); return;
        }
        if (request.method === 'POST' && url.pathname === '/leave') {
          rooms.close(member.room, 'leave'); json(response, 200, { ok: true }); return;
        }
      }
      if (request.method === 'GET') {
        let file;
        try { file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch { throw new RoomError(404, 'NOT_FOUND'); }
        const path = resolve(root, `.${file}`);
        if (!path.startsWith(`${root}/`) || !contentTypes[extname(path)]) throw new RoomError(404, 'NOT_FOUND');
        const data = await readFile(path);
        response.setHeader('Content-Type', contentTypes[extname(path)]);
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        response.setHeader('Accept-Ranges', 'bytes');
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1] ? Number(match[1]) : Math.max(0, data.length - Number(match?.[2]));
          const end = match?.[1] && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
          if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= data.length) {
            response.setHeader('Content-Range', `bytes */${data.length}`);
            response.writeHead(416).end(); return;
          }
          response.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
          response.setHeader('Content-Length', end - start + 1);
          response.writeHead(206).end(data.subarray(start, end + 1)); return;
        }
        response.setHeader('Content-Length', data.length);
        response.writeHead(200).end(data); return;
      }
      throw new RoomError(404, 'NOT_FOUND');
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      const known = error.code === 'ENOENT' || (error.code && error.category);
      // Error text may contain request data: responses carry only our own text,
      // the error log a scrubbed message, the stack and fixed context fields.
      if (!known) errors.exception(error, context(status));
      else if (LOGGED_REJECTIONS.has(error.code)) errors.rejected(error.code, context(status));
      if (!response.headersSent) json(response, status, errorResponse(error.code === 'ENOENT' ? fault('NOT_FOUND', 404) : known ? error : fault('SERVER_ERROR', status)));
    }

    function context(status) {
      const room = member?.room;
      return { route, method: request.method, status,
        ...(member ? { member: { role: member.role, client: member.client, joined: room.members.length === 2,
          roomAgeS: Math.round((now() - room.created) / 1000), queued: member.events.length, sequence: member.sequence, sentSequence: member.sentSequence } } : {}),
        ...(payload !== undefined ? { request: { shape: shapeOf(payload) } } : {}) };
    }

    // Join lookups are the only way to probe invitation codes. Failed lookups
    // are limited per address and for all addresses together, before the
    // lookup runs, so a guesser learns nothing once the budget is spent.
    function lookup(code, handshake) {
      const failures = rateLimits.get(`lookup:${client}`);
      refill(lookupBudget, config.lookupFailureRatePerSecond, config.lookupFailureBurst);
      if ((!exempt && failures && failures.until >= now() && failures.count >= config.lookupFailuresPerClient) || lookupBudget.tokens < 1) {
        counters.limited.lookups++;
        throw new RoomError(429, 'RATE_LIMITED');
      }
      try { return rooms.join(code, handshake); } catch (error) {
        if (error.code === 'ROOM_NOT_FOUND' || error.code === 'ROOM_FULL') {
          lookupBudget.tokens--;
          if (!exempt) try { limitRequests(`lookup:${client}`, Infinity, 'lookups'); } catch { /* table full: the global budget still applies */ }
        }
        throw error;
      }
    }
  });
  server.maxConnections = config.maxConnections;
  const cleanup = setInterval(() => {
    rooms.sweep();
    roomRequests.sweep();
    usage.tick();
    const currentTime = now();
    for (const [key, value] of rateLimits) if (currentTime > value.until) rateLimits.delete(key);
    sweepBuckets(currentTime);
  }, 15_000);
  cleanup.unref();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('close', () => {
    clearInterval(cleanup);
    for (const room of rooms.rooms.values()) rooms.close(room, 'shutdown');
    roomRequests.clear();
    rateLimits.clear();
    buckets.clear();
  });
  server.operatingSnapshot = () => counters.snapshot(rooms, roomRequests.entries.size, draining);
  server.usage = usage;
  server.errors = errors;
  server.reports = reports;
  // Aggregate operating status without addresses, codes or tokens.
  server.status = () => {
    const memory = process.memoryUsage();
    return { ...rooms.status(), inFlight: counters.inFlight, rssMB: Math.round(memory.rss / 1048576), heapMB: Math.round(memory.heapUsed / 1048576), draining };
  };
  server.shutdown = ({ deadlineMs = 5000 } = {}) => {
    if (shutdown) return shutdown;
    draining = true;
    for (const room of rooms.rooms.values()) rooms.close(room, 'shutdown');
    shutdown = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, deadlineMs);
      server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    }).then(() => Promise.all([usage.stop(), errors.flush(), reports.flush()])).then(() => undefined);
    return shutdown;
  };
  return server;

  function limitRequests(key, limit, category, windowMs = 60_000) {
    const currentTime = now();
    let entry = rateLimits.get(key);
    if (!entry && rateLimits.size >= rateLimitEntries) {
      for (const [storedKey, value] of rateLimits) if (value.until < currentTime) rateLimits.delete(storedKey);
      if (rateLimits.size >= rateLimitEntries) throw fault('SERVER_BUSY', 503);
    }
    if (!entry || entry.until < currentTime) { entry = { count: 0, until: currentTime + windowMs }; rateLimits.set(key, entry); }
    if (++entry.count > limit) { counters.limited[category]++; throw new RoomError(429, 'RATE_LIMITED'); }
  }

  function refill(bucket, rate, burst) {
    const currentTime = now();
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, currentTime - bucket.at) * rate / 1000);
    bucket.at = currentTime;
  }

  // Returns true when admitted, false when the address is over its rate and
  // 'full' when the table holds only active addresses (fail closed, 503).
  function take(table, key, rate, burst) {
    let bucket = table.get(key);
    if (!bucket) {
      if (table.size >= rateLimitEntries) sweepBuckets(now());
      if (table.size >= rateLimitEntries) return 'full';
      bucket = { tokens: burst, at: now() };
      table.set(key, bucket);
    }
    refill(bucket, rate, burst);
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  // A refilled bucket carries no state and is forgotten.
  function sweepBuckets(currentTime) {
    for (const [key, bucket] of buckets) {
      if (bucket.tokens + Math.max(0, currentTime - bucket.at) * config.floodRatePerSecond / 1000 >= config.floodBurst) buckets.delete(key);
    }
  }
}

// Fixed route names for counters and error context; never the raw path.
function routeName(method, url = '') {
  const path = url.split('?')[0];
  if (method === 'OPTIONS') return 'preflight';
  if (path === '/health') return 'health';
  if (path === '/rooms') return 'create';
  if (/^\/rooms\/[A-Z2-9]{6}\/join$/.test(path)) return 'join';
  if (['/events', '/relay', '/leave'].includes(path)) return path.slice(1);
  if (path === '/reports') return 'report';
  return method === 'GET' && PUBLIC_ASSET.test(url) ? 'page' : 'unknown';
}

// TRUST_PROXY=1: the reverse proxy overwrites X-Real-IP with the TCP peer
// (deploy/Caddyfile). X-Forwarded-For is client-controlled and never read.
function clientAddress(request, trustProxy) {
  let address = request.socket.remoteAddress || '';
  const forwarded = trustProxy ? request.headers['x-real-ip'] : undefined;
  if (typeof forwarded === 'string' && isIP(forwarded.trim())) address = forwarded.trim();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return address;
}

const loopback = address => address === '::1' || address.startsWith('127.');

// One IPv6 subscriber usually controls a whole /64; limits count it once.
function addressKey(address) {
  if (isIP(address) !== 6) return address;
  const plain = address.split('%')[0].toLowerCase();
  const [head, tail] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// The body deadline answers with a regular response. Node's own request
// timeout (a raw 408 and socket reset) stays as backstop, but Caddy does not
// pass that on and would hold the client connection open indefinitely.
function body(request, response, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data).off('end', end).off('error', failed).off('close', failed);
    };
    const fail = error => {
      cleanup();
      // Never drain the rest of an oversized or stalled body; close after answering.
      request.pause();
      response.setHeader('Connection', 'close');
      reject(error);
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > limit) fail(new RoomError(413, 'REQUEST_TOO_LARGE')); else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new RoomError(400, 'INVALID_JSON')); }
    };
    const failed = () => fail(new RoomError(400, 'INVALID_JSON'));
    const timer = setTimeout(() => fail(new RoomError(408, 'TIMEOUT')), timeoutMs);
    if (Number(request.headers['content-length']) > limit) { fail(new RoomError(413, 'REQUEST_TOO_LARGE')); return; }
    request.on('data', data).on('end', end).on('error', failed).on('close', failed);
  });
}

function json(response, status, value) {
  if (value?.failure?.code) response.failureCode = value.failure.code;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(JSON.stringify(value));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({ dataDirectory: process.env.DATA_DIR || null, commit: process.env.SOURCE_COMMIT || 'unknown' });
  // An uncaught failure is written synchronously; the container restarts the process.
  const crashed = error => { server.errors.crash(error); console.error('Video Sync relay crashed.'); process.exit(1); };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  await server.usage.start();
  server.listen(port, host, () => console.log('Video Sync relay started.'));
  // Operators pick restart moments from this line (`docker compose logs app`).
  // It repeats every 5 minutes while rooms exist or the count changed.
  let reported = null;
  const report = force => {
    const status = server.status();
    const key = `${status.activeRooms}/${status.joinedRooms}`;
    if (!force && key === reported && !status.activeRooms) return;
    reported = key;
    console.log(JSON.stringify({ event: 'status', ...status }));
  };
  setInterval(() => report(false), 300_000).unref();
  process.on('SIGUSR2', () => report(true));
  const stop = () => { void server.shutdown().then(() => {
    console.log(JSON.stringify({ event: 'shutdown', counters: server.operatingSnapshot() }));
  }).catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
