# Player-Erkennung und Kompatibilität

Diese Beschreibung gilt für die Laufzeit aller Pakete (Stable, Experimental, Dev). Sie ist keine Stable- oder Realanbieter-Abnahme.

## Auswahl und Grenzen

Geladene Videos mit endlicher positiver Dauer werden im Dokument und in offenen Shadow Roots gesucht. Größe, `display`, `visibility`, `opacity`, `content-visibility` sowie Vorfahren, Shadow-Hosts und Slots werden berücksichtigt. `visibility` wird am Kandidaten selbst anhand des berechneten Werts geprüft: Ein ausdrücklich sichtbares Kind darf einen versteckten Vorfahren überschreiben. Null-Opacity, `display:none` und `content-visibility:hidden` auf Vorfahren schließen es weiterhin aus. Mehrere plausible Videos erfordern eine Auswahl; Fläche sortiert die Liste, entscheidet aber keine Mehrdeutigkeit. Es gibt keine zuverlässige automatische Werbung-/Trailer-Klassifikation.

Die Auswahl identifiziert ein konkretes Element in einem konkreten Chrome-Dokument. Beim Verbinden werden Discovery und Sichtbarkeit erneut geprüft. Entfernte Elemente oder navigierte Frames werden nicht durch einen anderen Kandidaten ersetzt. iframe-Dokumente werden über `event.source` und das tatsächliche `contentWindow` zugeordnet, auch nach Redirects und bei identischen URLs. Die Meldungen enthalten nur einen Scanbezeichner und eine Dokument-ID, keine Raumdaten. Eine URL-Heuristik dient ausschließlich dazu, vor einer fehlenden Frame-Freigabe den nächsten Berechtigungsschritt anzubieten; nach der Freigabe ist die konkrete Fensterzuordnung erforderlich.

Ein Discovery-Vorgang hat ein gemeinsames Budget von sechs Sekunden. Eine fehlende Zuordnung oder abgelaufene Erkennung fordert zum Wiederholen auf. Listener werden nach Abschluss oder spätestens am Scanende entfernt; eingefrorene Dokumente verarbeiten die Bereinigung beim Fortsetzen. Attach hat im Offscreen zehn Sekunden, mit einer neunsekündigen Ausführungsfrist im Player-Aufruf; normales Sampling behält zwei Sekunden. Die aktuelle Laufzeit prüft ihren Besitz im selben Script-Aufruf wie das Sampling. Historische Laufzeiten erhalten eine zusätzliche Besitzprüfung durch den gemeinsamen Router.

Geschlossene Shadow Roots, vollständige Verdeckung durch andere Elemente, jede Form von Clipping, Live-Videos ohne endliche Dauer und DRM-Steuerung ohne nutzbaren Adapter werden nicht als unterstützt versprochen. Ein erfolgreicher Fixture-Test ist kein Nachweis für einen Streaminganbieter.

## Medien und Adapter

| Adapter | Fähigkeiten | Wechselerkennung | Abnahmestand |
| --- | --- | --- | --- |
| HTML5 | Play, Pause, Seek, kleine Geschwindigkeitskorrekturen | Dokumentpfad/-Query, Quelle, `emptied`/`loadstart` | Node-Regressionen; neue Browserfälle vor Abnahme ausführen |
| Netflix, experimentell | Play, Pause, Seek; keine Geschwindigkeitskorrektur | zusätzlich eindeutige private Watch-Session | ausschließlich synthetische API-Fixtures; reale aktuelle Netflix-Wiedergabe nicht abgenommen |
| Prime, HBO, Disney+, andere Anbieter | gegebenenfalls zugängliches HTML5-Element | nur tatsächlich verfügbare HTML5-Signale | keine neue Realanbieter-Abnahme |

Mehrere sichtbare Videos auf Netflix werden nicht an eine einzelne private Watch-Session gebunden, weil die Elementzuordnung nicht bewiesen ist. Andere Player schließen und die Episode erneut verbinden. Bei fehlender oder mehrdeutiger Netflix-API erfolgt keine vermeintlich erfolgreiche HTML5-Seek-Übernahme. Die Meldung nennt Episode öffnen/Seite neu laden und erneut verbinden. Native Pause bleibt ein Sicherheitsrückfall. Reine Titeländerungen ändern keine Medienidentität. Ein Inhaltswechsel bei identischer Quelle und identischer Provider-Session ohne Ladeereignis ist nicht sicher erkennbar; dann manuell erneut verbinden und ausrichten.

Jeder mutierende Auftrag trägt die beim Versand erwartete Medien-ID und beim Routing die konkrete Player-ID. Die neue Laufzeit prüft beides nach Aktualisierung ihrer tatsächlichen Medienidentität. Verspätete Aufträge, auch nach einem bereits erfolgten Sample oder einer neuen Elementauswahl, werden ohne Steuereffekt verworfen; der aktuelle Sample wird zurückgegeben. Ein neuer Attach erzeugt eine neue Medien-ID. Historische Stable-Adapter behalten ihren unveränderten Router/Player und ignorieren zusätzliche unbekannte Befehlsfelder.

Der Popup-Titel folgt Änderungen am ausgewählten Tab; Tooltip und zugänglicher Name enthalten den vollständigen Titel. Das ist kein vollständiger Screenreader-Konformitätsnachweis.

## Installationen und Dev-Reload

Eine Installation reserviert die von ihr inspizierten zugänglichen Dokumente. Eine andere Installation wird mit einem konkreten Hinweis zum Deaktivieren der zweiten Kopie und Neuladen des Video-Tabs abgewiesen. Auch eine unmarkierte ältere Playerinstanz führt vorsichtshalber zu diesem Hinweis. Reservierungen verschwinden mit dem Dokument; für das gebundene Dokument auch beim Kanalwechsel. Das MAIN-world-Merkmal ist eine Kollisionshilfe, keine Sicherheitsgrenze gegenüber Websitecode.

Ältere, unverändert installierte Extensionversionen kennen diese Prüfung nicht und können weiterhin den gemeinsamen globalen Namen überschreiben. Die neue laufende Playerinstanz erkennt eine solche Übernahme, pausiert und meldet den Konflikt. Ein störungsfreier Parallelbetrieb mit Altversionen wird nicht zugesagt.

Kandidaten-IDs liegen in einer installationsgebundenen WeakMap des Videodokuments. Ein Dev-Reload verwirft Adapter und Listener, erhält aber diese Element-IDs. Der Checkpoint stellt genau den ausgewählten Player wieder her, auch bei mehreren Videos. Entfernte Elemente und ersetzte Dokumente verlangen eine neue Auswahl; es wird kein anderer Player ersatzweise gewählt.

## Ausstehende praktische Nachweise

Discovery läuft als `discovery-stable-candidate` und `discovery-experimental-candidate` in der gemeinsamen Paketmatrix, zusammen mit `e2e-local-branch.js` und den Frame-, UX-, Popup-, Kanal-, Fehler- und Kernfällen. Tab-Discard/Freeze, Berechtigungsentzug, Worker-/Browser-Neustart und Betriebssystem-Schlafen bleiben außerhalb der genannten Fixture-Nachweise offen und dürfen nicht als abgenommen gelten.
