import { errorResponse } from './runtime-errors.js';
import { Signaling } from './signaling.js';
let connection;
let closed = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'open' && !closed) {
    connection = new Signaling(data.server,
      event => self.postMessage({ type: 'event', event }),
      error => self.postMessage({ type: 'error', ...errorResponse(error) }),
      status => self.postMessage({ type: 'status', ...status }));
    try {
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
