// Fixed categories only. No path, address, token, room, request ID or error text.
// Histograms count values below each bound; the last bucket takes the rest.
export const DURATION_BUCKETS = Object.freeze([['under10m', 600_000], ['under1h', 3_600_000], ['under3h', 10_800_000], ['longer', Infinity]]);
export const LATENCY_BUCKETS = Object.freeze([['under10ms', 10], ['under50ms', 50], ['under200ms', 200], ['under1s', 1000], ['longer', Infinity]]);
export const DELIVERY_BUCKETS = Object.freeze([['under50ms', 50], ['under250ms', 250], ['under1s', 1000], ['under5s', 5000], ['longer', Infinity]]);
export const CLIENT_LABELS = 32; // distinct extension builds counted per process; the rest is `other`
const API_ROUTES = new Set(['create', 'join', 'relay', 'leave']); // long polls wait on purpose
const histogram = buckets => Object.fromEntries(buckets.map(([name]) => [name, 0]));
const count = (target, buckets, value) => { target[buckets.find(([, bound]) => value < bound)[0]]++; };
const copy = value => JSON.parse(JSON.stringify(value));

// `client` in a create/join handshake names the extension build. Anything
// that is not a plain version and two short identifiers counts as `unknown`.
export function clientLabel(handshake) {
  const client = handshake?.client;
  const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(value) ? value : 'unknown';
  if (!client || typeof client !== 'object' || typeof client.version !== 'string' || !/^\d{1,4}(?:\.\d{1,4}){2,3}$/.test(client.version)) return 'unknown';
  return `${name(client.distribution)}/${name(client.channel)}/${client.version}`;
}

export class OperatingCounters {
  constructor() {
    this.requests = 0;
    this.inFlight = 0;
    this.aborted = 0;
    this.responses = { success: 0, rejected: 0, failed: 0 };
    this.latencyMs = { count: 0, sum: 0, max: 0 };
    this.replays = 0;
    this.batchReplays = 0;
    this.supersededPolls = 0;
    this.closed = { leave: 0, idle: 0, expired: 0, overflow: 0, shutdown: 0, other: 0 };
    // Requests refused by an admission limit, by limit category.
    this.limited = { flood: 0, concurrency: 0, polls: 0, relay: 0, admission: 0, rooms: 0, lookups: 0, reports: 0 };
    this.rooms = { created: 0, joined: 0, unusedInvitations: 0 };
    this.durations = histogram(DURATION_BUCKETS); // joined rooms, from join to close
    this.traffic = { api: 0, health: 0, page: 0, unknown: 0 };
    this.apiLatency = histogram(LATENCY_BUCKETS); // create, join, relay and leave
    this.delivery = histogram(DELIVERY_BUCKETS); // relayed message waiting for the receiver's poll
    this.codes = {}; // error responses by runtime error code
    this.clients = {}; // admitted seats by extension build
    this.errorLog = { logged: 0, suppressed: 0 };
    this.reports = 0; // error reports sent from the popup
  }

  begin(route = 'unknown') {
    this.requests++;
    this.inFlight++;
    this.traffic[{ create: 'api', join: 'api', events: 'api', relay: 'api', leave: 'api', report: 'api', preflight: 'api', health: 'health', page: 'page' }[route] || 'unknown']++;
    const started = performance.now();
    let finished = false;
    return (status, aborted, code) => {
      if (finished) return;
      finished = true;
      this.inFlight--;
      if (aborted) this.aborted++;
      else this.responses[status >= 500 ? 'failed' : status >= 400 ? 'rejected' : 'success']++;
      if (code) this.codes[code] = (this.codes[code] || 0) + 1;
      const elapsed = Math.round(performance.now() - started);
      this.latencyMs.count++;
      this.latencyMs.sum += elapsed;
      this.latencyMs.max = Math.max(this.latencyMs.max, elapsed);
      if (!aborted && API_ROUTES.has(route)) count(this.apiLatency, LATENCY_BUCKETS, elapsed);
    };
  }

  seat(label) {
    const key = Object.hasOwn(this.clients, label) || Object.keys(this.clients).length < CLIENT_LABELS ? label : 'other';
    this.clients[key] = (this.clients[key] || 0) + 1;
  }

  roomClosed(room, now) {
    if (room.joined === undefined) this.rooms.unusedInvitations++;
    else count(this.durations, DURATION_BUCKETS, Math.max(0, now - room.joined));
  }

  delivered(ageMs) { count(this.delivery, DELIVERY_BUCKETS, Math.max(0, ageMs)); }

  // Cumulative counters only: a day's numbers are the difference of two totals.
  totals() {
    return copy({ requests: this.requests, aborted: this.aborted, responses: this.responses,
      replays: this.replays, batchReplays: this.batchReplays, supersededPolls: this.supersededPolls,
      closed: this.closed, limited: this.limited, rooms: this.rooms, durations: this.durations, traffic: this.traffic,
      apiLatency: this.apiLatency, delivery: this.delivery, codes: this.codes, clients: this.clients, errorLog: this.errorLog, reports: this.reports });
  }

  snapshot(rooms, cachedRequests, draining) {
    return { ...this.totals(), inFlight: this.inFlight, latencyMs: { ...this.latencyMs },
      ...rooms.status(), cachedRequests, draining };
  }
}
