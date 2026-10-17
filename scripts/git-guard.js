import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const archived = ref => ref.startsWith('refs/heads/archive/');
try {
  if (process.argv[2] === 'reference-transaction') {
    if (process.argv[3] !== 'prepared') process.exit(0);
    for (const line of readFileSync(0, 'utf8').trim().split('\n')) {
      const [old, next, ref] = line.split(' ');
      if (!ref || old === next || /^0+$/.test(old)) continue;
      if (archived(ref) || ref.startsWith('refs/tags/')) throw new Error(`${ref}: Archiv und Release-Tags bleiben unverändert.`);
      if (ref === 'refs/heads/main') {
        if (next !== git('rev-parse', 'refs/remotes/origin/main')) throw new Error('Main nur nach einem GitHub-PR per Fast-Forward aktualisieren.');
        git('merge-base', '--is-ancestor', old, next);
      }
    }
  } else {
    const branch = git('branch', '--show-current');
    if (!branch || branch === 'main' || archived(`refs/heads/${branch}`)) throw new Error('Änderungen auf ft/*, fix/* oder einem anderen PR-Arbeitsbranch erstellen.');
  }
} catch (error) { console.error(error.message); process.exit(1); }
