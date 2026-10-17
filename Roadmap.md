# Video Sync – Roadmap

## Technische Qualität – vor den großen Erweiterungen

Grobe Code-Sichtung: Testbare Bausteine wie `Timeline`, `Rooms` und der Transport sind vorhanden. Darauf schrittweise aufbauen; Klassen dort einsetzen, wo sie zusammengehörigen Zustand verständlich kapseln.

- **Zuständigkeiten & Lesbarkeit:** Darstellung, Servereinstellung, Offscreen-Start, Raumsitzung, Playerbindung und Statusfeed besitzen eigene Module; Abbruch und Lebenszyklusübergänge sind modelliert.
- **Verträge & automatische Codeprüfung – teilweise umgesetzt:** `protocol.js` enthält gemeinsame Laufzeitvalidierung, Rollenrechte und Capability-Abgleich; `runtime-errors.js` enthält strukturierte Fehlercodes. Gezieltes JSDoc/checkJs, fehlerorientiertes Linting, ein begrenzter Formatter-Check und Paket-/Ressourcenvalidierung sind vorhanden. Die vollständige Typisierung der Anwendung bleibt ausstehend; [Prüfumfang](docs/development.md#prüfungen).
- **Doppelte Helfer zusammenführen:** Doppelte Anfrage-/Retry-Helfer prüfen.
- **Regressionen früher erkennen:** Der gemeinsame CI-Starter prüft Kern-, iframe-, Discovery-, UX-, native Popup-, Update-, Recovery-, Diagnose-, Kanal-, Fehler- und Dev-Suites gegen die einmal gebauten Kandidatenpakete ([Browser-Gate](docs/browser-tests.md)).
- **Browser-Lebenszyklus – praktische Grenzen offen:** Abbruch-, Generations- und Idle-Verträge sind vorhanden. Gemeinsame Browserfälle stehen bereit; OS-Schlaf, echter Berechtigungsentzug und Langzeitverhalten bleiben praktisch zu belegen. [Chrome: Worker-Lebenszyklus](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- **Updates unabhängig von der Oberfläche – Hintergrundinstallation vorhanden:** Der Background startet den Installationslauf; Schließen der Updateansicht beendet ihn nicht. Ein dauerhaftes Transaktionsjournal, ein geschütztes Backup und geprüfte Wiederherstellung sind vorhanden. Reale Browser-/IDB-Grenzen und native Ordnerfreigabe sind im finalen Browser-/Praxisbericht getrennt nachzuweisen.
- **Streaming-Adapter abgrenzen:** Auswahl, Sichtbarkeit, offene Shadow Roots und dokumentierte Adapterfähigkeiten sind vorhanden. Netflix nutzt weiterhin eine private Schnittstelle. Reale Anbieter und zusätzliche Lebenszyklusfälle bleiben praktisch zu prüfen; [Fähigkeiten und Grenzen](docs/player-compatibility.md).
- **Fehler & Feedback – strukturierte Fehler vorhanden:** Fehlercodes bleiben über Transport, Worker/Runtime und UI hinweg erhalten; dazu kommt eine lokale begrenzte Diagnose mit gefiltertem Export und Löschung; Tokens und Raumzugangsdaten gehören nicht in den Export.

## Nach 0.6.0 – verschobene Punkte aus der Code-Prüfung

- **Server: Zugang nur auf Einladung:** Einladungscodes, Geräteschlüssel, Personen entfernen und Admin-Oberfläche direkt auf dem Server (SQLite über `node:sqlite`), mit eigener Datensicherung.
- **Struktur:** Erweiterung in Ordner aufteilen (`background/`, `offscreen/`, `player/`, `ui/`, `updater/`, `shared/`); der Server importiert nur noch aus `shared/`.
- **Nachrichtenvertrag:** Alle internen Nachrichten an einer Stelle beschreiben und den Background über eine Handler-Tabelle statt einer langen if-Kette verteilen.
- **Typprüfung und Formatierung:** `checkJs` schrittweise für `extension/` und `server/` einschalten; einmal das ganze Repository mit Prettier formatieren und den Check für alle Dateien erzwingen.
- **Server-Routing:** Kleine Tabelle aus Methode und Pfad mit Bausteinen für Rate-Limit, JSON und Authentifizierung als Grundlage für Auth und Admin-Oberfläche.
- **Synchronisation:** Zeitstempel im Sync-Befehl für Latenzausgleich; Spielerantworten der Seite schon in `player-binding.js` auf die erlaubten Felder kürzen.
- **Server-Härtung:** Tröpfelnde Request-Bodies hinter Caddy schneller schließen; Sperre für fehlgeschlagene Beitritte so gestalten, dass wenige Angreifer echte Beitritte nicht blockieren.
- **Updates:** Browser-Szenario für die Bestätigung neuer Rechte; Stable-Tags mit Build-Nummer, damit Stable-Downgrades schon bei der Prüfung erkannt werden.

## 1. Oberfläche vereinheitlichen

- **Gemeinsame Gestaltung – integriert:** Typografie, Farben, Abstände, Fokus und Zustände für Popup und Updates sind vereinheitlicht. Icons sind aktiviert; echte Screenshot-/Tastatur-/Zoomabnahme folgt im finalen Browserfenster.
- **Popup & Einstellungen – Integration vorhanden:** Updates sind als Unterseite im Popup erreichbar; die separate Update-Seite bleibt verfügbar. Informationshierarchie, Zugangseinrichtung, explizites Speichern der Serveradresse und Fokusführung sind integriert; praktische Prüfung offen.
- **Update-Banner:** Gestaltung verbessern. Ganz rechts der Download-Button, direkt links daneben ein ↗-Button zu den Versionsdetails bzw. Release Notes.
- **Farbthemen:** Drei bis vier ausgewählte Themes anbieten; später eigene Themes hinzufügen können.

## 2. Kompatibilität & gemeinsames Erlebnis

- **Client-/Server-Kompatibilität:** Protokollversion und Capabilities werden beim Verbinden abgeglichen; inkompatible Versionen erhalten eine Aufforderung zum Aktualisieren. Offen: bei eingeschränkter Kompatibilität nur gemeinsam unterstützte Funktionen anbieten und im Hinweis Client-/Server-Version und Grund nennen.
- **Emoji-Reaktionen:** Emojis über eine Auswahl verschicken und kurz als Overlay auf dem eigenen Bildschirm sowie bei allen anderen Teilnehmenden anzeigen.
- **Mehrere Personen:** Räume für mehr als zwei Personen ermöglichen. Gemeinsame Steuerung, Bereitschaft, Nachladen sowie Beitritt und Verlassen für Gruppen definieren.

## 3. Große Vorhaben & Experimente

- **Automatische Szenenausrichtung (Autosync):** Für Netflix, Disney+, HBO Max und weitere Streamingdienste untersuchen und erproben, wie sich dieselbe Szene schnell und zuverlässig finden lässt. Ziel: Nach dem Gruppenbeitritt möglichst automatisch im Hintergrund ausrichten, höchstens mit einem zusätzlichen Klick. Machbarkeit und Aufwand je Anbieter prüfen; manuelles Ausrichten bleibt als Rückfalloption.
- **Gemeinsam zur nächsten Folge:** Wenn eine Person „Nächste Folge“ wählt, sollen beide – später alle – automatisch zur passenden Folge wechseln, verbunden bleiben und erneut ausgerichtet werden. Anbietererkennung, Folgenzuordnung und Ladezustände erproben; auf den Erkenntnissen aus Autosync aufbauen.
