# Updates

Updates kommen aus den öffentlichen GitHub-Releases des [Repositorys](https://github.com/mikastudhhn/chrome-extension-video). Dafür sind weder ein GitHub-Account noch ein Token nötig. Ein eigener Token ist optional und erhöht nur GitHubs Abfragegrenze. Die Erweiterung wird nicht im Chrome Web Store veröffentlicht.

## Einmal installieren

Die ZIP einer Veröffentlichung dauerhaft entpacken und `video-sync/extension` über `chrome://extensions` → Entwicklermodus → **Entpackte Erweiterung laden** installieren. Den Entwicklermodus eingeschaltet lassen.

- Stable-Release `vX.Y.Z`: `video-sync-X.Y.Z.N.zip` ist das freigegebene Stable-Paket.
- Experimental-Release `vX.Y.Z-preview.N`: `video-sync-X.Y.Z.N.zip` ist das Experimental-Paket. Die zusätzliche ZIP mit `-stable` ist ein noch abzunehmender Stable-Kandidat und kein freigegebener Stable-Download.

Wer eine Version vor 0.6.0 verwendet hat, entfernt diese einmalig unter `chrome://extensions` und lädt 0.6.0 neu. Ältere Versionen können 0.6.0 weder automatisch installieren noch mit einem 0.6.0-Server oder -Partner zusammenarbeiten; das Popup meldet dann „Server und Extension passen nicht zusammen“.

## Stable und Experimental

Unter **Einstellungen → Version** wird gewählt, welchen Releases der integrierte Updater folgt: Stable den Versionen `vX.Y.Z`, Experimental den Kandidaten `vX.Y.Z-preview.N`. Jedes Paket enthält genau eine Laufzeit. Experimentelle Funktionen wie der Tontest sind an das installierte Paket gebunden, nicht an die Auswahl: Wer auf Experimental umstellt, erhält sie mit dem nächsten installierten Experimental-Paket. Ein Wechsel ist auch in einem laufenden Raum möglich und trennt weder Raum noch Video.

## Prüfen und installieren

Jede Installation sucht beim Browserstart, alle 30 Minuten, beim Kanalwechsel und beim Öffnen des Popups nach einer passenden Veröffentlichung. Automatische Auslöser innerhalb von zwei Minuten nach Beginn der letzten Prüfung senden keine weitere Anfrage; **Jetzt prüfen** sucht immer sofort. Installiert wird ausschließlich nach Klick auf **Jetzt aktualisieren** (Download-Symbol im Popup-Banner oder in der Update-Ansicht unter **Einstellungen → Erweitert → Updates**).

Die Suche braucht keine Website-Freigabe: Die GitHub-API sendet CORS-Header. Der Paketdownload wird dagegen auf `release-assets.githubusercontent.com` umgeleitet, das keine CORS-Header sendet. Deshalb fragt Chrome vor dem ersten **Jetzt aktualisieren** oder **Installation prüfen** einmal nach Zugriff auf `api.github.com` und `release-assets.githubusercontent.com`. Das Onboarding bietet diese Freigabe als überspringbaren Schritt an. Schließt der Chrome-Dialog das Popup oder verbraucht er den Klick, genügt ein erneuter Klick.

Beim ersten Update wird der tatsächlich geladene Erweiterungsordner `video-sync/extension` ausgewählt und in Chrome freigegeben. Eine Prüfdatei, die über die URL der laufenden Erweiterung zurückgelesen wird, verhindert das Überschreiben einer anderen Installation, des Quellordners oder eines Entwicklungsbuilds. Der Ordner bleibt gespeichert; Chrome kann den Schreibzugriff später erneut bestätigen lassen. **Weitere Optionen → Ordner finden → In Chrome anzeigen** öffnet die Detailseite mit dem Pfad.

Ein aktiver Raum sperrt Installation, Wiederherstellung und Ordnerauswahl. Die Installation läuft nach Ordnerauswahl im Hintergrund weiter, auch bei geschlossenem Popup, und startet die Erweiterung nach erfolgreicher Prüfung neu. Website-Freigaben, Einstellungen und Erweiterungs-ID bleiben erhalten.

### Nur neuere Versionen, Bestätigung bei Kanalwechsel und neuen Rechten

Im gewählten Kanal bietet und installiert der Updater nur Versionen, deren Manifest-Version **strikt höher** ist als die installierte. Ein älteres oder gleich altes Paket desselben Kanals wird nie installiert, auch nicht nach Bestätigung (Schutz gegen das erneute Veröffentlichen alter, gültig signierter Pakete).

- **Kanalwechsel** Stable ↔ Experimental: Das Zielpaket darf älter oder gleich alt sein (etwa die abgenommene Stable-Version nach einem neueren Experimental-Kandidaten). Vor dem Schreiben zeigt die Update-Ansicht „Bestätigung erforderlich“ mit beiden Versionen; erst **Bestätigen & installieren** installiert.
- **Neue Rechte**: Fügt das neue Manifest Einträge in `permissions`, `host_permissions`, `optional_permissions`, `optional_host_permissions`, `content_scripts`, `externally_connectable` oder `web_accessible_resources` hinzu oder ändert es `content_security_policy`, listet die Update-Ansicht die Änderungen auf und verlangt ebenfalls eine Bestätigung. Chrome fragt bei entpackten Erweiterungen beim Neuladen nicht erneut nach. Entfernte Rechte brauchen keine Bestätigung.

Die Bestätigung gilt nur für genau diese Prüfung (installierte und neue Version, Kanal, Commit und Änderungsliste). Der Updater lädt und prüft das Paket danach erneut; weicht etwas ab, wird neu gefragt. **Abbrechen** verwirft die Anzeige, ohne etwas zu schreiben. Im Popup-Banner erscheint dafür „Bestätigung erforderlich“ und öffnet die Update-Details.

**Kein passendes Release** bedeutet eine vollständig abgeschlossene Suche ohne installierbares Paket für diesen Kanal. **Alles aktuell** setzt ein gefundenes, zur Installation passendes Release voraus. Ein fehlgeschlagener Versuch ersetzt nicht den Zeitpunkt der letzten erfolgreichen Prüfung. Unter **Updates → Weitere Optionen → Preview-Nummer anzeigen** lässt sich im Experimental-Kanal die installierte Kandidatenkennung einblenden, etwa `0.6.0-preview.30`.

## Optionaler GitHub-Token

Unter **Einstellungen → Erweitert → Updates → GitHub-Token** lässt sich ein persönlicher Token hinterlegen. Er bleibt lokal in vertrauenswürdigen Erweiterungskontexten und wird ausschließlich an die GitHub-API gesendet. Ein Fine-grained Token mit **Public repositories (read-only)** genügt. **Token entfernen** schaltet auf öffentliche Abfragen zurück. Tokens niemals weitergeben oder in Pakete einbauen.

Ohne Token erlaubt GitHub [60 Anfragen pro Stunde je IP-Adresse](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api); alle Installationen hinter demselben Internetanschluss teilen sie, auch bedingte Anfragen mit 304-Antwort zählen mit.

| Vorgang | Anfragen ohne Token |
| --- | --- |
| Automatische Prüfung (Alarm, Start, Popup), erste Release-Seite unverändert | 1 (gespeicherte weitere Seiten werden wiederverwendet) |
| Automatische Prüfung nach neuem Release oder ohne vollständigen Cache | 1 je Release-Seite (100 Releases pro Seite) |
| **Jetzt prüfen** | 1 je Release-Seite |
| Installation | 1 je Release-Seite + 2 Downloads (Paket und Signatur) |
| **Installation prüfen** | 3 (Tag + Paket + Signatur) |

Meldet GitHub höchstens fünf verbleibende Anfragen, pausieren automatische Prüfungen bis zum Reset (höchstens eine Stunde), damit **Jetzt prüfen** und eine Installation möglich bleiben. Ist die Grenze erreicht, sendet die Erweiterung bis zur Wartezeit keine Anfrage, zeigt „Anfragelimit erreicht“ mit Uhrzeit und behauptet nie „Alles aktuell“. Ungültige Tokens, fehlende Berechtigung, nicht erreichbare Releases, Anfragelimits und vorübergehende Fehler erhalten getrennte Hinweise.

## Signierte Updates

Der Updater installiert ausschließlich Pakete, die mit dem Releaseschlüssel von Video Sync signiert sind. Neben jedem `update.json` liegt eine abgetrennte Signatur `update.json.sig` (ECDSA P-256 mit SHA-256, Format `ES256`). Signiert wird eine kanonische Aussage aus Repository, Release-Tag, Kanal, Dateiname und SHA-256 der exakten `update.json`-Bytes; `update.json` enthält wiederum Größe und SHA-256 jeder Paketdatei. Damit ist jede Datei an genau ein Release und einen Kanal gebunden.

Der öffentliche Schlüssel ist fest in `extension/release-key.js` eingebaut. Den privaten Schlüssel besitzen nur der Eigentümer und die geschützte GitHub-Umgebung `release`. Der Updater prüft vor dem Lesen des Pakets mit WebCrypto (ab Chrome 116) und bricht mit einer Meldung ab, wenn die Signatur fehlt („nicht signiert“), beschädigt ist, von einem anderen Schlüssel stammt, zu einem anderen Release, Kanal oder Paket gehört oder ungültig ist. Ein Angreifer mit Schreibzugriff auf die GitHub-Releases kann daher kein installierbares Update veröffentlichen, solange er den privaten Schlüssel nicht besitzt.

Der vorbereitete Stable-Kandidat `update-stable.json` eines Experimental-Releases ist nur für diesen Kandidatentag signiert und lässt sich nicht als Stable-Update installieren. Erst die Stable-Freigabe signiert die unveränderten Bytes als `update.json` des Stable-Tags. Der manuelle ZIP-Weg prüft keine Signatur; dort bleibt die `.sha256`-Datei maßgeblich.

## Paketformat

Jedes Release enthält `update.json` (Experimental-Kandidat bzw. freigegebenes Stable) mit `update.json.sig` und im Experimental-Release zusätzlich `update-stable.json` mit `update-stable.json.sig` für den vorbereiteten Stable-Kandidaten. Das Format ist in `extension/package-files.js` festgelegt: Jeder Eintrag hat `path`, `encoding` (`utf8` oder kanonisches `base64` für PNG), `content`, `size` und SHA-256 der dekodierten Bytes. Grenzen: 256 Dateien, 4 MiB je Datei, 8 MiB Gesamtinhalt, 12 MiB serialisiertes JSON.

Erlaubt sind kleingeschriebene relative Pfade mit bis zu drei Verzeichnisebenen (`[a-z][a-z0-9-]*`) und den Endungen `.js`, `.json`, `.html`, `.css`, `.png`. Absolute Pfade, `..`, leere, versteckte oder reservierte Namen und das Präfix `update-proof-` sind ausgeschlossen. Vor dem Schreiben prüft der Updater GitHub-Prüfsumme, Release-Signatur, Versionsfolge, Manifest-Rechte, Pfade, Paketidentität (Repository, Kanal, Commit, Kandidatentag, Version), Dateiprüfsummen und Manifest-/Modulverweise. Bei einem Fehler weicht er nicht auf andere Dateien aus. ZIP und `update.json` stammen aus demselben geprüften Ordner.

## Unterbrochene Updates wiederherstellen

Vor dem Schreiben werden Ausgangs-/Zielidentität, betroffene Dateien und ein geprüftes Backup in einem dauerhaften IndexedDB-Journal gespeichert und zurückgelesen. Das Manifest wird zuletzt geschrieben. Nach Installation und Rücksicherung werden alle Dateien byteweise per SHA-256 geprüft; erst danach gilt der Vorgang als abgeschlossen. Das letzte abgeschlossene Backup bleibt für **Vorherige Version wiederherstellen** erhalten.

Ein offenes Journal (etwa nach Browserabsturz) sperrt neue Installationen und die normale Nutzung. **Einstellungen → Erweitert → Updates → Unterbrochenes Update wiederherstellen** stellt den gesicherten Ausgangsstand wieder her; der Klick kann bei erneuter Unterbrechung wiederholt werden. Die Recovery prüft den gespeicherten Ordnerbezug und eine neue Prüfdatei der tatsächlich geladenen Erweiterung. Neue Dateien des abgebrochenen Updates werden entfernt, fremde Dateien bleiben erhalten.

Unbekannte, beschädigte oder ungültige Journal-/Backupdaten werden nie ungeprüft verwendet; sie sperren wie ein offenes Journal Updates und normale Nutzung. **Installation prüfen** vergleicht den geladenen Ordner vollständig mit dem exakt passenden veröffentlichten Paket (Kanal, Version, Commit, Kandidatentag) und hebt die Sperre erst nach Erfolg auf; die alten Daten werden lokal archiviert. Dafür sind Internet und Zugriff auf die öffentlichen Releases nötig. Dieser Klick installiert nichts.

### Externer ZIP-Weg, auch ohne startfähige Erweiterung

Ein Journal macht das Überschreiben eines entpackten Ordners nicht atomar. Startet die Erweiterung nicht mehr:

1. Unter `chrome://extensions` bei der Installation **Details** öffnen, Erweiterungs-ID und geladenen Ordnerpfad notieren und die Erweiterung deaktivieren. **Nicht entfernen**: Darin liegen Einstellungen, Journal und Backup.
2. Im [Releasebereich](https://github.com/mikastudhhn/chrome-extension-video/releases) die ZIP des gewünschten Releases und die `.sha256`-Datei laden und die Prüfsumme vergleichen (macOS: `shasum -a 256 video-sync-….zip`). Nie GitHubs „Source code“-Archiv verwenden.
3. Die ZIP außerhalb des Installationsordners entpacken und eine Kopie des bisherigen Ordners sichern.
4. Alle Dateien aus `video-sync/extension` in den bestehenden Ordner kopieren und vorhandene Dateien ersetzen. Enthält das bisherige Manifest einen `key`, diesen im neuen Manifest unverändert erhalten.
5. Die **vorhandene** Erweiterung wieder aktivieren bzw. **Neu laden**. ID und Pfad müssen gleich bleiben.
6. **Einstellungen → Erweitert → Updates → Installation prüfen** ausführen, gegebenenfalls zuvor unter **Installationsordner → Ändern** den geladenen Ordner wählen.

Chrome- und Dateisystemberechtigungen bleiben erforderlich. Betriebssystem- oder Datenträgerausfälle werden nicht abgefangen.

## Lokale Entwicklung

`npm run dev` erzeugt `dist/development/extension` als **Video Sync · Dev**. Release-Updates überschreiben diesen Ordner und den Quellordner `extension/` nie. Details: [development.md](development.md). Veröffentlichung und Stable-Freigabe: [release-workflow.md](release-workflow.md).
