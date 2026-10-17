import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyUpdateSignature, keyId, SignatureError } from '../extension/update-signature.js';
import { downloadBundle, REPOSITORY } from '../extension/github-updates.js';
import { RELEASE_PUBLIC_KEY } from '../extension/release-key.js';
import { sha256 } from '../extension/package-files.js';
import { signUpdateAsset, loadSigningKey } from '../scripts/release-signing.js';
import { createPackageBundle } from '../scripts/package-bundle.js';
import { runUpdate } from '../extension/update-runner.js';
import { configureUpdates } from '../extension/update-service.js';
import { candidateBundle, signedUpdateAssets, generateTestKey, testReleaseKey, fakeDirectory, copyRecord, bundleContents } from './update-fixtures.js';

const key = testReleaseKey();
const tag = 'v0.6.0-preview.7', channel = 'experimental';
const expectedFor = async (bytes, overrides = {}) => ({ repository: REPOSITORY, tag, channel, asset: 'update.json', sha256: await sha256(bytes), ...overrides });
const signed = async body => signUpdateAsset({ bytes: new TextEncoder().encode(body), tag, channel, asset: 'update.json', privateKey: key.privateKey, publicKey: key.publicKey });
const rejects = (promise, code, message) => assert.rejects(promise, error => error instanceof SignatureError && error.code === code && message.test(error.message));

test('the embedded release key is a P-256 public key without private material', async () => {
  assert.deepEqual(Object.keys(RELEASE_PUBLIC_KEY).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(RELEASE_PUBLIC_KEY.crv, 'P-256');
  await crypto.subtle.importKey('jwk', { ...RELEASE_PUBLIC_KEY }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.match(await keyId(RELEASE_PUBLIC_KEY), /^[A-Za-z0-9_-]{43}$/);
});

test('a valid signature verifies with the injected test key and binds the canonical statement', async () => {
  const body = JSON.stringify(await candidateBundle({ build: 7 }));
  const signature = await signed(body);
  const statement = await verifyUpdateSignature(signature, await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey });
  assert.deepEqual(statement, { schema: 1, purpose: 'video-sync-update', repository: REPOSITORY, tag, channel, asset: 'update.json', sha256: await sha256(new TextEncoder().encode(body)) });
  // Without the injected key the production key is used, which never signed it.
  await rejects(verifyUpdateSignature(signature, await expectedFor(new TextEncoder().encode(body))), 'wrong-key', /Releaseschlüssel signiert/);
});

test('a tampered per-file hash, tampered signature, wrong key and missing signature are rejected', async () => {
  const bundle = await candidateBundle({ build: 7 });
  const body = JSON.stringify(bundle);
  const signature = await signed(body);
  // Tampered file hash: update.json changes, so the signed asset digest no longer matches.
  const tampered = structuredClone(bundle); tampered.files[0].sha256 = '0'.repeat(64);
  await rejects(verifyUpdateSignature(signature, await expectedFor(new TextEncoder().encode(JSON.stringify(tampered))), { publicKey: key.publicKey }), 'mismatch', /anderen Release, Kanal oder Paket/);
  // Tampered signature bytes, including an attacker re-using the statement.
  const envelope = JSON.parse(signature);
  const flipped = envelope.signature[10] === 'A' ? 'B' : 'A';
  const forged = JSON.stringify({ ...envelope, signature: envelope.signature.slice(0, 10) + flipped + envelope.signature.slice(11) });
  await rejects(verifyUpdateSignature(forged, await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'invalid', /ungültig/);
  // Wrong key: a different key, also when it claims the expected key id.
  const other = generateTestKey();
  const foreign = await signUpdateAsset({ bytes: new TextEncoder().encode(body), tag, channel, asset: 'update.json', privateKey: other.privateKey, publicKey: other.publicKey });
  await rejects(verifyUpdateSignature(foreign, await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'wrong-key', /nicht mit dem Video-Sync-Releaseschlüssel/);
  const disguised = JSON.stringify({ ...JSON.parse(foreign), keyId: await keyId(key.publicKey) });
  await rejects(verifyUpdateSignature(disguised, await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'invalid', /ungültig/);
  // Missing or malformed signatures.
  await rejects(verifyUpdateSignature(new Uint8Array(), await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'missing', /nicht signiert/);
  await rejects(verifyUpdateSignature('not json', await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'malformed', /beschädigt/);
  await rejects(verifyUpdateSignature(JSON.stringify({ ...envelope, algorithm: 'none' }), await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'malformed', /unbekanntes Format/);
  await rejects(verifyUpdateSignature(JSON.stringify({ ...envelope, extra: 1 }), await expectedFor(new TextEncoder().encode(body)), { publicKey: key.publicKey }), 'malformed', /unbekanntes Format/);
});

test('a signature cannot be replayed for another tag, channel or the prepared Stable asset', async () => {
  const body = JSON.stringify(await candidateBundle({ build: 7 }));
  const bytes = new TextEncoder().encode(body);
  const signature = await signed(body);
  for (const overrides of [{ tag: 'v0.6.0-preview.8' }, { tag: 'v0.6.0' }, { channel: 'stable' }, { asset: 'update-stable.json' }, { repository: 'someone/fork' }]) {
    await rejects(verifyUpdateSignature(signature, await expectedFor(bytes, overrides), { publicKey: key.publicKey }), 'mismatch', /anderen Release/);
  }
});

test('signing refuses a key that does not match the expected public key, and key loading validates the curve', async () => {
  const other = generateTestKey();
  await assert.rejects(signUpdateAsset({ bytes: new Uint8Array([1]), tag, channel, asset: 'update.json', privateKey: other.privateKey, publicKey: key.publicKey }), /does not match/);
  await assert.rejects(signUpdateAsset({ bytes: new Uint8Array([1]), tag, channel, asset: 'update.json', privateKey: key.privateKey }), /does not match extension\/release-key\.js/);
  assert.throws(() => loadSigningKey({}), /RELEASE_SIGNING_KEY/);
  assert.throws(() => loadSigningKey({ RELEASE_SIGNING_KEY: 'garbage' }), /not a readable private key/);
  const { generateKeyPairSync } = await import('node:crypto');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => loadSigningKey({ RELEASE_SIGNING_KEY: rsa }), /ECDSA P-256/);
  assert.equal(loadSigningKey({ RELEASE_SIGNING_KEY: key.pem }).asymmetricKeyDetails.namedCurve, 'prime256v1');
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-key-file-'));
  try {
    await writeFile(join(directory, 'key.pem'), key.pem, { mode: 0o600 });
    assert.equal(loadSigningKey({ RELEASE_SIGNING_KEY_FILE: join(directory, 'key.pem') }).asymmetricKeyType, 'ec');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// GitHub fixture serving releases and asset bodies by id.
function serve(t, releases, bodies) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    const id = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
    if (id) return bodies[id] === undefined ? new Response('{}', { status: 404 }) : new Response(bodies[id]);
    return new Response(JSON.stringify(releases));
  });
  return requests;
}

test('downloadBundle verifies the detached signature before parsing and rejects unsigned releases', async t => {
  const bundle = await candidateBundle({ build: 7 });
  const body = JSON.stringify(bundle);
  const { assets, bodies } = await signedUpdateAssets(body, { tag, channel });
  const release = { id: 1, tag_name: tag, target_commitish: bundle.commit, prerelease: true, assets };
  const requests = serve(t, [release], bodies);
  const options = { publicKey: key.publicKey };
  assert.equal((await downloadBundle(release, channel, '', options)).candidateTag, tag);
  assert.equal(requests.length, 2, 'one package and one signature download');
  await assert.rejects(downloadBundle(release, channel, ''), /nicht mit dem Video-Sync-Releaseschlüssel/, 'the production key never accepts a test signature');
  await assert.rejects(downloadBundle({ ...release, assets: [assets[0]] }, channel, '', options), /nicht signiert/);
  // A replaced update.json with a matching GitHub digest still fails the signature.
  const tampered = structuredClone(bundle); tampered.files[0].sha256 = '0'.repeat(64);
  const forgedBody = JSON.stringify(tampered);
  const forged = await signedUpdateAssets(forgedBody, { tag, channel, signature: bodies[102] });
  serve(t, [], forged.bodies);
  await assert.rejects(downloadBundle({ ...release, assets: forged.assets }, channel, '', options), /anderen Release, Kanal oder Paket/);
  // A valid signature of the Experimental release cannot install as Stable.
  const asStable = { ...release, tag_name: 'v0.6.0', prerelease: false };
  serve(t, [], bodies);
  await assert.rejects(downloadBundle(asStable, 'stable', '', options), /anderen Release/);
});

test('end to end: a package built from extension/ and signed with a test key installs through the real updater path', async t => {
  const previous = globalThis.chrome, local = {};
  globalThis.chrome = { runtime: { id: 'signature-test' }, storage: { local: {
    get: async () => structuredClone(local), set: async values => Object.assign(local, structuredClone(values)),
    remove: async keys => { for (const item of [keys].flat()) delete local[item]; }, setAccessLevel: async () => {}
  } }, alarms: { create: async () => {} } };
  t.after(() => { globalThis.chrome = previous; });
  await configureUpdates('');
  const root = await mkdtemp(join(tmpdir(), 'video-sync-signed-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Build two versions of the real extension like scripts/package-extension.js.
  const build = async (number, commit) => {
    const directory = join(root, String(number));
    await cp('extension', directory, { recursive: true });
    const candidateTag = `v0.6.0-preview.${number}`, version = `0.6.0.${number}`;
    await writeFile(join(directory, 'build-info.json'), JSON.stringify({ schema: 2, repository: REPOSITORY, commit, channel, candidateTag, local: null }, null, 2) + '\n');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, version, version_name: `${version} · Experimental` }, null, 2) + '\n');
    return createPackageBundle(directory, { repository: REPOSITORY, channel, commit, candidateTag, version });
  };
  const installed = await build(6, 'a'.repeat(40)), target = await build(7, 'b'.repeat(40));
  const body = JSON.stringify(target);
  const { assets, bodies } = await signedUpdateAssets(body, { tag: target.candidateTag, channel });
  const release = { id: 7, tag_name: target.candidateTag, target_commitish: target.commit, draft: false, prerelease: true, assets };
  serve(t, [release], bodies);
  const disk = fakeDirectory(bundleContents(installed)), records = new Map();
  const io = {
    verifyInstallation: async () => {}, verifyRecoveryDirectory: async () => {},
    downloadBundle: (found, selected, token) => downloadBundle(found, selected, token, { publicKey: key.publicKey }),
    async stored(name, value) { if (arguments.length === 1) return copyRecord(records.get(name)); if (value === undefined) records.delete(name); else records.set(name, copyRecord(value)); },
    storeUpdateState: async values => { for (const [name, value] of Object.entries(values)) { if (value === undefined) records.delete(name); else records.set(name, copyRecord(value)); } }
  };
  assert.equal((await runUpdate({ channel, directory: disk.directory }, io)).outcome, 'installed');
  assert.deepEqual(Object.fromEntries(disk.files), bundleContents(target));
  // The production key rejects the same test-signed release without writing.
  const untouched = fakeDirectory(bundleContents(installed));
  const production = Object.fromEntries(Object.entries(io).filter(([name]) => name !== 'downloadBundle'));
  await assert.rejects(runUpdate({ channel, directory: untouched.directory }, production), /nicht mit dem Video-Sync-Releaseschlüssel/);
  assert.equal(untouched.writes.length, 0);
});

test('the release:sign and release:verify commands sign with a key file and verify with a test public key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-sign-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const update = join(directory, 'update.json'), keyFile = join(directory, 'test-key.pem'), publicFile = join(directory, 'test-key.jwk.json');
  await writeFile(update, JSON.stringify(await candidateBundle({ build: 7 })));
  await writeFile(keyFile, key.pem, { mode: 0o600 });
  await writeFile(publicFile, JSON.stringify(key.publicKey));
  const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/release-sign.js', ...args], { encoding: 'utf8', env: { ...process.env, RELEASE_SIGNING_KEY: '', RELEASE_SIGNING_KEY_FILE: '', ...env } });
  const common = [update, '--tag', tag, '--channel', channel, '--public-key', publicFile];
  const signedRun = run(['sign', ...common], { RELEASE_SIGNING_KEY_FILE: keyFile });
  assert.equal(signedRun.status, 0, signedRun.stderr);
  const verified = run(['verify', ...common]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Valid signature/);
  assert.notEqual(run(['verify', update, '--tag', 'v0.6.0-preview.8', '--channel', channel, '--public-key', publicFile]).status, 0);
  assert.notEqual(run(['verify', update, '--tag', tag, '--channel', channel]).status, 0, 'the embedded production key rejects the test signature');
  assert.match(run(['sign', ...common]).stderr, /RELEASE_SIGNING_KEY/);
  assert.doesNotMatch(signedRun.stdout + signedRun.stderr, /PRIVATE KEY/);
});
