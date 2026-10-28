# Datenschutzerklärung – Video Sync

Stand: 29. Oktober 2026

Video Sync ist eine nicht kommerzielle Chrome-Erweiterung, mit der zwei Personen ihre eigenen Videos gemeinsam abspielen, pausieren und spulen. Verantwortlich ist Mika Höft. Kontakt: [GitHub-Issues dieses Repositorys](https://github.com/mikastudhhn/chrome-extension-video/issues).

## Was die Erweiterung verarbeitet

**Auf deinem Gerät** (Chrome-Speicher der Erweiterung): Serveradresse, Erscheinungsbild, Fortschritt der Einrichtung und eine lokale Diagnose der letzten Ereignisse. Diese Daten verlassen dein Gerät nicht; die Diagnose nur, wenn du sie selbst exportierst oder als Fehlerbericht sendest.

**Auf Webseiten, die du freigibst:** Die Erweiterung liest und steuert ausschließlich den Zustand des Videoplayers (Zeit, Dauer, Abspielen/Pause, Puffern). Seiteninhalte, Adressen, Titel, Eingaben, Cookies oder Verläufe werden weder gelesen noch übertragen. Video und Ton bleiben auf deinem Gerät.

**Über den Verbindungsserver**, nur während du in einem Raum bist:

- Raumcode und zufällige Sitzungsschlüssel,
- Abspielzustand: Zeitposition, Dauer, Abspielen/Pause, Puffern, eine zufällig erzeugte Video-Kennung und Zeitstempel,
- deine IP-Adresse, die technisch für jede Internetverbindung nötig ist.

Der Server leitet den Abspielzustand nur an die andere Person im selben Raum weiter. Räume liegen nur im Arbeitsspeicher und enden spätestens nach 12 Stunden, nach 5 Minuten ohne Aktivität oder beim Verlassen; dann werden Raumcode, Sitzungsschlüssel und Abspielzustand gelöscht. IP-Adressen werden kurzzeitig im Arbeitsspeicher zur Missbrauchsbegrenzung (Anfrage- und Raumlimits) verwendet; der Verbindungsserver und der vorgeschaltete Webserver schreiben sie nicht in ihre Protokolle. Die Erweiterung verwendet keine Konten, Namen, Cookies, Werbung oder Analyse- und Tracking-Dienste von Drittanbietern.

**Betriebsstatistik:** Damit wir sehen, ob der Server ausreicht und welche Funktionen genutzt werden, bildet der Server aus den Daten, die er für das gemeinsame Abspielen ohnehin verarbeitet, Zählwerte:

- je Tag: Anzahl, Dauer und Ende der Räume; wie viele Räume ausgerichtet und gemeinsam abgespielt wurden; wie oft Abspielen, Pause, Spulen und Neu-Ausrichten ausgelöst wurden, getrennt nach Gastgeber, Gast und automatisch; die gemeinsame Abspielzeit; Antwort- und Zustellzeiten; Fehlercodes; abgewiesene Anfragen; die verwendeten Extension-Versionen,
- je Stunde: Spitzen- und Durchschnittswerte der Serverauslastung (Prozessor, Arbeitsspeicher, Verbindungen, gleichzeitig offene Räume).

Gespeichert werden nur diese Zahlen, ohne IP-Adresse, Raumcode, Sitzungsschlüssel, Video-Kennung und ohne den Zeitpunkt einzelner Aktionen. Tageswerte werden nach 400 Tagen gelöscht, Stundenwerte nach 30 Tagen. Weil Video Sync von wenigen Personen genutzt wird, kann jemand, der weiß, wer an einem Tag geschaut hat, sich in diesen Zahlen wiedererkennen.

**Fehlerprotokoll:** Bei technischen Fehlern speichert der Server einen Fehlereintrag mit Uhrzeit, betroffener Funktion, Fehlermeldung des Programms, Version und dem Aufbau der fehlerhaften Nachricht (Feldnamen, Zahlen und Ja/Nein-Werte, keine Texte). Der Server schreibt dabei keine IP-Adressen, Raumcodes, Sitzungsschlüssel oder Seiteninhalte. Fehlereinträge werden nach 30 Tagen gelöscht.

**Fehlerberichte (nur auf deinen Klick):** Unter Einstellungen → Synchronisationsdiagnose kannst du einen Fehlerbericht senden. Er enthält die lokale Diagnose (Zustandswechsel, Messwerte und Fehlercodes mit Uhrzeit), die Version der Erweiterung, die Chrome-Hauptversion und das Betriebssystem, den Verbindungszustand (zum Beispiel „verbunden“ oder „pausiert“) und deinen optionalen Text. Webseitenadressen, Titel, Raumcodes und Schlüssel sind nicht enthalten. Der Bericht geht an den eingestellten Verbindungsserver, wird unter einer zufälligen Bericht-ID gespeichert und nach 30 Tagen gelöscht; deine IP-Adresse wird dabei nur zur Begrenzung der Anzahl verwendet und nicht gespeichert. Rechtsgrundlage ist deine Einwilligung durch das Senden (Art. 6 Abs. 1 lit. a DSGVO). Für eine frühere Löschung genügt ein GitHub-Issue mit der Bericht-ID.

Der voreingestellte Server wird von uns bei netcup GmbH (Deutschland/EU) betrieben; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Wenn du in der Erweiterung einen anderen Server einträgst, gilt dessen Datenschutz.

## Weitergabe

Wir verkaufen keine Daten und nutzen sie nicht für Werbung. Empfänger ist netcup als Betreiber der Server-Infrastruktur (Auftragsverarbeitung, siehe oben). Die Zählwerte der Betriebsstatistik werten wir auch mit KI-Werkzeugen aus (derzeit Claude von Anthropic). Rechtsgrundlage ist die Bereitstellung der von dir genutzten Funktion (Art. 6 Abs. 1 lit. b DSGVO) bzw. unser berechtigtes Interesse an einem sicheren Betrieb, an der Planung der Serverkapazität und an der Verbesserung der Funktionen (Art. 6 Abs. 1 lit. f DSGVO).

## Deine Rechte

Du hast die Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie das Recht auf Beschwerde bei einer Datenschutzaufsichtsbehörde. Nach dem Ende eines Raums bleiben auf dem Server nur die beschriebenen Zählwerte und Fehlereinträge sowie Fehlerberichte, die du gesendet hast. Lokale Daten entfernst du, indem du die Erweiterung deinstallierst.

## Summary (English)

Video Sync synchronizes play, pause and seek of two people's own videos. On pages you allow, it reads and controls only the video player state; page content, URLs, titles, input and browsing history are never read or transmitted. While you are in a room, the relay server receives the room code, random session keys, the playback state (time, duration, playing/paused, buffering, a random video ID, timestamps) and, technically, your IP address. It forwards the playback state only to the other room member, keeps rooms in memory only (deleted after 12 hours at most, 5 minutes of inactivity or on leaving) and does not write IP addresses to its logs. To plan capacity and see which features are used, it keeps counts derived from what it processes anyway: per day rooms, durations and endings, aligned and jointly played rooms, Play/Pause/Seek/realign counts by host, guest or automatic, joint playing time, response times, error codes, rejected requests and extension versions (400 days); per hour server load peaks and averages (30 days). The counts contain no IP addresses, room codes, keys, video IDs or times of single actions; with few users, someone who knows who watched on a day may still recognize themselves in them. For technical errors it keeps an error record without IP addresses, room codes, keys or text content (deleted after 30 days). Only when you click "Fehlerbericht senden", an error report with the local diagnosis, versions, connection state and your optional note is sent to the relay and deleted after 30 days. No accounts, cookies, ads or third-party analytics or tracking services; no data is sold. We also analyze the counts with AI tools (currently Claude by Anthropic). The default server is operated by us at netcup GmbH in the EU. Contact: GitHub issues of this repository.
