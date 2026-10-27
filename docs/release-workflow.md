# Main, Arbeitsbranches und Veröffentlichungskanäle

Das Repository verwendet einen gemeinsamen `main` und Arbeitsbranches wie `ft/szenenerkennung`, `fix/verbindung` oder `experiment/neuer-abgleich`. Main ist auf GitHub durch Pull Requests und den erfolgreichen Check `verify` geschützt.

```text
ft/* oder fix/* → geprüfter PR → main → Experimental-Kandidat vX.Y.Z-preview.N
                                             ↓ praktische Abnahme
                                          Stable-Freigabe vX.Y.Z
experiment/* → Draft-PR → bei sicherer Integration nach main
```

Stable und Experimental sind ausschließlich Release-Streams des Updaters. Jedes Paket enthält genau eine Laufzeit; experimentelle Funktionen hängen am Paketprofil (`extension/features.js`).

## Entwicklung

```sh
git switch main
git pull --ff-only
git switch -c ft/meine-funktion
npm run setup:git
npm run dev
```

Einmal `dist/development/extension` als **Video Sync · Dev** laden. Nur bei laufendem Helfer ist **Dev · <Branch>** zusätzlich auswählbar; gültige Änderungen werden dort automatisch aktiviert, solange Auto-Reload nicht pausiert ist. Ablauf und Wiederaufnahme von Räumen: [development.md](development.md).

Vor dem PR `npm test`, `npm run check` und die betroffenen Browser-Szenarien ausführen. Nach erfolgreichem Review und grünen Checks den PR nach Main mergen und lokal den Remote-Stand per Fast-Forward übernehmen. Die Hooks aus `npm run setup:git` verhindern direkte Main-Commits, lokale Main-Merges unveröffentlichter Änderungen sowie Änderungen bestehender Release-Tags. Sie ersetzen nicht den serverseitigen Schutz.

## Experimental-Kandidat

Der Main-Workflow vergibt `vX.Y.Z-preview.N`; X.Y.Z stammt aus der App-Version, N ist die Workflow-Laufnummer. Die numerische Chrome-Version lautet X.Y.Z.N. Ein neuer Versionszyklus benötigt eine neue App-Basisversion, beispielsweise nach `v0.6.0` die Basis `0.6.1`.

CI baut alle Profile **einmal** aus demselben Commit:

- `video-sync-X.Y.Z.N.zip` und `update.json`: Experimental-Paket.
- `video-sync-X.Y.Z.N-stable.zip` und `update-stable.json`: Stable-Kandidat. Experimentelle Funktionen sind darin aus. Dieses Paket ist zur Abnahme bestimmt, noch keine Stable-Veröffentlichung.
- `video-sync-X.Y.Z.N-store.zip`: Chrome-Web-Store-Paket mit Stable-Funktionen, ohne GitHub-Updater ([Chrome Web Store](chrome-web-store.md)). Es wird nicht signiert; Chrome prüft und aktualisiert Store-Installationen selbst.

Alle Pakete durchlaufen die Browserprüfungen. Die Veröffentlichung übernimmt diese Dateien aus dem CI-Artefakt, ohne neu zu bauen. Erst der Job `release` in der geschützten Umgebung `release` signiert `update.json` und `update-stable.json` (abgetrennte Dateien `update.json.sig` und `update-stable.json.sig`); die geprüften Dateien selbst bleiben unverändert. Ohne Schlüssel oder mit einem Schlüssel, der nicht zu `extension/release-key.js` passt, bricht die Veröffentlichung vor jedem Schreibzugriff ab. Releases werden erst nach vollständigem Upload sichtbar; vorhandene Releases und Dateien werden nie ersetzt. PRs erzeugen dieselben Prüf-Artefakte, veröffentlichen aber keine Nutzer-Updates.

Die optionale GitHub-Variable `VIDEO_SYNC_SERVER` wird beim Bau als voreingestellter Server eingefroren. Ohne sie ist localhost voreingestellt; GitHub hostet keinen Verbindungsserver.

## Stable freigeben

Den Stable-Kandidaten aus dem gewünschten Experimental-Release installieren und praktisch prüfen: relevante Anbieter, Berechtigungsdialoge und unterstützte Browser/Betriebssysteme. Die Aufnahme eines Features in Main ist keine Stable-Abnahme.

Nach ausdrücklicher Freigabe durch den Eigentümer:

```sh
npm run promote -- stable --candidate v0.6.0-preview.12 --tested <vollständiger-geprüfter-Commit>
```

Lokal liest der Befehl den Signaturschlüssel aus einer Datei, ohne ihn auszugeben oder zu kopieren:

```sh
RELEASE_SIGNING_KEY_FILE=~/.config/video-sync/release-signing-key.pem npm run promote -- stable --candidate v0.6.0-preview.12 --tested <commit>
```

Alternativ den GitHub-Workflow **Approve Stable candidate** auf Main mit denselben Angaben starten; er läuft in der Umgebung `release` und wartet auf die Freigabe des Eigentümers. Er prüft Kandidat, Commit, Paketprofil, GitHub-Prüfsummen und die CI-Signatur des vorbereiteten Stable-Pakets und signiert dessen unveränderte Bytes anschließend als `update.json.sig` des Stable-Tags. ZIP und `update-stable.json` werden unverändert als ZIP und `update.json` in `v0.6.0` übernommen; nur der Dateiname des ZIPs und die Release-Beschreibung unterscheiden sich. Stable kann einen älteren, abgenommenen Kandidaten übernehmen, während Main und Experimental weiterlaufen. Eine vorhandene Stable-Version wird niemals durch andere Dateien ersetzt. Hat der Kandidat ein `video-sync-X.Y.Z.N-store.zip`, wird es nach Prüfsummen- und Commit-Prüfung ebenfalls unverändert übernommen; dieses ZIP wird danach im Chrome Web Store hochgeladen ([Chrome Web Store](chrome-web-store.md)).

Falls sich die Workflow-Dateien zwischen Kandidat und aktuellem Main unterscheiden, verlangt GitHub zusätzliche Workflow-Schreibrechte für das Anlegen des Releases. Dann den lokalen Befehl mit einem entsprechend berechtigten `gh`-Login verwenden oder für den manuellen Workflow ein auf dieses Repository beschränktes Secret `RELEASE_TOKEN` mit **Contents: write** und **Workflows: write** hinterlegen. Ohne dieses optionale Secret verwendet der Workflow den normalen `GITHUB_TOKEN` ([GitHub-Releases-API](https://docs.github.com/en/rest/releases/releases#create-a-release)).

## Release-Signatur

Updates werden mit einem ECDSA-P-256-Schlüssel (SHA-256) signiert; Format und Prüfung: [updates.md](updates.md#signierte-updates). Der öffentliche Schlüssel liegt in `extension/release-key.js`. Den privaten Schlüssel besitzen nur der Eigentümer (`~/.config/video-sync/release-signing-key.pem`) und das Secret `RELEASE_SIGNING_KEY` der GitHub-Umgebung `release`. Er wird nie ins Repository, in Artefakte, Logs oder Testdaten übernommen; Tests erzeugen eigene Schlüssel.

- `RELEASE_SIGNING_KEY`: PEM-Inhalt (CI-Secret). `RELEASE_SIGNING_KEY_FILE`: Pfad zur PEM-Datei (lokal). Der Inhalt hat Vorrang.
- `npm run release:sign -- <update.json> --tag <tag> --channel <stable|experimental>` erzeugt `<update.json>.sig`; `npm run release:verify -- …` prüft eine Signatur mit dem eingebauten Schlüssel. `--asset` ändert den signierten Dateinamen (Standard: Dateiname), `--public-key <jwk.json>` ersetzt den eingebauten Schlüssel nur für Testschlüssel.
- Wiederholte Läufe verwenden eine bereits hochgeladene Signatur nach Prüfung weiter; veröffentlichte Dateien werden nie ersetzt.
- Schlüsselwechsel: neues Schlüsselpaar erzeugen, `extension/release-key.js` per PR ändern und das erste Release mit neuem Schlüssel noch mit dem alten signieren, damit bestehende Installationen es annehmen. Danach das Secret ersetzen. Bei Verdacht auf einen kompromittierten Schlüssel sofort Secret entfernen, alle Releases prüfen und Nutzer über den manuellen ZIP-Weg (mit `.sha256`) auf eine Version mit neuem Schlüssel umstellen.

## GitHub einrichten (öffentliches Repository)

Diese Einstellungen werden einmalig vom Eigentümer im Repository vorgenommen; der Code setzt sie voraus, ändert sie aber nicht.

1. **Umgebung `release`** (Settings → Environments → New environment): *Required reviewers* = `@mikastudhhn`; *Deployment branches and tags* = nur `main`. Damit wartet jede Veröffentlichung (Experimental-Kandidat nach jedem Main-Merge und Stable-Freigabe) auf die Bestätigung des Eigentümers, bevor der Schlüssel lesbar ist.
2. **Secret `RELEASE_SIGNING_KEY`** als *Environment secret* von `release` anlegen, nicht als Repository-Secret, z. B. `gh secret set RELEASE_SIGNING_KEY --env release < ~/.config/video-sync/release-signing-key.pem`. PR-Läufe und Forks erhalten es nicht.
3. **Fork-PRs** (Settings → Actions → General → *Fork pull request workflows from outside collaborators*): **Require approval for all outside collaborators**. *Workflow permissions* auf *Read repository contents* belassen; die Workflows fordern Schreibrechte nur im Job `release` an.
4. **Tag-Ruleset** (Settings → Rules → Rulesets → New tag ruleset) für `v*`: *Restrict updates*, *Restrict deletions* und *Block force pushes*. Das Anlegen neuer Tags durch den Release-Job bleibt erlaubt; bestehende Release-Tags können nicht verschoben oder gelöscht werden.
5. **Unveränderliche Releases** (Settings → General → Releases → *Enable release immutability*), sofern verfügbar. Der Ablauf ist dafür ausgelegt: Dateien werden in einen Entwurf hochgeladen und erst danach veröffentlicht.
6. **Main-Schutz**: PR-Pflicht und Check `verify` bleiben. Optional *Require review from Code Owners* (`.github/CODEOWNERS`): Änderungen an Workflows, Updater, Signatur und Veröffentlichung brauchen dann die Freigabe von `@mikastudhhn`. Als einziger Maintainer kann der Eigentümer eigene PRs nicht selbst genehmigen und benötigt dafür die Admin-Umgehung.
7. **Dependabot** (`.github/dependabot.yml`) schlägt wöchentlich neue, wieder per Commit-SHA gepinnte Action-Versionen als PR vor; Dependabot-PRs erhalten keine Secrets.

## Langzeitexperimente

Abschaltbare Funktionen schrittweise per PR integrieren und in `extension/features.js` für das Stable-Profil deaktivieren. Beide Profile testen; Nebenwirkungen dürfen nicht bereits beim Import auftreten. Der Tontest ist ein solcher Schalter. Nicht sicher isolierbare Umbauten bleiben auf `experiment/*` und werden regelmäßig mit Main abgeglichen.

## Updater

Der Updater liest veröffentlichte Releases: `vX.Y.Z-preview.N` für Experimental, `vX.Y.Z` für Stable. Kanal, Kandidatentag und exakter Quellcommit sind zusätzlich im Paket gebunden. Paketformat, Prüfungen und Wiederherstellung: [updates.md](updates.md).
