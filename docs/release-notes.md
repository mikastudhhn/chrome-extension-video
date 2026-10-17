Testversion von Video Sync. Dies ist keine Stable-Freigabe.

**Download:** `video-sync-<Version>.zip` herunterladen, in einen dauerhaften Ordner entpacken und `video-sync/extension` in `chrome://extensions` als entpackte Erweiterung laden. `update.json` ist für den integrierten Updater bestimmt. Die zusätzliche ZIP mit `-stable` und `update-stable.json` bilden den noch abzunehmenden Stable-Kandidaten; sie werden erst nach ausdrücklicher Freigabe zum Stable-Download.

Unter **Einstellungen → Version** wird gewählt, welchen Releases der Updater folgt (Stable oder Experimental). Experimentelle Funktionen wie der Tontest sind nur im Experimental-Paket enthalten.

Updates aus öffentlichen Releases benötigen keinen Token. Die Erweiterung prüft alle 30 Minuten und beim Öffnen des Popups; installiert wird ausschließlich nach Klick auf **Jetzt aktualisieren**. Einzelheiten stehen in `UPDATES.md` im Download.

Versionen vor 0.6.0 einmalig entfernen und 0.6.0 neu laden; sie arbeiten nicht mit 0.6.0-Servern oder -Partnern zusammen. GitHub ersetzt keinen Verbindungsserver. Ist kein gemeinsamer HTTPS-Server voreingestellt, benötigen beide Personen eine passende Serveradresse beziehungsweise eine vollständige Einladung.
