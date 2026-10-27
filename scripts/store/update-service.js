// Chrome Web Store package: Chrome updates the extension. This replaces the
// GitHub release check; nothing is downloaded or written.
export const UPDATE_INTERVAL_MINUTES = 30;
export async function updateStatus() { return null; }
export async function checkUpdates() { return null; }
export async function configureUpdates() { throw new Error('Diese Installation aktualisiert Chrome über den Chrome Web Store.'); }
