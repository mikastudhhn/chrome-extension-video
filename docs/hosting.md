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
- `restart: unless-stopped` startet abgestürzte Prozesse und nach einem Hostneustart laufende Container wieder. Ein Docker-Healthcheck allein startet einen hängenden Prozess **nicht** neu. Ein externer Monitor sollte `/health` mindestens jede Minute prüfen und bei wiederholtem Ausfall alarmieren; er ist hier noch nicht eingerichtet. Quelle: [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
- Updates und geplante Neustarts außerhalb gemeinsamer Sitzungen durchführen. Räume liegen im RAM: Ein Serverneustart erfordert einen neuen Raum und erneute Ausrichtung. Ein einzelner VPS hat keinen automatischen Ausfallschutz auf einen zweiten Server.
- Keine Skalierung auf mehrere App-Container hinter einem Load Balancer: Der Raumzustand ist lokal im einzelnen Prozess.
- Beide Rechner während der Sitzung wach halten. Router-, WLAN-, Strom- und Streaminganbieter-Ausfälle kann ein VPS nicht verhindern. Bei schwankendem WLAN zuerst Ethernet bzw. ein stabiles Netz verwenden.
- Für einen Neustart einen ruhigen Moment wählen: `docker compose --env-file deploy/.env -f deploy/compose.yaml kill -s SIGUSR2 app`, danach `docker compose … logs --tail 1 app` zeigt eine Zeile `"event":"status"` mit `activeRooms`/`joinedRooms` (ohne Adressen, Codes oder Tokens). Bei offenen Räumen schreibt der Relay diese Zeile zusätzlich alle fünf Minuten.
- Abwehr: Caddy begrenzt Header-Lesezeit (5 s), Body-Lesezeit (10 s) und Body-Größe (16 KiB) und setzt `X-Real-IP`; der Relay begrenzt Anfragen, Warteschlangen und Räume je Adresse und insgesamt. Caddy läuft read-only ohne Capabilities außer `NET_BIND_SERVICE`; Images sind per Digest festgelegt (beim Update Tag und Digest gemeinsam ändern).
- Logs sind größenbegrenzt; Bearer-Tokens und Videoinhalte werden nicht protokolliert. Der Relay verarbeitet Steuerdaten im Speicher; HTTPS verschlüsselt die Transportstrecken, nicht Ende-zu-Ende gegenüber dem eigenen Server.

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

Aktualisieren: `git fetch origin && git checkout --detach <gemergter Commit>`, danach `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build` in einem ruhigen Moment (Räume liegen im RAM).

Es gibt keine Verfügbarkeitszusage und kein Monitoring.
