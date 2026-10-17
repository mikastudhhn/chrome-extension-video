import { validPackagePath as validUpdatePath, sha256, fileBytes, fileText, packageFile, validatePaths } from './package-files.js';

async function fileAt(directory, path, create = false) {
  if (!validUpdatePath(path)) throw new Error('Ungültiger Update-Pfad.');
  const parts = path.split('/');
  let parent = directory;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create });
  return parent.getFileHandle(parts.at(-1), { create });
}
async function write(directory, path, content) {
  const handle = await fileAt(directory, path, true);
  const stream = await handle.createWritable();
  try { await stream.write(content); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
}

export async function verifyInstallation(directory) {
  const manifest = JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text());
  if (manifest.name !== 'Video Sync') throw new Error('Bitte den installierten Video-Sync-Ordner mit manifest.json auswählen.');
  const build = JSON.parse(await (await (await directory.getFileHandle('build-info.json')).getFile()).text());
  if (build.local || build.source) throw new Error('Lokale Arbeitsstände werden nicht durch GitHub-Updates überschrieben.');
  await verifyDirectoryIdentity(directory);
}

export async function verifyDirectoryIdentity(directory) {
  // Verify the chosen folder is THIS installation, not another copy. The nonce
  // is read through Chrome's own extension URL before any app file is changed.
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const path = `update-proof-${nonce}.json`;
  const handle = await directory.getFileHandle(path, { create: true });
  try {
    const stream = await handle.createWritable(); await stream.write(JSON.stringify(nonce)); await stream.close();
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!response.ok || await response.json() !== nonce) throw new Error('Der Ordner gehört zu einer anderen Installation.');
  } catch { throw new Error('Bitte exakt den in chrome://extensions geladenen Ordner auswählen.'); }
  finally { await directory.removeEntry(path); }
}

export async function backupFiles(directory, files) {
  validatePaths(files);
  const backup = [];
  for (const file of files) {
    try {
      const bytes = await (await (await fileAt(directory, file.path)).getFile()).arrayBuffer();
      let encoding = 'utf8';
      try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { encoding = 'base64'; }
      backup.push(await packageFile(file.path, bytes, encoding));
    }
    catch (error) { if (error.name !== 'NotFoundError') throw error; backup.push({ path: file.path, content: null }); }
  }
  return backup;
}

export async function restoreFiles(directory, backup, progress = () => {}) {
  validatePaths(backup);
  for (const file of backup) if (file.content !== null) fileBytes(file);
  for (const file of [...backup].sort((a, b) => Number(a.path === 'manifest.json') - Number(b.path === 'manifest.json'))) {
    if (file.content !== null) await write(directory, file.path, file.encoding === 'base64' ? fileBytes(file) : file.content);
    else {
      if (!validUpdatePath(file.path)) throw new Error('Ungültiger Wiederherstellungspfad.');
      const parts = file.path.split('/');
      let parent = directory;
      try {
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        await parent.removeEntry(parts.at(-1));
      } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    await progress(file.path);
  }
}

export async function prepareInstallation(directory, files) {
  validatePaths(files);
  for (const file of files) fileBytes(file);
  const oldManifest = JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text());
  const nextManifest = JSON.parse(fileText(files.find(file => file.path === 'manifest.json')));
  if (oldManifest.key && nextManifest.key && nextManifest.key !== oldManifest.key) throw new Error('Die Erweiterungs-ID würde sich ändern.');
  return Promise.all(files.map(async file => {
    const bytes = file.path === 'manifest.json' && oldManifest.key
      ? new TextEncoder().encode(JSON.stringify({ ...nextManifest, key: oldManifest.key }, null, 2)) : fileBytes(file);
    return packageFile(file.path, bytes, file.encoding);
  }));
}

export async function verifyFiles(directory, expected) {
  for (const file of expected) {
    let bytes;
    try { bytes = await (await (await fileAt(directory, file.path)).getFile()).arrayBuffer(); }
    catch (error) {
      if (error.name === 'NotFoundError' && file.content === null) continue;
      throw error;
    }
    if (file.content === null || await sha256(bytes) !== await sha256(fileBytes(file))) {
      throw new Error(`Dateiprüfung fehlgeschlagen: ${file.path}`);
    }
  }
}

export async function installFiles(directory, files, progress = () => {}) {
  // Commit the manifest last; never remove user files or recursively clear the
  // installation. Existing extension IDs/permissions/settings are preserved.
  const prepared = await prepareInstallation(directory, files);
  const ordered = [...prepared].sort((a, b) => Number(a.path === 'manifest.json') - Number(b.path === 'manifest.json'));
  for (const [index, file] of ordered.entries()) {
    await write(directory, file.path, file.encoding === 'base64' ? fileBytes(file) : file.content);
    await progress(index + 1, ordered.length);
  }
}
