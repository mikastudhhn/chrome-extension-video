import test from 'node:test';
import assert from 'node:assert/strict';
import { storeUpdateState } from '../extension/update-storage.js';

// A small transaction driver: the storage adapter must await completion, use
// strict durability and explicitly abort if queuing a later write throws.
function database(t, failPut = false) {
  const previous = globalThis.indexedDB;
  t.after(() => { globalThis.indexedDB = previous; });
  const committed = new Map([['updateJournal', 'recoverable'], ['backup', 'last-good']]);
  let transaction, closed = false;
  globalThis.indexedDB = { open: () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        transaction: (name, mode, options) => {
          assert.equal(name, 'settings'); assert.equal(mode, 'readwrite'); assert.equal(options.durability, 'strict');
          const staged = new Map(committed);
          let aborted = false;
          transaction = {
            objectStore: () => ({
              delete: key => { staged.delete(key); },
              put: (value, key) => { if (failPut) throw new DOMException('Cannot clone', 'DataCloneError'); staged.set(key, value); }
            }),
            abort: () => { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
            complete: () => {
              if (aborted) return;
              committed.clear(); for (const [key, value] of staged) committed.set(key, value);
              transaction.oncomplete();
            }
          };
          return transaction;
        },
        close: () => { closed = true; }
      };
      request.onsuccess();
    });
    return request;
  } };
  return { committed, get transaction() { return transaction; }, get closed() { return closed; } };
}

test('journal removal and backup rotation resolve only after the same durable transaction commits', async t => {
  const db = database(t);
  let resolved = false;
  const saving = storeUpdateState({ updateJournal: undefined, backup: 'new-good' }).then(() => { resolved = true; });
  await new Promise(setImmediate);
  assert.equal(resolved, false);
  assert.equal(db.committed.get('updateJournal'), 'recoverable');
  db.transaction.complete();
  await saving;
  assert.equal(db.committed.get('updateJournal'), undefined);
  assert.equal(db.committed.get('backup'), 'new-good');
  assert.equal(db.closed, true);
});

test('a synchronous clone failure cannot commit journal deletion before backup storage', async t => {
  const db = database(t, true);
  await assert.rejects(storeUpdateState({ updateJournal: undefined, backup: 'cannot-clone' }), /Cannot clone/);
  db.transaction.complete();
  assert.equal(db.committed.get('updateJournal'), 'recoverable');
  assert.equal(db.committed.get('backup'), 'last-good');
  assert.equal(db.closed, true);
});

test('transaction abort preserves both the journal and the previous backup', async t => {
  const db = database(t);
  const saving = storeUpdateState({ updateJournal: undefined, backup: 'new-good' });
  await new Promise(setImmediate);
  db.transaction.abort();
  await assert.rejects(saving, /Speichern abgebrochen/);
  assert.equal(db.committed.get('updateJournal'), 'recoverable');
  assert.equal(db.committed.get('backup'), 'last-good');
});
