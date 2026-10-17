/* Isolated-world content script, injected only into the document of the video
   the user connected. It turns the page player's data-free intent event into a
   wake-up hint for the offscreen session, which then samples the player itself.
   The page can fire the event too; it carries nothing and is rate-limited, so a
   page can at most cause an earlier sample. No room data ever reaches this script. */
(() => {
  const owner = chrome.runtime.id;
  if (globalThis.__videoSyncBridge === owner) return;
  globalThis.__videoSyncBridge = owner;
  const spacingMs = 100;
  let last = 0, timer = null;
  const send = () => {
    timer = null;
    last = Date.now();
    try { void chrome.runtime.sendMessage({ target: 'offscreen', action: 'player-wake' }).catch(() => {}); }
    catch { document.removeEventListener(`videosync-intent:${owner}`, announce); } // Extension reloaded.
  };
  const announce = () => {
    if (timer !== null) return;
    const wait = spacingMs - (Date.now() - last);
    if (wait <= 0) send(); else timer = setTimeout(send, wait);
  };
  document.addEventListener(`videosync-intent:${owner}`, announce);
})();
