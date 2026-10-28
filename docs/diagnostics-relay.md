# Lokale Diagnose und Relay-Betrieb

## Diagnosevertrag

Die aktuelle Engine hält ausschließlich ausgewählte Diagnosefelder im RAM ihres
Offscreen-Dokuments: Phasen, Adapterkategorie, Verbindungsunterbrechungen, RTT und
Gründe für Pause/Neuausrichtung sowie bekannte Fehlercodes. Keine Rohmeldungen,
Tokens, Request-IDs, Raumcodes, Einladungen, URLs, Titel oder Medienkennungen.

Maximal 200 Ereignisse und 32 KiB Ereignis-JSON, höchstens 30 Minuten; RTT höchstens
alle zehn Sekunden. Die Retention entfernt Ereignisse auch ohne weitere Nutzung.
Export ist eine Kopie mit App-/Engine-/Protokollversion. Löschen entfernt den
Puffer sofort. Später tatsächlich eintretende Ereignisse werden neu erfasst.
Schließen/Ersetzen des Offscreen-Dokuments oder ein Browserneustart verliert den
Puffer. Es gibt weder Hintergrund-Upload noch persistente Speicherung.

Die Runtime-Aktionen `diagnostics-export` und `diagnostics-clear` sind für
vertrauenswürdige Erweiterungskontexte vorgesehen. Der Background erlaubt den
UI-Zugriff nur aus dem Popup. Im Popup unter Einstellungen →
Synchronisationsdiagnose stehen „Diagnose exportieren“ und „Diagnose löschen“.
Der native aufklappbare Abschnitt und die Buttons sind per Tastatur bedienbar;
Rückmeldungen werden lokal sichtbar und als höfliche Statusmeldung ausgegeben.
Export startet einen JSON-Download als `video-sync-diagnostics.json`; der Puffer
bleibt erhalten. Löschen entfernt den aktuellen Puffer, nicht zuvor heruntergeladene
Dateien. Neue Ereignisse können danach wieder hinzukommen.

## Wiederholbare Raumanfragen

`GET /health` liefert zusätzlich `roomRequests` (Version 1): eine an diesen
Serverprozess gebundene, signierte Freigabe, die 60 Sekunden gültig ist. Neue
Clients senden sie mit einer zufälligen ID im `roomRequest`-Feld des Create-/Join-
Handshakes; ein Server ohne diese Freigabe gilt als inkompatibel. Bei verlorenem HTTP-Ergebnis senden sie exakt denselben Handshake
höchstens dreimal, mit vier Sekunden Timeout je POST. Keine neue Freigabe oder
ID während eines unklaren Versuchs. Auch ein vorgeschalteter Proxy kann nach
Verarbeitung eine 502-Antwort liefern; dieser Fall ist abgedeckt.

Der Server speichert höchstens 2.000 erfolgreiche Ergebnisse bis zum Ablauf der
Freigabe. Eine Wiederholung liefert denselben Platz, erzeugt kein weiteres
Beitrittsereignis und muss zur ursprünglichen Operation passen. Ein voller Cache
lehnt neue IDs vor jeder Raummutation ab; gültige Ergebnisse werden niemals
vorzeitig verdrängt. Erfolgreich gespeicherte, gültige Replays verbrauchen nicht
das gemeinsame IP-Neuanfragebudget (30/Minute). Jede gespeicherte Anfrage erlaubt
höchstens zehn Replays innerhalb ihrer Freigabe; Neuanfragen und abgewiesene
Handshakes bleiben am IP-Budget begrenzt. Create und Join sind ausdrücklich am
30.-POST-NAT-Grenzfall mit verlorener Antwort geprüft. Abgelaufene Freigaben, Prozessneustarts und bereits beendete
Räume scheitern ausdrücklich. Aufräumen erfolgt alle 15 Sekunden und bei neuen
Anfragen. Diese zeitlich beschränkte Garantie ist keine persistente Exactly-once-
Garantie über Serverneustarts hinweg: Nach Neustart wird der alte Versuch abgelehnt.

Fachliche
Fehler und bekannte Überlast-/Shutdown-Antworten werden nicht automatisch
wiederholt. Nach einem zuvor unklaren POST bleibt auch bei einer späteren
Admission-Ablehnung der Zustand ausdrücklich unklar, bis ein Mitgliedschaftsergebnis
wiederhergestellt ist. Die Wiederholung authentifizierter Relay-Batches bleibt unabhängig.

## Lokaler Betrieb

Der Server stellt im Prozess `server.operatingSnapshot()` bereit, ohne neuen
HTTP-Metrikendpunkt. Es enthält nur feste Zähler/Gruppen: aktive Räume/Mitglieder,
laufende und abgeschlossene Anfragen, Abbrüche, Statusgruppen, Gesamtlatenz/Maximum,
Idempotenz- und Batchwiederholungen, Raum-Schließgründe, erstellte/beigetretene
Räume, Raumdauer, Zustellverzögerung, API-Latenz, Fehlercodes, Routenklassen und
Extension-Builds. HTTP-Latenz umfasst bei Long Polls die absichtliche Wartezeit und
ist deshalb keine reine Netzwerklatenz; die API-Latenz zählt Polls nicht mit.
Die Zähler beginnen nach Prozessneustart bei null. SIGTERM/SIGINT schreiben einen
aggregierten Abschlussbericht. Mit `DATA_DIR` werden Tagessummen und ein
begrenztes technisches Fehlerprotokoll gespeichert (`docs/hosting.md`, Abschnitt
„Überwachung und Statistik“); ohne `DATA_DIR` (lokal, Tests) bleibt alles im Speicher.

Begrenzungen: 500 Räume, 2.000 Idempotenz-Ergebnisse, 5.000 Rate-Limit-Einträge,
2.048 gleichzeitig laufende HTTP-Anfragen sowie die vorhandenen Body-/Queue-
Limits. Rate-Limit-Einträge werden nach Ablauf freigegeben. Ablehnung mit 429/503
verändert keine bestehenden Räume. `TRUST_PROXY=1` setzt weiterhin einen korrekt
konfigurierten vertrauenswürdigen Proxy voraus.

Beim Herunterfahren nimmt der Server keine neue Arbeit an, schließt Räume,
weckt Long Polls und lässt laufende Antworten auslaufen. Nach spätestens fünf
Sekunden werden verbleibende Sockets geschlossen. Nach Neustart benötigen beide
Personen einen neuen Raum. Es gibt keinen Redis-/Clusterbetrieb. Den externen
Verfügbarkeitsmonitor beschreibt `docs/hosting.md`.

## Nachweise und Grenzen

Node-Tests prüfen echte HTTP-Antwortverluste, parallele Join-Wiederholungen,
inkompatible Clients/Server, Ablauf/Neustart/Konflikte/Kapazität, Queue-/Request-Last,
Erholung, offene Long Polls, langsame POSTs und SIGTERM. Diagnose-Tests prüfen
Feldfilterung, Grenzen, Retention, Löschen und echte Offscreen-Routen/Hooks.

Automatisierte Tests ersetzen keine praktischen Anbieter-/DRM-, Zwei-Geräte-, OS-Sleep- oder
mehrstündigen Browsernachweise und keine Stable-Abnahme.

## UI-Vertrag

- DOM: `diagnostics-panel` (details), `diagnostics-summary` (summary),
  `diagnostics-export` / `diagnostics-clear` (button), `diagnostics-retention`,
  `diagnostics-privacy`, `diagnostics-availability`, `diagnostics-feedback` (role=status).
- `mountDiagnostics(root, { request, download? })` aus `diagnostics-view.js` bindet
  native Click-Aktivierung; `update(status, actionPending=false)` aktualisiert
  Verfügbarkeit über `diagnosticsAvailable === true`, Kanal und Sperrstatus.
  Nicht durch `act()` des allgemeinen Popup-Sitzungsstatus routen: Diagnoseantworten
  sind Berichte/Bestätigungen, kein neuer Sitzungsstatus.
- Runtime-Aktionen: `{ target: 'background', type: 'ui', action: 'diagnostics-export' }`
  bzw. `diagnostics-clear`. Kein Session-/Player-/Raumobjekt als Argument.
- Erfolgsantwort nach normalem Runtime-Envelope `{ ok:true, result }`: Export
  liefert Schema 1 (unten), Löschen `{ cleared:true }`. Fehler nutzen den bestehenden
  Runtime-Fehlervertrag. Im UI werden rohe Fehlermeldungen nicht ausgegeben.
- Kein neuer Hintergrund-Poll und kein automatischer Export; die Aktionen laufen
  nur nach Aktivierung des jeweiligen Buttons. Laufende Aktionen ignorieren
  Mehrfachaktivierung und verwerfen verspätete Exporte nach erkanntem Kanalwechsel.

Schema 1 ist JSON mit `schema:1`, `storage:"session-memory"`,
`retentionMs:1800000`, optionalen geprüften `appVersion`/`engineVersion` und `protocol`
sowie `events`. Ereignisse enthalten ausschließlich:

| Feld | Werte |
| --- | --- |
| `at` | Unixzeit in Millisekunden |
| `kind` | phase, transport, pause, alignment, player, rtt, failure |
| `phase` | disconnected, connecting, aligning, synced, interrupted, ended |
| `reason` | network, player-timeout, player-changed, navigation, user, peer, reload, buffering |
| `adapter` | html5, netflix |
| `lane` | send, receive, open |
| `reconnecting` | Boolean |
| `rttMs` | Gerundete Millisekunden, 0 bis 59999 |
| `code` | Ausschließlich bekannte Codes aus runtime-errors.js |

Nur `at`/`kind` sind an jedem Ereignis vorhanden, weitere Felder sind optional.
Die Größenbegrenzung gilt für das kompakte Ereignis-JSON, nicht für Einrückung und
Metadaten der Exportdatei. `serializeDiagnosticReport` wählt die erlaubten Felder
am Dateirand erneut aus. Keine Instance-/Generation-/Player-/Binding-/Media-ID,
Raumkennung oder Request-ID wird ins Format aufgenommen. Schemaänderungen müssen
explizit versioniert werden.

## Browserfälle

`scripts/e2e-diagnostics.js` läuft in der gemeinsamen Matrix als
`diagnostics-stable-candidate` und `diagnostics-experimental-candidate` und verwendet
ausschließlich vom Starter vorgegebene Kandidaten, Kanal, Evidenzordner und
temporären Relay (Port 8787 ausgeschlossen). Geprüft werden echte Downloads mit
JSON-Prüfung, sichtbares Löschen, Enter/Space/Tab, Fehlerdarstellung, Forced Colors,
ein als Fixture gekennzeichnetes 200-%-CSS-Zoom-Szenario sowie nativer Popup-Input,
Screenshot und Größenprüfung. Eine echte Browserzoom-Abnahme wird damit nicht
behauptet. Datei- und Runtime-Retention bleiben zusätzlich deterministisch in Node
geprüft; der Browserfall validiert das Alter exportierter Ereignisse.
