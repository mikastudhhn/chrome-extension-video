import { serializeDiagnosticReport } from './diagnostics.js';
import { REPORT_ID } from './error-report.js';

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

const PROGRESS = { 'diagnostics-export': 'Export wird vorbereitet …', 'diagnostics-clear': 'Diagnose wird gelöscht …', 'diagnostics-report': 'Fehlerbericht wird gesendet …' };
// Only our own texts; the code selects which one.
function reportFailure(error) {
  if (error?.code === 'RATE_LIMITED') return 'Zu viele Fehlerberichte in kurzer Zeit. Bitte später erneut versuchen.';
  if (error?.code === 'NOT_FOUND') return 'Dieser Verbindungsserver nimmt keine Fehlerberichte an.';
  if (error?.code === 'PERMISSION_DENIED') return 'Der Zugriff auf den Verbindungsserver ist nicht erlaubt. Bitte die Serveradresse in den Einstellungen speichern.';
  return 'Senden nicht möglich. Bitte die Verbindung zum Server prüfen und erneut versuchen.';
}

export function mountDiagnostics(root, { request, download = downloadDiagnosticReport }) {
  const get = id => root.querySelector(`#${id}`);
  const exportButton = get('diagnostics-export'), clearButton = get('diagnostics-clear'), sendButton = get('diagnostics-send');
  const note = get('diagnostics-note'), feedback = get('diagnostics-feedback'), availability = get('diagnostics-availability');
  let available = false, busy = false, blocked = false, channel, revision = 0;

  function render() {
    root.setAttribute('aria-busy', String(busy));
    for (const button of [sendButton, exportButton, clearButton]) {
      button.disabled = !available;
      button.setAttribute('aria-disabled', String(!available || busy || blocked));
    }
    note.disabled = !available;
    availability.hidden = available;
  }

  async function act(action) {
    if (!available || busy || blocked) return;
    busy = true;
    const started = revision;
    feedback.textContent = PROGRESS[action];
    render();
    try {
      // Sending happens only here, after the person's click; the note is theirs.
      const result = await request(action, action === 'diagnostics-report' ? { note: note.value } : {});
      if (started !== revision) return;
      if (action === 'diagnostics-export') {
        const content = serializeDiagnosticReport(result);
        download(content);
        feedback.textContent = 'JSON-Download gestartet. Der lokale Diagnosepuffer bleibt erhalten.';
      } else if (action === 'diagnostics-report') {
        if (!REPORT_ID.test(result?.id)) throw new Error('Report not acknowledged');
        note.value = '';
        feedback.textContent = `Fehlerbericht gesendet. Bericht-ID: ${result.id}. Nenne diese ID, wenn du den Fehler beschreibst.`;
      } else {
        if (result?.cleared !== true) throw new Error('Deletion not acknowledged');
        feedback.textContent = 'Lokale Diagnose gelöscht. Neue Ereignisse werden wieder erfasst. Bereits exportierte Dateien bleiben erhalten.';
      }
    } catch (error) {
      if (started === revision) feedback.textContent = action === 'diagnostics-report' ? reportFailure(error) : action === 'diagnostics-export'
        ? 'Export nicht möglich. Bitte erneut versuchen.' : 'Löschen nicht bestätigt. Bitte erneut versuchen.';
    } finally {
      busy = false;
      render();
    }
  }

  // Native buttons activate through click, Enter and Space; no parallel key handler.
  sendButton.addEventListener('click', () => { void act('diagnostics-report'); });
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
