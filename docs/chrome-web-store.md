# Chrome Web Store

Video Sync wird zusätzlich als **nicht gelisteter** Eintrag im Chrome Web Store verteilt: Nur wer den Link hat, findet ihn; Chrome installiert und aktualisiert die Erweiterung selbst, ohne Entwicklermodus. Die GitHub-Pakete mit integriertem Updater bleiben für Experimental und Tests bestehen.

## Paket

`PACKAGE_PROFILE=store npm run package -- <Server>` erzeugt `dist/store/video-sync-X.Y.Z.N-store.zip` (Manifest im ZIP-Wurzelverzeichnis, wie der Store es verlangt). Jeder Main-Build veröffentlicht dieses ZIP am Experimental-Kandidaten; `npm run promote` übernimmt es unverändert in das Stable-Release. Hochgeladen wird nur das `-store.zip` eines **Stable-Releases**.

Gegenüber dem Stable-Paket (`scripts/store-package.js`):

- Stable-Funktionsumfang (kein Tontest), Server aus `VIDEO_SYNC_SERVER` voreingestellt.
- Kein GitHub-Updater: Updater-Module sind durch wirkungslose Module aus `scripts/store/` ersetzt; alles, was Pakete lädt, prüft oder Dateien schreibt, ist entfernt. Store-Richtlinien verbieten nachgeladenen Code.
- Keine Kanalwahl, kein Update-Banner, keine Update-Ansicht, kein GitHub-Schritt in der Einrichtung (5 statt 6 Schritte).
- Manifest ohne `alarms`, ohne `tabCapture` und ohne feste `localhost`-Hostrechte.
- `distribution.js` meldet `STORE = true`; `build-info.json` enthält `"distribution": "chrome-web-store"`.

Die Store-Installation hat eine eigene Erweiterungs-ID und eigenen Speicher. Wer bisher das GitHub-Paket nutzt, entfernt es nach der Store-Installation unter `chrome://extensions`.

## Neue Version veröffentlichen

1. Stable wie gewohnt freigeben (`docs/release-workflow.md`).
2. Im [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Video Sync → **Paket** → **Neues Paket hochladen** das `video-sync-X.Y.Z.N-store.zip` des Stable-Releases hochladen. Die Versionsnummer muss höher sein als die zuletzt hochgeladene; das ist durch die Build-Nummer gegeben.
3. **Zur Überprüfung einreichen.** Nach der Prüfung (meist wenige Tage) verteilt Chrome das Update automatisch.

## Eintrag (einmalig)

**Store-Eintrag**

- Name: Video Sync (aus dem Manifest)
- Zusammenfassung: Zwei Videoquellen manuell ausrichten und gemeinsam ansehen. (aus dem Manifest)
- Kategorie: Unterhaltung · Sprache: Deutsch
- Beschreibung:

> Schaut gemeinsam, auch wenn ihr nicht im selben Raum seid. Video Sync verbindet zwei Personen, die dasselbe Video jeweils in ihrem eigenen Browser öffnen, und hält Abspielen, Pause und Spulen synchron.
>
> So funktioniert es:
> • Eine Person erstellt einen Raum und schickt die Einladung.
> • Beide stellen ihr eigenes Video auf dieselbe Szene und bestätigen sie.
> • Ab dann wirkt Play, Pause und Spulen bei beiden – egal wer klickt.
>
> Gut zu wissen:
> • Es werden keine Videos oder Töne übertragen. Jede Person schaut ihre eigene Quelle mit ihrem eigenen Zugang.
> • Über den Verbindungsserver gehen nur Abspielzeit, Pause/Play und ein Raumcode – keine Seiteninhalte, Adressen oder Verläufe.
> • Keine Konten, keine Werbung, kein Tracking.
> • Funktioniert mit HTML5-Videoplayern, auch in eingebetteten Frames. Zugriff auf Websites wird erst nach deiner Freigabe genutzt.
>
> Quellcode (MIT): https://github.com/mikastudhhn/chrome-extension-video

- Bilder: Symbol `extension/assets/icons/pause-128.png`; Screenshots 1280 × 800 und kleine Kachel 440 × 280 aus `docs/store-assets/`.
- Website: https://github.com/mikastudhhn/chrome-extension-video

**Datenschutz**

- Alleiniger Zweck: Synchronisiert Abspielen, Pause und Spulen der eigenen Videos zweier Personen über einen Verbindungsserver, damit sie gemeinsam schauen können.
- Begründungen der Berechtigungen:
  - `activeTab`: Beim Öffnen des Popups im Video-Tab den Player dieses Tabs finden und verbinden, ohne dauerhafte Freigabe.
  - `scripting`: Den Player-Adapter in den freigegebenen Video-Tab und seine eingebetteten Frames einfügen, um Zeit und Status des Videos zu lesen und Play, Pause und Spulen auszuführen.
  - `offscreen`: Ein Offscreen-Dokument hält die Verbindung zum Verbindungsserver, auch wenn das Popup geschlossen ist.
  - `storage`: Einstellungen (Serveradresse, Erscheinungsbild, Einrichtung) und den Sitzungszustand lokal speichern.
  - `webNavigation`: Erkennen, wenn im verbundenen Tab oder Frame eine neue Seite lädt, damit die Wiedergabe sicher pausiert und der Player neu verbunden wird.
  - Hostberechtigungen (optional, `https://*/*`, `http://*/*`): Erst nach ausdrücklicher Freigabe der Person. Videoplayer liegen oft in eingebetteten Frames fremder Domains; ohne die Freigabe wird pro Website gefragt. Gelesen und gesteuert wird nur das Videoelement.
- Remote-Code: **Nein.** Alle Skripte sind im Paket enthalten; vom Server kommen nur Daten.
- Datennutzung, empfohlene Angaben (deckungsgleich mit `PRIVACY.md`):
  - **Standort** (IP-Adresse): technisch für die Serververbindung nötig, nur im Arbeitsspeicher zur Missbrauchsbegrenzung, nicht protokolliert.
  - **Nutzeraktivität**: Play, Pause und Spulen werden an die zweite Person im Raum übertragen.
  - Alle drei Erklärungen bestätigen (kein Verkauf, keine zweckfremde Nutzung, keine Kreditwürdigkeit).
- Datenschutzerklärung: https://github.com/mikastudhhn/chrome-extension-video/blob/main/PRIVACY.md

**Vertrieb**

- Sichtbarkeit: **Nicht gelistet** · Regionen: alle

**Testanleitung für die Prüfung**

> No account is needed. The default relay server is preset. To test: open https://159.195.131.172/ (a test player page of our relay) in two Chrome profiles with the extension installed. In profile A: open the extension popup on that tab, allow access, then "Raum erstellen" (create room) and copy the invitation. In profile B: open the popup on the same page, paste the invitation and join. Both confirm the same scene ("Diese Szene bestätigen"), then press play in either window – play, pause and seek are mirrored.
