import { runUpdate } from './update-runner.js';
import { recoveryStatus } from './update-recovery.js';

export let recovery;
export const updateRecovery = (async () => {
  recovery = await recoveryStatus();
  const { updateLock } = await chrome.storage.session.get('updateLock');
  if (recovery.pending || updateLock) {
    await chrome.storage.session.set({ updateOperation: { error: recovery.message || 'Updatevorgang unterbrochen. Bitte den angezeigten Installationsstand prüfen.' } });
  }
  await chrome.storage.session.remove('updateLock');
})();
export async function completeUpdate(options) {
  // Extension API activity keeps this worker alive while downloading/writing.
  // No popup or tab is needed, including while a native chooser has focus.
  const keepAlive = setInterval(() => void chrome.storage.session.get('updateLock'), 20000);
  try {
    const result = await runUpdate({ ...options, progress: (done, total) => {
      return chrome.storage.session.set({ updateOperation: { message: `Dateien aktualisieren: ${done}/${total}`, progress: { done, total } } });
    } });
    await chrome.storage.local.remove('updateResults');
    await chrome.storage.local.set({ updateCompleted: result.outcome });
    recovery = await recoveryStatus();
    await chrome.storage.session.remove('updateLock');
    chrome.runtime.reload();
  } catch (error) {
    recovery = await recoveryStatus();
    // A required confirmation is not a failure: the view shows the review and
    // a later click sends its id back with the next installation request.
    await chrome.storage.session.set({ updateOperation: { error: error.message, ...(error.confirmation ? { confirmation: error.confirmation } : {}) } });
    await chrome.storage.session.remove('updateLock');
  } finally {
    clearInterval(keepAlive);
  }
}

