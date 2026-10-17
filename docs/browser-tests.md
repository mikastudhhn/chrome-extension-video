# Verbindliches Browser-Gate

`npm run test:browser` baut die beiden Kandidatenprofile einmal und führt die
Browser-Suites nacheinander aus. Es braucht keinen bereits laufenden Server.
CI verteilt dieselbe Matrix auf parallele Jobs (`--group=`), innerhalb einer
Gruppe bleibt die Reihenfolge seriell.
Node.js ab 22, Python 3 (ZIP-Prüfung), ffmpeg (synthetischer Tontest) und Chrome
mit Extension-Unterstützung werden benötigt. Der Starter unterstützt macOS und
Linux; Prozessgruppenbereinigung unter Windows ist nicht implementiert.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm test
npm run check
npm run test:browser
```

Unter Linux ohne Desktop: `npx --no-install playwright install --with-deps chromium`
und `xvfb-run --auto-servernum npm run test:browser`. Das Toolbar-Popup läuft mit
sichtbarem Chrome und ohne feste Viewport-Höhe, auch in CI. Xvfb stellt dafür den
Bildschirm bereit. Ein als Tab geöffnetes `popup.html` ersetzt diesen Test nicht.

Playwright und dessen Chromium-Revision sind durch `package-lock.json` gebunden.
Lokal berücksichtigt der Starter `videosync.playwrightModule` und
`videosync.chromiumExecutable` aus der Git-Konfiguration. Die Umgebungsvariablen
`PLAYWRIGHT_MODULE` und `CHROMIUM_EXECUTABLE` haben Vorrang. Die konfigurierte
Playwright-Version muss zur gepinnten Abhängigkeit passen. Eine abweichende lokale
Chrome-Version wird mit Pfad und Version in den Belegen ausgewiesen; sie ist kein
Nachweis für das CI-Chromium. Node-, Betriebssystem- und ffmpeg-Version werden
ebenfalls protokolliert.

## Pakete und Matrix

Der Starter prüft die ZIP-Prüfsumme, entpackt jedes Archiv in einen eigenen
vorübergehenden Ordner und vergleicht alle Extension-Dateien mit `update.json`.
Commit, Paketprofil und Manifestversion müssen passen. Nach den Tests werden die
extrahierten Dateien sowie ZIP und Updatebundle erneut auf Unverändertheit geprüft.
Jedes Paket enthält eine Laufzeit; jede Suite testet ein Kandidatenpaket.

| Gruppe | Suite | Paket |
| --- | --- | --- |
| `core-candidates` | `core-stable-candidate`, `core-experimental-candidate` | Zweipersonen-Kernablauf beider Pakete |
| `core-delayed` | `core-delayed-start-stable-candidate`, `core-delayed-start-experimental-candidate` | Kernablauf mit einmalig um 800 ms verzögertem Gaststart |
| `ui` | `frames-*`, `discovery-*-candidate`, `ux-*`, `popup-*-package` | iframe-Player, Player-/Shadow-/Frame-Auswahl und Installationskonflikte, UX, echtes Toolbar-Popup |
| `ui` | `channels-stable-package`, `channels-experimental-package` | Kanalwahl als Release-Stream, Tontest nur im Experimental-Paket |
| `ui` | `errors-stable-candidate`, `errors-experimental-candidate` | Fehlerdarstellung sowie strukturierte Fehler-/Bodyabbruchverträge |
| `ui` | `onboarding` | Erste Einrichtung im Popup (`TEST_ONBOARDING=1`; sonst gilt sie als abgeschlossen) |
| `updates` | `diagnostics-*-candidate` | Lokale Diagnose |
| `updates` | `updates-stable`, `updates-experimental` | Update-/Kanalabläufe beider Pakete, dazu Dev-Fixtures |
| `updates` | `update-recovery-stable`, `update-recovery-experimental` | Journal-/Readback-Recovery mit echter IDB/OPFS und Neustartgrenzen |
| `updates` | `development` | Eigener geklonter Checkout mit Branchwechsel, Watcher und Extension-Reload |

Die Discovery-Suite verlangt `TEST_EXTENSION`, `TEST_CHANNEL` und `TEST_SERVER` vom
gemeinsamen Starter; einen stillen Sourcepfad-Fallback gibt es nicht. Ihre beiden
Installationskopien ändern nur das Manifest für Namen, Fixture-Rechte und getrennte
IDs; alle übrigen Dateien werden bytegenau mit dem extrahierten Paket verglichen.

Frames, Discovery und Audiotest verwenden gekennzeichnete Manifest-Kopien mit Testrechten.
Updates ändern nur Installationskopien und verwenden synthetische GitHub-Antworten.
Weil Updateprüfungen ohne Token laufen, startet der gemeinsame Kontext jeden Browser
mit `--host-resolver-rules`, die `api.github.com` und `release-assets.githubusercontent.com`
unauflösbar machen; echte Releases beeinflussen so kein Testergebnis.
Diese Fixture-Änderungen gelten nicht als unveränderte Paketabnahme oder Prüfung
nativer Berechtigungsdialoge. Die ursprünglichen Archive bleiben unverändert.

Die Fehlerfälle prüfen HTTP-Fehlercodes trotz widersprüchlichem Freitext über
Worker, Offscreen und Background bis ins Popup sowie fatales ungültiges JSON im
Sitzungshinweis. Weitere Fälle starten den unveränderten paketierten Worker in
der Extension-Seite: Der HTTP-Proxy beschädigt erst nach serverseitiger
Ausführung die Relay-Bestätigung. Bodytimeout und Socketabbruch müssen denselben
Batch wiederholen, ohne Resync doppelt auszuführen; vollständig empfangenes
ungültiges JSON bleibt fatal, lokales Beenden bleibt ohne Fehler/Retry.

Die Recovery-Suite lädt eine bytegleiche Kopie des Kandidaten und akzeptiert weder
Dev- noch Sourcebuilds. Nur das Zielpaket der OPFS-Transaktion ist ein synthetisches
Fixture mit eigener Commit-/Versionsidentität und zusätzlicher Datei. Journal,
Snapshot und DirectoryHandle liegen in der echten IndexedDB. Extension-Reload und
vollständiges Schließen/Wiederöffnen des Browsers müssen den angehaltenen Runner
verlieren, während Journal und Snapshot-Digests erhalten bleiben. Ein Defektfall
ersetzt `offscreen.js` in einer separaten Kopie. Die Nonce-Lesequelle wird auf den
OPFS-Ordner abgebildet; das beweist weder einen nativen Ordnerdialog noch die
dauerhafte Schreibfreigabe eines externen Installationsordners.

## Isolation und Diagnose

Jeder Starter besitzt eigene Ports, temporäre Profile und Prozessgruppen. Er nutzt
oder beendet keinen Server auf Port 8787. Eine Sperre unter
`test-results/.browser-lock` verhindert überlappende Starter im selben Checkout.
Nach einem harten Betriebssystemabbruch kann die Sperre zurückbleiben: erst den
in `owner.json` genannten Prozess prüfen, dann eine verwaiste Sperre entfernen.

Belege liegen pro Lauf unter `test-results/browser-*/`:

- `summary.json`: Commit, uncommittierte Änderungen, Werkzeug-/Paketidentitäten,
  geplante Matrix, Testskript-Hashes, Ergebnisse und Gesamtstatus. Nur
  `commitBound: true` bindet einen sauberen Arbeitsbaum an den Commit; CI verlangt
  einen sauberen Checkout.
- Pro Suite `output.log` und `process.json` mit Exitcode, Signal, Laufzeit und
  Bereinigung der registrierten Prozessgruppen; `owned-processes.jsonl` enthält
  deren PID, Elternprozess, Gruppe, Startzeit, Startbefehl und Eigentumsmarker.
- `context-*-identity.json`, Screenshots und `context-*-trace.zip` für die Browser.
- `timing.jsonl` mit Szenariomarken, Mediaereignissen, angeklickten Aktionen sowie
  im Kern mit Adapterbefehlen und Relay-Bestätigungen.

Die Traces enthalten ausschließlich isolierte Testprofile und synthetische
Sitzungsdaten, können aber deren Raumkennungen enthalten. Sie gehören nicht in
öffentliche Fehlerberichte; CI-Artefakte sind bei öffentlichem Repository für alle
herunterladbar. Traces ansehen:
`npx --no-install playwright show-trace PFAD/context-1-trace.zip`.

Fehler stoppen das Gate; es gibt keine automatischen Suite-Wiederholungen.
SIGINT/SIGTERM und die äußere Zehn-Minuten-Notgrenze pro Suite ergeben ebenfalls
Rot. Ein Node-Preload registriert die von Playwright gestarteten Browsergruppen
synchron beim `spawn`; nach Suite-Ende oder hartem SIGKILL räumt der Starter genau
diese Gruppen anhand ihres Eigentumsmarkers auf. Nicht bestätigte
Eigentumsverhältnisse werden nicht beendet und machen den Lauf rot. Persönliche
Browser werden nicht gesucht oder registriert.

Zur gezielten Diagnose kann eine Suite oder Gruppe gewählt werden:

```sh
npm run test:browser -- --suite=ux-stable
npm run test:browser -- --group=ui
# Bereits gebaute Pakete unverändert verwenden:
PACKAGE_VERSION=0.6.0.0 npm run test:browser -- --skip-build --suite=core-stable-candidate
```

Ein Teillauf trägt `fullGate: false` und ersetzt niemals das vollständige Gate.
`--group=NAME` führt eine der Gruppen aus `browserGroups`
(`scripts/browser-test-matrix.js`) seriell aus: `core-candidates`, `core-delayed`,
`ui`, `updates`. Das vollständige Gate entsteht erst aus allen Gruppen desselben
Commits. `--skip-build` verlangt passende, bereits gebaute Pakete des aktuellen
Commits. Ohne CI-Metadaten verwendet der lokale Build die Kandidatennummer 0.

`npm run test:browser -- --suite=diagnose-delayed-start` reproduziert separat den
verzögerten ersten `video.play()` des Gasts (800 ms) und ersetzt keinen
Matrixeintrag; Timeouts und Toleranzen bleiben unverändert.

## CI und praktische Grenzen

Der Workflow läuft für Pull Requests auf alle Zielbranches; der Push-Trigger ist
auf `main` begrenzt. Ein neuer Push auf denselben PR bricht dessen laufende Prüfung
ab; Läufe auf `main` brechen einander nie ab.

- `build` baut beide Kandidatenprofile einmal und lädt `dist/` als Artefakt hoch.
- `checks` führt Unit-Tests, `npm run check` und die Demo-Erzeugung aus.
- `browser` läuft als Matrix über die Gruppen. Jeder Job lädt genau die gebauten
  ZIPs herunter, installiert das gepinnte Chromium (aus dem Cache, wenn
  `package-lock.json` unverändert ist) und führt seine Gruppe seriell aus. Eine
  rote Gruppe bricht die übrigen nicht ab (`fail-fast: false`); jede Gruppe lädt
  ihre Belege getrennt hoch, auch bei Fehlern.
- `verify` ist der Pflicht-Check für `main`. Er ist nur grün, wenn `build`,
  `checks` und jede Gruppe erfolgreich waren.
- `release` hängt von `verify` ab, läuft ausschließlich auf `main` außerhalb von
  Pull Requests und veröffentlicht die getesteten Artefakte ohne Neubau.

Dieses Gate erteilt keine Stable-Freigabe. Anbieter/DRM, reale
Zweigerätesitzungen, Langzeitverhalten, native Ordnerfreigabe und Screenreader
bleiben separate praktische Nachweise.
