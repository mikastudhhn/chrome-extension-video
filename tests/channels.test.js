import test from 'node:test';
import assert from 'node:assert/strict';
import { channelName, channelOptions, validateChannelSwitch } from '../extension/channels.js';

test('new and invalid settings follow the Stable release stream', () => {
  for (const value of [undefined, null, '', 'production', 'unknown']) assert.equal(channelName(value), 'stable');
  assert.equal(channelName('experimental'), 'experimental');
});
test('the current branch exists only in local builds while the helper runs or Dev stays selected', () => {
  const build = { local: { branch: 'ft/my-feature' } };
  const live = { online: true, branch: 'ft/my-feature' };
  assert.deepEqual(channelOptions().map(option => option.value), ['stable', 'experimental']);
  assert.deepEqual(channelOptions(build, live).map(option => option.label), ['Stable', 'Experimental', 'Dev · ft/my-feature']);
  assert.equal(channelName('local'), 'stable');
  assert.equal(channelName('local', build), 'local');
  assert.throws(() => validateChannelSwitch('local', {}), /Unbekannte/);
  validateChannelSwitch('local', build, live);
  assert.deepEqual(channelOptions(build).map(option => option.value), ['stable', 'experimental']);
  assert.throws(() => validateChannelSwitch('local', build), /Unbekannte/);
  assert.equal(channelOptions(build, { online: false }, 'local').at(-1).label, 'Dev · ft/my-feature · offline');
});
test('switches accept only offered release streams', () => {
  assert.throws(() => validateChannelSwitch('main'), /Unbekannte/);
  validateChannelSwitch('experimental');
  validateChannelSwitch('stable');
});
