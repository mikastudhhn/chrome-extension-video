// Background requests from a test surface (popup or extension page) over the
// shared 'ui' message contract. A status read that lands while a concurrent
// attach/leave bumps the UI generation is aborted by design; suites read again
// instead of failing on that transient. Every other failure is reported unchanged.
const transientStatus = (action, response) => action === 'status' && response?.failure?.code === 'ABORTED';

export function sendUiMessage(page, action, extra = {}) {
  return page.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type: 'ui', action, ...extra });
}

export async function uiRequest(page, action, extra = {}, { label, attempts = 5, retryDelayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await sendUiMessage(page, action, extra);
    if (transientStatus(action, response) && attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      continue;
    }
    if (!response?.ok) throw new Error(`${label ? `${label}: ` : ''}${response?.error || 'No extension response'}`);
    return response.result;
  }
}

// api(action, extra, surface): the optional surface lets one suite address several installations.
export const extensionApi = (page, options = {}) => (action, extra = {}, surface = page) => uiRequest(surface, action, extra, options);
