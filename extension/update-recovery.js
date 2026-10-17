// @ts-check
import { stored } from './update-storage.js';
import { REPOSITORY } from './github-updates.js';
import { sha256, fileText, fileBytes, validateFileEntries, packageFile, MAX_PACKAGE_FILES } from './package-files.js';
import { verifyDirectoryIdentity } from './update-install.js';

/**
 * @typedef {{path: string, content: string, encoding: 'utf8' | 'base64', size: number, sha256: string}} EncodedFile
 * @typedef {{path: string, content: null}} AbsentFile
 * @typedef {EncodedFile | AbsentFile} BackupFile
 * @typedef {{version: string, commit: string, channel: 'stable' | 'experimental', candidateTag: string | null}} InstallationIdentity
 * @typedef {{schema: 2, id: string, extensionId: string, directory: FileSystemDirectoryHandle,
 *   source: InstallationIdentity, files: BackupFile[], digest: string}} Snapshot
 * @typedef {'prepared' | 'installing' | 'restoring'} JournalPhase
 * @typedef {{schema: 1, id: string, phase: JournalPhase, backup: Snapshot} &
 *   ({kind: 'install', target: Snapshot} | {kind: 'restore'})} Journal
 * @typedef {{pending: boolean, canRestore: boolean, blocked?: boolean, message?: string}} RecoveryStatus
 */

export const RECOVERY_HELP = 'Bitte die Installation unter Updates prüfen. Falls sie nicht mehr startet: das freigegebene ZIP gemäß UPDATES.md im bisherigen Ordner wiederherstellen.';
/** @param {unknown} value */
const digest = value => sha256(new TextEncoder().encode(JSON.stringify(value)));

/** @param {BackupFile[]} files @returns {InstallationIdentity} */
export function installationIdentity(files) {
  const manifest = record(JSON.parse(fileText(files.find(file => file.path === 'manifest.json'))));
  const build = record(JSON.parse(fileText(files.find(file => file.path === 'build-info.json'))));
  const candidateTag = build.candidateTag || null;
  if (manifest?.name !== 'Video Sync' || manifest.manifest_version !== 3 || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){2,3}$/.test(manifest.version || '') ||
      build?.repository !== REPOSITORY || typeof build.commit !== 'string' || !/^[a-f0-9]{40}$/.test(build.commit || '') ||
      (build.channel !== 'stable' && build.channel !== 'experimental') ||
      (candidateTag !== null && typeof candidateTag !== 'string') || build.local || build.source) {
    throw new Error(`Die gespeicherte Paketidentität ist unvollständig. ${RECOVERY_HELP}`);
  }
  return { version: manifest.version, commit: build.commit, channel: build.channel, candidateTag };
}

/** @param {FileSystemDirectoryHandle} directory @param {BackupFile[]} files @returns {Promise<Snapshot>} */
export async function sealSnapshot(directory, files) {
  /** @type {BackupFile[]} */
  const sealedFiles = await Promise.all(files.map(file => file.content === null ? { path: file.path, content: null }
    : packageFile(file.path, fileBytes(file), file.encoding)));
  const source = installationIdentity(sealedFiles);
  /** @type {Omit<Snapshot, 'digest'>} */
  const snapshot = { schema: 2, id: crypto.randomUUID(), extensionId: chrome.runtime.id, directory, source, files: sealedFiles };
  return { ...snapshot, digest: await snapshotDigest(snapshot) };
}

/** @param {Omit<Snapshot, 'digest'>} snapshot */
function snapshotDigest(snapshot) {
  return digest({ schema: snapshot.schema, id: snapshot.id, extensionId: snapshot.extensionId, source: snapshot.source, files: snapshot.files });
}

/** @param {unknown} input @returns {Promise<Snapshot>} */
export async function validateSnapshot(input) {
  const snapshot = record(input);
  if (snapshot.schema !== 2 || typeof snapshot.id !== 'string' || snapshot.extensionId !== chrome.runtime.id ||
      typeof record(snapshot.directory).isSameEntry !== 'function' || !Array.isArray(snapshot.files) ||
      !snapshot.files.length || snapshot.files.length > MAX_PACKAGE_FILES) throw new Error(`Unbekanntes Backupformat. ${RECOVERY_HELP}`);
  await validateFileEntries(snapshot.files, { backup: true });
  const validated = /** @type {Snapshot} */ (input);
  if (JSON.stringify(installationIdentity(validated.files)) !== JSON.stringify(validated.source) ||
      await snapshotDigest(validated) !== validated.digest) throw new Error(`Die Backup-Prüfsumme stimmt nicht. ${RECOVERY_HELP}`);
  return validated;
}

/** @param {unknown} input @returns {Promise<Journal>} */
export async function validateJournal(input) {
  const journal = record(input);
  if (journal?.schema !== 1 || typeof journal.id !== 'string' || typeof journal.phase !== 'string' || !['prepared', 'installing', 'restoring'].includes(journal.phase) ||
      typeof journal.kind !== 'string' || !['install', 'restore'].includes(journal.kind)) throw new Error(`Unbekanntes Update-Journal. ${RECOVERY_HELP}`);
  const backup = await validateSnapshot(journal.backup);
  if (journal.kind === 'install') {
    const target = await validateSnapshot(journal.target);
    if (!await backup.directory.isSameEntry(target.directory)) throw new Error(`Abweichende Journalordner. ${RECOVERY_HELP}`);
    const before = backup.files.map(file => file.path).sort();
    const after = target.files.map(file => file.path).sort();
    if (JSON.stringify(before) !== JSON.stringify(after) || target.files.some(file => file.content === null)) {
      throw new Error(`Unvollständiges Update-Journal. ${RECOVERY_HELP}`);
    }
  }
  return /** @type {Journal} */ (input);
}

// Recovery retains the same nonce proof as ordinary installation, plus the
// directory binding saved before writing. Broken metadata never weakens it.
/** @param {FileSystemDirectoryHandle} directory @param {unknown} input */
export async function verifyRecoveryDirectory(directory, input) {
  const snapshot = await validateSnapshot(input);
  if (!await directory.isSameEntry(snapshot.directory)) throw new Error('Der Ordner gehört nicht zu diesem Wiederherstellungsvorgang.');
  await verifyDirectoryIdentity(directory);
}

/** @param {(key: string) => Promise<unknown>} [read] @returns {Promise<RecoveryStatus>} */
export async function recoveryStatus(read = stored) {
  try {
    const journal = await read('updateJournal');
    if (journal !== undefined) {
      await validateJournal(journal);
      return { pending: true, canRestore: true, message: 'Update unterbrochen. Zuerst den gesicherten Stand wiederherstellen; ein neuer Updateversuch bleibt bis dahin gesperrt.' };
    }
    const backup = await read('backup');
    if (backup !== undefined) await validateSnapshot(backup);
    return { pending: false, canRestore: !!backup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pending: true, blocked: true, canRestore: false, message: message.includes(RECOVERY_HELP) ? message : `${message} ${RECOVERY_HELP}` };
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}
