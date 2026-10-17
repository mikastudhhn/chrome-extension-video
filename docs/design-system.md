# Designsystem

Stand 22. September 2026. Gilt für Popup, Einstellungen und Update-Ansicht in `extension/`. Lebende Referenz: `demo/styleguide.html` (im Browser öffnen, benötigt keinen Server).

## Dateien

| Datei | Inhalt | Wer darf sie verwenden |
| --- | --- | --- |
| `extension/tokens.css` | Alle Design-Tokens in drei Ebenen, Light-Standard, Dark-Theme, Forced-Colors | Nur Komponenten und Themes |
| `extension/components.css` | Komponentenbibliothek: Typografie, Buttons, Felder, Karten, Hinweise, Status, Disclosure, Kopf/Fuß, Layout-Helfer | Jede Ansicht |
| `extension/popup.css` | Fester Popup-Rahmen und Layout der Ansichten (Setup, Lobby, Raum, Einrichtung, Einstellungen) | Nur `popup.html` |
| `extension/updates-view.css` | Layout der Update-Ansicht (Popup-Unterseite und eigener Tab) | Nur die Update-Ansicht |
| `extension/updates.css` | Seitenlayout des eigenständigen Update-Tabs | Nur `updates.html` |
| `extension/theme-init.js` | Klassisches Skript im `<head>`: löst `chrome.storage.local.theme` (`light`, `dark`, `system`) in `data-theme` auf | Jede HTML-Seite der Extension |

## Drei Token-Ebenen

1. **Primitive** (`--palette-*`, `--size-*`, `--font-*`): Rohwerte. Werden nie direkt in Komponenten verwendet.
2. **Semantische Rollen** (`--color-*`, `--text-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--motion-*`): die einzige Ebene, die Komponenten benutzen. Ein Theme überschreibt ausschließlich diese Ebene.
3. **Komponenten-Tokens** (`--control-*`, `--card-*`, `--row-*`, `--popup-*`, `--hero-art-size`, `--page-padding`, `--section-gap`): aus Ebene 2 abgeleitet.

### Farbrollen

| Rolle | Verwendung |
| --- | --- |
| `--color-bg`, `--color-surface`, `--color-surface-muted`, `--color-surface-hover` | Seite (hellgrau), Karte und Zeile (weiß), Zeile in einer Karte (gedämpft), Hover |
| `--color-field` | Eingabefelder und Code-Zellen: leicht gefüllt mit dünnem Rand |
| `--color-border`, `--color-border-strong` | Trennlinien; Feldränder (mindestens 3:1) |
| `--color-text`, `--color-text-muted`, `--color-text-disabled` | Text stark, gedämpft, deaktiviert |
| `--color-accent`, `--color-accent-hover`, `--color-accent-active`, `--color-on-accent` | Primäraktion und Text darauf |
| `--color-accent-soft`, `--color-accent-soft-hover` | Sekundäraktion, bereite Teilnehmer, Badges |
| `--color-focus` | Fokusring |
| `--color-success`, `--color-warning*`, `--color-danger*` | Status, Hinweise, gefährliche Aktionen |

Der Test `tests/popup-experience.test.js` misst die Kontraste der Rollenpaare für Light und Dark. Neue Rollen dort ergänzen.

### Typografie und Abstände

- Schriftgrößen `--text-xs` bis `--text-2xl` (11 bis 26 px bei 14 px Basis), Gewichte `--weight-regular` bis `--weight-bold`, Zeilenhöhen `--leading-tight` bis `--leading-relaxed`.
- Abstände `--space-1` bis `--space-8` auf 4-px-Raster. Layout-Helfer: `.stack` (12 px), `.stack-tight` (8 px), `.stack-loose` (16 px), `.row`, `.cluster`.
- Radien `--radius-sm` (Icon-Kacheln), `--radius-md` (Controls, Zeilen), `--radius-lg` (Karten), `--radius-xl` (Hero-Kachel), `--radius-full`.

## Popup-Rahmen

Jede Ansicht hat dieselbe Größe: `--popup-width` × `--popup-height` (360 × 560 px, Chrome erlaubt höchstens 600 × 800). `body` ist eine Flex-Spalte aus drei festen Zonen:

1. `.app-header`: Marke, Wortmarke, Kanal-Badge, Zahnrad.
2. `main`: die einzige scrollende Fläche. Enthält Update-Banner, Fehlerkarte und genau eine sichtbare `.page` (`#onboarding`, `#player-page`, `#settings`, `#updates-page`).
3. `#page-actions`: fester Aktionsbereich unter `main` mit einer `.actions-group` pro Ansicht (`#onboarding-actions`, `#player-actions`). Hier steht die eine primäre Aktion des Bildschirms, darunter höchstens ein Textbutton. Gruppen ohne sichtbare Kinder und der ganze Bereich klappen per CSS `:has()` zu.

Die Buttons behalten ihre IDs, liegen aber außerhalb ihrer Sektion. Deshalb setzen `popup-view.js` (`create`, `copy`, `ready`, `unblock`, `playback`) und `onboarding.js` (`data-step-action`) deren `hidden` ausdrücklich. Onboarding-Submit-Buttons hängen per `form="…"` an ihrem Formular.

## Komponenten

- **Hero:** `.hero` mit `.hero-art` (Kachel mit Glyphe oder Icon), Titel und einem Satz. Für Willkommen, „Alles bereit“ und den Leerzustand „Video verbinden“; die einzige zentrierte Komponente.
- **Zeilen:** `.list` aus `.list-row` (Icon-Kachel `.row-icon`, `.row-main` mit optionalem `.row-sub`, `.row-trailing`, `.chevron`), `.control-row` (Label links, kompaktes Select rechts), `.member[data-ready]`. Auf der Seite weiß mit Rand, innerhalb einer `.card` gedämpft ohne Rand.
- **Karten:** `.card` mit `.card-title` (`.card-icon` + gedämpftes Label). Einstellungen sind eine Karte je Gruppe.
- **Buttons:** `.primary`, `.secondary`, `.text-button`, `.danger`, `.icon-button`; Modifikatoren `.full-width`, `.compact`. Deaktiviert ist immer umrandet ohne Füllung, damit es sich von `.secondary` unterscheidet. Ein Link, der wie ein Control wirkt (z. B. die Release-Seite im Update-Banner), trägt `a.icon-button` und erhält dieselbe Box, denselben Hover und dieselbe Bewegung wie ein `<button>`. Hover-Regeln für Buttons verwenden deshalb `:not(:disabled)`, nie `:enabled`, das auf Links nicht zutrifft. `.round` macht Icon-Buttons zur gefüllten Akzentscheibe beim Hover; im Banner stehen Release-Link und Installieren als zwei gleiche runde Icon-Buttons mit `--space-1` Abstand.
- **Felder:** `label` + `input`/`select`/`textarea` in `.field`, Hinweis als `.hint`, Fehler als `.field-error` oder `data-error="true"`, Aktionen in `.field-actions`.
- **Hinweise:** `.callout` und `.action-error` (mit `.dismiss-error`) sind ruhige weiße Karten mit einem kleinen Tonpunkt; der Text bleibt in der normalen Textfarbe.
- **Status:** `.status-dot` (`data-tone="attention" | "muted"`), `.badge` (`data-tone="success" | "attention"`), `.member[data-ready]`.
- **Gliederung:** `.section` mit `.section-title`, `details`/`summary` mit eigenem Chevron, `.separator`, `.divider`.
- **Rahmen:** `.app-header` mit `.mark`, `.page-heading` (Zurück-Pfeil + Titel), `.page-actions` mit `.actions-group`, `.app-footer`.

## Regeln

1. Eine primäre Aktion pro Bildschirm, immer im festen Aktionsbereich unten. Alles andere ist `.secondary` oder `.text-button`.
2. Alle Ansichten gleich groß; Inhalt scrollt in `main`, nie das Popup. Inhalte linksbündig an einer Kante, Buttons in voller Breite; nur `.hero` ist zentriert.
3. Zustand ist sichtbar: verbunden, wartet, bereit, Fehler haben je eine eigene Form und Farbe.
4. Erklärtext nur dort, wo eine Entscheidung ansteht. Nachrangiges liegt hinter `details`.
5. Keine Rohfarben und keine Rohgrößen ab 4 px außerhalb von `tokens.css`. `npm run check` prüft das (`scripts/check-design-tokens.js`); begründete Ausnahmen tragen `/* px-ok */`.
6. Element-IDs, die `scripts/e2e-ux.js` und `scripts/e2e-popup.js` verwenden, bleiben stabil. Gestaltung ändert Klassen und Struktur, nicht IDs.
7. Eine Akzentfarbe. Warnfarbe nur als Punkt, Rand oder Text, nie als große Fläche.

## Themes

Eingebaut: Light (Standard), Dark, System. `theme-init.js` setzt `data-theme="light|dark"` vor dem ersten Paint; Ansichten schreiben nur `chrome.storage.local.theme`. Ein späteres eigenes Theme überschreibt die semantische Ebene per `[data-theme="<name>"]` oder per gespeicherter Rollen-Liste, ohne Komponenten anzufassen. Marke (Icon, Wortmarke, Grün) ist offen; die Grünpalette ist als Standard-Theme austauschbar.
