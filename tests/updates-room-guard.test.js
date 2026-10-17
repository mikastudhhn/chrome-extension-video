import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUpdates } from '../extension/updates.js';

// Minimal view/storage boundary; native picker behavior is covered separately
// by browser tests. Here the invariant is zero prompts for an active room.
function view(t, { savedDirectory, activeClick = true, recovery, githubGranted = true, grantGithub = true, expireOnPrompt = false, operation } = {}) {
  const globals = ['chrome', 'indexedDB', 'window', 'navigator'];
  const descriptors = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => { for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  const controls = new Map(), calls = [];
  let status = { recovery, channel: 'stable', channels: [{ value: 'stable', label: 'Stable' }], engineVersion: '0.5.0',
    updates: { configured: true, available: true, releaseState: 'available', tag: 'v0.6.0' }, updateOperation: operation };
  const root = {
    ownerDocument: { activeElement: null, body: {} },
    checkVisibility: () => true,
    contains: control => [...controls.values()].includes(control),
    set innerHTML(value) {
      for (const match of value.matchAll(/<(\w+)[^>]*id="updates-([^"]+)"/g)) {
        controls.set(match[2], { tag: match[1], setAttribute() {}, removeAttribute() {}, textContent: '', hidden: false, disabled: false, dataset: {}, style: { setProperty() {}, removeProperty() {} },
          addEventListener(type, listener) { this[`on${type}`] = listener; },
          click() { if (!this.disabled) this.onclick?.(); },
          checkVisibility() { return !this.hidden; },
          focus() { root.ownerDocument.activeElement = this; } });
      }
    },
    querySelector: selector => controls.get(selector.replace('#updates-', '')),
    querySelectorAll: () => [...controls.values()].filter(item => ['button', 'input'].includes(item.tag)),
    setAttribute() {}
  };
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.5.0' }), sendMessage: async ({ action }) => {
      calls.push(action); return { ok: true, result: structuredClone(status) };
    } }, storage: { local: { get: async () => ({}) } },
    permissions: {
      contains: async () => githubGranted,
      request: async () => {
        calls.push('github-permission');
        if (expireOnPrompt) navigator.userActivation.isActive = false;
        githubGranted = grantGithub;
        return grantGithub;
      }
    }
  };
  globalThis.indexedDB = { open() {
    const open = {};
    queueMicrotask(() => {
      open.result = { close() {}, transaction() {
        const transaction = { objectStore: () => ({ get: key => ({ result: key === 'directory' ? savedDirectory : undefined }) }) };
        queueMicrotask(() => transaction.oncomplete()); return transaction;
      } };
      open.onsuccess();
    });
    return open;
  } };
  globalThis.window = { showDirectoryPicker: async () => { calls.push('picker'); throw Object.assign(new Error('cancel'), { name: 'AbortError' }); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { isActive: activeClick } } });
  const updates = mountUpdates(root);
  return { updates, controls, calls, root, setRoom: room => { status = { ...status, room }; }, setRoomUnavailable: () => { status = { ...status, roomStatusUnavailable: true }; } };
}

test('known room disables folder/install/restore and their handlers cannot open a picker', async t => {
  const ui = view(t); ui.setRoom({ code: 'fixture' });
  await ui.updates.refresh();
  for (const id of ['install', 'restore', 'folder', 'verify-repair']) {
    assert.equal(ui.controls.get(id).disabled, true);
    await ui.controls.get(id).onclick();
  }
  assert.equal(ui.controls.get('room-block').hidden, false);
  assert.deepEqual(ui.calls, ['update-status']);
});

test('a room entered after rendering blocks both picker and saved-folder permission prompts', async t => {
  let permissions = 0;
  for (const savedDirectory of [undefined, { name: 'saved', queryPermission: async () => 'prompt', requestPermission: async () => { permissions++; return 'granted'; } }]) {
    await t.test(savedDirectory ? 'saved folder' : 'no folder', async t => {
    const ui = view(t, { savedDirectory });
    await ui.updates.refresh();
    assert.equal(ui.controls.get('install').disabled, false);
    ui.setRoom({ code: 'new-room' });
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status']);
    assert.equal(permissions, 0);
    assert.equal(ui.controls.get('install').disabled, true);
    assert.match(ui.controls.get('error').textContent, /Raum verlassen/);
    });
  }
});

test('a cleared room permits picker cancellation; an expired click requests another click without prompting', async t => {
  for (const activeClick of [true, false]) {
    await t.test(activeClick ? 'active click' : 'expired click', async t => {
    const ui = view(t, { activeClick });
    await ui.updates.refresh();
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, activeClick ? ['update-status', 'update-status', 'picker'] : ['update-status', 'update-status']);
    assert.match(ui.controls.get(activeClick ? 'message' : 'error').textContent, activeClick ? /abgebrochen/ : /erneut anklicken/);
    });
  }
});


test('GitHub download access is requested only after the room preflight and only when missing', async t => {
  await t.test('a room entered after rendering prevents the GitHub prompt', async t => {
    const ui = view(t, { githubGranted: false });
    await ui.updates.refresh();
    ui.setRoom({ code: 'new-room' });
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status']);
  });
  await t.test('a missing grant is requested before the picker in the same click', async t => {
    const ui = view(t, { githubGranted: false });
    await ui.updates.refresh();
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status', 'github-permission', 'picker']);
    await ui.controls.get('install').onclick();
    assert.equal(ui.calls.filter(call => call === 'github-permission').length, 1, 'a granted permission is not requested again');
  });
  await t.test('a dialog that outlasts the click asks for another click', async t => {
    const ui = view(t, { githubGranted: false, expireOnPrompt: true });
    await ui.updates.refresh();
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status', 'github-permission']);
    assert.match(ui.controls.get('error').textContent, /Zugriff auf GitHub erlaubt\. Bitte die Aktion erneut anklicken/);
  });
  await t.test('a denied grant stops before the picker', async t => {
    const ui = view(t, { githubGranted: false, grantGithub: false });
    await ui.updates.refresh();
    await ui.controls.get('install').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status', 'github-permission']);
    assert.match(ui.controls.get('error').textContent, /Ohne Zugriff auf GitHub/);
  });
  await t.test('restoring a local backup never asks for GitHub access', async t => {
    const ui = view(t, { githubGranted: false, recovery: { pending: false, canRestore: true } });
    await ui.updates.refresh();
    await ui.controls.get('restore').onclick();
    assert.deepEqual(ui.calls, ['update-status', 'update-status', 'picker']);
  });
});

test('unavailable player status explains why folder actions are disabled', async t => {
  const ui = view(t);
  ui.setRoomUnavailable();
  await ui.updates.refresh();
  assert.equal(ui.controls.get('install').disabled, true);
  assert.equal(ui.controls.get('folder').disabled, true);
  assert.equal(ui.controls.get('room-block').hidden, false);
  assert.match(ui.controls.get('room-block').textContent, /Raumstatus derzeit nicht prüfbar/);
});


test('an unverifiable recovery state offers verification without installation or restore', async t => {
  const ui = view(t, { recovery: { pending: true, blocked: true, canRestore: false, message: 'Unbekanntes Backupformat' } });
  await ui.updates.refresh();
  assert.equal(ui.controls.get('heading').textContent, 'Wiederherstellung erforderlich');
  assert.equal(ui.controls.get('access-status').textContent, 'Gespeichert · ungeprüft');
  assert.equal(ui.controls.get('install').hidden, true);
  assert.equal(ui.controls.get('restore').hidden, true);
  assert.equal(ui.controls.get('verify-repair').hidden, false);
  assert.equal(ui.controls.get('recovery-help').hidden, false);
  assert.equal(ui.controls.get('folder').disabled, false);
});


test('folder cancellation restores native focus after the busy state blurred the action', async t => {
  const ui = view(t);
  await ui.updates.refresh();
  const install = ui.controls.get('install');
  install.focus();
  window.showDirectoryPicker = async () => {
    ui.root.ownerDocument.activeElement = ui.root.ownerDocument.body;
    throw Object.assign(new Error('cancel'), { name: 'AbortError' });
  };
  await install.onclick();
  assert.equal(ui.root.ownerDocument.activeElement, install);
  assert.equal(install.disabled, false);
});

test('a completed update action does not steal focus from a different link', async t => {
  const ui = view(t);
  await ui.updates.refresh();
  const install = ui.controls.get('install');
  const link = ui.controls.get('release-link');
  install.focus();
  window.showDirectoryPicker = async () => {
    link.focus();
    throw Object.assign(new Error('cancel'), { name: 'AbortError' });
  };
  await install.onclick();
  assert.equal(ui.root.ownerDocument.activeElement, link);
});

test('when an action becomes unavailable its focus moves to the update heading', async t => {
  const ui = view(t);
  await ui.updates.refresh();
  const install = ui.controls.get('install');
  install.focus();
  ui.setRoom({ code: 'joined-elsewhere' });
  await install.onclick();
  assert.equal(install.disabled, true);
  assert.equal(ui.root.ownerDocument.activeElement, ui.controls.get('heading'));
});

test('a pending review replaces the install button, shows the changes and can be confirmed or dismissed', async t => {
  const confirmation = { id: 'c'.repeat(64), from: '0.6.0.15', to: '0.6.0.16', fromChannel: 'stable', channel: 'stable', downgrade: false, older: false,
    changes: [{ key: 'host_permissions', label: 'Website-Zugriff', entries: ['https://*/*'] }] };
  const ui = view(t, { operation: { error: 'Bestätigung erforderlich: …', confirmation } });
  await ui.updates.refresh();
  assert.equal(ui.controls.get('confirm').hidden, false);
  assert.equal(ui.controls.get('install').hidden, true);
  assert.equal(ui.controls.get('error').hidden, true, 'the review is not shown as a failure');
  assert.match(ui.controls.get('confirm-summary').textContent, /zusätzliche Rechte/);
  assert.equal(ui.controls.get('confirm-details').textContent, 'Website-Zugriff: https://*/*');
  ui.setRoom({ code: 'fixture' });
  await ui.updates.refresh();
  assert.equal(ui.controls.get('confirm-install').disabled, true, 'an active room blocks the confirmed installation too');
  await ui.controls.get('confirm-install').onclick();
  assert.equal(ui.calls.includes('picker'), false);
  await ui.controls.get('confirm-cancel').onclick();
  assert.ok(ui.calls.includes('update-dismiss'));
});
