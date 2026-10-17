// Release signing for CI and the owner's machine. The private key is read
// from RELEASE_SIGNING_KEY (PEM, GitHub secret of the protected environment
// `release`) or from the file named by RELEASE_SIGNING_KEY_FILE. It is never
// written, logged or copied; only detached signatures leave this module.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_PUBLIC_KEY } from '../extension/release-key.js';
import { signatureStatement, statementBytes, keyId, encodeBase64Url, verifyUpdateSignature, SIGNATURE_SCHEMA, SIGNATURE_ALGORITHM } from '../extension/update-signature.js';
import { updateAssetName, signatureAssetName } from '../extension/package-files.js';

export const repository = 'mikastudhhn/chrome-extension-video';
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadSigningKey(env = process.env) {
  let pem = env.RELEASE_SIGNING_KEY;
  if (!pem && env.RELEASE_SIGNING_KEY_FILE) {
    const path = env.RELEASE_SIGNING_KEY_FILE.replace(/^~(?=$|\/)/, homedir());
    pem = readFileSync(path, 'utf8');
  }
  if (!pem) throw new Error('Release signing key missing: set RELEASE_SIGNING_KEY (PEM) or RELEASE_SIGNING_KEY_FILE (path to the PEM file).');
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('Release signing key is not a readable private key (PEM).'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Release signing key must be an ECDSA P-256 key.');
  return key;
}

export function statementFor({ bytes, tag, channel, asset }) {
  return signatureStatement({ repository, tag, channel, asset, sha256: hex(bytes) });
}

// Signs one update asset and verifies the result with the public key the
// extension embeds, so a wrong CI secret can never publish unverifiable updates.
export async function signUpdateAsset({ bytes, tag, channel, asset, privateKey, publicKey = RELEASE_PUBLIC_KEY }) {
  const signer = createPublicKey(privateKey).export({ format: 'jwk' });
  const id = await keyId(publicKey);
  if (await keyId(signer) !== id) throw new Error('The signing key does not match extension/release-key.js; refusing to create unverifiable signatures.');
  const statement = statementFor({ bytes, tag, channel, asset });
  const signature = encodeBase64Url(sign('sha256', statementBytes(statement), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  const text = JSON.stringify({ schema: SIGNATURE_SCHEMA, algorithm: SIGNATURE_ALGORITHM, keyId: id, statement, signature }, null, 2) + '\n';
  await verifyUpdateSignature(text, statement, { publicKey });
  return text;
}

export async function verifySignatureFile({ bytes, signature, tag, channel, asset, publicKey = RELEASE_PUBLIC_KEY }) {
  return verifyUpdateSignature(signature, statementFor({ bytes, tag, channel, asset }), { publicKey });
}

// Returns the path of the signature for one update asset of `release`. A
// signature already uploaded to a (draft) release is reused after verification:
// ECDSA signatures are randomized, and published bytes are never replaced.
export async function releaseSignature({ release, preparedStable = false, updatePath, tag, channel, directory, privateKey, download, publicKey = RELEASE_PUBLIC_KEY }) {
  const asset = updateAssetName(preparedStable), name = signatureAssetName(preparedStable), path = join(directory, name);
  const bytes = await readFile(updatePath);
  if (release?.assets?.some(item => item.name === name)) {
    const downloaded = await download(release, name, directory);
    await verifySignatureFile({ bytes, signature: await readFile(downloaded), tag, channel, asset, publicKey });
    return downloaded;
  }
  await writeFile(path, await signUpdateAsset({ bytes, tag, channel, asset, privateKey, publicKey }));
  return path;
}
