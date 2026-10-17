# 0.6.0

Erste öffentliche Version von Video Sync unter der MIT-Lizenz. Alle Installationen werden einmal manuell auf 0.6.0 umgestellt; Server und Extension werden gemeinsam aktualisiert.

- Zwei Personen richten ihre eigenen Videoquellen manuell auf dieselbe Szene aus und steuern Play, Pause und Spulen gemeinsam über einen HTTPS-Relay. Es werden keine Video- oder Audiodaten übertragen.
- Räume werden mit sechsstelligen Einladungscodes geteilt; die kopierte Einladung enthält zusätzlich die Serveradresse.
- Relay-Protokoll 3 mit Capability-Abgleich und signierten, wiederholbaren Raumanfragen. Ältere Clients und Server erhalten eine klare Aufforderung zum Aktualisieren.
- Einrichtung beim ersten Start im Popup, eingebettete und verschachtelte Player, Hell/Dunkel/System-Darstellung und lokale, filterbare Diagnose.
- Stable und Experimental sind Release-Kanäle des integrierten Updaters. Jedes Paket enthält eine Laufzeit; der achtsekündige Tontest ist nur im Experimental-Paket enthalten.
- Integrierter Updater für öffentliche GitHub-Releases ohne Token, mit Prüfsummen, Pfadprüfung, Journal, Readback und Wiederherstellung. Installation nur nach Klick.
- Lokaler Dev-Kanal mit automatischem Reload (`npm run dev`).
