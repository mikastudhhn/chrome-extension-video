// Chrome Web Store package: there is no self-installed update to recover or complete.
export const recovery = { pending: false, blocked: false, message: '' };
export const updateRecovery = Promise.resolve();
export async function completeUpdate() { throw new Error('Diese Installation aktualisiert Chrome über den Chrome Web Store.'); }
