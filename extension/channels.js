// The selected channel only chooses which release stream the updater follows.
// Every package contains one runtime; Dev additionally enables automatic reloads.
export function channelName(value, build = {}) {
  if (value === 'local' && build.local?.branch) return 'local';
  return value === 'experimental' ? 'experimental' : 'stable';
}

export function channelOptions(build = {}, development = null, selected = 'stable') {
  return [
    { value: 'stable', label: 'Stable' },
    { value: 'experimental', label: 'Experimental' },
    ...(build.local?.branch && (development?.online || selected === 'local')
      ? [{ value: 'local', label: `Dev · ${development?.branch || build.local.branch}${development?.online ? '' : ' · offline'}` }] : [])
  ];
}

export function validateChannelSwitch(channel, build = {}, development = null, selected = 'stable') {
  if (!channelOptions(build, development, selected).some(option => option.value === channel)) throw new Error('Unbekannte Version.');
}
