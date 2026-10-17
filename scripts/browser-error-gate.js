import http from 'node:http';

// Real HTTP faults, outside the extension. Relay faults happen only after the
// upstream has consumed and acknowledged the command, exercising lost ACKs.
export function errorGate(base) {
  const gate = { mode: 'offline', fault: null };
  gate.server = http.createServer((request, response) => {
    if (gate.mode === 'offline') { request.socket.destroy(); return; }
    if (gate.mode === 'slow-failure') {
      const timer = setTimeout(() => request.socket.destroy(), 900);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    if (gate.mode === 'structured-open' && request.method === 'POST' && request.url.endsWith('/join')) {
      request.resume();
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Failed to fetch', failure: {
        code: 'ROOM_FULL', category: 'connection', retryable: true, message: 'Failed to fetch'
      } }));
      return;
    }
    if (gate.mode === 'malformed-events' && request.url.startsWith('/events?')) {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{');
      return;
    }
    const fault = gate.fault;
    const intercept = fault && request.method === 'POST' && request.url === '/relay';
    let body = '';
    if (intercept) request.on('data', chunk => { body += chunk; });
    const upstream = http.request(new URL(request.url, base), { method: request.method, headers: request.headers }, incoming => {
      if (!intercept) {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
        return;
      }
      let acknowledgement = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { acknowledgement += chunk; });
      incoming.on('end', () => {
        fault.attempts.push({ body, status: incoming.statusCode, acknowledgement });
        if (fault.attempts.length > 1 || incoming.statusCode !== 200) {
          response.writeHead(incoming.statusCode, { 'Content-Type': 'application/json' });
          response.end(acknowledgement);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
        fault.headersSent = true;
        response.on('close', () => { fault.bodyClosed = true; });
        if (fault.kind === 'malformed-json') response.end();
        else if (fault.kind === 'socket-close') {
          const timer = setTimeout(() => response.destroy(), 50);
          response.on('close', () => clearTimeout(timer));
        }
        // body-timeout/local-abort: leave the body open until the client aborts.
      });
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => response.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  return gate;
}
