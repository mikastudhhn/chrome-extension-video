import { spawn } from 'node:child_process';
import { open, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { processIdentity, groupMembers, hasGroupOwnership } from './browser-test-ownership.js';

// Chromium adds its own directory and SingletonSocket below TMPDIR. Keep suite
// names in evidence only: long names exceed the Unix-domain socket path limit.
export const createSuiteTemporaryDirectory = root => mkdtemp(join(root, 's-'));

// A group can disappear between suite exit and the final signal. EPERM alone
// never authorizes skipping cleanup: independently prove no live members remain.
export function signalProcessGroup(group, signal, kill = process.kill) {
  if (!Number.isInteger(group) || group <= 1) throw new Error('Invalid owned process group');
  try { kill(-group, signal); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM' && groupMembers(group).length === 0) return false;
    throw error;
  }
}

// One child at a time, with a launch-time registry for separately detached
// browser groups. No name-based process killing or access to other servers.
export async function runProcess(command, args, { cwd, env, directory, signal, timeoutMs = 600_000 }) {
  await mkdir(directory, { recursive: true });
  const log = await open(join(directory, 'output.log'), 'w');
  const registry = resolve(directory, 'owned-processes.jsonl');
  await writeFile(registry, '');
  const preload = new URL('./browser-test-ownership.js', import.meta.url).href;
  const inheritedEnv = env || process.env;
  const childEnv = { ...inheritedEnv, VIDEO_SYNC_TEST_PROCESS_REGISTRY: registry,
    NODE_OPTIONS: `${inheritedEnv.NODE_OPTIONS || ''} --import=${JSON.stringify(preload)}` };
  const started = Date.now();
  let reason = null, timer, forceTimer;
  const child = spawn(command, args, { cwd, env: childEnv, detached: true, stdio: ['ignore', log.fd, log.fd] });
  const killGroup = signal => {
    if (!child.pid) return;
    signalProcessGroup(child.pid, signal);
  };
  const stop = cause => {
    if (reason) return;
    reason = cause;
    killGroup('SIGTERM');
    forceTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
  };
  const abort = () => stop('aborted');
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('suite deadline exceeded'), timeoutMs);
  try {
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, spawnError: error.message }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (signal?.aborted) abort();
    const result = { command, args, started: new Date(started).toISOString(), ...await exited,
      reason, durationMs: Date.now() - started };
    // An exited test must not leave Chrome or a fixture watcher alive.
    killGroup('SIGKILL');
    // The suite can no longer launch children. Re-read even after a blocked
    // suite's SIGKILL; registration does not depend on its exit/signal handlers.
    result.ownedGroups = [];
    for (const line of (await readFile(registry, 'utf8')).trim().split('\n').filter(Boolean)) {
      const owned = JSON.parse(line);
      const current = processIdentity(owned.pid);
      const members = groupMembers(owned.group);
      if (members.length === 0) { result.ownedGroups.push({ ...owned, cleanup: 'already exited' }); continue; }
      if (current && (current.group !== owned.group || (owned.identity && current.identity !== owned.identity))) {
        result.reason ||= 'owned process identity changed; cleanup refused';
        result.ownedGroups.push({ ...owned, cleanup: 'identity mismatch' });
        continue;
      }
      // A missing leader does not prove an empty group. A still-live member
      // must carry this launch's inherited marker before we signal the group.
      const witness = members.find(pid => hasGroupOwnership(pid, owned));
      if (!witness) {
        if (groupMembers(owned.group).length === 0) {
          result.ownedGroups.push({ ...owned, cleanup: 'already exited' }); continue;
        }
        result.reason ||= 'owned group membership could not be verified; cleanup refused';
        result.ownedGroups.push({ ...owned, members, cleanup: 'ownership unverified' });
        continue;
      }
      const sent = signalProcessGroup(owned.group, 'SIGKILL');
      result.ownedGroups.push({ ...owned, members, witness, cleanup: sent ? 'SIGKILL' : 'already exited' });
    }
    await writeFile(join(directory, 'process.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer);
    signal?.removeEventListener('abort', abort);
    await log.close();
  }
}

export async function runSerial(suites, run, signal) {
  const results = [];
  for (const suite of suites) {
    if (signal?.aborted) break;
    const result = await run(suite);
    results.push({ name: suite.name, ...result });
    // Fail closed, including interruption and spawn failure. Never retry a suite.
    if (result.code !== 0 || result.reason) break;
  }
  return results;
}
