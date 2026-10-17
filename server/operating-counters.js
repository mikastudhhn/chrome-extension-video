// Fixed categories only. No path, address, token, room, request ID or error text.
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
    this.limited = { flood: 0, concurrency: 0, polls: 0, relay: 0, admission: 0, rooms: 0, lookups: 0 };
  }

  begin() {
    this.requests++;
    this.inFlight++;
    const started = performance.now();
    let finished = false;
    return (status, aborted) => {
      if (finished) return;
      finished = true;
      this.inFlight--;
      if (aborted) this.aborted++;
      else this.responses[status >= 500 ? 'failed' : status >= 400 ? 'rejected' : 'success']++;
      const elapsed = Math.round(performance.now() - started);
      this.latencyMs.count++;
      this.latencyMs.sum += elapsed;
      this.latencyMs.max = Math.max(this.latencyMs.max, elapsed);
    };
  }

  snapshot(rooms, cachedRequests, draining) {
    return { requests: this.requests, inFlight: this.inFlight, aborted: this.aborted,
      responses: { ...this.responses }, latencyMs: { ...this.latencyMs },
      replays: this.replays, batchReplays: this.batchReplays, supersededPolls: this.supersededPolls,
      closed: { ...this.closed }, limited: { ...this.limited },
      ...rooms.status(), cachedRequests, draining };
  }
}
