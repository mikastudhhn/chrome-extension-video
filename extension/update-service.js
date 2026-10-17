import { discoverRelease, releaseCommit, RELEASES_URL, safeGitHubError, GitHubError, AUTOMATIC_RESERVE } from './github-updates.js';
import { releaseOrder } from './update-review.js';

// The Chrome alarm sets the cadence. Every automatic trigger (alarm, browser
// start, channel switch, popup open) shares a short debounce measured from the
// START of the previous check, so an alarm firing exactly one period later is
// never skipped and overlapping triggers do not duplicate a request.
export const UPDATE_INTERVAL_MINUTES = 30;
export const AUTOMATIC_DEBOUNCE_MINUTES = 2;
const debounce = AUTOMATIC_DEBOUNCE_MINUTES * 60 * 1000;
let checking = Promise.resolve(), writing = Promise.resolve(), activeSearch;

// Configuration and completed checks share one short storage queue. Network
// requests never hold it, so replacing/removing access can cancel them promptly.
function writeState(run) {
  const task = writing.then(run);
  writing = task.catch(() => {});
  return task;
}

function sameAccess(current, session) {
  return current.githubToken === session.githubToken && current.githubAccessRevision === session.githubAccessRevision;
}

function failedAccess(failure, previous = {}) {
  return { status: ['invalid-token', 'forbidden', 'not-found', 'rate-limited'].includes(failure.code) ? failure.code : 'unavailable',
    verifiedAt: previous.verifiedAt || null, error: failure.message, retryAt: failure.retryAt };
}

// Successful access. A nearly used-up limit pauses only automatic checks until
// GitHub resets it, so a manual check or an installation can still run.
function verifiedAccess(now, quota) {
  const pause = quota && quota.remaining <= AUTOMATIC_RESERVE && quota.reset > now ? Math.min(quota.reset, now + 60 * 60 * 1000) : 0;
  return { status: 'verified', verifiedAt: now, ...(pause ? { automaticPauseUntil: pause } : {}) };
}

function clearFailedResults(results = {}) {
  return Object.fromEntries(Object.entries(results).map(([channel, result]) => [channel, result.error
    ? { checkedAt: 0, lastSuccessfulCheckAt: result.lastSuccessfulCheckAt || null, releaseState: 'unchecked', available: false, error: '' }
    : result]));
}

async function requireCurrentAccess(session, checkCooldown = true) {
  const current = await chrome.storage.local.get(['githubToken', 'githubAccessRevision', 'githubAccess']);
  if (!sameAccess(current, session)) throw new GitHubError('access-changed', 'GitHub-Zugang wurde geändert. Bitte den Vorgang erneut starten.');
  if (checkCooldown && Date.now() < (current.githubAccess?.retryAt || 0)) {
    throw new GitHubError('rate-limited', 'GitHub-Anfragelimit erreicht. Bitte bis zum angezeigten Zeitpunkt warten.', current.githubAccess.retryAt);
  }
  return current;
}

// Install and repair downloads share the check queue, credential revision and
// cooldown. Only GitHub failures change access; disk/package validation does not.
// Call request separately for discovery and download so a changed token or a
// newly imposed cooldown prevents the next request as well.
export function withGitHubAccess(run) {
  const task = checking.then(async () => {
    const session = await chrome.storage.local.get(['githubToken', 'githubAccessRevision']);
    const request = async fetchResource => {
      await requireCurrentAccess(session);
      try {
        const result = await fetchResource(session.githubToken);
        await requireCurrentAccess(session, false);
        return result;
      } catch (error) {
        if (error instanceof GitHubError && error.code !== 'access-changed') {
          await writeState(async () => {
            const current = await requireCurrentAccess(session, false);
            await chrome.storage.local.set({ githubAccess: failedAccess(error, current.githubAccess) });
          });
        }
        throw error;
      }
    };
    const result = await run(request);
    await writeState(async () => {
      await requireCurrentAccess(session, false);
      const { updateResults } = await chrome.storage.local.get('updateResults');
      await chrome.storage.local.set({ githubAccess: { status: 'verified', verifiedAt: Date.now() },
        updateResults: clearFailedResults(updateResults) });
    });
    return result;
  });
  checking = task.catch(() => {});
  return task;
}

// Release updates work without a token through public GitHub Releases.
// `configured` means updates are checked; `hasToken` marks the optional token.
export async function updateStatus(channel, build) {
  const { githubToken, githubAccess, updateResults = {} } = await chrome.storage.local.get(['githubToken', 'githubAccess', 'updateResults']);
  const hasToken = !!githubToken;
  const access = githubAccess || { status: hasToken ? 'unverified' : 'public' };
  if (channel === 'local') return { local: true, configured: true, hasToken, access, releasesUrl: RELEASES_URL };
  if (build.source) return { source: true, configured: false, hasToken: false, access: { status: 'missing' } };
  const result = updateResults[channel] || {};
  return { ...result, configured: true, hasToken, releasesUrl: RELEASES_URL, access,
    // Historical checkedAt alone is not evidence of a matching release.
    releaseState: result.releaseState || 'unchecked',
    available: !!result.available && !access.error,
    error: access.error || result.error || '' };
}

export async function checkUpdates(channel, build, force = false) {
  if (build.source || channel === 'local') return updateStatus(channel, build);
  const task = checking.then(async () => {
    // Recheck inside the queue: overlapping alarms must not duplicate a scan.
    const previous = await updateStatus(channel, build);
    if (!previous.configured || Date.now() < (previous.access.retryAt || 0) ||
        (!force && (Date.now() - (previous.checkedAt || 0) < debounce || Date.now() < (previous.access.automaticPauseUntil || 0)))) return previous;
    const startedAt = Date.now();
    const { githubToken, githubAccessRevision, releaseCache = {} } = await chrome.storage.local.get(['githubToken', 'githubAccessRevision', 'releaseCache']);
    const controller = new AbortController();
    activeSearch = controller;
    let result, access, cache;
    try {
      // Without a token, each request counts against GitHub's shared limit:
      // automatic checks reuse the cached later pages if the first is unchanged.
      const found = await discoverRelease(channel, githubToken, { cache: releaseCache, signal: controller.signal, shallow: !githubToken && !force });
      const release = found.release, commit = releaseCommit(release);
      cache = found.cache;
      const installedCommit = build.commit;
      const channelSwitch = !build.local && channel !== build.channel;
      // Same stream: only a strictly newer release is offered. A channel switch
      // may offer an older or equal one; installing it then needs a confirmation.
      const order = release && !build.local ? releaseOrder(release.tag_name, channel, globalThis.chrome?.runtime?.getManifest?.().version) : null;
      const available = !!release && (commit !== installedCommit || (!build.local && (channelSwitch ||
        (channel === 'experimental' && release.tag_name.startsWith('v') && release.tag_name !== build.candidateTag)))) &&
        (channelSwitch || order === null || order > 0);
      const now = Date.now();
      result = { checkedAt: startedAt, lastSuccessfulCheckAt: now, available, ...(available && channelSwitch && order !== 1 ? { confirmDowngrade: true } : {}),
        releaseState: !release ? 'no-release' : available ? 'available' : 'current',
        releaseId: release?.id || null, commit: commit || null, tag: release?.tag_name || '',
        url: release ? `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` : RELEASES_URL,
        name: release?.name || '', error: '' };
      access = verifiedAccess(now, found.quota);
    } catch (error) {
      const failure = safeGitHubError(error);
      result = { checkedAt: startedAt, lastSuccessfulCheckAt: previous.lastSuccessfulCheckAt || null,
        available: false, releaseState: 'error', error: failure.message, errorCode: failure.code };
      access = failedAccess(failure, previous.access);
    } finally {
      if (activeSearch === controller) activeSearch = undefined;
    }
    return writeState(async () => {
      const current = await chrome.storage.local.get(['githubToken', 'githubAccessRevision', 'updateResults']);
      if (current.githubToken !== githubToken || current.githubAccessRevision !== githubAccessRevision || controller.signal.aborted) {
        return updateStatus(channel, build);
      }
      // Verification resolves old cross-channel access errors, but does not
      // claim that another channel's installed version is current.
      const results = access.status === 'verified' ? clearFailedResults(current.updateResults) : current.updateResults;
      await chrome.storage.local.set({ updateResults: { ...results, [channel]: result }, githubAccess: access,
        ...(cache ? { releaseCache: cache } : {}) });
      return updateStatus(channel, build);
    });
  });
  checking = task.catch(() => {});
  return task;
}

// Saving or removing the optional token starts a new access revision, so a
// running request cannot write results for the previous credentials. Checks
// continue without a token; the alarm therefore stays in both cases.
export async function configureUpdates(token) {
  if (typeof token !== 'string' || token.length > 512 || /\s/.test(token)) throw new Error('Ungültiger GitHub-Token.');
  activeSearch?.abort();
  return writeState(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (token) {
      await chrome.storage.local.set({ githubToken: token, githubAccessRevision: crypto.randomUUID(),
        githubAccess: { status: 'unverified' }, updateResults: {}, releaseCache: {} });
    } else {
      await chrome.storage.local.remove(['githubToken', 'githubAccess', 'updateResults', 'releaseCache']);
      await chrome.storage.local.set({ githubAccessRevision: crypto.randomUUID() });
    }
    await chrome.alarms.create('check-github-updates', { periodInMinutes: UPDATE_INTERVAL_MINUTES });
  });
}
