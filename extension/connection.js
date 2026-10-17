import { fault, responseError } from './runtime-errors.js';

export class Connection {
  constructor(server, onEvent, onError, onStatus) {
    this.server = server;
    this.closed = false;
    this.outbox = [];
    this.worker = new Worker('connection-worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data.type === 'opened') { this.resolveOpen?.(data.member); this.resolveOpen = this.rejectOpen = null; }
      else if (data.type === 'suspended') {
        this.resolveSuspend?.(data.checkpoint);
        this.resolveSuspend = this.rejectSuspend = null;
        this.closed = true;
        this.worker.terminate();
      } else if (data.type === 'event') onEvent(data.event);
      else if (data.type === 'status') onStatus(data);
      else if (data.type === 'error') this.fail(responseError(data), onError);
    };
    this.worker.onerror = () => this.fail(fault('WORKER_INTERRUPTED'), onError);
  }

  fail(error, onError) {
    if (this.closed) return;
    const opening = !!this.rejectOpen;
    this.rejectPending(error);
    if (!opening) onError(error);
  }

  rejectPending(error) {
    this.rejectOpen?.(error);
    this.rejectSuspend?.(error);
    this.resolveOpen = this.rejectOpen = this.resolveSuspend = this.rejectSuspend = null;
  }

  open(code, checkpoint) {
    if (this.closed) return Promise.reject(fault('ABORTED'));
    return new Promise((resolve, reject) => {
      this.resolveOpen = resolve; this.rejectOpen = reject;
      this.worker.postMessage({ type: 'open', server: this.server, code, checkpoint });
    });
  }

  async suspend() {
    if (this.closed) throw fault('ABORTED');
    this.post();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          this.resolveSuspend = resolve; this.rejectSuspend = reject;
          this.worker.postMessage({ type: 'suspend' });
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dev-Reload konnte die Verbindung nicht sichern.')), 4000); })
      ]);
    } finally { clearTimeout(timer); this.resolveSuspend = this.rejectSuspend = null; }
  }

  // Messages sent in the same task (a keepalive and its ping) reach the worker
  // together and leave in one relay batch.
  send(message) {
    if (this.closed) return;
    if (!this.outbox.length) queueMicrotask(() => this.post());
    this.outbox.push(message);
  }
  post() {
    if (this.closed || !this.outbox.length) return;
    this.worker.postMessage({ type: 'send', messages: this.outbox });
    this.outbox = [];
  }
  close() {
    if (this.closed) return;
    this.outbox = [];
    this.closed = true;
    this.rejectPending(fault('ABORTED'));
    this.worker.postMessage({ type: 'close' });
    // The worker finishes its bounded /leave request; late callbacks are ignored.
    setTimeout(() => this.worker.terminate(), 3500);
  }
}
