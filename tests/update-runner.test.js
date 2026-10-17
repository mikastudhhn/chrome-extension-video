import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpdate } from '../extension/update-runner.js';
import { recoveryStatus, sealSnapshot, validateSnapshot } from '../extension/update-recovery.js';
import { fakeDirectory, packageFiles, copyRecord, fileEntries } from './update-fixtures.js';

function fixture(t, diskHook) {
  const oldChrome = globalThis.chrome;
  const access = { githubToken: 'fixture-token' };
  globalThis.chrome = { runtime: { id: 'test-extension' }, storage: { local: { get: async () => ({ ...access }), set: async values => Object.assign(access, values) } } };
  t.after(() => { globalThis.chrome = oldChrome; });
  const initial = packageFiles();
  const target = packageFiles('0.5.1', 'b'.repeat(40), { 'ui/new.js': 'new file' });
  const disk = fakeDirectory({ ...initial, 'user-notes.txt': 'keep' }, diskHook);
  const records = new Map(), events = [];
  const io = {
    verifyInstallation: async directory => { assert.equal(directory, disk.directory); events.push('verify'); },
    verifyRecoveryDirectory: async (directory, snapshot) => {
      await validateSnapshot(snapshot);
      if (!await directory.isSameEntry(snapshot.directory)) throw new Error('Wrong folder');
      events.push('verify recovery');
    },
    latestRelease: async () => { events.push('download'); return { id: 1 }; },
    downloadBundle: async () => ({ commit: 'b'.repeat(40), files: fileEntries(target) }),
    async stored(key, value) {
      if (arguments.length === 1) return copyRecord(records.get(key));
      if (value === undefined) records.delete(key);
      else records.set(key, copyRecord(value));
    },
    storeUpdateState: async values => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) records.delete(key);
        else records.set(key, copyRecord(value));
      }
    }
  };
  return { initial, target, disk, records, events, io, options: { channel: 'experimental', directory: disk.directory } };
}

function interruption(point) {
  let reached;
  const stopped = new Promise(resolve => { reached = resolve; });
  return { stopped, checkpoint: async name => {
    if (name === point) { reached(); await new Promise(() => {}); }
  } };
}

async function abandonAt(f, point, options = {}) {
  const stop = interruption(point);
  // The abandoned runner never resumes or executes catch/finally. A new runner
  // receives only the persisted records and directory, as after process loss.
  const task = runUpdate({ ...f.options, ...options, checkpoint: stop.checkpoint }, f.io);
  await Promise.race([stop.stopped, task.then(() => assert.fail(`checkpoint not reached: ${point}`))]);
}

test('successful update commits a checked backup only after complete readback; explicit restore consumes it', async t => {
  const f = fixture(t);
  assert.deepEqual(await runUpdate(f.options, f.io), { outcome: 'installed' });
  await validateSnapshot(f.records.get('backup'));
  assert.equal(f.records.get('updateJournal'), undefined);
  assert.equal(f.records.get('updateReceipt').outcome, 'installed');
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.target, 'user-notes.txt': 'keep' });
  assert.equal(f.disk.writes.at(-1), 'manifest.json');
  await runUpdate({ ...f.options, restore: true }, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
  assert.equal(f.records.get('backup'), undefined);
  await assert.rejects(runUpdate({ ...f.options, restore: true }, f.io), /Kein vorheriger Stand/);
});

test('access, folder identity, package and journal persistence failures write no installation files', async t => {
  const f = fixture(t);
  const cases = [
    { options: { directory: { queryPermission: async () => 'denied' } }, io: {}, error: /Schreibzugriff/ },
    { io: { verifyInstallation: async () => { throw new Error('Wrong folder'); } }, error: /Wrong folder/ },
    { io: { downloadBundle: async () => { throw new Error('Bad checksum'); } }, error: /checksum/ },
    { io: { stored: async (key, value) => { if (value) throw new Error('Quota'); } }, error: /Quota/ }
  ];
  for (const scenario of cases) {
    await assert.rejects(runUpdate({ ...f.options, ...scenario.options }, { ...f.io, ...scenario.io }), scenario.error);
    assert.equal(f.disk.writes.length, 0);
  }
});

const installPoints = ['before-journal', 'prepared', 'installing', ...[1, 2, 3, 4].map(n => `installed-file:${n}`), 'before-install-readback', 'after-install-readback'];
for (const point of installPoints) {
  test(`process loss at ${point}: a fresh invocation cannot back up a mixed installation`, async t => {
    const f = fixture(t);
    const older = await sealSnapshot(f.disk.directory, fileEntries(f.initial));
    f.records.set('backup', older);
    await abandonAt(f, point);
    assert.deepEqual(f.records.get('backup'), older, 'previous completed backup remains untouched');
    f.events.length = 0;
    const result = await runUpdate(f.options, f.io);
    if (point === 'before-journal') {
      assert.equal(result.outcome, 'installed');
    } else {
      assert.equal(result.outcome, 'restored');
      assert.equal(f.events.includes('download'), false, 'the recovery click never starts a new install');
      assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
      await validateSnapshot(f.records.get('backup'));
      await runUpdate(f.options, f.io);
      assert.equal(f.records.get('backup').source.commit, 'a'.repeat(40));
    }
  });
}

for (const point of ['restoring', 'restored-file:popup.js', 'restored-file:ui/new.js', 'restored-file:manifest.json', 'before-restore-readback', 'after-restore-readback']) {
  test(`repeated recovery interruption at ${point} retains the recoverable source`, async t => {
    const f = fixture(t);
    await abandonAt(f, 'after-install-readback');
    const source = copyRecord(f.records.get('updateJournal').backup);
    await abandonAt(f, point);
    await abandonAt(f, point);
    assert.deepEqual(f.records.get('updateJournal').backup, source);
    await runUpdate(f.options, f.io);
    assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
  });
}

test('explicit restore survives a crash after writing the final file', async t => {
  const f = fixture(t);
  await runUpdate(f.options, f.io);
  await abandonAt(f, 'restored-file:manifest.json', { restore: true });
  await runUpdate(f.options, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
  assert.equal(f.records.get('backup'), undefined);
});

test('restart after committed install has a complete target and an intact source backup', async t => {
  const f = fixture(t);
  await abandonAt(f, 'installed-committed');
  assert.equal(f.records.has('updateJournal'), false);
  assert.equal((await recoveryStatus(f.io.stored)).pending, false);
  await runUpdate({ ...f.options, restore: true }, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
});

test('silent write corruption is detected by readback and never reported as installed', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdate({ ...f.options, checkpoint: async point => {
    if (point === 'before-install-readback') f.disk.files.set('popup.js', 'silent corruption');
  } }, f.io), /geprüft wiederhergestellt/);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
  assert.equal(f.records.get('updateReceipt').outcome, 'restored');
});

test('restore readback failure retains journal and backup, then a retry repairs it', async t => {
  const f = fixture(t);
  await abandonAt(f, 'installed-file:2');
  await assert.rejects(runUpdate({ ...f.options, checkpoint: async point => {
    if (point === 'before-restore-readback') f.disk.files.set('popup.js', 'wrong restored bytes');
  } }, f.io), /Dateiprüfung/);
  assert.equal(f.records.get('updateJournal').phase, 'restoring');
  assert.equal(f.records.get('updateReceipt'), undefined);
  await runUpdate(f.options, f.io);
  assert.equal(f.disk.files.get('popup.js'), f.initial['popup.js']);
});

test('unknown, malformed and corrupt backups are retained and block ordinary installation', async t => {
  const f = fixture(t);
  const good = await sealSnapshot(f.disk.directory, fileEntries(f.initial));
  for (const bad of [[], null, { ...good, schema: 99 }, { ...good, digest: 'bad' }, { ...good, files: [...good.files, good.files[0]] }]) {
    f.records.set('backup', bad);
    await assert.rejects(runUpdate(f.options, f.io));
    assert.deepEqual(f.records.get('backup'), bad);
    assert.equal((await recoveryStatus(f.io.stored)).blocked, true);
  }
  assert.equal(f.disk.writes.length, 0);
  assert.equal(f.events.includes('download'), false);
});

test('unknown and corrupt journals cannot be bypassed by a valid backup', async t => {
  const f = fixture(t);
  await abandonAt(f, 'prepared');
  const journal = copyRecord(f.records.get('updateJournal'));
  for (const bad of [null, { ...journal, schema: 2 }, { ...journal, phase: 'invented' }, { ...journal, target: { ...journal.target, digest: 'bad' } }]) {
    f.records.set('updateJournal', bad);
    await assert.rejects(runUpdate(f.options, f.io));
    assert.equal((await recoveryStatus(f.io.stored)).blocked, true);
  }
  assert.equal(f.disk.writes.length, 0);
});

test('completion storage failure leaves the journal for a restart without rotating the backup', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdate(f.options, { ...f.io, storeUpdateState: async () => { throw new Error('Transaction aborted'); } }), /Transaction aborted/);
  assert.equal(f.records.get('updateJournal').phase, 'installing');
  assert.equal(f.records.get('backup'), undefined);
  await runUpdate(f.options, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
});

test('repair verification archives rejected state only after complete published-package readback', async t => {
  const f = fixture(t);
  const rejected = [{ path: 'popup.js', content: 'untrusted record' }];
  f.records.set('backup', rejected);
  const io = { ...f.io, githubRequest: async path => {
    assert.equal(path, '/releases/tags/v0.5.0-preview.1');
    return { json: async () => ({ id: 1 }) };
  }, downloadBundle: async () => ({ commit: 'a'.repeat(40), files: fileEntries(f.initial) }) };
  f.disk.files.set('popup.js', 'partial install');
  await assert.rejects(runUpdate({ ...f.options, verifyRepair: true }, io), /Dateiprüfung/);
  assert.deepEqual(f.records.get('backup'), rejected);
  f.disk.files.set('popup.js', f.initial['popup.js']);
  await runUpdate({ ...f.options, verifyRepair: true }, io);
  assert.deepEqual(f.records.get('recoveryArchive').backup, rejected);
  assert.equal(f.records.get('backup'), undefined);
  assert.equal(f.disk.writes.length, 0);
});

test('a failed automatic rollback never loses the source journal or claims success', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdate(f.options, { ...f.io,
    installFiles: async () => { f.disk.files.set('popup.js', 'partial'); throw new Error('Disk full'); },
    restoreFiles: async () => { throw new Error('Access revoked'); }
  }), /nicht abgeschlossen.*Backup bleibt erhalten/);
  assert.equal(f.records.get('updateJournal').phase, 'restoring');
  assert.equal(f.records.get('updateReceipt'), undefined);
  await runUpdate(f.options, f.io);
  assert.equal(f.disk.files.get('popup.js'), f.initial['popup.js']);
});

for (const point of ['write:popup.js', 'before-close:manifest.json', 'after-close:manifest.json']) {
  test(`process loss inside a file stream at ${point} recovers without running the abandoned catch`, async t => {
    const stop = interruption(point);
    let enabled = true;
    const f = fixture(t, name => enabled ? stop.checkpoint(name) : undefined);
    const abandoned = runUpdate(f.options, f.io);
    await Promise.race([stop.stopped, abandoned.then(() => assert.fail('did not stop'))]);
    enabled = false;
    await runUpdate(f.options, f.io);
    assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
  });
}

test('a physically torn manifest can be restored using the original directory binding', async t => {
  const f = fixture(t);
  await abandonAt(f, 'installed-file:3');
  f.disk.files.set('manifest.json', '{broken');
  f.disk.files.delete('build-info.json');
  await runUpdate(f.options, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
});

test('a different selected directory cannot consume the open journal or receive recovery writes', async t => {
  const f = fixture(t);
  await abandonAt(f, 'installed-file:2');
  const other = fakeDirectory(f.initial);
  await assert.rejects(runUpdate({ ...f.options, directory: other.directory }, f.io), /Wrong folder/);
  assert.equal(other.writes.length, 0);
  assert.equal(f.records.get('updateJournal').phase, 'installing');
});

test('published-package verification accepts a preserved key with changed JSON formatting but rejects changed manifest fields', async t => {
  const f = fixture(t);
  f.records.set('backup', []);
  const io = { ...f.io, githubRequest: async () => ({ json: async () => ({ id: 1 }) }),
    downloadBundle: async () => ({ commit: 'a'.repeat(40), files: fileEntries(f.initial) }) };
  const manifest = JSON.parse(f.initial['manifest.json']);
  f.disk.files.set('manifest.json', JSON.stringify({ ...manifest, permissions: ['debugger'] }));
  await assert.rejects(runUpdate({ ...f.options, verifyRepair: true }, io), /Manifest weicht/);
  assert.deepEqual(f.records.get('backup'), []);
  f.disk.files.set('manifest.json', JSON.stringify(manifest));
  await runUpdate({ ...f.options, verifyRepair: true }, io);
  assert.equal(f.records.get('updateReceipt').outcome, 'verified');
});

test('published-package verification rejects a different immutable commit or an identity-changing key', async t => {
  const f = fixture(t);
  f.records.set('backup', []);
  const io = { ...f.io, githubRequest: async () => ({ json: async () => ({ id: 1 }) }) };
  await assert.rejects(runUpdate({ ...f.options, verifyRepair: true }, io), /passt nicht/);
  const otherKey = { ...f.initial, 'manifest.json': JSON.stringify({ ...JSON.parse(f.initial['manifest.json']), key: 'other-key' }) };
  io.downloadBundle = async () => ({ commit: 'a'.repeat(40), files: fileEntries(otherKey) });
  await assert.rejects(runUpdate({ ...f.options, verifyRepair: true }, io), /Erweiterungs-ID/);
  assert.deepEqual(f.records.get('backup'), []);
  assert.equal(f.disk.writes.length, 0);
});

test('an open or corrupt journal takes precedence over a stored backup', async t => {
  const f = fixture(t);
  await abandonAt(f, 'installed-file:2');
  f.records.set('backup', await sealSnapshot(f.disk.directory, fileEntries(f.initial)));
  let state = await recoveryStatus(f.io.stored);
  assert.equal(state.pending, true);
  assert.equal(state.canRestore, true);
  const journal = copyRecord(f.records.get('updateJournal'));
  f.records.set('updateJournal', { ...journal, schema: 99 });
  state = await recoveryStatus(f.io.stored);
  assert.equal(state.pending, true);
  assert.equal(state.blocked, true);
  assert.equal(state.canRestore, false);
  await assert.rejects(runUpdate(f.options, f.io), /Update-Journal/);
  f.records.set('updateJournal', journal);
  await runUpdate(f.options, f.io);
  assert.deepEqual(Object.fromEntries(f.disk.files), { ...f.initial, 'user-notes.txt': 'keep' });
});

test('failed online verification leaves an unverifiable backup unchanged and writes nothing', async t => {
  const f = fixture(t);
  const rejected = [{ path: 'popup.js', content: 'unverifiable' }];
  f.records.set('backup', rejected);
  for (const reason of ['Offline', 'GitHub-Zugriff abgelaufen']) {
    await assert.rejects(runUpdate({ ...f.options, verifyRepair: true }, {
      ...f.io, githubRequest: async () => { throw new Error(reason); }
    }), new RegExp(reason));
    const state = await recoveryStatus(f.io.stored);
    assert.equal(state.blocked, true);
    assert.equal(state.canRestore, false);
    assert.deepEqual(f.records.get('backup'), rejected);
    assert.equal(f.records.has('updateJournal'), false);
  }
  assert.equal(f.disk.writes.length, 0);
});
