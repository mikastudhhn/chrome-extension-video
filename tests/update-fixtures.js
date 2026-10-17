import { generateKeyPairSync } from 'node:crypto';
import { REPOSITORY } from '../extension/github-updates.js';
import { packageFile, fileEncoding, fileBytes, sha256, updateAssetName, signatureAssetName, UPDATE_SCHEMA } from '../extension/package-files.js';
import { signUpdateAsset } from '../scripts/release-signing.js';

// Freshly generated ECDSA P-256 keys. Tests never read the real release key;
// they inject the test public key into the updater instead.
export function generateTestKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }), pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}
let sharedKey;
export const testReleaseKey = () => (sharedKey ??= generateTestKey());

export const releaseKeyModule = jwk => `export const RELEASE_PUBLIC_KEY = Object.freeze(${JSON.stringify(jwk)});\n`;

// GitHub asset entries for an update asset and its detached signature, plus the
// response body for each asset id. `signature` may replace the generated one.
export async function signedUpdateAssets(body, { tag, channel, key = testReleaseKey(), id = 101, preparedStable = false, signature } = {}) {
  const bytes = new TextEncoder().encode(body);
  signature ??= await signUpdateAsset({ bytes, tag, channel, asset: updateAssetName(preparedStable), privateKey: key.privateKey, publicKey: key.publicKey });
  const entry = async (assetId, name, text) => {
    const data = new TextEncoder().encode(text);
    return { id: assetId, name, state: 'uploaded', size: data.byteLength, digest: `sha256:${await sha256(data)}` };
  };
  return { signature, assets: [await entry(id, updateAssetName(preparedStable), body), await entry(id + 1, signatureAssetName(preparedStable), signature)],
    bodies: { [id]: body, [id + 1]: signature } };
}

// Files every update package must contain besides manifest.json and build-info.json.
export const requiredFiles = Object.freeze({ 'background.js': '', 'features.js': '', 'popup.html': '', 'popup.js': '',
  'offscreen.html': '', 'updates.html': '', 'updates.js': '' });

// A complete, valid update bundle of one candidate; `build` is the preview number.
export async function candidateBundle({ channel = 'experimental', commit = 'b'.repeat(40), base = '0.6.0', build = 1, extra = {}, manifest = {} } = {}) {
  const version = `${base}.${build}`, candidateTag = `v${base}-preview.${build}`;
  const contents = { ...requiredFiles, 'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version, ...manifest }),
    'build-info.json': JSON.stringify({ schema: 2, repository: REPOSITORY, commit, channel, candidateTag, local: null }), ...extra };
  const files = await Promise.all(Object.entries(contents).map(([path, data]) =>
    packageFile(path, typeof data === 'string' ? new TextEncoder().encode(data) : data, fileEncoding(path))));
  return { schema: UPDATE_SCHEMA, repository: REPOSITORY, channel, commit, candidateTag, version, files };
}

// The installed files of a bundle as the fake directory stores them.
export function bundleContents(bundle) {
  return Object.fromEntries(bundle.files.map(file => [file.path, file.encoding === 'utf8' ? file.content : fileBytes(file)]));
}

export function packageFiles(version = '0.5.0', commit = 'a'.repeat(40), extra = {}) {
  return {
    'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version, key: 'same-key' }, null, 2),
    'build-info.json': JSON.stringify({ repository: REPOSITORY, commit, channel: 'experimental', candidateTag: `v${version}-preview.1`, local: null }),
    'popup.js': `popup ${version}`,
    ...extra
  };
}

// Update entries as the installer receives them; strings are UTF-8, bytes Base64.
export function fileEntries(record) {
  return Object.entries(record).map(([path, data]) => typeof data === 'string' ? { path, encoding: 'utf8', content: data }
    : { path, encoding: 'base64', content: Buffer.from(data).toString('base64') });
}

export function fakeDirectory(initial, hook = async () => {}) {
  const files = new Map(Object.entries(initial)), writes = [];
  const missing = () => Object.assign(new Error('Missing'), { name: 'NotFoundError' });
  const directory = prefix => ({
    name: 'isolated-extension',
    queryPermission: async () => 'granted',
    isSameEntry: async other => other === root,
    getDirectoryHandle: async name => directory(prefix + name + '/'),
    getFileHandle: async (name, options) => {
      const path = prefix + name;
      if (!files.has(path) && !options?.create) throw missing();
      return { getFile: async () => {
        if (!files.has(path)) throw missing();
        const content = files.get(path);
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
        return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
      }, createWritable: async () => {
        let value;
        return {
          write: async text => { await hook(`write:${path}`); value = text; },
          close: async () => { await hook(`before-close:${path}`); files.set(path, value); writes.push(path); await hook(`after-close:${path}`); },
          abort: async () => {}
        };
      } };
    },
    removeEntry: async name => {
      await hook(`before-remove:${prefix + name}`);
      if (!files.delete(prefix + name)) throw missing();
      writes.push(`remove:${prefix + name}`);
      await hook(`after-remove:${prefix + name}`);
    }
  });
  const root = directory('');
  return { directory: root, files, writes };
}

// Emulate structured persistence without copying the directory capability.
export function copyRecord(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof value.isSameEntry === 'function') return value;
  if (Array.isArray(value)) return value.map(copyRecord);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyRecord(item)]));
}
