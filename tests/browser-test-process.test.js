import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity } from '../scripts/browser-test-ownership.js';
import { runProcess, runSerial, signalProcessGroup, createSuiteTemporaryDirectory } from '../scripts/browser-test-process.js';

test('isolated suite temporary directories leave room for the real Chromium Unix socket', async () => {
  const root = await mkdtemp('/tmp/video-sync-browser-');
  const server = createServer();
  try {
    const first = await createSuiteTemporaryDirectory(root);
    const second = await createSuiteTemporaryDirectory(root);
    assert.notEqual(first, second, 'Suites retain separate temporary directories');
    const socketDirectory = join(first, 'org.chromium.Chromium.Vmu3NV');
    await mkdir(socketDirectory);
    const socket = join(socketDirectory, 'SingletonSocket');
    assert.ok(Buffer.byteLength(socket) < 104, 'Fits both macOS and Linux sockaddr_un');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    assert.equal(server.listening, true);
    const former = join(root, 'core-delayed-start-stable-candidate', 'org.chromium.Chromium.Vmu3NV', 'SingletonSocket');
    assert.ok(Buffer.byteLength(former) >= 108, 'Reproduces the failing Linux CI path budget');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-runner-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('browser gate runs serially, retains a failed process log and never retries or starts its successor', () => fixture(async directory => {
  const started = [], finished = [];
  const results = await runSerial([{ name: 'first' }, { name: 'broken' }, { name: 'must-not-run' }], async suite => {
    assert.equal(started.length, finished.length, 'No overlapping processes');
    started.push(suite.name);
    const result = await runProcess(process.execPath, ['-e', `console.log('evidence:${suite.name}'); setTimeout(() => process.exit(${suite.name === 'broken' ? 7 : 0}), 50)`],
      { cwd: directory, env: process.env, directory: join(directory, suite.name) });
    finished.push(suite.name);
    return result;
  });
  assert.deepEqual(started, ['first', 'broken']);
  assert.deepEqual(results.map(result => result.code), [0, 7]);
  assert.match(await readFile(join(directory, 'broken', 'output.log'), 'utf8'), /evidence:broken/);
  assert.equal(JSON.parse(await readFile(join(directory, 'broken', 'process.json'))).code, 7);
}));

test('a hung suite fails with a deadline and its child process group is terminated', () => fixture(async directory => {
  const code = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid); setInterval(()=>{},1000);`;
  // The deadline must not land before the fixture printed its child PID on a loaded runner.
  const result = await runProcess(process.execPath, ['-e', code],
    { cwd: directory, env: process.env, directory, timeoutMs: 2000 });
  assert.equal(result.reason, 'suite deadline exceeded');
  assert.notEqual(result.code, 0);
  const pid = Number((await readFile(join(directory, 'output.log'), 'utf8')).trim());
  assert.ok(pid > 0);
  // Let the operating system reap the terminated descendant; no retry of a test.
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Fixture descendant survived suite termination');
}));

test('cancellation cannot become a successful gate or launch the next suite', () => fixture(async directory => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const results = await runSerial([{ name: 'cancelled' }, { name: 'next' }], () => runProcess(process.execPath,
      ['-e', 'setInterval(()=>{},1000)'], { cwd: directory, env: process.env, directory, signal: controller.signal }), controller.signal);
    assert.equal(results.length, 1);
    assert.equal(results[0].reason, 'aborted');
    assert.notEqual(results[0].code, 0);
  } finally { clearTimeout(timer); }
}));

test('a missing executable is a recorded failure rather than an absent result', () => fixture(async directory => {
  const result = await runProcess(join(directory, 'missing-command'), [], { cwd: directory, env: process.env, directory });
  assert.equal(result.code, null);
  assert.match(result.spawnError, /ENOENT/);
  assert.match(JSON.parse(await readFile(join(directory, 'process.json'))).spawnError, /ENOENT/);
}));

async function assertExited(pid) {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Owned process ${pid} survived cleanup`);
}

test('hard deadline kills a registered detached group despite a blocked suite and preserves unrelated processes', t => fixture(async directory => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  let ownedPid;
  t.after(() => {
    // Clean only this regression's known children even if an assertion fails.
    for (const pid of [ownedPid, unrelated.pid].filter(pid => Number.isInteger(pid) && pid > 1)) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const browser = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(JSON.stringify({browser:process.pid,grandchild:grandchild.pid}));
    setInterval(()=>{},1000);`;
  const suite = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const browser=spawn(process.execPath,['-e',${JSON.stringify(browser)}],{detached:true,stdio:['ignore','pipe','inherit']});
    browser.stdout.once('data',data=>{process.stdout.write(data.toString()); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  // The nested Node start-up and the synchronous ps registration of the detached
  // browser must finish before the deadline: a SIGTERM that lands during that
  // registration kills ps, the preload fails closed and the suite exits early
  // instead of blocking (CI run 35665936029 on a loaded runner).
  const result = await runProcess(process.execPath, ['-e', suite],
    { cwd: directory, env: process.env, directory, timeoutMs: 3000 });
  const log = (await readFile(join(directory, 'output.log'), 'utf8')).trim();
  assert.equal(result.reason, 'suite deadline exceeded', `Suite must block until the deadline, not exit early:\n${log}`);
  const pids = JSON.parse(log);
  ownedPid = pids.browser;
  assert.ok(Number.isInteger(ownedPid) && ownedPid > 1, JSON.stringify(pids));
  assert.equal(result.signal, 'SIGKILL', 'Suite never handled SIGTERM');
  assert.ok(result.durationMs >= 5500, 'Existing five-second grace period elapsed');
  assert.equal(result.ownedGroups.length, 1);
  assert.equal(result.ownedGroups[0].pid, pids.browser);
  assert.equal(result.ownedGroups[0].group, pids.browser, 'Browser owns a separate process group');
  assert.equal(result.ownedGroups[0].cleanup, 'SIGKILL');
  await assertExited(pids.browser);
  await assertExited(pids.grandchild);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'Unrelated detached process survives');
}));

test('an early suite exit also cleans its registered detached child', () => fixture(async directory => {
  const suite = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    console.log(child.pid); process.exit(7);`;
  const result = await runProcess(process.execPath, ['-e', suite],
    { cwd: directory, env: process.env, directory });
  assert.equal(result.code, 7);
  assert.equal(result.ownedGroups.length, 1);
  assert.equal(result.ownedGroups[0].cleanup, 'SIGKILL');
  await assertExited(result.ownedGroups[0].pid);
}));


test('a crashed detached leader leaves a provably owned group whose ordinary child is cleaned', t => fixture(async directory => {
  let leaderPid;
  t.after(() => {
    if (leaderPid > 1) { try { process.kill(-leaderPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  });
  const leader = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','console.log(process.pid); setInterval(()=>{},1000)'],{stdio:['ignore','pipe','inherit']});
    child.stdout.once('data',data=>{process.stdout.write(data); process.exit(1);});`;
  const suite = `const {spawn}=require('node:child_process');
    const leader=spawn(process.execPath,['-e',${JSON.stringify(leader)}],{detached:true,stdio:['ignore','inherit','inherit']});
    leader.once('exit',code=>process.exit(code===1?7:9));`;
  const result = await runProcess(process.execPath, ['-e', suite],
    { cwd: directory, env: process.env, directory });
  const childPid = Number((await readFile(join(directory, 'output.log'), 'utf8')).trim());
  leaderPid = result.ownedGroups[0]?.pid;
  assert.equal(result.code, 7);
  assert.equal(result.reason, null);
  assert.equal(result.ownedGroups.length, 1);
  assert.equal(result.ownedGroups[0].cleanup, 'SIGKILL');
  assert.equal(result.ownedGroups[0].witness, childPid, 'Surviving ordinary child proves ownership');
  assert.notEqual(childPid, leaderPid);
  assert.equal(processIdentity(leaderPid), null, 'Leader exited before cleanup');
  await assertExited(childPid);
}));

test('a live group without the registered launch marker is preserved and makes the gate fail', () => fixture(async directory => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  try {
    const stale = { pid: unrelated.pid, ...processIdentity(unrelated.pid), owner: 'not-this-process-owner' };
    const suite = `require('node:fs').appendFileSync(process.env.VIDEO_SYNC_TEST_PROCESS_REGISTRY,${JSON.stringify(JSON.stringify(stale) + '\n')});`;
    const result = await runProcess(process.execPath, ['-e', suite],
      { cwd: directory, env: process.env, directory });
    assert.equal(result.code, 0);
    assert.match(result.reason, /membership could not be verified/);
    assert.equal(result.ownedGroups[0].cleanup, 'ownership unverified');
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally { process.kill(-unrelated.pid, 'SIGKILL'); }
}));


test('EPERM is tolerated only with independent proof that the owned group has no live members', async () => {
  const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  const denyKill = () => { throw denied; };
  try {
    assert.throws(() => signalProcessGroup(live.pid, 'SIGKILL', denyKill), error => error === denied,
      'Permission errors for a live group must remain failures');
  } finally {
    const exited = new Promise(resolve => live.once('exit', resolve));
    process.kill(-live.pid, 'SIGKILL'); await exited;
  }
  assert.equal(signalProcessGroup(live.pid, 'SIGKILL', denyKill), false,
    'The exact exited fixture group has no remaining live members');
  const other = Object.assign(new Error('other failure'), { code: 'EIO' });
  assert.throws(() => signalProcessGroup(live.pid, 'SIGKILL', () => { throw other; }), error => error === other);
  assert.throws(() => signalProcessGroup(0, 'SIGKILL', denyKill), /Invalid owned process group/);
});
