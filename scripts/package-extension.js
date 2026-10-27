import { createPackageBundle } from './package-bundle.js';
import { prepareStorePackage } from './store-package.js';
import { updateAssetName } from '../extension/package-files.js';
import { copyFile, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const server = new URL(process.argv[2] || 'http://localhost:8787');
const channel = process.env.PACKAGE_PROFILE || 'experimental';
if (!['stable', 'experimental', 'store'].includes(channel)) throw new Error('PACKAGE_PROFILE must be stable, experimental or store.');
// The Chrome Web Store package runs the Stable feature set without the GitHub updater.
const store = channel === 'store';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (server.username || server.password || server.search || server.hash || server.pathname !== '/' ||
    !(server.protocol === 'https:' || (server.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(server.hostname)))) {
  throw new Error('Use an HTTPS server origin or localhost.');
}
const sourceManifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const buildNumber = process.env.BUILD_NUMBER;
if (buildNumber && (!/^\d+$/.test(buildNumber) || Number(buildNumber) > 65535)) throw new Error('Invalid build number.');
const version = buildNumber ? `${sourceManifest.version}.${buildNumber}` : sourceManifest.version;
const candidateTag = process.env.RELEASE_TAG || null;
const directory = resolve('dist', channel, `build-${version}`, 'video-sync');
const extensionDirectory = join(directory, 'extension');
await rm(directory, { recursive: true, force: true });
await mkdir(extensionDirectory, { recursive: true });
await cp('extension', extensionDirectory, { recursive: true });
await writeFile(join(extensionDirectory, 'build-info.json'), JSON.stringify({ schema: 2,
  repository: 'mikastudhhn/chrome-extension-video', commit, channel: store ? 'stable' : channel, candidateTag, local: null,
  ...(store ? { distribution: 'chrome-web-store' } : {}) }, null, 2) + '\n');
await writeFile(join(extensionDirectory, 'config.js'), `export const DEFAULT_SERVER = ${JSON.stringify(server.origin)};\n`);
const manifest = JSON.parse(await readFile(join(extensionDirectory, 'manifest.json'), 'utf8'));
manifest.version = version;
manifest.version_name = `${manifest.version} · ${channel === 'stable' ? 'Stable' : 'Experimental'}`;
if (store) await prepareStorePackage(extensionDirectory, manifest);
await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const prompt = `Installiere Video Sync ${manifest.version} aus dieser ZIP als entpackte Chrome-Erweiterung in einem dauerhaften Ordner. Der zu ladende Unterordner heißt video-sync/extension. Aktiviere chrome://extensions → Entwicklermodus → Entpackte Erweiterung laden und hefte Video Sync an. Falls die Extension bereits installiert ist, aktualisiere den Inhalt des bisherigen Erweiterungsordners und klicke Neu laden; installiere keine zweite Kopie.

Der gemeinsame Verbindungsserver ist ${server.origin}. Beide Personen sollen Video Sync ${manifest.version} mit einem Server derselben Version (Relay-Protokoll 3) verwenden; ältere Versionen vorher einmalig entfernen. Eine bisher gespeicherte alte Serveradresse im Popup auf die neue Adresse ändern. Localhost ist nur für Tests auf demselben Rechner geeignet. Auf dem Rechner des Empfängers ist bei einer öffentlichen HTTPS-Adresse kein eigener Server nötig.

Unter Zahnrad → Version ist Stable voreingestellt; die Auswahl bestimmt, welche Releases der integrierte Updater anbietet. Experimental-Pakete enthalten einen optionalen achtsekündigen Tontest, noch keine automatische Szenenerkennung. Anleitung: EXPERIMENTAL-TEST.md. Tonproben werden nicht gespeichert oder übertragen. Der Test benötigt keinen Verbindungsserver.

Öffne das Popup auf dem eigenen Video-Tab. Klicke einmal „Erlauben & verbinden“ und bestätige Chrome. Diese gespeicherte Freigabe umfasst alle HTTP-/HTTPS-Websites, eingebettete Player und den Server. Eingebettete und verschachtelte Player werden danach automatisch erkannt, ohne zusätzliche Bestätigung pro Domain. Beim späteren Öffnen des Popups wird das aktuelle Video automatisch verbunden, wenn noch kein Video verbunden ist.

Eine Person erstellt einen Raum und kopiert die Einladung. Die andere fügt sie in der Extension ein und tritt bei; Code und Serveradresse werden gemeinsam übernommen. Ein reiner Raumcode funktioniert ebenfalls mit der gespeicherten Serveradresse. Falls beides fehlt, frage nach der Einladung. Beide stellen ihre eigenen Videos pausiert auf dieselbe Szene und bestätigen „Diese Szene bestätigen“. Dann gemeinsam „Abspielen“. „Anderes Video verbinden“ steht direkt unter der Steuerung. Das Zahnrad oben rechts öffnet die Einstellungen. Nach einem Player-/Folgenwechsel erneut ausrichten. Bei Autoplay-Sperre einmal im eigenen Video Play drücken.

Nach einem Netzabbruch verbindet die Extension automatisch wieder. Nach erkannter Unterbrechung mit Play fortsetzen. Der Raum bleibt bis zu fünf Minuten ohne Teilnehmeraktivität erhalten. Nach Server-/Browserneustart einen neuen Raum erstellen. Der HTTPS-Server muss dauerhaft laufen.
`;
const instructions = `# Video Sync ${manifest.version}

## Installation / Update

1. ZIP in einen dauerhaften Ordner entpacken und behalten.
2. chrome://extensions öffnen, Entwicklermodus einschalten und den Ordner video-sync/extension laden.
3. Bei bestehender Installation die Dateien im bisherigen Ordner ersetzen, dann „Neu laden“. Keine zweite Kopie installieren.
4. Beide Personen sollen Video Sync ${manifest.version} mit einem Server derselben Version (Relay-Protokoll 3) verwenden. Eine Version vor 0.6.0 zuvor unter chrome://extensions entfernen.

Der integrierte Updater prüft die öffentlichen GitHub-Releases ohne Token; beim ersten Update unter Einstellungen → Erweitert → Updates den installierten Ordner auswählen und den Zugriff auf GitHub erlauben. Details: UPDATES.md. Die manuelle ZIP-Aktualisierung bleibt als Rückfallweg möglich.

## Einmal einrichten

Serveradresse: ${server.origin}

Eine bereits gespeicherte alte Adresse bleibt beim Update erhalten; gegebenenfalls im Popup ändern. Localhost funktioniert nur auf demselben Rechner.

Video auf der Website laden. Popup öffnen, einmal „Erlauben & verbinden“ klicken und Chrome bestätigen. Die gespeicherte Freigabe umfasst Websites, Verbindungsserver und eingebettete Player. Danach erkennt die Extension verschachtelte iframe-Player ohne weitere Freigabedialoge. Beim Öffnen des Popups verbindet sie das Video im aktuellen Tab automatisch, sofern noch keines verbunden ist.

Die Freigabe gilt bis zum Widerruf oder einer Neuinstallation; Autoplay-Regeln bleiben bestehen. Ohne breite Freigabe ist die gezielte Freigabe einzelner Player weiterhin möglich.

## Gemeinsam ansehen

Unter Zahnrad → Version zwischen Stable (voreingestellt) und Experimental wählen. Die Auswahl bestimmt, welche Releases der integrierte Updater anbietet. Experimental-Pakete enthalten einen optionalen achtsekündigen Tontest; automatische Szenenerkennung ist noch nicht enthalten. Anleitung und Grenzen stehen in EXPERIMENTAL-TEST.md. Der Tontest benötigt keinen Server.

Eine Person erstellt einen Raum und klickt „Einladung kopieren“. Die andere fügt die Einladung in der Extension ein und klickt „Beitreten“; die Serveradresse wird automatisch übernommen. Ein reiner Raumcode funktioniert ebenfalls mit der gespeicherten Serveradresse. Beide suchen dieselbe Szene und bestätigen „Diese Szene bestätigen“. Anschließend gelten Play, Pause und Seek für beide. Videos werden nicht übertragen.

Testplayer: ${server.origin}/ — Version A bei 00:05 und B bei 00:10 zeigen dieselbe Szene.

Bei Netzproblemen pausieren beide. Die Verbindung wird automatisch erneut aufgebaut; nach einer erkannten Unterbrechung mit Play fortsetzen. Nach fünf Minuten ohne Aktivität eines Teilnehmers, Server-/Browserneustart oder ausdrücklichem Verlassen ist ein neuer Raum nötig. Nach Medienwechsel erneut ausrichten.

Der gemeinsame HTTPS-Server muss durchgehend erreichbar sein; für den Dauerbetrieb einen VPS mit fester IP-Adresse oder Domain verwenden.

Anbieter sind mit ${manifest.version} noch nicht praktisch abgenommen; Netflix verwendet eine private Schnittstelle. INSTALL-PROMPT.txt enthält die Einrichtungsschritte für einen lokalen Assistenten.
`;
if (store) {
  // The Web Store expects manifest.json at the root of the uploaded ZIP.
  execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/validate-development.js', extensionDirectory], { stdio: 'pipe' });
  const archive = resolve(`dist/store/video-sync-${manifest.version}-store.zip`);
  zip(extensionDirectory, archive, extensionDirectory);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  video-sync-${manifest.version}-store.zip\n`);
  console.log(JSON.stringify({ archive, extensionDirectory, server: server.origin, sha256: digest, channel, commit }, null, 2));
} else {
  await writeFile(join(directory, 'INSTALL-PROMPT.txt'), prompt);
  await writeFile(join(directory, 'INSTALLATION.md'), instructions);
  await copyFile('docs/updates.md', join(directory, 'UPDATES.md'));
  await copyFile('docs/release-workflow.md', join(directory, 'VERSIONEN.md'));
  await copyFile('docs/experimental-test.md', join(directory, 'EXPERIMENTAL-TEST.md'));
  await copyFile('CHANGELOG.md', join(directory, 'CHANGELOG.md'));
  execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/validate-development.js', extensionDirectory], { stdio: 'pipe' });
  const bundle = await createPackageBundle(extensionDirectory, { repository: 'mikastudhhn/chrome-extension-video', channel, commit, candidateTag, version: manifest.version });
  const archive = resolve(`dist/${channel}/video-sync-${manifest.version}.zip`);
  zip(directory, archive, dirname(directory));
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  video-sync-${manifest.version}.zip\n`);
  const update = resolve('dist', channel, updateAssetName());
  await writeFile(update, JSON.stringify(bundle));
  console.log(JSON.stringify({ archive, extensionDirectory, server: server.origin, sha256: digest, channel, commit, update }, null, 2));
}

function zip(root, archive, base) {
  execFileSync('python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]); base=pathlib.Path(sys.argv[3])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as archive:
 for path in sorted(root.rglob('*')):
  if path.is_file(): archive.write(path,path.relative_to(base))
`, root, archive, base]);
}
