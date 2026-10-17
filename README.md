# Video Sync 0.6.0

Chromium-Extension für **genau zwei Personen**, die ihre eigenen Videoquellen auf dieselbe Szene ausrichten und anschließend gemeinsam steuern. Kein Video- oder Audiotransport: Nur Positionen, Zustände und Befehle laufen über einen gemeinsamen HTTPS-Server.

## Updates und lokaler Arbeitsbranch

Der Quellcode liegt auf [GitHub](https://github.com/mikastudhhn/chrome-extension-video) und steht unter der [MIT-Lizenz](LICENSE). Freunde laden die ZIP unter Releases und wählen beim ersten Update den installierten Ordner aus; für die öffentlichen Releases ist kein GitHub-Zugang nötig. Der integrierte Updater prüft den gewählten Kanal alle 30 Minuten und beim Öffnen des Popups und installiert erst nach **Jetzt aktualisieren**. Einrichtung und Grenzen: [docs/updates.md](docs/updates.md).

`npm run dev` startet den lokalen Entwicklungshelfer. Einmal `dist/development/extension` als **Video Sync · Dev** in Chrome laden; danach genügt der Startbefehl. Bei laufendem Helfer erscheint dort **Dev · ft/mein-branch** zusätzlich zu Stable und Experimental. Im Dev-Kanal werden gültige Datei- und Branchänderungen automatisch aktiviert, auch ohne Commit. **Auto-Reload pausieren** hält den geladenen Stand fest. Bei Buildfehlern bleibt der letzte funktionierende Stand erhalten. Weitergegebene ZIPs zeigen ausschließlich Stable und Experimental und verbinden sich nie mit dem Helfer. Details: [Lokale Entwicklung](docs/development.md).

## Stable oder Experimental auswählen

Unter **Zahnrad → Version** zwischen **Stable** und **Experimental** wählen. Die Auswahl bestimmt, welchen Releases der integrierte Updater folgt: Stable den freigegebenen Versionen, Experimental den Kandidaten aus Main. Stable ist voreingestellt. Jedes Paket enthält genau eine Laufzeit; ein Wechsel trennt weder Raum noch Video. Experimentelle Funktionen kommen mit dem installierten Experimental-Paket.

Das Experimental-Paket bietet einen **achtsekündigen Tontest** als ersten Schritt zur automatischen Szenenausrichtung. Video verbinden, im Originalplayer abspielen, Popup dort erneut öffnen und unter **Einstellungen → Tonzugriff testen → Tontest starten** wählen. Der Browser fragt optional nach Tab-Tonzugriff. Keine Tonaufnahme wird gespeichert oder übertragen. Der Test benötigt keinen Raum und keinen Server und endet selbstständig, auch bei geschlossenem Popup.

Diese Version erkennt noch keine Szenen automatisch. Ob Netflix, Prime Video oder HBO Max Tonproben bereitstellen, muss je Anbieter und Browser praktisch geprüft werden. Ein positives Ergebnis belegt noch keine Szenenerkennung. Ablauf: [docs/experimental-test.md](docs/experimental-test.md).

Die Entwicklung erfolgt auf PR-Arbeitsbranches, die nach Prüfung in `main` integriert werden. Main veröffentlicht versionierte Experimental-Kandidaten. Stable übernimmt nach ausdrücklicher Abnahme ein bereits gebautes Kandidatenpaket; Main darf inzwischen weiterentwickelt sein. Einrichtung und Befehle: [docs/release-workflow.md](docs/release-workflow.md).

## Einmal freigeben, eingebettete Player automatisch verbinden

Beim ersten Start führt das Popup in sechs Schritten durch die Einrichtung: Website-Freigabe, Verbindungsserver (mit Erreichbarkeitsprüfung), optionaler GitHub-Zugang für Updates, Erscheinungsbild und Version. Jeder Schritt ist überspringbar; nach dem nativen Chrome-Dialog geht es beim erneuten Öffnen an derselben Stelle weiter. **Einstellungen → Erweitert → Einrichtung erneut öffnen** startet sie später noch einmal.

1. Extension laden bzw. aktualisieren und im eigenen Video-Tab öffnen.
2. **Erlauben & verbinden** klicken und den Chrome-Dialog für alle Websites bestätigen.
3. Die Freigabe gilt anschließend auch für neue und verschachtelte iframe-Player sowie den Verbindungsserver. Keine weiteren Freigaben pro Player-Domain. Beim Öffnen des Popups verbindet die Extension das Video im aktuellen Tab automatisch, wenn noch keines verbunden ist.
4. Eine Person erstellt einen Raum und wählt **Einladung kopieren**. Die zweite fügt die Einladung ein und klickt **Beitreten**; Code und Serveradresse werden gemeinsam übernommen. Beide stellen ihr Video auf dieselbe Szene und wählen **Diese Szene bestätigen**. Anschließend **Abspielen**.

Das Popup zeigt jeweils den nächsten Schritt. Nach dem Verbinden verschwinden die Einrichtungshinweise. Während der Wiedergabe stehen Play/Pause und Spulen im Vordergrund; ein Klick auf den **Videotitel ↗** führt zurück zum Originalplayer. **Anderes Video verbinden** bleibt als zurückhaltende Aktion unter der Steuerung erreichbar. Video- und Partnerstatus bleiben auch beim Einladen sichtbar. Das **Zahnrad** oben rechts öffnet eine eigene Einstellungsseite mit Serverangaben, erneuter Einladung, erneutem Ausrichten und Verlassen. Der Zurück-Pfeil führt wieder zur Steuerung. Die Serveradresse wird mit **Speichern** geprüft und dauerhaft übernommen. **Verwerfen** setzt den Entwurf zurück; ein ungespeicherter Entwurf ändert den Server neuer Räume nicht. Ein reiner Raumcode verwendet die gespeicherte Serveradresse.

Chrome speichert diese Website-Freigabe bis zum Widerruf bzw. einer Neuinstallation. Sie ersetzt keine Browser-/Betriebssystemregeln: Autoplay kann einmaliges Play im Video verlangen. Die App benötigt weder Kamera- noch Mikrofonzugriff. Die breite Freigabe bedeutet Zugriff auf HTTP-/HTTPS-Websites; die Extension untersucht und steuert weiterhin nur den ausdrücklich im Popup ausgewählten Tab.

Wer die breite Freigabe nicht erteilt, kann weiterhin einzelne Player-Domains freigeben. Nach Neuladen eines Player-Dokuments wird die alte Ausrichtung verworfen. Popup öffnen verbindet das neue Video bei vorhandener breiter Freigabe; beide müssen es erneut ausrichten. Ein unbekannter neuer Film startet nicht automatisch.

## Stabile Verbindung

Die Steuerdaten laufen über einen HTTPS-Relay. Ein dedizierter Worker hält die Verbindung bei geschlossenem Popup aktiv. Fehlgeschlagene Abfragen und Sendungen werden automatisch mit Rückoff wiederholt. Fortlaufende Nummern verhindern doppelt ausgeführte Befehle. Veraltete Messwerte werden zusammengefasst und verworfen.

Fehlen aktuelle Verbindungsdaten, pausieren beide Videos. Der Raum und die Szenenpositionen bleiben bei kurzen Ausfällen erhalten; bei einer erkannten Unterbrechung nach Wiederverbindung mit Play fortsetzen. Verwaiste Räume enden nach fünf Minuten, gesunde Sitzungen haben kein Stundenlimit. Serverneustart, Browserneustart/Extension-Neuladen und ausdrückliches Verlassen erfordern einen neuen Raum.

**Beide Personen verwenden Video Sync 0.6.0 oder neuer mit einem Server derselben Version (Relay-Protokoll 3).** Ältere Versionen erhalten beim Erstellen oder Beitreten den Hinweis, Server und Extension zu aktualisieren; Details: [docs/protocol.md](docs/protocol.md).

## Lokal starten

Node.js ab 22.13; keine npm-Abhängigkeiten für den Betrieb:

```sh
npm start
```

Der normale lokale Verbindungsserver läuft unter `http://localhost:8787` und muss während der Nutzung weiterlaufen. `npm run manual-test` startet dagegen einen eigenen temporären Server auf einem anderen Port, der beim Schließen beider Testbrowser endet. Ein funktionierender Testbrowser bedeutet deshalb nicht, dass der normale Server auf Port 8787 läuft.

Scheitert **Raum erstellen** oder **Beitreten**, bleibt das Popup bei der Aktion und nennt einen passenden nächsten Schritt. Bei Verbindungsproblemen wird der Button zu **Erneut versuchen**; **Serveradresse ändern** öffnet die Einstellungen erst auf ausdrücklichen Klick. Fehlermeldungen verschwinden beim Schließen, Navigieren, Bearbeiten oder erfolgreichen Wiederholen. Eine abgelaufene Einladung wird von einem nicht erreichbaren Server unterschieden. Gesonderte Sitzungshinweise lassen sich schließen, ohne spätere neue Fehler zu unterdrücken.

1. `chrome://extensions` öffnen, Entwicklermodus aktivieren, **Entpackte Erweiterung laden** und den Ordner `extension` wählen.
2. Für den Zweipersonentest zwei getrennte Browserprofile verwenden. Zwei normale Tabs desselben Profils teilen eine Sitzung.
3. Beide öffnen `http://localhost:8787`. Eine Person verwendet Version A, die andere Version B.
4. A auf **00:05**, B auf **00:10** stellen; beide zeigen dieselbe Szene. Jeweils bereit bestätigen.

Play, Pause und Spulen funktionieren im Popup und im Player. **Zahnrad → Szene neu ausrichten** pausiert beide, löscht die Bestätigungen und führt zurück zur Szenenauswahl. **Raum verlassen** beendet den Raum für beide. Lokal gewählte Videos werden nicht hochgeladen.

Eine Pause direkt im Originalplayer bleibt sofort auf dem gewählten Bild stehen. Ältere Synchronisationsdaten dürfen lokale Bedienaktionen nicht rückgängig machen, während deren Bestätigung unterwegs ist. Auch bei schnellem Play/Pause-Wechsel zählt die letzte lokale Aktion; Verbindungsverlust pausiert weiterhin beide Videos.

Play, Vor-/Zurückspulen und Ziehen auf der Zeitleiste behalten auch nach der Bestätigung die lokal gewählte Position einschließlich der inzwischen weitergelaufenen Wiedergabe. Kurze Ladezustände beim Spulen lösen keine zusätzliche gemeinsame Pause aus; ab 500 ms anhaltendem Nachladen wird die Ladepause gemeldet. Die Popup-Schaltflächen reagieren ebenfalls lokal: Mehrere schnelle Zehnsekunden-Sprünge werden in Reihenfolge addiert, statt sich auf eine alte Position zu beziehen.

## Dauerhafter Server und Weitergabe

Empfohlener Aufbau: kleiner dauerhaft laufender VPS in Europa, HTTPS direkt auf der festen IP-Adresse (keine Domain nötig), Docker und Caddy. Konkrete Mietempfehlung, recherchierte Preise, fertige Deployment-Dateien und Vierstunden-Abnahme: **[docs/hosting.md](docs/hosting.md)**.

```sh
npm run package -- https://euer-verbindungsserver.example
```

Unter `dist/` entstehen ZIP, Prüfsumme, `update.json`, Installationsanleitung und ein Installationsprompt. Der Empfänger benötigt weder Node.js noch einen eigenen Server. Veröffentlichte Versionen installiert der integrierte Updater; manuell die Dateien im bisherigen Erweiterungsordner ersetzen und unter `chrome://extensions` **Neu laden** klicken. Gespeicherte Website-Freigaben bleiben beim Update derselben Installation erhalten. Eine zuvor gespeicherte Serveradresse bleibt ebenfalls erhalten; beim Umzug auf den VPS im Popup ändern.

Ein lokales Paket mit `localhost` funktioniert nur auf demselben Rechner.

## Player und Grenzen

- Geladene HTML5-Videos im Hauptdokument, sichtbaren verschachtelten iframes und offenen Shadow Roots. Mehrere plausible Videos erfordern eine Auswahl. Fähigkeiten und Grenzen: [Player-Kompatibilität](docs/player-compatibility.md).
- Der Netflix-Adapter verwendet eine private Schnittstelle; Anbieter sind mit dieser Version noch nicht praktisch abgenommen.
- Chrome mindestens 116. Andere Chromium-Browser benötigen eigene Funktionstests.
- Ein konstanter manuell bestimmter Zeitversatz bleibt erhalten. Bei unterschiedlichen Schnitten, Werbung und Medienwechsel neu ausrichten.
- Nachladen pausiert beide. Eine manuelle Pause verhindert automatische Wiederaufnahme nach dem Nachladen.
- Ein VPS verbessert die Erreichbarkeit der Steuerverbindung, nicht das Streamingangebot oder das WLAN der Teilnehmer.

## Aufbau

```text
Popup → Service Worker → ausgewähltes Player-Dokument
                    ↘ Offscreen-Dokument → Verbindungs-Worker
                                              ↕ HTTPS
                                         Relay-Server
                                              ↕ HTTPS
                                         zweite Extension
```

`player.js` steuert HTML5/Netflix, `player-frames.js` erkennt sichtbare eingebettete Player, `timeline.js` ordnet gemeinsame Befehle und erhält den Zeitversatz. `offscreen.js` verwaltet Sitzung und Playerabgleich; `connection-worker.js` und `signaling.js` übertragen geordnete HTTPS-Befehle. `server/` verwaltet feste Zweipersonenräume und begrenzte Ereigniswarteschlangen im RAM. Raumtokens gelangen nicht in Videoseiten.

## Direkt auf einem Rechner ausprobieren

```sh
npm run manual-test
```

Mit installiertem Playwright/Chromium öffnet das zwei sichtbare, getrennte Browserprofile und startet einen eigenen lokalen Server. Standardmäßig lädt jeder Start eine temporäre Kopie des ausgecheckten `extension/`-Ordners mit dem Paketprofil Stable; beide Profile sind bereits in einem Raum, auf Video A bei 00:05 und Video B bei 00:10 ausgerichtet und pausiert. `TEST_CHANNEL=experimental` verwendet das Experimental-Profil, `TEST_EXTENSION=…/video-sync/extension` ein entpacktes Release-Paket. Ansichten, frische Ersteinrichtung und Browserpfade: [Lokale Entwicklung](docs/development.md#manuelle-zweipersonentests).

Zum Beenden beide Testfenster schließen; der eigene Server wird automatisch beendet. Die einmalige breite Freigabe im nativen Chrome-Dialog und das Verbinden eigener Streamingseiten sind separate manuelle Schritte.

## Prüfen

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm test
npm run check
npm run test:browser
```

Der Browserstarter baut beide Kandidatenprofile, prüft die exakten ZIP-/Update-Dateien
und führt Kern-, iframe-, UX-, native Popup-, Update-, Kanal-, Fehler- und Dev-Fälle
seriell mit eigenen Servern und Profilen aus; CI verteilt sie auf parallele
Gruppen (`--group=`). Lokale Browserpfade aus der Git-
Konfiguration werden berücksichtigt. Für den Tontest ist ffmpeg nötig; auf Linux
ohne Desktop zusätzlich Xvfb. Fehlerbelege liegen unter `test-results/browser-*/`.

Matrix, gezielte Diagnoseläufe, CI und Grenzen: [Browser-Gate](docs/browser-tests.md).
Ein mehrstündiger Transporttest bleibt separat:
`TEST_SERVER=https://euer-server.example SOAK_SECONDS=14400 npm run soak`.

Gestaltung, Tokens und Komponenten: [docs/design-system.md](docs/design-system.md); Komponentengalerie unter `demo/styleguide.html`. Qualitätswerkzeuge und portable Demoerzeugung: [docs/development.md](docs/development.md#prüfungen). Relay-Protokoll: [docs/protocol.md](docs/protocol.md). Änderungen: [CHANGELOG.md](CHANGELOG.md).

Analyse und Recherche zur automatischen Szenenausrichtung: [docs/automatic-alignment.md](docs/automatic-alignment.md).
