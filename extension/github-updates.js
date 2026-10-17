import { sha256, fileText, validateFileEntries, validatePackageReferences, selectUpdateAsset, selectSignatureAsset, updateAssetName, signatureAssetName, MAX_TRANSPORT_BYTES, MAX_PACKAGE_FILES, UPDATE_SCHEMA } from './package-files.js';
import { verifyUpdateSignature, MAX_SIGNATURE_BYTES } from './update-signature.js';
export { sha256 } from './package-files.js';
export const REPOSITORY = 'mikastudhhn/chrome-extension-video';
export const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
// GitHub writes pagination links with the numeric repository ID.
export const REPOSITORY_ID = 1376456582;
// The API sends CORS headers, so release searches need no host permission.
// Asset downloads redirect to a host without CORS headers; only with both
// hosts granted is the redirected download readable.
export const GITHUB_ORIGINS = { origins: ['https://api.github.com/*', 'https://release-assets.githubusercontent.com/*'] };
// Automatic checks leave a few requests of GitHub's unauthenticated hourly
// limit (shared per IP address) for a manual check or an installation.
export const AUTOMATIC_RESERVE = 5;

export function releaseChannel(channel) {
  if (!['stable', 'experimental'].includes(channel)) throw new Error('Für lokale Branches gibt es keine GitHub-Updates.');
  return channel;
}

export function selectRelease(releases, channel) {
  releaseChannel(channel);
  return releases.filter(release => !release.draft && (channel === 'stable' ? !release.prerelease : !!release.prerelease) &&
    versionTag(release.tag_name, channel) && releaseCommit(release) && selectUpdateAsset(release))
    .sort((a, b) => compareVersionTags(a.tag_name, b.tag_name))[0] || null;
}

export function compareVersionTags(a, b) {
  const left = a.match(/\d+/g).map(Number), right = b.match(/\d+/g).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return (right[i] || 0) - (left[i] || 0);
  }
  return 0;
}

function versionTag(tag, channel) {
  return (channel === 'stable' ? /^v\d+\.\d+\.\d+$/ : /^v\d+\.\d+\.\d+-preview\.\d+$/).test(tag);
}

export function releaseCommit(release) {
  return /^[a-f0-9]{40}$/.test(release?.target_commitish || '') ? release.target_commitish : null;
}

// Only these safe messages cross the worker/UI boundary. Never forward response
// bodies or fetch exception messages: either may contain credentials or URLs.
export class GitHubError extends Error {
  constructor(code, message, retryAt = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export function safeGitHubError(error) {
  return error instanceof GitHubError ? error : new GitHubError('unavailable', 'GitHub ist momentan nicht erreichbar. Bitte später erneut versuchen.');
}

const rateLimitMessage = authorized => authorized
  ? 'GitHub-Anfragelimit erreicht. Die Prüfung wird nach der Wartezeit erneut versucht.'
  : 'GitHub-Anfragelimit ohne Token erreicht (60 Anfragen pro Stunde je Internetanschluss). Die Prüfung wird nach der Wartezeit erneut versucht; ein optionaler GitHub-Token erhöht die Grenze.';

async function downloadAccessMissing() {
  try { return !!globalThis.chrome?.permissions?.contains && !await chrome.permissions.contains(GITHUB_ORIGINS); }
  catch { return false; }
}

// Public releases need no token. A saved token is optional and only raises
// GitHub's request limit; it is sent exclusively to the fixed API.
export async function githubRequest(path, token, { binary = false, fetcher = fetch, etag, signal } = {}) {
  const authorized = typeof token === 'string' && !!token.trim();
  // Pagination may supply links, but credentials must stay on our fixed API.
  if (!path.startsWith('/releases') || path.includes('..') || path.includes('#')) {
    throw new GitHubError('invalid-response', 'Ungültige GitHub-Antwort. Prüfung nicht abgeschlossen.');
  }
  let response;
  try {
    response = await fetcher(`${API_ROOT}${path}`, {
      headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(etag ? { 'If-None-Match': etag } : {}) },
      credentials: 'omit', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
  } catch (error) {
    if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new GitHubError('interrupted', 'Release-Suche unterbrochen. Prüfung nicht abgeschlossen; bitte erneut prüfen.');
    }
    // A blocked download redirect looks like a network failure. Name the
    // missing grant without recording it as a GitHub access state.
    if (binary && await downloadAccessMissing()) {
      throw new Error('Downloads von GitHub sind nicht freigegeben. Bitte die Aktion erneut anklicken und den Zugriff auf GitHub erlauben.');
    }
    throw safeGitHubError(error);
  }
  if (response.status === 304 && etag) return response;
  if (!response.ok) {
    const header = name => response.headers?.get(name);
    // Secondary limits can be 403 without a remaining=0 header. Inspect the
    // message only for classification; never retain or display it.
    let secondaryLimit = false;
    if (response.status === 403) {
      try { secondaryLimit = /(?:rate limit|abuse detection)/i.test((await response.json()).message || ''); } catch { /* no JSON */ }
    }
    if ([403, 429].includes(response.status) && (response.status === 429 || header('x-ratelimit-remaining') === '0' || header('retry-after') || secondaryLimit)) {
      const delay = Number(header('retry-after')) * 1000;
      const reset = Number(header('x-ratelimit-reset')) * 1000;
      const retryAt = Math.max(Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000), Number.isFinite(reset) ? reset : 0);
      throw new GitHubError('rate-limited', rateLimitMessage(authorized), retryAt);
    }
    if (authorized && response.status === 401) throw new GitHubError('invalid-token', 'GitHub-Zugang ungültig oder abgelaufen. Bitte den Token ersetzen.');
    if (authorized && [403, 404].includes(response.status)) throw new GitHubError('forbidden', 'GitHub-Zugriff auf das Repository fehlt. Token-Berechtigung und Repository-Zugriff prüfen.');
    // Without a token, GitHub answers 404 for private, renamed or deleted repositories.
    if ([403, 404].includes(response.status)) throw new GitHubError('not-found', 'Releases nicht öffentlich erreichbar. Ist das Repository privat, hilft ein GitHub-Token.');
    throw new GitHubError('unavailable', 'GitHub ist momentan nicht erreichbar. Bitte später erneut versuchen.');
  }
  return response;
}

function nextReleasePage(response, path, count) {
  const link = response.headers.get('link');
  const next = link?.split(',').find(part => /;\s*rel="next"/.test(part));
  if (next) {
    const address = /<([^>]+)>/.exec(next)?.[1];
    let url;
    try { url = new URL(address); } catch { /* rejected below */ }
    if (!url || url.origin !== 'https://api.github.com' || ![`/repos/${REPOSITORY}/releases`, `/repositories/${REPOSITORY_ID}/releases`].includes(url.pathname) ||
        url.username || url.password || url.hash || !/^\d+$/.test(url.searchParams.get('page') || '') ||
        url.searchParams.get('per_page') !== '100' || [...url.searchParams.keys()].some(key => !['page', 'per_page'].includes(key))) {
      throw new GitHubError('invalid-response', 'Ungültige GitHub-Seitenfolge. Prüfung nicht abgeschlossen.');
    }
    return `/releases${url.search}`;
  }
  if (link || count < 100) return null;
  // Also support a full final page with no Link header.
  const page = Number(new URL(`${API_ROOT}${path}`).searchParams.get('page'));
  return `/releases?per_page=100&page=${page + 1}`;
}

function releaseSummary(release) {
  if (!release) return null;
  const { id, tag_name, target_commitish, draft, prerelease, published_at, name } = release;
  return { id, tag_name, target_commitish, draft, prerelease, published_at, name,
    assets: release.assets.filter(asset => [updateAssetName(), signatureAssetName()].includes(asset.name)).map(({ id, name, state, size, digest }) => ({ id, name, state, size, digest })) };
}

// Remaining request budget, read from every answer including a 304.
function rateQuota(response) {
  const remaining = response.headers?.get('x-ratelimit-remaining'), reset = response.headers?.get('x-ratelimit-reset');
  if (!/^\d+$/.test(remaining || '') || !/^\d+$/.test(reset || '')) return null;
  return { remaining: Number(remaining), reset: Number(reset) * 1000 };
}

// Cached pages store release summaries in this format; others are refetched.
// Format 2 adds the detached signature asset to each summary.
const CACHE_FORMAT = 2;
function validCachedPage(page) {
  return page?.format === CACHE_FORMAT && Array.isArray(page.candidates) && Object.hasOwn(page, 'next') && Number.isInteger(page.count);
}

// The complete cached page chain after the first page, or null if any part is missing.
function cachedChain(cache, path) {
  const chain = [];
  for (let next = path; next; next = cache?.[next]?.next) {
    if (chain.some(([seen]) => seen === next) || !validCachedPage(cache?.[next])) return null;
    chain.push([next, cache[next]]);
  }
  return chain;
}

// `shallow` serves automatic checks without a token, where every request,
// including a 304, counts against GitHub's limit. An unchanged first page then
// reuses the complete cached chain: a new release always changes the first
// page. Manual checks and installations revalidate every page.
export async function discoverRelease(channel, token, { cache = {}, signal, fetcher = fetch, shallow = false } = {}) {
  releaseChannel(channel);
  const pages = {}, candidates = [], visited = new Set();
  let quota = null;
  // A deadline is a failed/incomplete check, never an empty release result.
  const deadline = AbortSignal.timeout(120000);
  const searchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let path = '/releases?per_page=100&page=1', cacheBytes = 0;
  while (path) {
    if (searchSignal.aborted) throw new GitHubError('interrupted', 'Release-Suche unterbrochen. Prüfung nicht abgeschlossen; bitte erneut prüfen.');
    if (visited.has(path)) throw new GitHubError('invalid-response', 'Ungültige GitHub-Seitenfolge. Prüfung nicht abgeschlossen.');
    visited.add(path);
    const saved = cache?.[path];
    let response = await githubRequest(path, token, { fetcher, signal: searchSignal, etag: saved?.etag });
    if (response.status === 304 && !validCachedPage(saved)) {
      response = await githubRequest(path, token, { fetcher, signal: searchSignal });
    }
    quota = rateQuota(response) || quota;
    let page;
    if (response.status === 304) {
      page = { ...saved };
      // A 304 may carry updated pagination metadata.
      if (response.headers.get('link')) page.next = nextReleasePage(response, path, saved.count);
      const chain = shallow && visited.size === 1 && page.next ? cachedChain(cache, page.next) : null;
      if (chain) {
        for (const [cachedPath, cachedPage] of [[path, page], ...chain]) {
          candidates.push(...cachedPage.candidates);
          pages[cachedPath] = cachedPage;
        }
        break;
      }
    } else {
      let batch;
      try { batch = await response.json(); } catch { /* rejected below */ }
      if (!Array.isArray(batch) || batch.some(item => !item || typeof item.tag_name !== 'string' || !Array.isArray(item.assets))) {
        throw new GitHubError('invalid-response', 'Ungültige GitHub-Antwort. Prüfung nicht abgeschlossen.');
      }
      page = { format: CACHE_FORMAT, etag: response.headers.get('etag'), count: batch.length, next: nextReleasePage(response, path, batch.length),
        candidates: ['stable', 'experimental'].map(kind => releaseSummary(selectRelease(batch, kind))).filter(Boolean) };
    }
    candidates.push(...page.candidates);
    // Limit cache storage, not discovery. Uncached pages are still searched.
    cacheBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (cacheBytes <= 2 * 1024 * 1024) pages[path] = page;
    path = page.next;
  }
  if (searchSignal.aborted) throw new GitHubError('interrupted', 'Release-Suche unterbrochen. Prüfung nicht abgeschlossen; bitte erneut prüfen.');
  return { release: selectRelease(candidates, channel), cache: pages, quota };
}

// Installation uses a fresh complete search, preserving the existing runner API.
export async function latestRelease(channel, token) {
  return (await discoverRelease(channel, token)).release;
}

export async function validateBundle(bundle, channel, commit) {
  releaseChannel(channel);
  if (bundle?.schema !== UPDATE_SCHEMA || bundle.repository !== REPOSITORY || bundle.channel !== channel ||
      bundle.commit !== commit || !/^[a-f0-9]{40}$/.test(commit) || !Array.isArray(bundle.files) ||
      !bundle.files.length || bundle.files.length > MAX_PACKAGE_FILES) throw new Error('Das Update-Paket passt nicht zum gewählten Kanal.');
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_TRANSPORT_BYTES) throw new Error('Update-Paket ist zu groß.');
  const paths = await validateFileEntries(bundle.files);
  for (const required of ['manifest.json', 'background.js', 'features.js', 'popup.html', 'popup.js', 'build-info.json', 'offscreen.html', 'updates.html', 'updates.js']) {
    if (!paths.has(required)) throw new Error(`Unvollständiges Update: ${required}`);
  }
  validatePackageReferences(bundle.files);
  const manifest = JSON.parse(fileText(bundle.files.find(file => file.path === 'manifest.json')));
  const build = JSON.parse(fileText(bundle.files.find(file => file.path === 'build-info.json')));
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(bundle.version || '') || bundle.version.split('.').some(part => Number(part) > 65535)) throw new Error('Ungültige Kandidaten-Version.');
  if (build.schema !== 2 || manifest.version !== bundle.version ||
      !/^v\d+\.\d+\.\d+-preview\.\d+$/.test(bundle.candidateTag || '') || build.candidateTag !== bundle.candidateTag) throw new Error('Unvollständige Kandidaten-Identität.');
  if (manifest.manifest_version !== 3 || manifest.name !== 'Video Sync' || build.local || build.source ||
      build.commit !== commit || build.channel !== channel || build.repository !== REPOSITORY) throw new Error('Falsche Erweiterung im Update.');
  return bundle;
}

function verifiedAssetInfo(asset, maxBytes) {
  return Number.isSafeInteger(asset?.id) && Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= maxBytes && /^sha256:[a-f0-9]{64}$/.test(asset.digest || '');
}

// Reads one release asset within its size limit and checks GitHub's digest.
async function readAsset(asset, maxBytes, token) {
  const response = await githubRequest(`/releases/assets/${asset.id}`, token, { binary: true });
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Update-Paket ist zu groß.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength !== asset.size || await sha256(bytes) !== asset.digest.slice(7)) throw new Error('GitHub-Prüfsumme stimmt nicht. Update abgebrochen.');
  return bytes;
}

// Downloads update.json and its detached signature. Nothing is parsed as a
// package before the signature over these exact bytes has been verified with
// the embedded release key (`publicKey` is injectable for tests only).
export async function downloadBundle(release, channel, token, { publicKey } = {}) {
  releaseChannel(channel);
  const asset = selectUpdateAsset(release), signatureAsset = selectSignatureAsset(release);
  if (!verifiedAssetInfo(asset, MAX_TRANSPORT_BYTES)) {
    throw new Error('GitHub liefert kein geprüftes Update-Paket. Bitte den ZIP-Download verwenden.');
  }
  if (!signatureAsset) throw new Error('Dieses Release ist nicht signiert. Installation abgebrochen; es werden nur signierte Video-Sync-Releases installiert.');
  if (!verifiedAssetInfo(signatureAsset, MAX_SIGNATURE_BYTES)) throw new Error('Die Update-Signatur ist beschädigt. Installation abgebrochen.');
  const bytes = await readAsset(asset, MAX_TRANSPORT_BYTES, token);
  const signature = await readAsset(signatureAsset, MAX_SIGNATURE_BYTES, token);
  await verifyUpdateSignature(signature, { repository: REPOSITORY, tag: release.tag_name, channel, asset: updateAssetName(), sha256: await sha256(bytes) },
    publicKey ? { publicKey } : {});
  const bundle = await validateBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), channel, releaseCommit(release));
  const expected = channel === 'experimental' ? bundle.candidateTag : bundle.candidateTag.replace(/-preview\.\d+$/, '');
  if (expected !== release.tag_name) throw new Error('Release und Kandidatenpaket stimmen nicht überein.');
  return bundle;
}
