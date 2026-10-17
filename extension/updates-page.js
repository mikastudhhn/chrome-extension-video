import { versionDisplayState } from './version-label.js';
import { mountUpdates } from './updates.js';
import { StatusFeed, observeStatus } from './status-feed.js';

const updates = mountUpdates(document.getElementById('updates-content'), { readStatus: () => feed.refresh() });
const feed = new StatusFeed({
  prepare: versionDisplayState,
  request: (action, extra) => chrome.runtime.sendMessage({ target: 'background', type: 'ui', action: action === 'status' ? 'update-status' : action, ...extra }),
  changed: state => { void updates.refresh(state); },
  visible: () => !document.hidden,
  interval: state => state?.updating || state?.development ? 1000 : state?.room && !state?.lifecycle ? 1500 : null
});
observeStatus(feed);
await feed.refresh();
