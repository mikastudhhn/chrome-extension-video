// Display the installed candidate identity, never the newest available release.
export function engineVersionLabel(state) {
  if (state?.channel === 'experimental' && state.showExperimentalPreview &&
      /^v\d+\.\d+\.\d+-preview\.\d+$/.test(state.experimentalTag || '')) {
    return state.experimentalTag.slice(1);
  }
  return state?.engineVersion || '…';
}

// A Dev popup can load new files before its background has been reloaded.
// Read this UI preference from storage, independently of background versions.
export async function versionDisplayState(state) {
  const { showExperimentalPreview } = await chrome.storage.local.get('showExperimentalPreview');
  return { ...state, showExperimentalPreview: showExperimentalPreview === true };
}
