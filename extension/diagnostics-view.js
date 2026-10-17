import { serializeDiagnosticReport } from './diagnostics.js';

export const DIAGNOSTIC_FILENAME = 'video-sync-diagnostics.json';

export function downloadDiagnosticReport(content, document = globalThis.document, urls = URL, schedule = setTimeout) {
  const url = urls.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = DIAGNOSTIC_FILENAME;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Give Chrome time to consume the blob. Closing the popup also revokes it.
    schedule(() => urls.revokeObjectURL(url), 1000);
  }
}

export function mountDiagnostics(root, { request, download = downloadDiagnosticReport }) {
  const get = id => root.querySelector(`#${id}`);
  const exportButton = get('diagnostics-export'), clearButton = get('diagnostics-clear');
  const feedback = get('diagnostics-feedback'), availability = get('diagnostics-availability');
  let available = false, busy = false, blocked = false, channel, revision = 0;

  function render() {
    root.setAttribute('aria-busy', String(busy));
    for (const button of [exportButton, clearButton]) {
      button.disabled = !available;
      button.setAttribute('aria-disabled', String(!available || busy || blocked));
    }
    availability.hidden = available;
  }

  async function act(action) {
    if (!available || busy || blocked) return;
    busy = true;
    const started = revision;
    feedback.textContent = action === 'diagnostics-export' ? 'Export wird vorbereitet …' : 'Diagnose wird gelöscht …';
    render();
    try {
      const result = await request(action);
      if (started !== revision) return;
      if (action === 'diagnostics-export') {
        const content = serializeDiagnosticReport(result);
        download(content);
        feedback.textContent = 'JSON-Download gestartet. Der lokale Diagnosepuffer bleibt erhalten.';
      } else {
        if (result?.cleared !== true) throw new Error('Deletion not acknowledged');
        feedback.textContent = 'Lokale Diagnose gelöscht. Neue Ereignisse werden wieder erfasst. Bereits exportierte Dateien bleiben erhalten.';
      }
    } catch {
      if (started === revision) feedback.textContent = action === 'diagnostics-export'
        ? 'Export nicht möglich. Bitte erneut versuchen.' : 'Löschen nicht bestätigt. Bitte erneut versuchen.';
    } finally {
      busy = false;
      render();
    }
  }

  // Native buttons activate through click, Enter and Space; no parallel key handler.
  exportButton.addEventListener('click', () => { void act('diagnostics-export'); });
  clearButton.addEventListener('click', () => { void act('diagnostics-clear'); });
  render();
  return {
    update(status, actionPending = false) {
      const nextAvailable = status?.diagnosticsAvailable === true;
      if (channel !== status?.channel || available !== nextAvailable) {
        revision++;
        feedback.textContent = '';
      }
      channel = status?.channel;
      available = nextAvailable;
      blocked = actionPending || !!status?.updating;
      render();
    }
  };
}
