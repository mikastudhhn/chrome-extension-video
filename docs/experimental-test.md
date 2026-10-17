# Experimental: Tonzugriff prüfen

Der Tontest ist nur im Experimental-Paket enthalten. Diese Anleitung ist keine Abnahme eines Kandidaten; dafür Commit, Paketprofil und Prüfsummen des getesteten Pakets festhalten.

Diese erste experimentelle Version beantwortet die offene Machbarkeitsfrage: Liefert der Browser für den ausgewählten Player verwertbare Tonproben? Sie enthält **noch keine automatische Szenenerkennung oder Ausrichtung**. Ein eigener Server wird für den Tontest nicht benötigt.

## Ablauf auf Netflix, Prime Video, HBO Max oder einer eigenen Quelle

1. Ein Experimental-Paket installieren: das ZIP eines Experimental-Releases laden oder in den Einstellungen **Experimental** wählen und das angebotene Update installieren.
2. Falls verbunden, zuerst den Raum verlassen; der Tontest läuft nur außerhalb eines Raums.
3. Im gewünschten Video-Tab das Popup öffnen und das Video verbinden. Das Verbinden pausiert den Player wie bisher.
4. Im Originalplayer Play drücken. Eine Passage mit hörbarem Ton verwenden.
5. Das Popup erneut **im selben Video-Tab** öffnen, Einstellungen aufrufen und **Tontest starten** wählen. Die optionale Chrome-Berechtigung für Tab-Capture erlauben. Mikrofonzugriff wird nicht angefordert.
6. Das Video ungefähr acht Sekunden weiterlaufen lassen. Der Test endet selbstständig; **Test abbrechen** beendet ihn früher.
7. Ergebnis ablesen oder **Diagnose kopieren** verwenden. Die Zwischenablage enthält Version, Browserkennung und Messwerte, keine Aufnahme, Videoadresse, Titel oder Raumtokens.

**Tonproben empfangen** belegt messbaren Ton in dieser konkreten Sitzung. Es belegt weder den richtigen Film noch die spätere Erkennungsqualität. Andere hörbare Elemente desselben Tabs können das Ergebnis beeinflussen.

**Kein ausreichender Ton gemessen** unterscheidet nicht zwischen einer stillen Passage, Stummschaltung und einem Zugriffsschutz. **Zugriff fehlgeschlagen** zeigt einen Browser-/Berechtigungsfehler; daraus wird ebenfalls keine DRM-Diagnose abgeleitet.

Der Browser zeigt den aktiven Tab-Zugriff an. Während des Tests wird der erfasste Ton lokal wieder ausgegeben, weil Chrome die normale Tab-Tonausgabe beim Capture umleitet. Pegelmessung erfolgt in einem AudioWorklet. Es werden keine Tondateien angelegt und keine Proben oder Messwerte an den Relay gesendet.

Pause, längeres Nachladen, Verlust des ausgewählten Players, Tabwechsel durch erneutes Verbinden, Navigation, Schließen des Tabs und Raumbeitritt beenden den Test. Ein anderer ausgewählter Browsertab wird niemals automatisch erfasst. Ein geschlossenes Popup beendet die achtsekündige Messung nicht vorzeitig.

## Abnahme protokollieren

Je Anbieter eine Passage mit Ton testen und Browser, Betriebssystem, Titel/Fassung und gewählte Sprache separat notieren. Die Extension kopiert diese Inhaltsangaben bewusst nicht automatisch. Dann eine stille Passage, Abbruch, pausierten Player und Schließen/Neuladen des Tabs prüfen. Ton muss nach Testende normal weiterlaufen.

Die Anbieter sind noch nicht praktisch abgenommen. Die Syntax- und automatisierten Tests sind kein Nachweis, dass DRM-geschützter Ton bei Netflix, Prime Video oder HBO Max zugänglich ist. Schutzmechanismen werden nicht umgangen. Auf Basis eurer Testergebnisse kann als nächster Schritt ein passendes Verfahren zum Vergleich kurzer Audioabschnitte entwickelt werden.
