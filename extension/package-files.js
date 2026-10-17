// Shared by the browser installer and Node packaging. The update transport
// schema is independent of build-info.schema and of the recovery snapshot schema.
export const UPDATE_SCHEMA = 1;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSPORT_BYTES = 12 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 256;
export const MAX_DIRECTORY_DEPTH = 3;

const directoryName = /^[a-z][a-z0-9-]*$/;
const fileName = /^[a-z][a-z0-9-]*\.(?:js|json|html|css|png)$/;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

// Any lowercase relative path with at most three directory levels: no
// traversal, no absolute or empty segments, no hidden or reserved names.
// The update-proof- prefix is reserved for the folder identity check.
export function validPackagePath(path) {
  if (typeof path !== 'string' || path.length >= 160) return false;
  const parts = path.split('/'), name = parts.at(-1);
  return parts.length <= MAX_DIRECTORY_DEPTH + 1 && parts.slice(0, -1).every(part => directoryName.test(part)) &&
    fileName.test(name) && !parts.some(part => reservedName.test(part)) && !name.startsWith('update-proof-');
}

export const fileEncoding = path => path.endsWith('.png') ? 'base64' : 'utf8';

// Resolves "./" and "../" in a reference relative to the referencing file.
// Returns null when the reference escapes the package root.
export function resolvePackageReference(from, resource) {
  const segments = from.split('/').slice(0, -1);
  for (const part of resource.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!segments.length) return null; segments.pop(); continue; }
    segments.push(part);
  }
  return segments.join('/');
}

export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBase64(bytes) {
  let text = '';
  for (let start = 0; start < bytes.length; start += 16384) text += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(text);
}

export function fileBytes(file) {
  if (typeof file?.content !== 'string') throw new Error('Ungültiger Dateiinhalt.');
  if (file.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(file.content);
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== file.content) throw new Error('Ungültiger UTF-8-Inhalt.');
    return bytes;
  }
  if (file.encoding !== 'base64' || file.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
      (file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))) throw new Error('Ungültige Base64-Kodierung.');
  const bytes = Uint8Array.from(atob(file.content), char => char.charCodeAt(0));
  if (encodeBase64(bytes) !== file.content) throw new Error('Nicht kanonische Base64-Kodierung.');
  return bytes;
}

export function fileText(file) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fileBytes(file));
}

export async function packageFile(path, bytes, encoding) {
  bytes = new Uint8Array(bytes);
  const content = encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : encodeBase64(bytes);
  return { path, encoding, content, size: bytes.byteLength, sha256: await sha256(bytes) };
}

export function validatePaths(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_PACKAGE_FILES) throw new Error('Ungültige Dateianzahl.');
  const paths = new Set();
  for (const file of files) {
    if (!validPackagePath(file?.path) || paths.has(file.path)) throw new Error('Ungültiger Dateipfad im Update.');
    paths.add(file.path);
  }
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) if (paths.has(segments.slice(0, i).join('/'))) throw new Error('Kollidierende Dateipfade.');
  }
  return paths;
}

// Every entry carries path, encoding, content, size and SHA-256 of the decoded
// bytes. Backup entries may record an absent file as content null.
export async function validateFileEntries(files, { backup = false } = {}) {
  const paths = validatePaths(files);
  let total = 0;
  for (const file of files) {
    if (backup && file.content === null) continue;
    if (!['utf8', 'base64'].includes(file.encoding) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Ungültige Dateikodierung oder Größe.');
    if (!backup && file.encoding !== fileEncoding(file.path)) throw new Error('Dateikodierung passt nicht zum Pfad.');
    const bytes = fileBytes(file);
    total += bytes.byteLength;
    if (total > MAX_PACKAGE_BYTES || bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength !== file.size ||
        await sha256(bytes) !== file.sha256) throw new Error('Die Prüfsumme oder Größe der Datei stimmt nicht.');
  }
  return paths;
}

// Manifest references are installation-relative. Resource URLs in modules/HTML
// are checked by the build's linker as well as this browser-side file contract.
export function validatePackageReferences(files) {
  const paths = new Set(files.map(file => file.path));
  const manifest = JSON.parse(fileText(files.find(file => file.path === 'manifest.json')));
  const requireFile = (from, resource, relative = false) => {
    if (typeof resource !== 'string') throw new Error(`Ungültige Dateireferenz: ${from}`);
    const path = relative ? resolvePackageReference(from, resource) : resource;
    if (path === null || !validPackagePath(path) || !paths.has(path)) throw new Error(`Fehlende oder ungültige Paketdatei: ${from} → ${resource}`);
  };
  const icons = value => typeof value === 'string' ? [value] : Object.values(value || {});
  const references = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page,
    manifest.options_ui?.page, manifest.devtools_page, ...icons(manifest.icons), ...icons(manifest.action?.default_icon),
    ...(manifest.sandbox?.pages || []), ...(manifest.content_scripts || []).flatMap(item => [...(item.js || []), ...(item.css || [])])];
  for (const resource of references.filter(value => value !== undefined)) requireFile('manifest.json', resource);
  for (const file of files) {
    if (!/\.(?:js|html|css)$/.test(file.path)) continue;
    const source = fileText(file);
    if (file.path.endsWith('.js')) {
      for (const [, resource] of source.matchAll(/\b(?:import\s*(?:\([^)]*?['"]|['"])|(?:import|export)\s+[^;]*?\bfrom\s*['"])([^'"]+)['"]/g)) requireFile(file.path, resource, true);
      for (const [, resource] of source.matchAll(/(?:new\s+Worker|\.addModule)\(\s*['"]([^'"]+)['"]/g)) requireFile(file.path, resource, true);
    }
    if (file.path.endsWith('.html')) for (const [, resource] of source.matchAll(/(?:src|href)=["']([^"'#]+\.(?:js|css|png))["']/g)) requireFile(file.path, resource, true);
    if (file.path.endsWith('.css')) for (const [, resource] of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) requireFile(file.path, resource, true);
  }
}

// Experimental candidates and released Stable versions publish update.json.
// A candidate additionally carries its prepared, not yet released Stable package.
export function updateAssetName(preparedStable = false) {
  return preparedStable ? 'update-stable.json' : 'update.json';
}

export function selectUpdateAsset(release, preparedStable = false) {
  return release.assets?.find(asset => asset.name === updateAssetName(preparedStable) && asset.state === 'uploaded');
}

// Each update asset has a detached release signature next to it.
export function signatureAssetName(preparedStable = false) {
  return `${updateAssetName(preparedStable)}.sig`;
}

export function selectSignatureAsset(release, preparedStable = false) {
  return release.assets?.find(asset => asset.name === signatureAssetName(preparedStable) && asset.state === 'uploaded');
}
