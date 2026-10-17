import http from 'node:http';

// A real HTTP boundary: unlike browser offline emulation, this also interrupts
// requests issued by extension offscreen/dedicated-worker contexts.
export async function failureProxy(target, record = () => {}) {
  let offlineRole = null, offlinePath = '';
  const roles = new Map(), active = new Set(), delays = new Map(), counts = {};
  const server = http.createServer(async (request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const role = roles.get(token);
    const lane = request.url.split('?')[0];
    if (role) (counts[role] ??= {})[lane] = (counts[role][lane] || 0) + 1;
    if (offlineRole && role === offlineRole && request.url.startsWith(offlinePath)) { request.socket.destroy(); return; }
    const abort = new AbortController();
    const entry = { role, path: request.url, response, abort };
    active.add(entry);
    response.on('close', () => { abort.abort(); active.delete(entry); });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === '/relay') record({ type: 'relay-received', role,
        delayMs: delays.get(role) || 0, batch: JSON.parse(Buffer.concat(chunks).toString()) });
      if (request.url === '/relay' && delays.get(role)) await new Promise(resolve => setTimeout(resolve, delays.get(role)));
      const headers = {};
      for (const key of ['authorization', 'content-type', 'accept']) if (request.headers[key]) headers[key] = request.headers[key];
      const upstream = await fetch(`${target}${request.url}`, {
        method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: abort.signal
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (request.url === '/relay') record({ type: 'relay-ack', role, status: upstream.status, body: JSON.parse(body.toString()) });
      if (upstream.status === 201) {
        const member = JSON.parse(body.toString());
        roles.set(member.token, member.role);
      }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { if (!response.destroyed) response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    offline(role, path = '') {
      offlineRole = role; offlinePath = path;
      for (const entry of active) if (entry.role === role && entry.path.startsWith(path)) { entry.abort.abort(); entry.response.destroy(); }
    },
    online() { offlineRole = null; },
    delay(role, milliseconds) { delays.set(role, milliseconds); },
    // Requests per member role and path, for traffic measurements.
    counts() { return structuredClone(counts); },
    async close() {
      for (const entry of active) { entry.abort.abort(); entry.response.destroy(); }
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
