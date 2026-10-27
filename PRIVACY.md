# Datenschutzerklärung – Video Sync

Stand: 27. Oktober 2026

Video Sync ist eine nicht kommerzielle Chrome-Erweiterung, mit der zwei Personen ihre eigenen Videos gemeinsam abspielen, pausieren und spulen. Verantwortlich ist Mika Höft. Kontakt: [GitHub-Issues dieses Repositorys](https://github.com/mikastudhhn/chrome-extension-video/issues).

## Was die Erweiterung verarbeitet

**Auf deinem Gerät** (Chrome-Speicher der Erweiterung): Serveradresse, Erscheinungsbild, Fortschritt der Einrichtung und eine lokale Diagnose der letzten Ereignisse. Diese Daten verlassen dein Gerät nicht; die Diagnose nur, wenn du sie selbst exportierst.

**Auf Webseiten, die du freigibst:** Die Erweiterung liest und steuert ausschließlich den Zustand des Videoplayers (Zeit, Dauer, Abspielen/Pause, Puffern). Seiteninhalte, Adressen, Titel, Eingaben, Cookies oder Verläufe werden weder gelesen noch übertragen. Video und Ton bleiben auf deinem Gerät.

**Über den Verbindungsserver**, nur während du in einem Raum bist:

- Raumcode und zufällige Sitzungsschlüssel,
- Abspielzustand: Zeitposition, Dauer, Abspielen/Pause, Puffern, eine zufällig erzeugte Video-Kennung und Zeitstempel,
- deine IP-Adresse, die technisch für jede Internetverbindung nötig ist.

Der Server leitet den Abspielzustand nur an die andere Person im selben Raum weiter. Räume liegen nur im Arbeitsspeicher und enden spätestens nach 12 Stunden, nach 5 Minuten ohne Aktivität oder beim Verlassen; dann ist alles gelöscht. IP-Adressen werden nur im Arbeitsspeicher kurzzeitig zur Missbrauchsbegrenzung (Anfrage- und Raumlimits) verwendet und nicht protokolliert. Es gibt keine Konten, keine Namen, keine Cookies, keine Werbung, keine Analyse- oder Tracking-Dienste.

Der voreingestellte Server wird von uns bei netcup GmbH (Deutschland/EU) betrieben; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Wenn du in der Erweiterung einen anderen Server einträgst, gilt dessen Datenschutz.

## Weitergabe

Daten werden nicht verkauft, nicht an Dritte weitergegeben und nicht für andere Zwecke als das gemeinsame Abspielen verwendet. Rechtsgrundlage ist die Bereitstellung der von dir genutzten Funktion (Art. 6 Abs. 1 lit. b DSGVO) bzw. unser berechtigtes Interesse an einem sicheren Betrieb (Art. 6 Abs. 1 lit. f DSGVO).

## Deine Rechte

Du hast die Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie das Recht auf Beschwerde bei einer Datenschutzaufsichtsbehörde. Da der Server nichts dauerhaft speichert, liegen nach Ende eines Raums keine Daten über dich mehr vor. Lokale Daten entfernst du, indem du die Erweiterung deinstallierst.

## Summary (English)

Video Sync synchronizes play, pause and seek of two people's own videos. On pages you allow, it reads and controls only the video player state; page content, URLs, titles, input and browsing history are never read or transmitted. While you are in a room, the relay server receives the room code, random session keys, the playback state (time, duration, playing/paused, buffering, a random video ID, timestamps) and, technically, your IP address. It forwards the playback state only to the other room member, keeps rooms in memory only (deleted after 12 hours at most, 5 minutes of inactivity or on leaving) and does not log IP addresses. No accounts, cookies, ads, analytics or tracking; no data is sold or shared. The default server is operated by us at netcup GmbH in the EU. Contact: GitHub issues of this repository.
