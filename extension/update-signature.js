// Detached release signatures, shared by the browser updater (verification)
// and the Node release scripts (signing). A signature covers a canonical
// statement that binds the exact bytes of one update asset (which itself
// carries the SHA-256 of every package file) to repository, release tag,
// channel and asset name. A valid signature can therefore not be reused for
// another release, another channel or the not yet approved Stable candidate.
import { RELEASE_PUBLIC_KEY } from './release-key.js';

export const SIGNATURE_SCHEMA = 1;
export const SIGNATURE_ALGORITHM = 'ES256';
export const SIGNATURE_PURPOSE = 'video-sync-update';
export const MAX_SIGNATURE_BYTES = 4096;

export class SignatureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Sorted keys, no whitespace. Statements contain only strings and integers.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function signatureStatement({ repository, tag, channel, asset, sha256 }) {
  return { schema: SIGNATURE_SCHEMA, purpose: SIGNATURE_PURPOSE, repository, tag, channel, asset, sha256 };
}

export const statementBytes = statement => new TextEncoder().encode(canonicalJson(statement));

export function encodeBase64Url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(text) {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)), char => char.charCodeAt(0));
}

// RFC 7638 JWK thumbprint of a P-256 public key.
export async function keyId(jwk) {
  const thumbprint = canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return encodeBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprint)));
}

const fail = (code, message) => { throw new SignatureError(code, message); };

// Verifies a detached signature (bytes or JSON text) against the statement the
// updater expects for the downloaded asset. The public key is injectable for
// tests; production always uses the embedded release key.
export async function verifyUpdateSignature(signature, expected, { publicKey = RELEASE_PUBLIC_KEY } = {}) {
  if (!signature || (typeof signature !== 'string' && signature.byteLength === 0)) fail('missing', 'Das Update ist nicht signiert. Installation abgebrochen.');
  let envelope;
  try {
    const text = typeof signature === 'string' ? signature : new TextDecoder('utf-8', { fatal: true }).decode(signature);
    if (new TextEncoder().encode(text).byteLength > MAX_SIGNATURE_BYTES) throw new Error('too large');
    envelope = JSON.parse(text);
  } catch { fail('malformed', 'Die Update-Signatur ist beschädigt. Installation abgebrochen.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join() !== 'algorithm,keyId,schema,signature,statement' ||
      envelope.schema !== SIGNATURE_SCHEMA || envelope.algorithm !== SIGNATURE_ALGORITHM ||
      typeof envelope.keyId !== 'string' || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) {
    fail('malformed', 'Die Update-Signatur hat ein unbekanntes Format. Installation abgebrochen.');
  }
  if (publicKey?.kty !== 'EC' || publicKey.crv !== 'P-256') fail('key', 'Der Releaseschlüssel dieser Installation ist ungültig.');
  if (envelope.keyId !== await keyId(publicKey)) fail('wrong-key', 'Das Update wurde nicht mit dem Video-Sync-Releaseschlüssel signiert. Installation abgebrochen.');
  const statement = signatureStatement(expected);
  if (canonicalJson(envelope.statement) !== canonicalJson(statement)) {
    fail('mismatch', 'Die Signatur gehört zu einem anderen Release, Kanal oder Paket. Installation abgebrochen.');
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64Url(envelope.signature), statementBytes(statement));
  } catch { fail('key', 'Der Releaseschlüssel dieser Installation ist ungültig.'); }
  if (!valid) fail('invalid', 'Die Update-Signatur ist ungültig. Das Paket wurde verändert oder nicht vom Herausgeber signiert. Installation abgebrochen.');
  return statement;
}
