# Lokale Entwicklung

Voraussetzung: Node.js ab Version 22.13. Vor dem ersten Prüflauf `npm ci --ignore-scripts` ausführen; der Relay benötigt zur Laufzeit keine npm-Pakete. Git-Historie oder Release-Tags werden nicht gebraucht: Build, Tests und Dev funktionieren auch in einem Checkout mit genau einem Commit.

## Dev-Kanal

1. `npm run dev` im gewünschten Checkout starten.
2. Einmal `chrome://extensions` öffnen, Entwicklermodus aktivieren und **Entpackte Erweiterung laden** → `dist/development/extension` wählen. Die Installation heißt **Video Sync · Dev**. Beim Entwickeln nur diese Installation zur Videosteuerung verwenden, damit keine zweite Video-Sync-Installation dasselbe Video steuert.
3. In dieser Extension unter **Einstellungen → Version** den Eintrag **Dev · <Branch>** wählen.
4. Dateien speichern. Der Helfer bündelt Änderungen, prüft JavaScript, Modulimporte, JSON und referenzierte Ressourcen und veröffentlicht erst danach den Build. Die Extension erkennt ihn innerhalb weniger Sekunden und startet automatisch neu. Ein geöffnetes Toolbar-Popup muss danach erneut geöffnet werden; als Tabs geöffnete Extension-Seiten werden neu geladen.

**Auto-Reload pausieren** hält den laufenden Stand fest, während der Helfer weitere Änderungen vorbereitet. **Auto-Reload fortsetzen** übernimmt den neuesten fertigen Build. **Jetzt neu laden** aktiviert ihn einmalig auch bei pausierter Automatik. Buildfehler werden in der Extension und im Terminal angezeigt; Dateien des letzten gültigen Builds bleiben erhalten. Änderungen an der Helfer-Implementierung selbst benötigen einen Neustart von `npm run dev`.

Der Dev-Build ist eine Kopie der aktuellen Quelldateien des ausgecheckten Branches einschließlich uncommitteter Änderungen, mit genau einer Laufzeit und dem Paketprofil `local` (experimentelle Funktionen eingeschaltet). Stable und Experimental wählen auch hier nur den Release-Stream für die Updateanzeige; mit ihnen wird bei Dateiänderungen nicht automatisch neu geladen, und Release-Updates überschreiben den Dev-Ordner nie. Der Helfer führt selbst keine Git-Wechsel oder Pulls aus. Git-Branchwechsel aktualisieren Namen und Code. Ein eigener Port und ein eigenes Geheimnis je Checkout halten mehrere Worktrees auseinander. Zwei Helfer für denselben Checkout sind nicht erlaubt. Falls der gespeicherte Port anderweitig belegt ist, den dort laufenden Prozess prüfen; `dist/development/helper.json` nicht während einer Sitzung löschen.

Normale ZIP-Installationen enthalten keinen Dev-Verbindungsclient und zeigen ausschließlich Stable und Experimental. `npm run dev` verändert keine normale Installation.

**Strg+C** beendet den Helfer. Ein ungewählter Dev-Eintrag verschwindet; bei ausgewähltem Dev bleibt der letzte Stand mit **Dev offline** sichtbar. Erneutes `npm run dev` verbindet dieselbe Installation wieder, ohne erneute Ordnerauswahl. `npm run dev:prepare` baut nur einmal und bietet ohne Helfer keinen neuen Dev-Wechsel an.

### Videos und Räume beim Reload

Der aktuelle Video-Tab wird ohne Seiten-Reload erneut angebunden, sodass die Position im Player erhalten bleibt. Eine aktive Raum-Mitgliedschaft wird mit ihren vorhandenen Zugangsdaten und Nachrichtenzählern kurz lokal gesichert und nach dem Reload wieder aufgenommen. Die Sicherung wird danach gelöscht und ist höchstens zwei Minuten gültig. Sie wird nie an den Dev-Helfer übertragen. Der Tontest wird abgebrochen und Wiedergabe bleibt pausiert. Durch den neuen Playeradapter kann erneutes Bestätigen der Szene nötig sein.

Ein geschlossener oder navigierter Video-Tab, ein abgelaufener Raum oder ein Serverneustart kann die Wiederaufnahme verhindern; dann zeigt die Extension einen Hinweis zum erneuten Verbinden. Beliebige Laufzeitfehler im geänderten Code kann die Buildprüfung nicht ausschließen. Der Helfer startet und beendet nicht den normalen Verbindungsserver auf Port 8787.

## Manuelle Zweipersonentests

```sh
npm run manual-test
```

Öffnet zwei sichtbare, getrennte Browserprofile mit einem eigenen temporären Server (nie Port 8787), bereits im Raum, auf Video A bei 00:05 und B bei 00:10 ausgerichtet und pausiert. Standardmäßig lädt der Starter eine temporäre **Kopie des ausgecheckten `extension/`-Ordners** mit dem Paketprofil und Kanal **Stable**. Spätere Änderungen am Checkout beeinflussen einen laufenden Test nicht.

- `TEST_CHANNEL=experimental` verwendet das Experimental-Profil (Tontest sichtbar) und wählt Experimental.
- `TEST_EXTENSION=<Ordner>` lädt stattdessen eine Kopie eines anderen Ordners, etwa eines entpackten Release-Pakets: Die ZIP des freigegebenen Stable-Releases von GitHub herunterladen, entpacken und `TEST_EXTENSION=…/video-sync/extension` setzen. Dessen Profil bleibt unverändert; nur `config.js` erhält die Testserveradresse.
- `TEST_VIEW=controls` zeigt zuerst den Steuerungstab, `TEST_VIEW=video` nur das Testvideo, `TEST_VIEW=popup` (Standard) öffnet das echte Toolbar-Popup (Chrome 127 oder neuer).
- `TEST_MODE=fresh` startet beide Profile ohne gespeicherte Einstellungen, Website-Freigabe, Video oder Raum für die vollständige Ersteinrichtung.

`PLAYWRIGHT_MODULE` und `CHROMIUM_EXECUTABLE` können auf vorhandene Installationen zeigen; als dauerhafte lokale Voreinstellung liest der Starter die Git-Konfiguration `videosync.playwrightModule` und `videosync.chromiumExecutable`. Zum Beenden beide Testfenster schließen; der eigene Server endet automatisch. Die native Website-Freigabe und eigene Streamingseiten sind separate manuelle Schritte.

## Prüfungen

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run test:browser
```

`npm test` führt die Node-Tests unter `tests/` aus. `npm run check` prüft Manifest, Designtokens, die Syntax aller JavaScript-Dateien sowie Modul-/Ressourcenverweise der Extension und danach drei verpflichtende Qualitätsprüfungen. Keine davon formatiert oder korrigiert Dateien automatisch. Gesamtgate und Einzelbefehle verwenden denselben Starter `scripts/check-quality.js`; er startet die lokal gepinnten Werkzeuge mit der laufenden Node-Executable, ohne Shell.

| Befehl | Umfang | Grenze |
| --- | --- | --- |
| `npm run check:types` | Striktes JSDoc/checkJs für `protocol.js`, `runtime-errors.js`, `update-recovery.js`, den UI-Verbraucher `errors.js` und die Compile-only-Verbraucher unter `tests/types/` | Keine vollständige Typprüfung der übrigen Module |
| `npm run check:lint` | JavaScript in Extension, Server, Demo, Skripten und Tests; Regeln gegen doppelte Schlüssel/Zweige, unsichere optionale Zugriffe, asynchrone Promise-Executors und unerreichbaren Code | Ausgabeordner ausgeschlossen; keine Stilregeln |
| `npm run check:format` | Explizite Dateiliste in `scripts/check-quality.js` | Bewusst schrittweise, keine Gesamtformatierung |

Typgeprüfte Dateien tragen `// @ts-check`; global bleibt `checkJs` aus. Unbekannte Eingaben bleiben `unknown`, bis Laufzeitvalidatoren sie eingrenzen; die Protokoll-Negativtests bleiben verbindlich. Compile-only-Fälle verwenden `@ts-expect-error`, damit aufgeweichte Typen den Check scheitern lassen. Neue Verträge an der zuständigen Modulgrenze annotieren und in `tsconfig.contracts.json` aufnehmen. `tests/quality-tools.test.js` belegt die Fehlererkennung der geladenen Lint-/Formatkonfiguration.

`scripts/validate-resources.js` und `scripts/validate-development.js` sind die gemeinsame Paketprüfung für Kandidaten und Dev: ESM-Verlinkung sowie HTML-, Worker-, AudioWorklet- und injizierte Skriptverweise, ohne Laufzeitcode auszuführen. Browser-Suites, Matrix und CI: [browser-tests.md](browser-tests.md). Mehrstündiger Transporttest: `TEST_SERVER=https://euer-server.example SOAK_SECONDS=14400 npm run soak`.

### Demo portabel erzeugen

Python 3 mit venv, ffmpeg mit `libvpx-vp9` und für die Prüfung zusätzlich ffprobe installieren:

```sh
python3 -m venv /tmp/video-sync-demo-venv
/tmp/video-sync-demo-venv/bin/python -m pip install -r scripts/requirements-demo.txt
/tmp/video-sync-demo-venv/bin/python scripts/generate-demo.py --output-dir /tmp/video-sync-demo
/tmp/video-sync-demo-venv/bin/python tests/generate-demo.test.py
```

Auf Windows den Python-Pfad der venv unter `Scripts` verwenden. Pillow liefert die Standardschrift; `--font /pfad/zur/schrift.ttf` erlaubt eine andere Schrift. Ohne `--output-dir` werden die Videos unter `demo/` ersetzt. Version A dauert 45 Sekunden, B 50 Sekunden mit fünf Sekunden Vorlauf. Die Tests prüfen Codec, Auflösung, Bildrate, Dauer und übereinstimmende Bilder nach dem Versatz; bytegleiche WebM-Dateien über ffmpeg-Versionen werden nicht zugesagt.
