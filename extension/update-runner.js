import { fileText, fileBytes, packageFile } from './package-files.js';
import { latestRelease, downloadBundle, githubRequest } from './github-updates.js';
import { withGitHubAccess } from './update-service.js';
import { stored, storeUpdateState } from './update-storage.js';
import { verifyInstallation, backupFiles, prepareInstallation, installFiles, restoreFiles, verifyFiles } from './update-install.js';
import { sealSnapshot, validateSnapshot, validateJournal, verifyRecoveryDirectory, installationIdentity, RECOVERY_HELP } from './update-recovery.js';
import { reviewUpdate, ConfirmationRequired } from './update-review.js';

const defaults = { latestRelease, downloadBundle, githubRequest, stored, storeUpdateState, verifyInstallation,
  backupFiles, prepareInstallation, installFiles, restoreFiles, verifyFiles, verifyRecoveryDirectory };

// A checkpoint is a test seam for process termination, not an exception-based
// rollback shortcut. Tests discard the suspended runner and restart from disk.
// `confirmation` is the id of a review the user explicitly accepted; it only
// authorizes exactly that downgrade/permission change for exactly that target.
export async function runUpdate({ channel, restore, verifyRepair, directory, confirmation, progress = () => {}, checkpoint = async () => {} }, dependencies = defaults) {
  const io = { ...defaults, ...dependencies };
  if (!directory) throw new Error('Bitte zuerst den Installationsordner auswählen.');
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Bitte den Schreibzugriff im Update-Bereich erneut erlauben.');
  if (verifyRepair) return verifyRepairedInstallation(directory, io);
  const journal = await io.stored('updateJournal');
  if (journal !== undefined) {
    await validateJournal(journal);
    await io.verifyRecoveryDirectory(directory, journal.backup);
    // This click only resolves the previous attempt. Never install a new target
    // while the running code may still belong to a partially written version.
    await recover(journal, directory, io, checkpoint);
    return { outcome: 'restored' };
  }
  const previousBackup = await io.stored('backup');
  if (previousBackup !== undefined) await validateSnapshot(previousBackup);
  if (restore) {
    if (!previousBackup) throw new Error('Kein vorheriger Stand gespeichert.');
    await io.verifyRecoveryDirectory(directory, previousBackup);
    const restoring = { schema: 1, id: crypto.randomUUID(), kind: 'restore', phase: 'restoring', backup: previousBackup };
    await io.stored('updateJournal', restoring);
    await checkpoint('restore-journal');
    await recover(restoring, directory, io, checkpoint);
    return { outcome: 'restored' };
  }
  await io.verifyInstallation(directory);
  const bundle = await withGitHubAccess(async request => {
    const release = await request(token => io.latestRelease(channel, token));
    if (!release) throw new Error('Für diesen Kanal ist noch kein Update veröffentlicht.');
    return request(token => io.downloadBundle(release, channel, token));
  });
  const files = await io.prepareInstallation(directory, bundle.files);
  const previous = await io.backupFiles(directory, files);
  // Strictly newer versions only; a channel-switch downgrade or new manifest
  // capabilities stop here, before the journal or any file is written.
  const review = await reviewUpdate({ installedFiles: previous, targetFiles: files, channel });
  if (review && review.id !== confirmation) throw new ConfirmationRequired(review);
  const backup = await sealSnapshot(directory, previous);
  const target = await sealSnapshot(directory, files);
  const operation = { schema: 1, id: crypto.randomUUID(), kind: 'install', phase: 'prepared', backup, target };
  await validateJournal(operation);
  await io.verifyFiles(directory, backup.files);
  await checkpoint('before-journal');
  await io.stored('updateJournal', operation);
  await checkpoint('prepared');
  // Read the committed journal back before touching installation files.
  const persisted = await validateJournal(await io.stored('updateJournal'));
  if (persisted.id !== operation.id || persisted.backup.digest !== backup.digest || persisted.target.digest !== target.digest) throw new Error('Update-Journal wurde nicht vollständig gespeichert.');
  operation.phase = 'installing';
  await io.stored('updateJournal', operation);
  await checkpoint('installing');
  try {
    await io.installFiles(directory, files, async (done, total) => {
      await progress(done, total);
      await checkpoint(`installed-file:${done}`);
    });
    await checkpoint('before-install-readback');
    await io.verifyFiles(directory, files);
    await checkpoint('after-install-readback');
  } catch (error) {
    try { await recover(operation, directory, io, checkpoint); }
    catch { throw new Error(`Update und Wiederherstellung nicht abgeschlossen. Das Backup bleibt erhalten. ${RECOVERY_HELP}`); }
    throw new Error(`Update abgebrochen; Dateien des vorherigen Stands geprüft wiederhergestellt. Erweiterung vor weiterer Nutzung neu laden. ${error.message}`);
  }
  // No catch/rollback around the commit: an ambiguous persistence failure must
  // leave recovery to a fresh read, never overwrite a possibly completed state.
  await io.storeUpdateState({ updateJournal: undefined, backup, updateReceipt: { outcome: 'installed', source: backup.source, target: target.source } });
  await checkpoint('installed-committed');
  return { outcome: 'installed' };
}

async function recover(journal, directory, io, checkpoint) {
  await validateJournal(journal);
  const restoring = { ...journal, phase: 'restoring' };
  await io.stored('updateJournal', restoring);
  await checkpoint('restoring');
  await io.restoreFiles(directory, restoring.backup.files, path => checkpoint(`restored-file:${path}`));
  await checkpoint('before-restore-readback');
  await io.verifyFiles(directory, restoring.backup.files);
  await checkpoint('after-restore-readback');
  const changes = { updateJournal: undefined, updateReceipt: { outcome: 'restored', target: restoring.backup.source } };
  // Only the verified rollback may replace the earlier completed backup.
  // An explicit restore consumes its backup after successful readback.
  changes.backup = journal.kind === 'restore' ? undefined : restoring.backup;
  await io.storeUpdateState(changes);
  await checkpoint('restored-committed');
}

async function verifyRepairedInstallation(directory, io) {
  await io.verifyInstallation(directory);
  const identityFiles = await io.backupFiles(directory, [{ path: 'manifest.json' }, { path: 'build-info.json' }]);
  const identity = installationIdentity(identityFiles);
  const candidate = identity.candidateTag || '';
  const tag = identity.channel === 'stable' ? candidate.replace(/-preview\.\d+$/, '') : candidate;
  if (!/^v\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(tag)) throw new Error(RECOVERY_HELP);
  const bundle = await withGitHubAccess(async request => {
    const release = await request(async token => (await io.githubRequest(`/releases/tags/${encodeURIComponent(tag)}`, token)).json());
    return request(token => io.downloadBundle(release, identity.channel, token));
  });
  if (bundle.commit !== identity.commit || installationIdentity(bundle.files).version !== identity.version) throw new Error(`Das veröffentlichte Paket passt nicht zur Installation. ${RECOVERY_HELP}`);
  const expected = await io.prepareInstallation(directory, bundle.files);
  const currentManifest = identityFiles.find(file => file.path === 'manifest.json');
  const installedManifest = JSON.parse(fileText(currentManifest));
  const publishedManifest = JSON.parse(fileText(bundle.files.find(file => file.path === 'manifest.json')));
  // A manually retained key changes manifest bytes. Verify every other field
  // against the published manifest, then bind readback to the exact local bytes.
  if (installedManifest.key) {
    const withoutKey = manifest => { const copy = { ...manifest }; delete copy.key; return canonicalJson(copy); };
    if (withoutKey(installedManifest) !== withoutKey(publishedManifest)) throw new Error('Das Manifest weicht vom veröffentlichten Paket ab.');
    Object.assign(expected.find(file => file.path === 'manifest.json'), await packageFile('manifest.json', fileBytes(currentManifest), 'utf8'));
  }
  await io.verifyFiles(directory, expected);
  const journal = await io.stored('updateJournal'), backup = await io.stored('backup');
  // Retain rejected or unknown records for diagnosis; only a fully verified
  // published installation permits leaving the blocked recovery state.
  const changes = { updateJournal: undefined, backup: undefined, updateReceipt: { outcome: 'verified', target: identity } };
  if (journal !== undefined || backup !== undefined) changes.recoveryArchive = { journal, backup };
  await io.storeUpdateState(changes);
  return { outcome: 'verified' };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
