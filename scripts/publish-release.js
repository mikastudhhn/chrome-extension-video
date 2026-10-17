import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, candidatePattern } from './release-refs.js';
import { publishRelease, getRelease, downloadAsset } from './github-releases.js';
import { updateAssetName } from '../extension/package-files.js';
import { readPackageBundle } from './package-bundle.js';
import { loadSigningKey, releaseSignature } from './release-signing.js';

// Publishes the files CI built and tested for this commit; nothing is rebuilt.
// Only detached signatures are added; they never change the tested files.
const privateKey = loadSigningKey();
const experimentalPackage = await readPackageBundle('dist/experimental', 'experimental');
const stablePackage = await readPackageBundle('dist/stable', 'stable');
const { bundle: experimental } = experimentalPackage, { bundle: stable } = stablePackage;
const tag = process.env.RELEASE_TAG;
if (!candidatePattern.test(tag || '') || experimental.candidateTag !== tag || stable.candidateTag !== tag || experimental.commit !== stable.commit || experimental.commit !== git('rev-parse', 'HEAD')) throw new Error('Candidate identity mismatch.');
if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main publishes candidates.');
git('merge-base', '--is-ancestor', experimental.commit, 'origin/main');
const existing = getRelease(tag);
if (existing && !existing.draft) {
  if (existing.target_commitish !== experimental.commit || !existing.prerelease || !existing.assets.some(asset => asset.name === updateAssetName(true))) throw new Error('Existing candidate is inconsistent.');
  console.log(`Candidate already published: ${existing.html_url}`);
}
const directory = 'dist/release';
await mkdir(directory, { recursive: true });
const version = experimental.version;
const files = [];
for (const [from, name] of [
  [`dist/experimental/video-sync-${version}.zip`, `video-sync-${version}.zip`],
  [`dist/experimental/video-sync-${version}.zip.sha256`, `video-sync-${version}.zip.sha256`],
  [experimentalPackage.path, updateAssetName()],
  [`dist/stable/video-sync-${version}.zip`, `video-sync-${version}-stable.zip`],
  [stablePackage.path, updateAssetName(true)]
]) { const path = join(directory, name); await copyFile(from, path); files.push(path); }
// update.json is installable in this Experimental release. The prepared
// Stable package is signed for this candidate tag only: its signature proves
// CI provenance at promotion, but never verifies as a released Stable update.
for (const [preparedStable, channel] of [[false, 'experimental'], [true, 'stable']]) {
  files.push(await releaseSignature({ release: existing, preparedStable, updatePath: join(directory, updateAssetName(preparedStable)), tag, channel,
    directory, privateKey, download: downloadAsset }));
}
const release = await publishRelease({ tag, commit: experimental.commit, title: `Experimental ${tag}`, notes: 'docs/release-notes.md', files, prerelease: true });
console.log(release.html_url);
