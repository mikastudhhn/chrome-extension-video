// Folder handles and rollback copies stay on this device, outside the package.
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('video-sync-updater', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function stored(key, value) {
  const db = await database();
  const write = arguments.length === 2;
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', write ? 'readwrite' : 'readonly', write ? { durability: 'strict' } : {});
      const store = transaction.objectStore('settings');
      const request = write ? value === undefined ? store.delete(key) : store.put(value, key) : store.get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Speichern abgebrochen.'));
    });
  } finally { db.close(); }
}

// Journal completion and backup rotation must either both commit or both abort.
export async function storeUpdateState(values) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('settings');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Speichern abgebrochen.'));
      try {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) store.delete(key);
          else store.put(value, key);
        }
      } catch (error) {
        // A synchronous DataCloneError must not commit earlier queued deletes.
        transaction.abort();
        reject(error);
      }
    });
  } finally { db.close(); }
}
