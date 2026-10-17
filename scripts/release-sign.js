// Local signing and verification of one update asset.
//   npm run release:sign -- <update.json> --tag <tag> --channel <stable|experimental> [--asset <name>] [--out <file>] [--public-key <jwk.json>]
//   npm run release:verify -- <update.json> --tag <tag> --channel <stable|experimental> [--asset <name>] [--signature <file>] [--public-key <jwk.json>]
// The private key comes from RELEASE_SIGNING_KEY (PEM) or RELEASE_SIGNING_KEY_FILE.
// --public-key replaces the embedded release key for test keys only.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { RELEASE_PUBLIC_KEY } from '../extension/release-key.js';
import { loadSigningKey, signUpdateAsset, verifySignatureFile } from './release-signing.js';

const [command, file, ...rest] = process.argv.slice(2);
const option = name => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] : undefined; };
const usage = 'Usage: node scripts/release-sign.js sign|verify <update.json> --tag <tag> --channel <stable|experimental> [--asset <name>] [--out|--signature <file>] [--public-key <jwk.json>]';
const tag = option('tag'), channel = option('channel');
if (!['sign', 'verify'].includes(command) || !file || !/^v\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(tag || '') || !['stable', 'experimental'].includes(channel)) throw new Error(usage);
const asset = option('asset') || basename(file);
const publicKey = option('public-key') ? JSON.parse(await readFile(option('public-key'), 'utf8')) : RELEASE_PUBLIC_KEY;
const bytes = await readFile(file);
if (command === 'sign') {
  const out = option('out') || `${file}.sig`;
  await writeFile(out, await signUpdateAsset({ bytes, tag, channel, asset, privateKey: loadSigningKey(), publicKey }));
  console.log(`Signed ${asset} for ${tag} (${channel}): ${out}`);
} else {
  const signature = await readFile(option('signature') || `${file}.sig`);
  const statement = await verifySignatureFile({ bytes, signature, tag, channel, asset, publicKey });
  console.log(`Valid signature: ${JSON.stringify(statement)}`);
}
