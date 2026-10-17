import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePromotion } from '../scripts/promotion-policy.js';
import { featuresFor } from '../extension/features.js';

test('main accepts only a fast-forward of the fetched PR result; archives and version tags stay fixed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-git-test-'));
  const run = (command, args, ok = true) => {
    const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    if (ok) assert.equal(result.status, 0, result.stderr || result.stdout);
    else assert.notEqual(result.status, 0, 'operation should have been blocked');
    return result.stdout.trim();
  };
  const git = (...args) => run('git', args);
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Local test'); git('config', 'user.email', 'test@example.invalid');
    await mkdir(join(directory, 'scripts'));
    for (const file of ['git-guard.js', 'install-hooks.js']) await cp(resolve('scripts', file), join(directory, 'scripts', file));
    await cp('.githooks', join(directory, '.githooks'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    git('add', '.'); git('commit', '-m', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', baseline);
    git('branch', 'archive/production', baseline);
    git('tag', 'v0.3.0', baseline);
    git('switch', '-c', 'ft/example');
    run(process.execPath, ['scripts/install-hooks.js']);
    await writeFile(join(directory, 'change.txt'), 'candidate');
    git('add', '.'); git('commit', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD');
    git('switch', 'main');
    run('git', ['commit', '--allow-empty', '-m', 'direct'], false);
    run('git', ['merge', '--ff-only', 'ft/example'], false);
    git('update-ref', 'refs/remotes/origin/main', candidate);
    git('merge', '--ff-only', 'origin/main');
    assert.equal(git('rev-parse', 'main'), candidate);
    run('git', ['tag', '-f', 'v0.3.0', candidate], false);
    run('git', ['update-ref', 'refs/heads/archive/production', candidate, baseline], false);
    assert.equal(git('rev-parse', 'v0.3.0'), baseline);
    git('switch', '-c', 'fix/next');
    git('commit', '--allow-empty', '-m', 'follow-up');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stable approval is bound to a published candidate and accepted package, independent of current main', () => {
  const commit = 'a'.repeat(40), laterMain = 'b'.repeat(40);
  const release = { tag_name: 'v0.5.0-preview.12', prerelease: true, draft: false, target_commitish: commit };
  const bundle = { schema: 1, channel: 'stable', commit, candidateTag: release.tag_name };
  assert.equal(validatePromotion(release, bundle, commit), 'v0.5.0');
  assert.throws(() => validatePromotion(release, bundle, laterMain), /exact candidate/);
  assert.throws(() => validatePromotion({ ...release, draft: true }, bundle, commit), /published/);
  assert.throws(() => validatePromotion(release, { ...bundle, channel: 'experimental' }, commit), /Stable package/);
  assert.throws(() => validatePromotion(release, { ...bundle, candidateTag: 'v0.5.0-preview.11' }, commit), /Stable package/);
});

test('experimental behavior is off in Stable and unknown profiles', () => {
  assert.equal(featuresFor('stable').audioDiagnostics, false);
  assert.equal(featuresFor('unknown').audioDiagnostics, false);
  assert.equal(featuresFor('experimental').audioDiagnostics, true);
  assert.equal(featuresFor('local').audioDiagnostics, true);
});

test('workflows pin every action to a full commit SHA and only the protected release environment can sign', async () => {
  const directory = '.github/workflows';
  const workflows = Object.fromEntries(await Promise.all((await readdir(directory)).filter(name => /\.ya?ml$/.test(name))
    .map(async name => [name, await readFile(join(directory, name), 'utf8')])));
  for (const [name, text] of Object.entries(workflows)) {
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length, name);
    for (const [, action, comment] of uses) {
      assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${action} must be pinned to a commit SHA`);
      assert.match(comment, /^ # v\d+\.\d+\.\d+$/, `${name}: ${action} keeps its version as a comment`);
    }
    for (const checkout of text.split(/- uses: actions\/checkout@/).slice(1)) {
      assert.match(checkout.split('\n      - ')[0], /persist-credentials: false/, `${name}: checkout does not persist credentials`);
    }
    // The key is only referenced by jobs in the protected environment.
    for (const job of text.split(/\n  (?=[\w-]+:\n)/).slice(1)) {
      if (job.includes('RELEASE_SIGNING_KEY')) assert.match(job, /\n    environment: release\n/, `${name}: signing job uses environment release`);
    }
    assert.match(text, /^permissions:\n  contents: read$/m, `${name}: read-only default token`);
  }
  assert.match(workflows['verify.yml'].split('\n  release:')[1], /RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}/);
  assert.match(workflows['promote-stable.yml'], /RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}/);
  for (const job of ['build', 'checks', 'browser', 'verify']) {
    assert.doesNotMatch(workflows['verify.yml'].split(`\n  ${job}:`)[1].split(/\n  [\w-]+:\n/)[0], /secrets\./, `${job} never reads secrets`);
  }
  const dependabot = await readFile('.github/dependabot.yml', 'utf8');
  assert.match(dependabot, /package-ecosystem: github-actions/);
  const owners = await readFile('.github/CODEOWNERS', 'utf8');
  for (const path of ['/.github/', '/extension/release-key.js', '/scripts/publish-release.js', '/extension/github-updates.js', '/extension/update-*.js']) {
    assert.match(owners, new RegExp(`^${path.replace(/[.*/]/g, '\\$&')} @mikastudhhn$`, 'm'), path);
  }
});
