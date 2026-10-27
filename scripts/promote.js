import { selectUpdateAsset, updateAssetName, signatureAssetName } from '../extension/package-files.js';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getRelease, downloadAsset, publishRelease, requireReleaseRepository } from './github-releases.js';
import { validatePromotion } from './promotion-policy.js';
import { validateBundle } from '../extension/github-updates.js';
import { candidatePattern } from './release-refs.js';
import { loadSigningKey, releaseSignature, verifySignatureFile } from './release-signing.js';
import { verifyStorePackage } from './store-package.js';

const [channel, candidateOption, candidate, testedOption, tested] = process.argv.slice(2);
if (channel !== 'stable' || candidateOption !== '--candidate' || !candidatePattern.test(candidate || '') || testedOption !== '--tested' || !/^[a-f0-9]{40}$/.test(tested || '')) throw new Error('npm run promote -- stable --candidate vX.Y.Z-preview.N --tested <full accepted commit>');
// Read the key first: a missing key must fail before any download or write.
const privateKey = loadSigningKey();
requireReleaseRepository();
const release = getRelease(candidate);
if (!release || release.draft || !release.prerelease || release.target_commitish !== tested) throw new Error('Candidate and accepted commit do not match.');
const directory = await mkdtemp(join(tmpdir(), 'video-sync-promotion-'));
try {
  const asset = selectUpdateAsset(release, true);
  if (!asset) throw new Error('Missing prepared Stable update asset.');
  const bundlePath = await downloadAsset(release, asset.name, directory);
  // CI signed exactly these bytes as this candidate's prepared Stable package.
  await verifySignatureFile({ bytes: await readFile(bundlePath), signature: await readFile(await downloadAsset(release, signatureAssetName(true), directory)),
    tag: candidate, channel: 'stable', asset: updateAssetName(true) });
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  const tag = validatePromotion(release, bundle, tested);
  await validateBundle(bundle, 'stable', tested);
  const zip = await downloadAsset(release, `video-sync-${bundle.version}-stable.zip`, directory);
  const archive = join(directory, `video-sync-${bundle.version}.zip`);
  await copyFile(zip, archive);
  const update = join(directory, updateAssetName()); await copyFile(bundlePath, update);
  // The owner's approval: the unchanged bytes are signed as the released Stable update.
  const signature = await releaseSignature({ release: getRelease(tag), updatePath: update, tag, channel: 'stable', directory, privateKey, download: downloadAsset });
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${createHash('sha256').update(await readFile(archive)).digest('hex')}  video-sync-${bundle.version}.zip\n`);
  // The accepted candidate's Chrome Web Store ZIP is released unchanged next to it.
  // Candidates published before the store profile existed have none.
  const storeName = `video-sync-${bundle.version}-store.zip`, store = [];
  if (release.assets.some(asset => asset.name === storeName)) {
    store.push(await downloadAsset(release, storeName, directory), await downloadAsset(release, `${storeName}.sha256`, directory));
    await verifyStorePackage(store[0], tested);
  }
  const notes = join(directory, 'notes.md');
  await writeFile(notes, `Stable-Freigabe von ${candidate}. Praktisch abgenommener Commit: ${tested}.\n\nZIP und Update-Paket sind unveränderte Dateien des geprüften Stable-Profils dieses Kandidaten; ein vorhandenes \`-store.zip\` ist das unveränderte Chrome-Web-Store-Paket desselben Kandidaten. \`update.json.sig\` signiert das Update-Paket als freigegebenes Stable-Release.\n`);
  const result = await publishRelease({ tag, commit: tested, title: `Stable ${tag}`, notes, files: [archive, checksum, update, signature, ...store], prerelease: false });
  console.log(result.html_url);
} finally { await rm(directory, { recursive: true, force: true }); }
