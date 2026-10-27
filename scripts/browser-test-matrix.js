// CI runs every group in its own job; inside a group the suites stay serial and
// are never retried. Every package contains one runtime, so each suite tests one
// candidate package profile. Groups must stay listed in verify.yml.
export const browserGroups = ['core-candidates', 'core-delayed', 'ui', 'updates'];

export function browserMatrix(packages) {
  const stable = packages.stable.extension, experimental = packages.experimental.extension, store = packages.store.extension;
  const suite = (group, name, script, extension, channel, extra = {}) => ({ name, group, script,
    env: { TEST_EXTENSION: extension, TEST_CHANNEL: channel, ...extra } });
  return [
    suite('core-candidates', 'core-stable-candidate', 'e2e.js', stable, 'stable'),
    suite('core-candidates', 'core-experimental-candidate', 'e2e.js', experimental, 'experimental'),
    suite('core-delayed', 'core-delayed-start-stable-candidate', 'e2e.js', stable, 'stable', { TEST_STARTUP_DELAY_MS: '800' }),
    suite('core-delayed', 'core-delayed-start-experimental-candidate', 'e2e.js', experimental, 'experimental', { TEST_STARTUP_DELAY_MS: '800' }),
    suite('ui', 'frames-stable', 'e2e-frames.js', stable, 'stable'),
    suite('ui', 'frames-experimental', 'e2e-frames.js', experimental, 'experimental'),
    suite('ui', 'discovery-stable-candidate', 'e2e-player-discovery.js', stable, 'stable'),
    suite('ui', 'discovery-experimental-candidate', 'e2e-player-discovery.js', experimental, 'experimental'),
    suite('ui', 'ux-stable', 'e2e-ux.js', stable, 'stable'),
    suite('ui', 'ux-experimental', 'e2e-ux.js', experimental, 'experimental'),
    suite('ui', 'popup-stable-package', 'e2e-popup.js', stable, 'stable'),
    suite('ui', 'popup-experimental-package', 'e2e-popup.js', experimental, 'experimental'),
    suite('updates', 'diagnostics-stable-candidate', 'e2e-diagnostics.js', stable, 'stable', { TEST_EXPECT_DIAGNOSTICS: '1' }),
    suite('updates', 'diagnostics-experimental-candidate', 'e2e-diagnostics.js', experimental, 'experimental', { TEST_EXPECT_DIAGNOSTICS: '1' }),
    suite('updates', 'updates-stable', 'e2e-updates.js', stable, 'stable', { TEST_RELEASE_EXTENSION: stable }),
    suite('updates', 'updates-experimental', 'e2e-updates.js', experimental, 'experimental', { TEST_RELEASE_EXTENSION: experimental }),
    suite('updates', 'update-recovery-stable', 'e2e-update-recovery.js', stable, 'stable'),
    suite('updates', 'update-recovery-experimental', 'e2e-update-recovery.js', experimental, 'experimental'),
    suite('ui', 'onboarding', 'e2e-onboarding.js', experimental, '', { TEST_ONBOARDING: '1' }),
    suite('ui', 'store-package', 'e2e-store.js', store, '', { TEST_ONBOARDING: '1' }),
    suite('ui', 'channels-stable-package', 'e2e-channels.js', stable, ''),
    suite('ui', 'channels-experimental-package', 'e2e-channels.js', experimental, ''),
    suite('ui', 'errors-stable-candidate', 'e2e-errors.js', stable, 'stable'),
    suite('ui', 'errors-experimental-candidate', 'e2e-errors.js', experimental, 'experimental'),
    suite('updates', 'development', 'e2e-local-branch.js', experimental, '')
  ];
}

// Explicit reproduction, never substituted for a required matrix entry.
export function browserDiagnostics(packages) {
  return [{ name: 'diagnose-delayed-start', script: 'e2e.js', env: {
    TEST_EXTENSION: packages.stable.extension, TEST_CHANNEL: 'stable', TEST_STARTUP_DELAY_MS: '800'
  } }];
}
