import { errorResponse } from './runtime-errors.js';
import { Signaling } from './signaling.js';
import { clientInfo } from './error-report.js';
import { STORE } from './distribution.js';
let connection;
let closed = false;
// The build label for the relay's aggregate counts; without it the room still opens.
const packaged = file => fetch(new URL(file, import.meta.url)).then(response => response.json());
const client = Promise.all([packaged('manifest.json'), packaged('build-info.json')])
  .then(([manifest, build]) => clientInfo(manifest, build, STORE)).catch(() => null);
self.onmessage = async ({ data }) => {
  if (data.type === 'open' && !closed) {
    connection = new Signaling(data.server,
      event => self.postMessage({ type: 'event', event }),
      error => self.postMessage({ type: 'error', ...errorResponse(error) }),
      status => self.postMessage({ type: 'status', ...status }));
    try {
      if (!data.checkpoint) connection.client = await client;
      const member = data.checkpoint ? connection.resume(data.checkpoint) : await connection.open(data.code);
      if (closed) return;
      self.postMessage({ type: 'opened', member });
      connection.poll();
    } catch (error) { if (!closed) self.postMessage({ type: 'error', ...errorResponse(error) }); }
  } else if (data.type === 'send') {
    for (const message of Array.isArray(data.messages) ? data.messages : [data.message]) connection?.send(message);
  }
  else if (data.type === 'suspend') {
    self.postMessage({ type: 'suspended', checkpoint: connection.suspend() });
    self.close();
  }
  else if (data.type === 'close') {
    closed = true;
    await connection?.close();
    self.close();
  }
};
