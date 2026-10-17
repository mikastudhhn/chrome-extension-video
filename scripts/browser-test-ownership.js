import childProcess from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

// Loaded before the suite (and before Playwright captures child_process.spawn).
// This registry contains only detached children created by this suite tree.
export function processIdentity(pid) {
  try {
    const line = childProcess.execFileSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart=', '-o', 'args='],
      { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = line.match(/^(\d+)\s+([\s\S]+)$/);
    return match ? { group: Number(match[1]), identity: match[2] } : null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

const ownerKey = 'VIDEO_SYNC_TEST_PROCESS_OWNER';

export function groupMembers(group) {
  // Enumerate only numeric membership globally; inspect environments solely for
  // members of an already registered group. Zombies cannot execute or be killed.
  const table = childProcess.execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return table.trim().split('\n').map(line => line.trim().split(/\s+/))
    .filter(([, pgid, state]) => Number(pgid) === group && !state.startsWith('Z'))
    .map(([pid]) => Number(pid));
}

export function hasGroupOwnership(pid, owned) {
  const before = processIdentity(pid);
  if (before?.group !== owned.group) return false;
  let matches;
  try {
    const marker = `${ownerKey}=${owned.owner}`;
    if (process.platform === 'linux') {
      matches = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker);
    } else {
      // macOS exposes inherited environment with ps eww. Never log its contents.
      const environment = childProcess.execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      matches = environment.split(/\s+/).includes(marker);
    }
  } catch (error) {
    if (error.status === 1 || ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
  const after = processIdentity(pid);
  return matches && after?.group === before.group && after.identity === before.identity;
}

const registry = process.env.VIDEO_SYNC_TEST_PROCESS_REGISTRY;
if (registry) {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, args, options) {
    const hasArgs = Array.isArray(args);
    const originalOptions = hasArgs ? options : args;
    if (!originalOptions?.detached) return originalSpawn.apply(this, arguments);
    const owner = randomUUID();
    const ownedOptions = { ...originalOptions, env: { ...(originalOptions.env || process.env), [ownerKey]: owner } };
    const child = hasArgs ? originalSpawn.call(this, command, args, ownedOptions) : originalSpawn.call(this, command, ownedOptions);
    if (child.pid) {
      try {
        const identity = processIdentity(child.pid);
        if (identity && identity.group !== child.pid) throw new Error('Detached test process has an unexpected process group');
        // Record even if the leader has already exited: children inherit the
        // per-launch marker and can prove ownership of the surviving group.
        appendFileSync(registry, JSON.stringify({ pid: child.pid, parent: process.pid,
          command, group: child.pid, identity: identity?.identity || null, owner }) + '\n');
      } catch (error) {
        // Fail closed if ownership cannot be recorded while the ChildProcess is ours.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        throw error;
      }
    }
    return child;
  };
  syncBuiltinESMExports();
}
