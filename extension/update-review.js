// Reviews a verified target package against the installed one before any
// file is written. By default only strictly newer versions install. A switch
// between Stable and Experimental may install an older or equal version, and
// new capabilities in the manifest take effect on reload without a Chrome
// prompt for unpacked extensions: both need an explicit, target-bound
// confirmation from the user.
import { fileText, sha256 } from './package-files.js';
import { canonicalJson } from './update-signature.js';

// Numeric dotted versions as used by Chrome (up to four parts).
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export const validVersion = version => typeof version === 'string' && /^\d+(?:\.\d+){0,3}$/.test(version);

// Order of a release tag relative to the installed version: 1 newer, -1 older,
// 0 equal, null when the tag alone cannot tell (Stable tags omit the build part).
export function releaseOrder(tag, channel, installedVersion) {
  if (!validVersion(installedVersion)) return null;
  const candidate = /^v(\d+\.\d+\.\d+)-preview\.(\d+)$/.exec(tag || ''), stable = /^v(\d+\.\d+\.\d+)$/.exec(tag || '');
  if (channel === 'experimental' && candidate) return compareVersions(`${candidate[1]}.${candidate[2]}`, installedVersion);
  if (channel === 'stable' && stable) return compareVersions(stable[1], installedVersion.split('.').slice(0, 3).join('.')) || null;
  return null;
}

const LIST_KEYS = {
  permissions: 'Berechtigungen',
  optional_permissions: 'Optionale Berechtigungen',
  host_permissions: 'Website-Zugriff',
  optional_host_permissions: 'Optionaler Website-Zugriff',
  content_scripts: 'Skripte in Websites',
  web_accessible_resources: 'Für Websites freigegebene Dateien'
};
export const CHANGE_LABELS = { ...LIST_KEYS, externally_connectable: 'Verbindungen von außen', content_security_policy: 'Content Security Policy' };

const describe = value => typeof value === 'string' ? value : canonicalJson(value);
const listEntries = (manifest, key) => Array.isArray(manifest?.[key]) ? manifest[key].map(describe) : [];
const connectableEntries = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).flatMap(([key, item]) => Array.isArray(item) ? item.map(entry => `${key}: ${describe(entry)}`) : [`${key}: ${describe(item)}`])
  : value === undefined ? [] : [describe(value)];

// Additions to permission-like manifest keys and any CSP change. Removals are
// harmless and need no confirmation.
export function manifestChanges(installed, target) {
  const changes = [];
  const added = (before, after) => { const known = new Set(before); return [...new Set(after.filter(entry => !known.has(entry)))]; };
  for (const key of Object.keys(LIST_KEYS)) {
    const entries = added(listEntries(installed, key), listEntries(target, key));
    if (entries.length) changes.push({ key, label: CHANGE_LABELS[key], entries });
  }
  const connectable = added(connectableEntries(installed?.externally_connectable), connectableEntries(target?.externally_connectable));
  if (connectable.length) changes.push({ key: 'externally_connectable', label: CHANGE_LABELS.externally_connectable, entries: connectable });
  const policy = manifest => manifest?.content_security_policy === undefined ? null : manifest.content_security_policy;
  if (canonicalJson(policy(installed)) !== canonicalJson(policy(target))) {
    changes.push({ key: 'content_security_policy', label: CHANGE_LABELS.content_security_policy,
      entries: [policy(target) === null ? 'Chrome-Standard (eigene Richtlinie entfernt)' : describe(policy(target))] });
  }
  return changes;
}

export class ConfirmationRequired extends Error {
  constructor(review) {
    super(review.downgrade
      ? `Bestätigung erforderlich: Der Kanalwechsel installiert Version ${review.to}, die ${review.older ? 'älter als' : 'gleich alt wie'} die installierte Version ${review.from} ist${review.changes.length ? ', und ändert Berechtigungen' : ''}.`
      : `Bestätigung erforderlich: Version ${review.to} verlangt zusätzliche Rechte (${review.changes.map(change => change.label).join(', ')}).`);
    this.code = 'confirmation-required';
    this.confirmation = review;
  }
}

const parse = (files, path) => {
  const file = files.find(entry => entry.path === path);
  if (!file || file.content === null) return null;
  try { return JSON.parse(fileText(file)); } catch { return null; }
};

// `installedFiles` are the current manifest.json/build-info.json entries,
// `targetFiles` the verified package. Returns null when nothing needs
// confirmation, otherwise a review whose id binds the exact decision.
export async function reviewUpdate({ installedFiles, targetFiles, channel }) {
  const installedManifest = parse(installedFiles, 'manifest.json'), installedBuild = parse(installedFiles, 'build-info.json') || {};
  const targetManifest = parse(targetFiles, 'manifest.json'), targetBuild = parse(targetFiles, 'build-info.json') || {};
  if (!validVersion(installedManifest?.version) || !validVersion(targetManifest?.version)) throw new Error('Die installierte oder neue Version ist nicht lesbar. Update abgebrochen.');
  const from = installedManifest.version, to = targetManifest.version, order = compareVersions(to, from);
  const channelSwitch = installedBuild.channel !== channel;
  if (order <= 0 && !channelSwitch) {
    throw new Error(order === 0 ? `Version ${to} ist bereits installiert. Es wird nur eine neuere Version installiert.`
      : `Version ${to} ist älter als die installierte Version ${from}. Ältere Versionen werden nicht installiert.`);
  }
  const changes = manifestChanges(installedManifest, targetManifest);
  if (order > 0 && !changes.length) return null;
  const review = { from, to, fromChannel: installedBuild.channel || null, channel, downgrade: order <= 0, older: order < 0, changes,
    target: { commit: targetBuild.commit || null, candidateTag: targetBuild.candidateTag || null } };
  return { ...review, id: await sha256(new TextEncoder().encode(canonicalJson(review))) };
}
