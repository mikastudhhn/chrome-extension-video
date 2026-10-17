# Automatische Szenenausrichtung: Analyse und Recherche

Stand: 18. September 2026. Untersuchte Extension: 0.2.7.

Die automatische Ausrichtung ist technisch plausibel. Für gleiche Tonspuren empfiehlt sich als erster Versuch Audio-Fingerprinting: kurze Tonabschnitte in kompakte Erkennungsmerkmale umwandeln, passende Stellen finden und daraus den Zeitversatz bestimmen. Unterschiedliche Sprachen erfordern ergänzende Verfahren, insbesondere Bildvergleich. Die größte offene Frage ist der zuverlässige Zugriff auf die benötigten Daten bei euren tatsächlichen Streamingplayern.

Dies ist eine Recherche und ein Architekturvorschlag. Automatische Erkennung ist noch nicht implementiert oder auf Netflix beziehungsweise eingebetteten Drittanbieter-Playern getestet. Da die bevorzugten Sprachkombinationen noch offen sind, berücksichtigt der Vorschlag gleiche und unterschiedliche Tonspuren.

## Was die Extension bereits automatisch macht

Die Extension erkennt und steuert einen ausgewählten HTML5-Player, auch in verschachtelten iframes. Netflix hat einen eigenen Adapter über eine private Player-Schnittstelle. Ein Offscreen-Dokument verwaltet die Sitzung; ein Worker überträgt Steuerdaten über den Relay-Server. Die raumerstellende Extension führt die gemeinsame Zeitachse und ordnet Befehle.

Manuell ist vor allem die **inhaltliche Zuordnung**: Beide suchen dieselbe Szene und bestätigen ihre pausierte Position. `Timeline.ready()` speichert diese Positionen als `anchors.host` und `anchors.guest`. Der Code prüft, ob beide Player bereit sind, aber nicht, ob tatsächlich dieselbe Szene zu sehen ist.

Beispiel: Eine Tür öffnet sich bei A bei 02:00 und bei B bei 02:07. Die gespeicherten Bezugspunkte sind 120 und 127 Sekunden. Nach zehn gemeinsamen Sekunden stehen die Videos bei 02:10 und 02:17. Der notwendige Abstand beträgt weiterhin sieben Sekunden.

```text
Quelle A: 02:00 ───── gemeinsame Szene ───── 02:10
Quelle B: 02:07 ───── gemeinsame Szene ───── 02:17
                     Versatz: +7 Sekunden
```

Danach arbeitet die Synchronisation bereits automatisch: Abfragen werden alle 350 ms angestoßen, Uhren per Ping/Pong abgeglichen und Play/Pause/Seek gemeinsam angewendet. HTML5-Player gleichen moderate Abweichungen mit 0,96- beziehungsweise 1,04-facher Geschwindigkeit aus; größere Abweichungen werden durch Spulen korrigiert. Netflix verwendet diese Geschwindigkeitskorrektur ausdrücklich nicht. Netzwerk- oder längere Ladeprobleme führen zu einer gemeinsamen Pause.

**Folgerung aus dem Code:** Ein Algorithmus muss zunächst zuverlässige Bezugspunkte liefern. Für Quellen mit gleicher inhaltlicher Geschwindigkeit kann danach die bestehende Synchronisation weiterarbeiten. Eine neue Steuerungsarchitektur ist dafür voraussichtlich nicht erforderlich.

Relevante Stellen im untersuchten Stand:

| Datei | Bedeutung |
| --- | --- |
| `extension/timeline.js:66` | Bestätigung und Speicherung der beiden Bezugspunkte |
| `extension/timeline.js:149` | Berechnung der lokalen Zielposition |
| `extension/player.js:82` | Experimenteller Netflix-Adapter |
| `extension/player.js:121` | Liefert Zeiten und Zustände, keine Inhaltsmerkmale |
| `extension/player.js:185` | Laufende Korrektur von Positionsabweichungen |
| `extension/offscreen.js:145` | Uhrabgleich zwischen den Teilnehmern |
| `extension/offscreen.js:310` | Ablauf der manuellen Szenenbestätigung |
| `extension/background.js:8` | Offscreen-Dokument derzeit nur mit Grund `WORKERS` |
| `server/rooms.js:131` | Erlaubte Nachrichtentypen des Relays |

Die lokalen `mediaId`-Werte sind zufällige Kennungen zur Erkennung von Medienwechseln. Sie identifizieren keinen gemeinsamen Film über zwei Anbieter hinweg. Auch gleiche Titel oder ähnliche Laufzeiten beweisen keine identische Schnittfassung.

## Welche Verfahren geeignet sind

Die Bewertung in dieser Tabelle ist eine technische Einschätzung für dieses Projekt, kein gemessener Anbieter-Benchmark.

| Verfahren | Gut geeignet für | Grenzen | Einordnung |
| --- | --- | --- | --- |
| Audio-Fingerprinting | Gleiche oder ausreichend ähnliche Tonspuren mit anderem Startversatz | Stille, andere Synchronisation, wiederkehrende Musik, Datenzugriff | Erster Prototyp bei gleicher Sprache |
| Bildfolgen vergleichen | Gleiche Bilder bei unterschiedlichen Sprachen | Geschützte Bilder, Beschnitt, Untertitel, Logos, wiederholte Einstellungen | Ergänzung für verschiedene Tonspuren |
| Untertitel abgleichen | Zugängliche Untertitel mit vergleichbarem Text und Zeitmarken | Unterschiedliche Übersetzungen, abweichendes Timing, fehlende Tracks | Zusätzliche Anhaltspunkte |
| Anbieter- und Versionsdaten | Nachweislich dieselbe Fassung desselben Inhalts | Anbieterübergreifend fehlen gemeinsame verlässliche IDs | Suche eingrenzen und Ergebnisse plausibilisieren |
| KI auf Bild oder Transkript | Stark veränderte Bilder oder sprachübergreifende Zuordnung | Zusätzliche Rechenarbeit, Modellbedarf, ungenaue Zeitzuordnung | Spätere Untersuchung bei belegtem Bedarf |

### Audio-Fingerprinting und Bestimmung des Versatzes

Ein etabliertes Verfahren sucht markante Frequenzspitzen im zeitlichen Verlauf des Tons. Aus Paaren solcher Spitzen werden kompakte Kennungen erzeugt. Gleiche Kennungen in beiden Quellen ergeben Paare von Zeitpunkten. Häufen sich deren Zeitdifferenzen um denselben Wert, ist das ein Kandidat für den Versatz. Das ist das Grundprinzip des klassischen Shazam-Verfahrens. [Wang: An Industrial-Strength Audio Search Algorithm](https://www.ee.columbia.edu/~dpwe/papers/Wang03-shazam.pdf)

Für unsere Anwendung lässt sich das so ausdrücken:

```text
Gleicher Fingerprint bei tA und tB
    → Kandidat Δ = tB − tA

Viele unabhängige Treffer mit ähnlichem Δ
    → plausibler Zeitversatz

Beispiel: 7,02 / 6,98 / 7,01 Sekunden
    → ungefähr +7 Sekunden
```

Auch die Ausrichtung verschiedener Filmfassungen wurde mit Audio-Landmarken untersucht, einschließlich hinzugefügter und entfernter Szenen. Das belegt die grundsätzliche Eignung der Methode; es belegt noch keine zuverlässige Erkennung in unserer Extension oder bei beliebigen Sprachspuren. [Duong und Thudor: Movie Synchronization by Audio Landmark Matching, ICASSP 2013](https://dihana.cps.unizar.es/proceedings/ICASSP/2013/pdfs/0003632.pdf), [Konferenzeintrag](https://www.2013.ieeeicassp.org/Papers/ViewPaperse0a4.html?PaperNum=4223)

**Vorgeschlagener erster Ablauf:** Beide starten die automatische Ausrichtung. Die Extension erfasst zunächst etwa 10–20 Sekunden Ton pro Quelle, berechnet lokal Fingerprints und tauscht nur Merkmale mit Medienzeitpunkten aus. Ein Matcher in der Host-Extension prüft den Versatz. Die Aufnahmelänge ist ein zu testender Startwert, keine Zusage für Erkennungsdauer oder Genauigkeit.

Für die Annahme eines Ergebnisses sollten mehrere Kriterien zusammenkommen: ausreichend viele unterschiedliche Treffer, Verteilung über mehrere Sekunden, geringe Streuung des Versatzes und ein deutlicher Abstand zur zweitbesten Zuordnung. Ein weiterer, zeitlich getrennter Abschnitt sollte denselben Versatz bestätigen. Stille oder ein wiederholtes Intro allein reichen nicht als sichere Bestätigung.

Die Fingerprints müssen der **Medienzeit** zugeordnet werden. Die Uhrzeit des Netzwerkempfangs wäre dafür ungeeignet. Aufnahmeverzögerung, Player-Abfrage und Audio-Puffer brauchen eine gemessene Zeitzuordnung. Bei Pause, Seek, Buffering, Medienwechsel oder Geschwindigkeitsänderung muss ein Aufnahmeabschnitt beendet oder entsprechend markiert werden. Der bestehende Uhrabgleich löst die zusätzliche Audio-Latenz nicht automatisch.

### Die Suchspanne ist eine eigenständige Aufgabe

Wenn A bei Minute 2 und B bei Minute 40 erfasst, liefern zwei 15-Sekunden-Ausschnitte normalerweise keinen gemeinsamen Inhalt. Ein Matcher kann keine nicht beobachtete Stelle finden.

Für die erste Version sollte deshalb eine begrenzte Suche gelten: Beide beginnen ungefähr im gleichen Filmbereich; alternativ steuert die Extension ausdrücklich gestartete kurze Suchabschnitte in einem begrenzten Bereich an. Solche Suchsprünge müssen außerhalb der normalen gemeinsamen Wiedergabe laufen. Bei einem kurzen Erfassungsfenster ist ein großer Versatz nicht zuverlässig abgedeckt.

Eine Suche über den ganzen Film braucht wesentlich mehr Referenzmaterial: längere Erfassung, gezieltes Durchsuchen oder einen bereits vorhandenen Fingerprint-Index der konkreten Fassung. Das ist ein eigener Ausbauschritt. Im Browser ist direktes Dekodieren einer vollständigen Datei außerdem nicht für jede Streamingquelle verfügbar.

### Unterschiedliche Sprachen: Bildfolgen als Ergänzung

Bei Deutsch gegen Englisch fehlen viele identische Sprachmerkmale. Gemeinsame Musik oder Geräusche können trotzdem Treffer liefern; darauf sollte das Produkt ohne Messungen keine Zusage aufbauen.

Für einen Bildvergleich bietet sich als Versuch an: nur den Videobereich verwenden, schwarze Balken und störende Randbereiche behandeln, Bilder vereinheitlichen und Wahrnehmungshashes wie pHash vergleichen. Solche Bildhash-Verfahren sind beispielsweise in OpenCV dokumentiert. [OpenCV: Image Hashing](https://docs.opencv.org/4.13.0/d4/d93/group__img__hash.html)

Unsere vorgeschlagene Erweiterung würde zunächst wenige Bilder pro Sekunde auswerten und eine zusammenhängende Bildfolge abgleichen. Ein einzelnes ähnliches Bild genügt nicht. Nach grober Zuordnung folgt eine feinere Suche im betreffenden Zeitbereich. Ob pHash bei den tatsächlich auftretenden Untertiteln, Logos und Ausschnitten reicht, muss ein Vergleich mit realen Beispielen zeigen.

Untertitel können zusätzlich helfen, wenn der Player sie als Textspuren mit Zeitmarken zugänglich macht. Dafür existiert `HTMLMediaElement.textTracks`; das garantiert keine solchen Daten bei jedem Anbieter. Unsere Ableitung: Mehrere übereinstimmende Textstellen können den Suchbereich eingrenzen, benötigen aber eine Kontrolle ihres Zeitversatzes. [MDN: textTracks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/textTracks)

## Browsergrenzen, die zuerst geprüft werden müssen

Die jetzige Extension kann Wiedergabezeiten lesen und Player steuern. Daraus folgt kein Zugriff auf Tonproben oder Bildpixel.

Chrome bietet mit `tabCapture` einen offiziellen Weg zum Erfassen von Tab-Audio und Tab-Video nach einer Nutzeraktion an der Extension. Dafür braucht es die zusätzliche Berechtigung `tabCapture`. Seit Chrome 116 kann der Service Worker eine Stream-ID an ein Offscreen-Dokument übergeben. Die bestehende Mindestversion passt dazu. Die Stream-ID muss zeitnah konsumiert werden. [Chrome: tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)

Das vorhandene Offscreen-Dokument könnte um die Aufnahmefunktion erweitert werden; für `getUserMedia()` wäre zusätzlich der passende Grund `USER_MEDIA` nötig. Chrome dokumentiert diesen Aufbau ausdrücklich. Bei Tab-Audio muss außerdem die lokale Tonausgabe über einen AudioContext erhalten werden, weil das Erfassen die normale Ausgabe umleitet. Mikrofoneingang ist für diesen Ansatz nicht erforderlich. [Chrome: Audio recording and screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture), [Chrome: offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)

Der erste Versuch sollte auch prüfen, ob weitere Audioquellen im selben Tab den Abgleich stören. Tab-Capture erfasst den Tab und ist nicht automatisch auf das ausgewählte Videoelement beschränkt. Bei Video-Capture muss der relevante Bildbereich zuverlässig gefunden werden.

Direkter Zugriff im Player-Dokument hat zusätzliche Grenzen: Cross-Origin-Medien ohne geeignete CORS-Freigabe können einen Canvas unlesbar machen; ein `MediaElementAudioSourceNode` muss bei entsprechend gesperrten Ressourcen Stille ausgeben. Die vorhandene Website-Freigabe ist daher kein allgemeiner Nachweis für auslesbare Bild- oder Tondaten. [MDN: Canvas und Cross-Origin-Inhalte](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image), [W3C: Web Audio, Abschnitt 1.22.4](https://www.w3.org/TR/webaudio-1.0/#MediaElementAudioSourceNode-security)

Bei DRM-geschützten Medien erlaubt die EME-Spezifikation Einschränkungen für die Ausgabe an andere Web-APIs. Daraus lässt sich weder allgemeine Unterstützung noch generelles Scheitern von Tab-Capture bei Netflix ableiten. **Die konkrete Kombination aus Anbieter, Browser und Betriebssystem muss praktisch getestet werden.** Ohne nutzbare Daten bleibt die manuelle Ausrichtung erforderlich. [W3C: Encrypted Media Extensions, Media Element Restrictions](https://www.w3.org/html/media/#media-element-restrictions)

## Passende bestehende Projekte

| Projekt | Belegter Funktionsumfang | Verwendung für uns |
| --- | --- | --- |
| [audfprint](https://github.com/dpwe/audfprint) | Landmark-Fingerprints, Zeitversatz und passende Zeitbereiche; Python; MIT-Lizenz | Referenz für Offline-Versuche und Bewertung der Treffer |
| [Olaf](https://github.com/JorenSix/Olaf) | Kompakter C-Kern, Fingerprinting im Browser über WebAssembly; AGPL-3.0 | Kandidat für einen Browser-Prototyp; Integration und Lizenzwahl gesondert bewerten |
| [Panako](https://github.com/JorenSix/Panako) | Berücksichtigt auch Zeitdehnung und Tonhöhenänderungen; Java-Projekt | Vergleich für unterschiedlich schnelle Fassungen, späterer Ausbau |
| [Chromaprint](https://github.com/acoustid/chromaprint) | Auf nahezu identische Audiodateien, Duplikate und längere Streams ausgerichtet | Als Vergleich möglich; meine erste Wahl für kurze, präzise Zuordnungen wäre ein Landmark-Verfahren |

`audfprint` dokumentiert eine begrenzte Zeitdarstellung in der Standardkonfiguration. Für vollständige Filme müssen die Zeitparameter passend eingestellt werden, sonst können ausgegebene Positionen mehrdeutig werden. Seine Beispiele belegen keine Genauigkeit in unserem Browserbetrieb. [audfprint: Scaling](https://github.com/dpwe/audfprint#scaling)

Bei WebAssembly wären die Dateien mit der Extension zu paketieren und die Extension-CSP passend zu konfigurieren; standardmäßig ist WebAssembly dort deaktiviert. [Chrome: Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)

Für den ersten Vergleich zweier Quellen ist ein lokaler Merkmalsvergleich innerhalb der Extension ein sinnvoller Entwurf. Dafür braucht es weder einen öffentlichen Filmkatalog noch einen KI-Dienst. Die Übertragung von Fingerprints wäre allerdings eine Erweiterung der bisherigen reinen Steuerdaten. Rohaufnahmen sollten im vorgeschlagenen Entwurf lokal und kurzlebig bleiben; Fingerprints können Inhalt identifizierbar machen und sind nicht automatisch anonyme Daten.

## Einbau in die bestehende Extension

Die folgenden Punkte sind ein Umsetzungsvorschlag, keine bereits vorhandenen Funktionen:

1. Im Popup eine Aktion „Automatisch ausrichten“ ergänzen, mit Fortschritt, Abbrechen und manueller Alternative. Jede Seite startet ihren erforderlichen Capture-Zugriff selbst.
2. Im Background-/Offscreen-Bereich Tab-Capture einrichten, Ressourcen beim Abbrechen freigeben und Merkmale in einem eigenen Worker berechnen. Der Verbindungs-Worker sollte durch die Analyse nicht blockiert werden.
3. Einen getrennten Suchzustand einführen. Die normale Synchronisation darf die für die Analyse nötige Wiedergabe oder Suchsprünge nicht zurücksetzen. Heartbeats, Medienwechsel- und Abbruchprüfung laufen weiter.
4. Neue, streng begrenzte Nachrichten für Fingerprints und Suchergebnisse vorsehen. `server/rooms.js` erlaubt derzeit keine solchen Nachrichtentypen. `server/index.js` begrenzt einen gesamten Request auf 32.768 Byte; Chunks und Batches müssen darunter bleiben. Steuerbefehle dürfen nicht hinter großen Analysepaketen warten.
5. Ergebnisse an beide Medienkennungen, Dokumentbindungen und die aktuelle Ausrichtungsrunde binden. Auch die bestehende 2,5-Sekunden-Altersprüfung in `offscreen.js` braucht eine bewusst definierte Behandlung neuer Analysenachrichten. Alte Treffer dürfen nicht nach einem Medienwechsel gelten.
6. Nach einem belastbaren Treffer passende Positionen anfahren, beide pausierten und geladenen Player prüfen und die Bezugspunkte gemeinsam übernehmen. `ready()` speichert die aktuelle Position; es kann nicht einfach zwei historische Trefferzeiten erhalten. Der Übergang benötigt daher eine koordinierte Bestätigung gegen Rennen mit lokalen Eingaben.
7. Anschließend die bestehende Wiedergabesynchronisation nutzen. Die manuelle Ausrichtung bleibt verfügbar, wenn die Daten fehlen oder das Ergebnis nicht eindeutig ist.

## Werbung, andere Schnitte und unterschiedliche Geschwindigkeit

Ein längeres Intro am Anfang lässt sich mit einem konstanten Versatz behandeln. Eine später eingefügte Szene oder Werbung verändert dagegen die Zuordnung ab einer bestimmten Stelle. Bei fehlendem Gegenstück gibt es in diesem Abschnitt keine gleichzeitig passende Szene.

Als späteren Ausbau empfehle ich mehrere lokale Zuordnungen: Innerhalb eines zusammenpassenden Abschnitts gilt ein Versatz; nach einer Unterbrechung wird neu abgeglichen. Während nur eine Person Werbung sieht, wäre Warten auf gemeinsamen Inhalt ein möglicher Produktablauf. Ein fehlender Treffer allein beweist allerdings keine Werbung und sollte keine ungeprüften Sprünge auslösen.

Eine dauerhaft andere inhaltliche Geschwindigkeit benötigt zusätzlich einen Faktor:

```text
Gleiche Geschwindigkeit:        tB = tA + Δ
Unterschiedliche Geschwindigkeit: tB = a × tA + b
Unterschiedliche Schnitte:      mehrere abschnittsweise Zuordnungen
```

Der aktuelle Code modelliert `a = 1`. Die vorhandene Korrektur kurzzeitiger Wiedergabeabweichungen ersetzt keine dauerhafte Abbildung unterschiedlich schneller Fassungen. Auch Panako dokumentiert diesen Unterschied und unterstützt entsprechende Audioänderungen; eine solche Funktion in unserer Zeitachse wäre gesonderte Entwicklungsarbeit. [Panako](https://github.com/JorenSix/Panako)

## Empfohlener nächster Entwicklungsschritt

Zuerst einen kleinen Machbarkeitstest für **Datenzugriff und Zeitzuordnung** durchführen: auf den tatsächlich verwendeten Quellen feststellen, ob verwertbarer Ton beziehungsweise Bildinhalt ankommt und wie groß die Capture-Verzögerung ist. Netflix und eingebettete Drittanbieter-Player unter 0.2.7 sind laut Projektunterlagen selbst für die vorhandene Steuerung noch nicht erneut abgenommen.

Wenn brauchbares Audio verfügbar ist, folgt ein begrenzter Audio-Prototyp mit gleicher Tonspur und konstantem Versatz. Bei regelmäßig unterschiedlichen Sprachen gehört ein Bildvergleich bereits in den ersten Machbarkeitstest. Die Aufnahmeparameter, Qualitätsgrenzen und Suchspanne werden anhand der Ergebnisse festgelegt.

Für die Bewertung braucht es bekannte richtige Zuordnungen und schwierige Gegenbeispiele: verschiedene Startversätze, andere Lautstärke und Kompression, Stille, wiederholte Intros, völlig unterschiedliche Videos, nicht überlappende Ausschnitte, andere Sprachen, Werbung/Schnitte sowie abgebrochene oder verspätete Suchergebnisse. Erfolgsquote, falsche Treffer, Positionsfehler, Suchdauer und CPU-/Speicherbedarf getrennt messen. Falsche Treffer sind besonders kritisch, weil sie ungewolltes Spulen auslösen könnten.

Als vorläufiges Ziel kann der im MVP verwendete Grenzwert von 500 ms dienen. Er ist ausdrücklich **noch kein Ergebnis der automatischen Erkennung**. Die vorhandenen Demo-Videos werden mit `-an` ohne Audio erzeugt und reichen für einen Audio-Fingerprinting-Test nicht aus; dafür werden zusätzliche Testquellen mit bekannter Ton-/Bildzuordnung benötigt.

Heute erneut geprüft: `npm test` mit 32 bestandenen Tests sowie `npm run check` mit gültigem Manifest und 28 syntaktisch geprüften JavaScript-Dateien. Die HTTP-Tests liefen nach Freigabe lokaler Netzwerkbuchsen erfolgreich. Es wurden keine neuen Browser-, Capture- oder Anbieter-Tests durchgeführt. Der Anwendungscode wurde für diese Recherche nicht verändert.
