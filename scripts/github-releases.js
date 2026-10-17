import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

export const repository = 'mikastudhhn/chrome-extension-video';
export const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function* listReleases() {
  for (let page = 1; ; page++) {
    const releases = JSON.parse(gh('api', `repos/${repository}/releases?per_page=100&page=${page}`));
    yield* releases;
    if (releases.length < 100) return;
  }
}
export function getRelease(tag) {
  const result = spawnSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (!result.stderr.includes('(HTTP 404)')) throw new Error(result.stderr || 'GitHub release lookup failed.');
  // The tag endpoint may omit drafts. Authors can find and resume them through
  // the authenticated release listing, including after an interrupted upload.
  for (const release of listReleases()) if (release.tag_name === tag) return release;
  return null;
}
// Only the canonical repository publishes; a fork or renamed copy must not.
export function requireReleaseRepository() {
  if (JSON.parse(gh('api', `repos/${repository}`)).full_name !== repository) throw new Error(`Releases require ${repository}.`);
}
export async function downloadAsset(release, name, directory) {
  const asset = release.assets.find(asset => asset.name === name && asset.state === 'uploaded');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`Missing verified asset: ${name}`);
  await mkdir(directory, { recursive: true });
  gh('release', 'download', release.tag_name, '--repo', repository, '--pattern', name, '--dir', directory);
  const path = join(directory, name);
  if (digest(await readFile(path)) !== asset.digest) throw new Error(`Downloaded asset changed: ${name}`);
  return path;
}
export async function publishRelease({ tag, commit, title, notes, files, prerelease }) {
  requireReleaseRepository();
  let release = getRelease(tag);
  if (release && release.target_commitish !== commit) throw new Error('Existing tag belongs to another commit.');
  if (!release) {
    // Use the creation response: GitHub's tag/list endpoints can briefly omit a
    // newly created draft, even after the POST succeeds.
    release = JSON.parse(gh('api', '--method', 'POST', `repos/${repository}/releases`,
      '-f', `tag_name=${tag}`, '-f', `target_commitish=${commit}`, '-f', `name=${title}`,
      '-F', `body=@${notes}`, '-F', 'draft=true', '-F', `prerelease=${prerelease}`));
  }
  // Retry incomplete drafts safely. Published packages and tags are immutable by
  // convention and never replaced, including when a workflow is run again.
  for (const path of files) {
    const asset = release.assets.find(asset => asset.name === basename(path));
    if (asset) {
      if (asset.digest !== digest(await readFile(path))) throw new Error(`Existing asset differs: ${asset.name}`);
    } else {
      if (!release.draft) throw new Error('Published release is incomplete; do not overwrite it.');
      gh('release', 'upload', tag, path, '--repo', repository);
    }
  }
  if (release.draft) gh('release', 'edit', tag, '--repo', repository, '--draft=false', ...(prerelease ? [] : ['--latest']));
  return JSON.parse(gh('api', `repos/${repository}/releases/${release.id}`));
}
