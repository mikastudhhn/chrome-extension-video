const channelLabel = channel => channel === 'stable' ? 'Stable' : channel === 'experimental' ? 'Experimental' : 'bisheriger Kanal';

// Text for a pending downgrade/permission review; plain text only (rendered
// through textContent), one change per line.
export function confirmationPresentation(review) {
  const summary = review.downgrade
    ? `Der Wechsel von ${channelLabel(review.fromChannel)} zu ${channelLabel(review.channel)} installiert Version ${review.to}. Sie ist ${review.older ? 'älter als' : 'gleich alt wie'} die installierte Version ${review.from}. Einstellungen bleiben erhalten.`
    : `Version ${review.to} verlangt zusätzliche Rechte. Chrome übernimmt sie beim Neustart der Erweiterung ohne weitere Nachfrage.`;
  const details = review.changes.map(change => `${change.label}: ${change.entries.join(', ')}`).join('\n');
  return { summary: review.downgrade && review.changes.length ? `${summary} Außerdem verlangt das Paket zusätzliche Rechte.` : summary, details };
}

export function updatePresentation(update) {
  const accessLabels = {
    missing: '', public: 'Optional', unverified: 'Gespeichert · ungeprüft', verified: 'Zugang geprüft',
    'invalid-token': 'Ungültig / abgelaufen', forbidden: 'Berechtigung fehlt', 'not-found': 'Releases nicht erreichbar',
    'rate-limited': 'Anfragelimit erreicht', unavailable: 'Derzeit nicht prüfbar'
  };
  // Public releases need no token: a successful check without one is not a
  // verified token, and a missing token is not missing setup.
  const saved = update.access?.status || (update.configured ? 'unverified' : 'missing');
  const accessStatus = update.hasToken === false && saved === 'verified' ? 'public' : saved;
  return {
    heading: !update.configured ? 'Updates einrichten' : update.error ? 'Prüfung fehlgeschlagen'
      : update.available ? 'Update verfügbar' : update.releaseState === 'no-release' ? 'Kein passendes Release'
        : update.releaseState === 'current' ? 'Alles aktuell' : 'Bereit für Updates',
    accessLabel: accessLabels[accessStatus] ?? accessLabels.unverified,
    // The check cadence lives on the last-check line; the status only carries
    // what the heading cannot say on its own.
    status: update.error || (!update.configured ? 'GitHub-Zugang einmal einrichten.'
      : update.releaseState === 'no-release' ? 'Für diesen Kanal wurde kein installierbares Release gefunden.'
        : update.available && update.confirmDowngrade ? 'Kanalwechsel: Ist das Paket nicht neuer als die installierte Version, wird vor der Installation um Bestätigung gebeten.' : ''),
    needsAccess: !update.configured || ['invalid-token', 'forbidden', 'not-found'].includes(accessStatus)
  };
}

export const updatesMarkup = `
    <h2 id="updates-heading" aria-live="polite" tabindex="-1">Updates werden geladen …</h2>
    <p id="updates-installed"></p>
    <p id="updates-message" role="status"></p>
    <p id="updates-recovery-help" role="status" hidden></p>
    <div class="recovery-actions"><button id="updates-restore" class="secondary" hidden>Vorherige Version wiederherstellen</button><button id="updates-verify-repair" class="text-button" hidden>Installation prüfen</button></div>
    <p id="updates-error" role="alert" hidden></p>
    <div id="updates-source-panel" hidden><p>Diese Installation lädt direkt die Quelldateien. Für die lokale Entwicklung einmal <code>npm run dev</code> starten und den Ordner <code>dist/development/extension</code> laden. Dort erscheint dein aktueller Branch zusätzlich zu Stable und Experimental.</p></div>
    <div id="updates-release-panel">
      <p id="updates-update-status" role="status">Version wird geprüft …</p>
      <div id="updates-release" class="update-banner release-row" hidden>
        <span id="updates-target" class="update-banner-title"></span>
        <a id="updates-changelog" class="icon-button round" target="_blank" rel="noopener noreferrer" aria-label="Release-Seite öffnen" title="Release-Seite öffnen" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
        <button id="updates-install" class="icon-button round ring" aria-label="Jetzt aktualisieren" title="Jetzt aktualisieren" hidden>
          <svg class="ring-svg" viewBox="0 0 40 40" aria-hidden="true"><circle class="ring-track" cx="20" cy="20" r="18"/><circle class="ring-value" cx="20" cy="20" r="18"/></svg>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>
        </button>
      </div>
      <section id="updates-confirm" role="alert" aria-labelledby="updates-confirm-heading" hidden>
        <h3 id="updates-confirm-heading">Bestätigung erforderlich</h3>
        <p id="updates-confirm-summary"></p>
        <p id="updates-confirm-details"></p>
        <div class="confirm-actions"><button id="updates-confirm-install" class="primary">Bestätigen &amp; installieren</button><button id="updates-confirm-cancel" class="text-button">Abbrechen</button></div>
      </section>
      <p id="updates-last-check" class="hint" hidden></p>
      <p id="updates-room-block" role="status" hidden>Für Ordnerzugriff und Installation zuerst den Raum verlassen.</p>
      <button id="updates-check" class="secondary" hidden>Jetzt prüfen</button>
      <section id="updates-local-panel" class="local-updates" hidden aria-labelledby="updates-local-heading">
        <h3 id="updates-local-heading">Live-Entwicklung</h3>
        <p class="hint">Der lokale Helfer aktualisiert diesen Dev-Ordner. Downloads für Stable und Experimental werden separat installiert.</p>
        <div id="updates-development-controls" hidden></div>
      </section>
      <details id="updates-setup">
        <summary>GitHub-Token<span id="updates-access-status"></span></summary>
        <p id="updates-token-description" class="hint">Optional. Erhöht nur die Abfragegrenze von 60 auf 5.000 Anfragen pro Stunde.</p>
        <label for="updates-token">GitHub-Token</label>
        <input id="updates-token" aria-describedby="updates-token-description" type="password" autocomplete="off" spellcheck="false" placeholder="Token einfügen">
        <button id="updates-save-token" class="primary">Speichern &amp; prüfen</button>
        <button id="updates-forget-token" class="text-button" hidden>Token entfernen</button>
        <details id="updates-token-help">
          <summary>Token erstellen</summary>
          <p class="hint">Ein Fine-grained Token mit „Public repositories (read-only)“ reicht, weitere Berechtigungen sind nicht nötig. Der Token bleibt in diesem Browser und wird nur an GitHub gesendet.</p>
          <p><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub-Token erstellen ↗</a></p>
        </details>
      </details>
      <details id="updates-options">
        <summary>Weitere Optionen</summary>
        <section id="updates-preview-setting" hidden>
          <label class="preview-toggle" for="updates-show-preview"><input id="updates-show-preview" type="checkbox" aria-describedby="updates-preview-hint">Preview-Nummer anzeigen</label>
          <p id="updates-preview-hint" class="hint"></p>
        </section>
        <section id="updates-folder-setting" aria-labelledby="updates-folder-heading">
          <div class="setting-row">
            <div><h3 id="updates-folder-heading">Installationsordner</h3><p id="updates-folder-status" role="status">Wird geladen …</p></div>
            <button id="updates-folder" class="text-button">Auswählen</button>
          </div>
          <p id="updates-folder-warning" class="hint" hidden></p>
          <details id="updates-folder-help">
            <summary>Ordner finden</summary>
            <p class="hint">Wähle den in Chrome geladenen Ordner mit <code>manifest.json</code>, meist <code>video-sync/extension</code>. Er wird für weitere Updates gespeichert.</p>
            <button id="updates-show-installation" class="text-button">In Chrome anzeigen ↗</button>
          </details>
        </section>
        <div class="advanced-actions">
          <a id="updates-release-link" target="_blank" rel="noopener noreferrer">Manuell herunterladen ↗</a>
        </div>
      </details>
    </div>
`;
