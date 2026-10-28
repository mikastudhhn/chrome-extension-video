# Dauerbetrieb für eine kleine Gruppe

Recherche- und Planungsstand: 16. Oktober 2026. Ausgelegt auf etwa sechs Personen gleichzeitig in mehreren Zweipersonenräumen, überwiegend in Deutschland/Mitteleuropa. Preise vor der Bestellung im Warenkorb prüfen.

## Empfehlung

**netcup VPS 500 G12.5, Laufzeit 1 Monat, Standort „Keine Präferenz Europa“, IPv4 + IPv6, Ubuntu 24.04 LTS: 9,50 €/Monat inklusive 19 % MwSt., keine Einrichtungsgebühr.** 2 vCores (geteilt), 4 GB RAM, 64 GB SSD. Der Relay braucht davon nur einen Bruchteil; mehrere gleichzeitige Räume sind kein Engpass. Kündigung mit einem Monat Frist zum Monatsende. Nach erfolgreicher Abnahme ist die 12-Monats-Laufzeit günstiger (8,26 €/Monat), verlängert sich aber nicht monatlich kündbar. Ein fester Standort (z. B. Nürnberg) kostet 1,04 €/Monat mehr und bringt für die kleinen Steuerdaten keinen spürbaren Vorteil.

Einschränkungen: Für VPS gelten laut AGB 99,6 % Jahresverfügbarkeit, keine 99,9-%-Zusage. netcup sichert keine Kundendaten; eigene Backups sind spätestens mit dauerhaft gespeicherten Daten nötig. Support zu Bürozeiten. Server werden im Kundenbereich bestellt, nicht per API. Quellen: [VPS-Übersicht](https://www.netcup.com/de/server/vps), [VPS 500 G12.5](https://www.netcup.com/de/server/vps/vps-500-g12-12m), [AGB](https://www.netcup.com/de/agb).

Hetzner Cloud ist die Alternative mit stundengenauer Abrechnung und API. Nach den Preisanpassungen 2026 waren die günstigen CX-/CAX-Tarife zuletzt nicht bestellbar; der kleinste bestellbare Tarif CPX12 kostet 11,99 € netto (rund 14,27 € brutto). Den Server nur abends laufen zu lassen spart wenig: Hetzner berechnet auch ausgeschaltete Server, er müsste täglich gelöscht und aus einem Snapshot neu erstellt werden, und Räume enden beim Löschen. Quelle: [Hetzner Preisanpassung](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/).

Kostenlose Angebote mit Schlafmodus (Render, Fly.io) oder rückforderbaren Instanzen passen nicht: Long Polls und RAM-Räume brauchen einen durchgehend laufenden Prozess.

## HTTPS ohne Domain

Die Extension akzeptiert außer `localhost` nur HTTPS-Server. Eine Domain ist dafür nicht nötig: Let's Encrypt stellt seit Januar 2026 öffentlich vertrauenswürdige Zertifikate für IP-Adressen aus, ausschließlich mit dem Profil `shortlived` (160 Stunden). `deploy/Caddyfile` setzt dafür ausdrücklich den ACME-Aussteller; ohne ihn würde Caddy IP-Adressen ein Zertifikat seiner internen CA geben, dem Browser nicht vertrauen. Browser senden für IP-Adressen keinen Servernamen (SNI); `default_sni` im Caddyfile wählt deshalb das IP-Zertifikat auch ohne SNI, sonst scheitert jeder TLS-Handshake. Caddy erneuert das Zertifikat automatisch lange vor Ablauf. Ein mehrtägiger Ausfall von Let's Encrypt kann es trotzdem ablaufen lassen. Nur IPv4 verwenden; IPv6-Zertifikate funktionieren in Caddy noch nicht zuverlässig. Dieselbe Konfiguration funktioniert auch mit einer Domain. Quellen: [Let's Encrypt: IP-Zertifikate](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html), [Caddy tls-Direktive](https://caddyserver.com/docs/caddyfile/directives/tls).

Die IP-Adresse bleibt für die Vertragsdauer fest. Bei einem Serverumzug ändert sich die Serveradresse: Einladungen enthalten sie, die Voreinstellung im Paket muss neu gebaut werden.

## Weshalb dieser Aufbau passt

Die App überträgt ausschließlich kleine Positions-, Zustands- und Steuerdaten. Netflix oder ein anderer Player liefert das Video weiterhin direkt an die jeweilige Person. Der neue HTTPS-Relay benötigt keinen TURN-Dienst, keine offenen Ports auf den Heimroutern und keine UDP-Erreichbarkeit zwischen den Teilnehmern.

Der Relay liefert neue Ereignisse per Long Poll sofort aus; die 20 Sekunden sind nur die maximale Wartezeit einer leeren Abfrage. Steuerdaten laufen über HTTPS-Port 443. Ein Web Worker im Offscreen-Dokument hält die Verbindung unabhängig vom Popup. Befehle werden geordnet übertragen und anhand fortlaufender Nummern bei Wiederholungen nur einmal zugestellt. Laufend erneuerte Messwerte werden zusammengefasst, sodass eine abwesende Person keinen ständig wachsenden Rückstau verursacht.

Bei einer Unterbrechung pausiert die Wiedergabe. Der Raum bleibt bei fehlender Aktivität eines Teilnehmers bis zu fünf Minuten bestehen; der Client versucht bis zu vier Minuten pro fehlgeschlagener Operation erneut zu verbinden. Nach erkannter Unterbrechung bleibt die Sitzung pausiert, bis jemand Play drückt. Szenenpositionen bleiben erhalten. Ein Raum endet spätestens nach 12 Stunden; eine nicht angenommene Einladung nach 30 Minuten. Pro Adresse sind höchstens drei Räume gleichzeitig offen. Alle Grenzen stehen in `docs/protocol.md`.

## Bereitstellen

Die Dateien `Dockerfile`, `deploy/compose.yaml`, `deploy/Caddyfile` und `deploy/.env.example` liegen fertig im Projekt. Docker Engine mit Compose-Plugin muss auf dem Server installiert sein ([Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Debian](https://docs.docker.com/engine/install/debian/)).

1. VPS mit Ubuntu 24.04 oder Debian 13 bestellen (netcup liefert das bestellte Image; der laufende Server nutzt Debian 13); öffentliche IPv4 beibehalten. Anmeldung nur per SSH-Schlüssel, Passwortanmeldung abschalten.
2. Firewall auf dem Server: TCP 80 und 443 freigeben, optional UDP 443 für HTTP/3. Port 80 wird für die Zertifikatsprüfung gebraucht. SSH 22 möglichst eingeschränkt. Port 8787 wird nicht öffentlich freigegeben.
3. Projektdateien auf den Server kopieren. Im Projektordner:

```sh
cp deploy/.env.example deploy/.env
# PUBLIC_ADDRESS (IPv4-Adresse oder Domain) in deploy/.env setzen.
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail https://203.0.113.10/health
```

`/health` muss `"ok":true` und `"protocol":3` liefern. Caddy beschafft und erneuert das öffentliche TLS-Zertifikat automatisch; die Zertifikate liegen in persistenten Docker-Volumes. Quellen: [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Reverse Proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

4. Auf dem Entwicklungsrechner das Paket mit der endgültigen Adresse erstellen:

```sh
npm run package -- https://203.0.113.10
```

5. Beide Extensions auf denselben ausdrücklich zum Test vorgesehenen Kandidaten aktualisieren und dessen Paketidentität protokollieren. Im Popup kontrollieren, dass beide die neue HTTPS-Adresse verwenden: Ein zuvor manuell gespeicherter Server bleibt beim Update erhalten. Einmal „Erlauben & verbinden“ klicken und den Chrome-Dialog bestätigen. Danach werden auch verschachtelte fremde Player ohne weitere Domain-Dialoge erkannt.

## Was für beständigen Betrieb nötig ist

- Server dauerhaft laufen lassen; keinen Laptop und keinen temporären Tunnel als Produktionsserver verwenden.
- `restart: unless-stopped` startet abgestürzte Prozesse und nach einem Hostneustart laufende Container wieder. Ein Docker-Healthcheck allein startet einen hängenden Prozess **nicht** neu. Ein externer Monitor prüft `/health` alle 15 Minuten und meldet Ausfälle (Abschnitt „Überwachung und Statistik“). Quelle: [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
- Updates und geplante Neustarts außerhalb gemeinsamer Sitzungen durchführen. Räume liegen im RAM: Ein Serverneustart erfordert einen neuen Raum und erneute Ausrichtung. Ein einzelner VPS hat keinen automatischen Ausfallschutz auf einen zweiten Server.
- Keine Skalierung auf mehrere App-Container hinter einem Load Balancer: Der Raumzustand ist lokal im einzelnen Prozess.
- Beide Rechner während der Sitzung wach halten. Router-, WLAN-, Strom- und Streaminganbieter-Ausfälle kann ein VPS nicht verhindern. Bei schwankendem WLAN zuerst Ethernet bzw. ein stabiles Netz verwenden.
- Für einen Neustart einen ruhigen Moment wählen: `docker compose --env-file deploy/.env -f deploy/compose.yaml kill -s SIGUSR2 app`, danach `docker compose … logs --tail 1 app` zeigt eine Zeile `"event":"status"` mit `activeRooms`/`joinedRooms` (ohne Adressen, Codes oder Tokens). Bei offenen Räumen schreibt der Relay diese Zeile zusätzlich alle fünf Minuten.
- Abwehr: Die Firewall begrenzt neue und offene Verbindungen je Adresse (`deploy/firewall.sh`). Caddy begrenzt Header-Lesezeit (5 s), Header-Größe (16 KB), Body-Lesezeit (10 s) und Body-Größe (16 KiB) und setzt `X-Real-IP`; der Relay begrenzt Anfragen, Warteschlangen und Räume je Adresse und insgesamt. Caddy läuft read-only ohne Capabilities außer `NET_BIND_SERVICE`; Images sind per Digest festgelegt (beim Update Tag und Digest gemeinsam ändern).
- Logs sind größenbegrenzt; Bearer-Tokens, Adressen und Videoinhalte werden nicht protokolliert. Der Relay verarbeitet Steuerdaten im Speicher; HTTPS verschlüsselt die Transportstrecken, nicht Ende-zu-Ende gegenüber dem eigenen Server.

## Abnahme vor dem ersten langen Film

Zunächst den Relay vier Stunden mit echten HTTP-Anfragen prüfen, idealerweise von beiden tatsächlichen Anschlussnetzen:

```sh
TEST_SERVER=https://203.0.113.10 SOAK_SECONDS=14400 npm run soak
```

Der Bericht `test-results/soak.json` enthält Anzahl der Roundtrips, Median/p95/p99, längste Antwortlücke und Wiederholungen. Ziel für diesen Steuerkanal: keine verlorene Sitzung, p99 unter 500 ms. Dieser Test prüft den Servertransport; er ersetzt keinen Vierstundentest mit zwei echten Browsern und den tatsächlichen Videoseiten.

Anschließend beide echten Rechner mindestens vier Stunden gemeinsam verwenden. Dabei geschlossenes Popup, 10–30 Sekunden Netzunterbrechung auf jeder Seite, native Play/Pause/Seek, Nachladen und einen Player-/Folgenwechsel prüfen. Nach einem Netzabbruch: gleicher Raum, erhaltene Bezugspunkte, beide pausiert, danach erfolgreiches Play. Nach einem Medienwechsel: neue Ausrichtung.

## Laufender Server

Seit 27. Oktober 2026 läuft der Relay auf dem netcup VPS 500 G12.5 (Debian 13). Eingerichtet:

- SSH nur mit Schlüssel für `root`; Passwort-, Keyboard-Interactive- und GSSAPI-Anmeldung sowie alle Weiterleitungen und Tunnel aus (`/etc/ssh/sshd_config.d/00-video-sync-hardening.conf`). Hostschlüssel vor der ersten Verbindung mit der netcup-Mail abgeglichen.
- `ufw`: eingehend nur 22/tcp (rate-limitiert), 80/tcp, 443/tcp und 443/udp. Docker veröffentlicht nur 80/443 (Caddy); 8787 ist von außen nicht erreichbar.
- `unattended-upgrades` für Debian-, Debian-Security- und Docker-Pakete täglich um 04:00 Uhr, bei Bedarf Neustart um 04:30 Uhr (Europe/Berlin). Docker mit `live-restore`, `no-new-privileges` und `icc: false`.
- Kernel-Sysctls: keine unprivilegierten User-Namespaces und kein unprivilegiertes BPF.
- Projekt unter `/opt/video-sync` als Checkout eines gemergten Main-Commits; `deploy/.env` (nur `PUBLIC_ADDRESS`) mit Rechten 600.
- Verbindungsgrenzen je Adresse vor Caddy (`deploy/firewall.sh`, eingebunden über `video-sync-firewall.service`, siehe unten).

Aktualisieren in einem ruhigen Moment (Räume liegen im RAM):

```sh
cd /opt/video-sync
git fetch origin && git checkout --detach <gemergter Commit>
SOURCE_COMMIT=$(git rev-parse --short HEAD) docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

Es gibt keine Verfügbarkeitszusage.

### Schutz vor Bots und Überlastung

- **Großangriffe (DDoS):** Gegen Angriffe, die die Leitung des Servers füllen, hilft nur der Netzbetreiber. netcup nennt seinen kostenlosen DDoS-Filter (bis Layer 4) ausdrücklich für Root- und Managed-Server; für VPS sagt die Seite nichts ([netcup DDoS-Schutz](https://www.netcup.com/de/ueber-netcup/ddos-schutz)). Wir gehen deshalb nicht von einem Filter aus. Ein großer Angriff würde den Relay bis zu seinem Ende unerreichbar machen; Daten gehen dabei nicht verloren, weil der Server keine speichert.
- **Einzelne Angreifer und Bots:** `deploy/firewall.sh` lässt je IPv4-Adresse bzw. IPv6-/64-Netz höchstens 64 offene Verbindungen und 20 neue Verbindungen pro Sekunde (nach 100 auf einmal) zu Port 80/443 zu; darüber werden Verbindungen zurückgesetzt bzw. verworfen. Ein Browser braucht davon wenige. Docker leitet veröffentlichte Ports an ufw vorbei, die Regeln stehen deshalb in der Kette `DOCKER-USER`; SSH ist nicht betroffen. Danach begrenzen Caddy und der Relay je Adresse (siehe oben). Scanner, die nach fremden Pfaden wie `/wp-login.php` suchen, bekommen 404 und werden nur gezählt.
- **SSH:** nur Schlüssel, keine Passwörter; ufw verlangsamt wiederholte Verbindungsversuche. Ein zusätzliches fail2ban bringt bei reiner Schlüsselanmeldung keinen Sicherheitsgewinn.

Einrichten bzw. nach Änderungen an `deploy/firewall.sh`:

```sh
install -m 644 /opt/video-sync/deploy/video-sync-firewall.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now video-sync-firewall.service
systemctl restart video-sync-firewall.service   # nach Änderungen
iptables -S VIDEO-SYNC-LIMITS                   # aktive Regeln
```

### Überwachung und Statistik

**Ausfall-Warnung:** `.github/workflows/monitor.yml` prüft alle 15 Minuten von GitHub aus (`scripts/monitor.js`, Adresse aus der Repository-Variable `VIDEO_SYNC_SERVER`):

- `/health` antwortet (drei Versuche im Abstand von 20 Sekunden),
- das Zertifikat ist gültig und noch mindestens 36 Stunden gültig (Caddy erneuert normalerweise mit etwa zwei Tagen Rest),
- der Server meldet seit dem vorigen Lauf keinen neuen Vorfall.

Vorfälle meldet der Server unter `/health` in `incidents` (nur Grund und Zeitpunkt, 24 Stunden): `error` unerwarteter Programmfehler, `crash` Prozess nicht sauber beendet (Absturz, Speicherlimit), `limits` mehr als 500 abgewiesene Anfragen pro Stunde (Bot/Angriff), `capacity` Server ausgelastet, `disk` weniger als 1 GB frei, `memory` mehr als 200 MB Arbeitsspeicher, `report` neuer Fehlerbericht aus der Extension. Jeder Vorfall schlägt einmal fehl; ein andauernder Ausfall bei jedem Lauf.

Ein fehlgeschlagener Lauf schickt GitHubs Benachrichtigung an die Person, die zuletzt die `cron`-Zeile geändert hat (GitHub → Settings → Notifications → Actions: „Only notify for failed workflows“, E-Mail). Grenzen: GitHub startet geplante Läufe manchmal verspätet, und in öffentlichen Repositories schaltet GitHub geplante Workflows nach 60 Tagen ohne Repository-Aktivität ab (vorher kommt eine E-Mail; unter Actions → „Monitor relay server“ → „Enable workflow“ wieder einschalten). Manuell starten: Actions → „Monitor relay server“ → „Run workflow“. Quelle: [GitHub: Ereignis `schedule`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).

**Statistik und Fehlerprotokoll:** Mit `DATA_DIR=/data` (Docker-Volume `app_data`) schreibt der Relay

- `usage/<UTC-Tag>.json`: Tagessummen (alle fünf Minuten aktualisiert, 400 Tage aufbewahrt): erstellte und beigetretene Räume, ungenutzte Einladungen, Räume mit bestätigter Szene und mit gemeinsamer Wiedergabe, Raumdauer (unter 10 Minuten, unter 1 Stunde, unter 3 Stunden, länger), Endgründe, Abspielen/Pause/Spulen getrennt nach Gastgeber, Gast und automatisch, Ausrichtungen, Neu-Ausrichtungen, Unterbrechungen, Resync-Anfragen, Pufferpausen, gemeinsame Abspielzeit, Zustellverzögerung weitergeleiteter Nachrichten, API-Antwortzeit, Fehlercodes, abgewiesene Anfragen nach Limit, Aufrufe unbekannter Pfade, Extension-Builds (`Vertrieb/Kanal/Version`), Starts, Abstürze, Tagesspitzen von Räumen, Arbeitsspeicher, Prozessor, Wartezeit und Verbindungen sowie freien Speicherplatz. Die Funktionszähler liest der Relay aus dem Zeitleisten-Zustand des Gastgebers, den er ohnehin prüft und weiterleitet (`server/room-features.js`);
- `load/<UTC-Tag>.json`: je Stunde Spitzen und Durchschnitte der Last (offene Räume, Personen, Anfragen, Verbindungen, Prozessor und Arbeitsspeicher von Relay und Server, Wartezeit der Event-Loop, vom Hoster belegte Rechenzeit), 30 Tage aufbewahrt (`server/load-metrics.js`);
- `live.json`: aktuelle Werte, alle 15 Sekunden überschrieben, für das Admin-Dashboard;
- `errors/<UTC-Tag>.jsonl`: je Fehler eine Zeile mit ID, Zeit, Route, Status und Code; bei Programmfehlern Fehlermeldung und Stack, bei Protokollablehnungen (`INVALID_MESSAGE`, `INVALID_SEQUENCE`, `INCOMPATIBLE_PROTOCOL`, `ROOM_REQUEST_CONFLICT`, `FORBIDDEN_ROLE`) der Aufbau der Nachricht (Feldnamen, Zahlen, Ja/Nein, Protokollbezeichner; Texte nur als Länge). Dazu Rolle, Extension-Build, Raumalter, Warteschlange und Sequenznummern des Mitglieds sowie Zustand und Commit des Servers. Höchstens 300 Einträge pro Tag und 20 je Fehlerart, 30 Tage aufbewahrt;
- `reports/<UTC-Tag>-<ID>.json`: Fehlerberichte, die jemand im Popup unter Einstellungen → Synchronisationsdiagnose gesendet hat (Diagnose, Versionen, Verbindungszustand, eigene Notiz; Inhalt in `docs/diagnostics-relay.md`), 30 Tage aufbewahrt, höchstens 200 pro Tag;
- `running`: Marker, solange der Prozess läuft; bleibt er nach einem Ende stehen, zählt der nächste Start einen Absturz.

Niemals enthalten: IP-Adressen, Raumcodes, Sitzungsschlüssel, Request-IDs, Video-Kennungen, Seiteninhalte oder Texte aus Nachrichten. Adressen, Tokens und UUIDs in Fehlermeldungen werden zusätzlich ersetzt. `tests/server-load.test.js` prüft für `usage`, `load` und `live.json`, dass nur feste Schlüssel, Zahlen, Daten, Commit und Build-Bezeichnungen vorkommen; `PRIVACY.md` beschreibt genau diesen Umfang und muss bei jedem neuen Zähler mitgeändert werden.

Auswerten auf dem Entwicklungsrechner (SSH-Zugang `video-sync`, anders über `VIDEO_SYNC_SSH`):

```sh
npm run stats                      # letzte 14 Tage und 10 Fehlereinträge
npm run stats -- --days 60 --errors 30
npm run stats -- --json            # Rohdaten, z. B. für Diagramme
npm run stats -- --reports         # letzte 20 Fehlerberichte
npm run stats -- --report K7Q2-9F3D   # ein Bericht mit Ablauf der Diagnose
```

Zum Nachstellen eines Fehlers: Eintrag mit Route, Code, Nachrichtenaufbau und Sequenznummern lesen, denselben Ablauf als Test gegen `createServer()` schreiben (`tests/server-monitoring.test.js` zeigt das Muster) und den Commit aus `server.commit` auschecken. CPU, Netzwerk und Datenträger des Hosts zeigt zusätzlich das netcup-Kundencenter (SCP) als Grafik.

### Admin-Dashboard

```sh
npm run admin                      # öffnet http://127.0.0.1:8790/
npm run admin -- --port 8800 --no-open
```

Das Dashboard läuft auf dem Entwicklungsrechner (`scripts/admin.js`, Seite in `admin/`) und lauscht nur auf 127.0.0.1; fremde `Host`-Namen werden abgewiesen. Die Daten holt es über SSH mit `deploy/admin-read.sh` (nur `overview`, `live` oder `report <ID>`, ausschließlich lesend); der Server öffnet dafür keinen Port, und die SSH-Weiterleitungen bleiben abgeschaltet. Live-Werte alle 15 Sekunden, die übrige Statistik alle 5 Minuten oder mit „Aktualisieren“.

Es zeigt eine Kapazitätsbewertung (höchster Stundendurchschnitt des Prozessors, Spitzen von Arbeitsspeicher, Räumen, Anfragen und Verbindungen gegen ihre Grenzen: unter 10 % viel Reserve, ab 60 % knapp, ab 80 % oder bei `SERVER_BUSY` zu klein), Live-Werte, Stundenverlauf, Nutzung pro Tag, den Weg vom Raum bis zur gemeinsamen Wiedergabe, Funktionen mit „nicht genutzt“, wer steuert, Raumdauer und Endgründe, Qualität pro Tag, Versionen, Vorfälle, Fehlerprotokoll und Fehlerberichte.

**Weitere Admins** brauchen keinen Shell-Zugang. Ihr öffentlicher Schlüssel kommt mit erzwungenem Befehl in `/root/.ssh/authorized_keys`; damit kann er nur Statistik lesen (keine Shell, keine Weiterleitung):

```
command="/opt/video-sync/deploy/admin-read.sh",restrict ssh-ed25519 AAAA… name
```

Sie klonen das Repository, tragen in `~/.ssh/config` einen Host `video-sync` (IP, `User root`, ihr Schlüssel, gepinnter Host-Key) ein und starten `npm run admin`. Entfernen: Zeile löschen.
