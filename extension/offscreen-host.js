import { responseError } from './runtime-errors.js';

// One runtime document per package. Audio diagnostics are a package feature,
// so only packages that enable them request the additional USER_MEDIA reason.
export function createOffscreenHost({ features }) {
  let lifecycle = Promise.resolve();
  const unavailable = () => ({ room: null, local: null, tabId: null, roomStatusUnavailable: true });
  function serializeLifecycle(run) {
    const result = lifecycle.then(run);
    lifecycle = result.catch(() => {});
    return result;
  }

  async function ensureCurrent() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    const audio = (await features()).audioDiagnostics;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: audio ? ['WORKERS', 'USER_MEDIA'] : ['WORKERS'],
      justification: audio ? 'Verbindung und ausdrücklich gestarteter, zeitlich begrenzter Tab-Tontest.' : 'Hintergrundverbindung für die Synchronisation.'
    });
  }

  const ensureOffscreen = () => serializeLifecycle(ensureCurrent);

  async function readStatus(message = { action: 'status' }, create = false) {
    try {
      if (create) await ensureOffscreen();
      else if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) return { room: null };
      return await runtimeRequest(message);
    } catch (error) {
      if (!create) return unavailable();
      throw error;
    }
  }

  async function runtimeRequest(message) {
    // createDocument resolves before the module listener is necessarily registered.
    let response;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' }); break; }
      catch (error) {
        if (!error.message.includes('Receiving end does not exist') || attempt === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!response?.ok) throw responseError(response);
    return response.result;
  }

  async function labRequest(action, extra = {}) {
    let response;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { response = await chrome.runtime.sendMessage({ target: 'capture-lab', action, ...extra }); break; }
      catch (error) {
        if (!error.message.includes('Receiving end does not exist') || attempt === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!response?.ok) throw new Error(response?.error || 'Der Tontest antwortet nicht.');
    return response.result;
  }

  return { ensureOffscreen, readStatus, runtimeRequest, labRequest };
}
