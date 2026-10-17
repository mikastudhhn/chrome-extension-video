import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { chromium, evidence, recordDiagnostic } from './browser-test-context.js';
import { extensionApi } from './browser-test-api.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';
const base = process.env.TEST_SERVER || 'http://127.0.0.1:8787';
const { failureProxy } = await import('./test-proxy.js');
const proxy = await failureProxy(process.env.TEST_SIGNALING_SERVER || base, recordDiagnostic);
const signalingServer = proxy.url;
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const contexts = [];
const profiles = [];
const results = [];
const errors = [];
await mkdir(evidence, { recursive: true });

async function browser(label, version) {
  const profile = await mkdtemp(join(tmpdir(), 'video-sync-test-'));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1200, height: 850 }
  });
  contexts.push(context);
  context.on('page', page => page.on('pageerror', error => errors.push(`${label}: ${error.message}`)));
  context.on('response', response => {
    if (response.status() >= 400 && response.url().startsWith(base) && !response.url().endsWith('/favicon.ico')) errors.push(`${label}: HTTP ${response.status()} ${response.url()}`);
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const video = await context.newPage();
  await video.goto(base);
  if (version === 'b') await video.getByRole('button', { name: 'Version B · +5 Sekunden', exact: true }).click();
  await video.waitForFunction(expected => document.querySelector('video').currentSrc.endsWith(`/scene-${expected}.webm`), version);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 370, height: 740 });
  const tabId = await popup.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, base);
  const api = extensionApi(popup, { label });
  const channel = process.env.TEST_CHANNEL;
  if (channel) await api('set-channel', { channel });
  const runtime = await api('status');
  assert.equal(runtime.channel, channel || 'stable');
  recordDiagnostic({ type: 'runtime', role: label, channel, status: runtime });
  await api('attach', { tabId });
  // Observe calls already made by the real adapter; no extra samples or state
  // changes are introduced by diagnostics.
  await video.evaluate(() => {
    const player = window.__videoSyncPlayer;
    const emit = event => { void window.__videoSyncTestEvent({ type: 'adapter',
      browserAt: performance.timeOrigin + performance.now(), ...event }).catch(() => {}); };
    for (const action of ['sample', 'apply']) {
      const original = player[action];
      player[action] = function (...args) {
        if (action === 'apply') emit({ action, command: args[0], liveTime: document.querySelector('video').currentTime });
        const result = original.apply(this, args);
        const observe = sample => emit({ action: `${action}-result`, sample });
        if (result?.then) void result.then(observe).catch(() => {});
        else observe(result);
        return result;
      };
    }
  });
  return { context, video, popup, api, label };
}

async function until(description, check, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout: ${description} (${JSON.stringify(last)})`);
}

async function time(browser) {
  return browser.video.evaluate(() => {
    const v = document.querySelector('video');
    return { time: v.currentTime, paused: v.paused, buffering: v.readyState < 3 || v.seeking };
  });
}

async function record(name, run) {
  recordDiagnostic({ type: 'scenario-start', name });
  await run(); results.push(name); console.log(`PASS ${name}`);
}

let host, guest;
try {
  host = await browser('host', 'a');
  guest = await browser('guest', 'b');
  if (process.env.EXPECT_DEFAULT_SERVER) assert.equal(await host.popup.locator('#server').inputValue(), process.env.EXPECT_DEFAULT_SERVER);
  const created = await host.api('create', { server: signalingServer });
  assert.match(created.room.code, /^[A-Z2-9]{6}$/, 'Every channel shares a six-character invitation');
  await guest.api('join', { server: signalingServer, code: created.room.code });
  assert.equal((await guest.api('status')).room.code, created.room.code);
  await record('two extension profiles connect through the HTTPS relay', async () => {
    await until('HTTPS connection', async () => (await host.api('status')).room?.connected && (await guest.api('status')).room?.connected, 25_000);
  });
  await record('room rejects a third member', async () => {
    assert.equal((await fetch(`${signalingServer}/rooms/${created.room.code}/join`, { method: 'POST', body: JSON.stringify({ protocol: PROTOCOL, capabilities: CAPABILITIES }) })).status, 409);
  });
  await record('manual alignment preserves a five-second version offset', async () => {
    await host.video.evaluate(() => { document.querySelector('video').currentTime = 5; });
    await guest.video.evaluate(() => { document.querySelector('video').currentTime = 10; });
    await until('seeks settle', async () => Math.abs((await time(host)).time - 5) < 0.1 && Math.abs((await time(guest)).time - 10) < 0.1 && !(await time(host)).buffering && !(await time(guest)).buffering);
    await host.api('ready'); await guest.api('ready');
    await until('both ready', async () => (await host.api('status')).room?.state?.phase === 'synced' && (await guest.api('status')).room?.state?.phase === 'synced');
    const state = (await host.api('status')).room.state;
    assert.ok(Math.abs(state.anchors.guest - state.anchors.host - 5) < 0.1);
  });
  await record('Play starts both videos and stable drift stays under 500 ms', async () => {
    if (process.env.TEST_STARTUP_DELAY_MS) {
      const delayMs = Number(process.env.TEST_STARTUP_DELAY_MS);
      assert.ok(Number.isFinite(delayMs) && delayMs > 0 && delayMs <= 1000);
      recordDiagnostic({ type: 'injected-play-start-delay', role: 'guest', delayMs });
      await guest.video.evaluate(delayMs => {
        const video = document.querySelector('video');
        const original = video.play.bind(video);
        video.play = async () => {
          video.play = original;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return original();
        };
      }, delayMs);
    }
    await host.api('control', { control: 'play' });
    await until('both playing', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await new Promise(resolve => setTimeout(resolve, 4000));
    const a = await time(host), b = await time(guest);
    assert.ok(!a.paused && !b.paused);
    const drift = Math.abs(b.time - a.time - 5);
    console.log(`Measured drift: ${Math.round(drift * 1000)} ms`);
    assert.ok(drift < 0.5, `drift ${drift}`);
  });
  for (const [role, browser] of [['guest', guest], ['host', host]]) {
    await record(`native ${role} Pause never restarts locally, even with a delayed acknowledgement`, async () => {
      await host.api('control', { control: 'play' });
      await until('both playing before native pause', async () => !(await time(host)).paused && !(await time(guest)).paused);
      proxy.delay(role, 450);
      const stoppedAt = await browser.video.evaluate(() => {
        const video = document.querySelector('video');
        window.pauseTest = { plays: 0, seeks: 0 };
        video.addEventListener('play', () => { window.pauseTest.plays++; }, { signal: (window.pauseTestAbort = new AbortController()).signal });
        video.addEventListener('seeking', () => { window.pauseTest.seeks++; }, { signal: window.pauseTestAbort.signal });
        video.pause();
        return video.currentTime;
      });
      try {
        await until('pause acknowledged by both', async () => !(await host.api('status')).room.state.wantsPlay &&
          !(await guest.api('status')).room.state.wantsPlay && (await time(host)).paused && (await time(guest)).paused);
        await new Promise(resolve => setTimeout(resolve, 1200));
        const observed = await browser.video.evaluate(() => ({ ...window.pauseTest, time: document.querySelector('video').currentTime }));
        assert.equal(observed.plays, 0, `native pause restarted ${observed.plays} times`);
        assert.equal(observed.seeks, 0, 'the paused player must stay on the chosen frame');
        assert.ok(Math.abs(observed.time - stoppedAt) < 0.08);
      } finally {
        proxy.delay(role, 0);
        await browser.video.evaluate(() => window.pauseTestAbort.abort());
      }
    });
  }
  await record('native Play stays responsive and a subsequent Pause wins over older acknowledgements', async () => {
    proxy.delay('guest', 450);
    try {
      await guest.video.evaluate(async () => {
        const video = document.querySelector('video');
        window.playTest = { pauses: 0 };
        window.playTestAbort = new AbortController();
        video.addEventListener('pause', () => { window.playTest.pauses++; }, { signal: window.playTestAbort.signal });
        await video.play();
      });
      await until('native play acknowledged', async () => (await host.api('status')).room.state.wantsPlay &&
        (await guest.api('status')).room.state.wantsPlay);
      assert.equal(await guest.video.evaluate(() => window.playTest.pauses), 0, 'native Play must not bounce back to Pause');
      await guest.video.evaluate(async () => {
        window.playTestAbort.abort();
        const video = document.querySelector('video');
        video.pause();
        await new Promise(resolve => setTimeout(resolve, 100));
        await video.play();
        await new Promise(resolve => setTimeout(resolve, 100));
        video.pause();
        window.rapidPause = { restarts: 0, time: video.currentTime };
        window.rapidPauseAbort = new AbortController();
        video.addEventListener('play', () => { window.rapidPause.restarts++; }, { signal: window.rapidPauseAbort.signal });
      });
      await until('last native pause acknowledged', async () => !(await host.api('status')).room.state.wantsPlay &&
        !(await guest.api('status')).room.state.wantsPlay && (await time(host)).paused && (await time(guest)).paused);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const result = await guest.video.evaluate(() => ({ ...window.rapidPause, final: document.querySelector('video').currentTime }));
      assert.equal(result.restarts, 0);
      assert.ok(Math.abs(result.time - result.final) < 0.08);
    } finally {
      proxy.delay('guest', 0);
      await guest.video.evaluate(() => { window.playTestAbort?.abort(); window.rapidPauseAbort?.abort(); });
    }
  });
  await record('native Seek in either player keeps the offset', async () => {
    await guest.video.evaluate(() => { document.querySelector('video').currentTime = 25; });
    await until('guest seek propagated', async () => Math.abs((await time(host)).time - 20) < 0.4);
    await host.video.evaluate(() => { document.querySelector('video').currentTime = 12; });
    await until('host seek propagated', async () => Math.abs((await time(guest)).time - 17) < 0.4);
  });
  await record('an empty intent queue before seeking fires is not a seek acknowledgement', async () => {
    await until('previous intents acknowledged', async () => guest.video.evaluate(() => window.__videoSyncPlayer.sample().intents.length === 0));
    const beforeEvent = await guest.video.evaluate(async () => {
      const video = document.querySelector('video');
      video.currentTime = 25;
      // currentTime changes synchronously; the seeking event that queues the
      // intent is a later media task. The former setup could observe zero here.
      const immediate = { seeking: video.seeking, intents: window.__videoSyncPlayer.sample().intents.length };
      if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      return immediate;
    });
    recordDiagnostic({ type: 'seek-before-media-event', ...beforeEvent });
    assert.deepEqual(beforeEvent, { seeking: true, intents: 0 });
    await until('seek event acknowledged', async () => guest.video.evaluate(() => window.__videoSyncPlayer.sample().intents.length === 0));
    await until('peer received the seek', async () => Math.abs((await time(host)).time - 20) < 0.4);
  });
  for (const [role, browser] of [['guest', guest], ['host', host]]) {
    for (const action of ['play', 'forward', 'back', 'scrub']) {
      await record(`native ${role} ${action} stays continuous through delayed synchronization`, async () => {
        await host.api('control', { control: 'pause' });
        await until('paused before gesture', async () => (await time(host)).paused && (await time(guest)).paused);
        await browser.video.evaluate(async () => {
          const video = document.querySelector('video');
          video.currentTime = 25;
          if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
        });
        await until('initial seek acknowledged', async () => browser.video.evaluate(() => window.__videoSyncPlayer.sample().intents.length === 0));
        if (action !== 'play') {
          await host.api('control', { control: 'play' });
          await until('playing before seek', async () => !(await time(host)).paused && !(await time(guest)).paused);
          await new Promise(resolve => setTimeout(resolve, 600));
        }
        proxy.delay(role, 450);
        try {
          await browser.video.evaluate(async action => {
            const video = document.querySelector('video');
            if (action === 'play') await video.play();
            else if (action === 'scrub') {
              for (const target of [28, 22, 31]) {
                video.currentTime = target;
                await new Promise(resolve => setTimeout(resolve, 80));
              }
            } else video.currentTime += action === 'forward' ? 10 : -10;
            if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
            window.gestureTrace = { pauses: 0, seeks: 0, at: performance.now(), time: video.currentTime };
            window.gestureAbort = new AbortController();
            video.addEventListener('pause', () => window.gestureTrace.pauses++, { signal: window.gestureAbort.signal });
            video.addEventListener('seeking', () => { window.gestureTrace.seeks++; }, { signal: window.gestureAbort.signal });
          }, action);
          await new Promise(resolve => setTimeout(resolve, 2400));
          const trace = await browser.video.evaluate(() => ({ ...window.gestureTrace,
            timeNow: document.querySelector('video').currentTime, elapsed: (performance.now() - window.gestureTrace.at) / 1000 }));
          assert.equal(trace.pauses, 0, `${role} ${action} must not pause after the gesture`);
          assert.equal(trace.seeks, 0, `${role} ${action} must not jump after the gesture`);
          assert.ok(Math.abs(trace.timeNow - trace.time - trace.elapsed) < 0.2, JSON.stringify(trace));
          await until('peer converges after gesture', async () => Math.abs((await time(guest)).time - (await time(host)).time - 5) < 0.5, 10000);
        } finally {
          proxy.delay(role, 0);
          await browser.video.evaluate(() => { window.gestureAbort?.abort(); window.gestureTrace = null; });
        }
      });
    }
  }
  for (const [role, browser] of [['guest', guest], ['host', host]]) {
    await record(`native ${role} paused scrubbing keeps the final frame`, async () => {
      await host.api('control', { control: 'pause' });
      await until('both paused before scrub', async () => (await time(host)).paused && (await time(guest)).paused);
      proxy.delay(role, 450);
      try {
        await browser.video.evaluate(async () => {
          const video = document.querySelector('video');
          for (const target of [27, 18, 24]) {
            video.currentTime = target;
            await new Promise(resolve => setTimeout(resolve, 80));
          }
          if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
          window.scrubTrace = { plays: 0, seeks: 0 };
          window.scrubAbort = new AbortController();
          video.addEventListener('play', () => window.scrubTrace.plays++, { signal: window.scrubAbort.signal });
          video.addEventListener('seeking', () => window.scrubTrace.seeks++, { signal: window.scrubAbort.signal });
        });
        await new Promise(resolve => setTimeout(resolve, 2400));
        assert.deepEqual(await browser.video.evaluate(() => window.scrubTrace), { plays: 0, seeks: 0 });
        assert.ok(Math.abs((await time(browser)).time - 24) < 0.08);
        await until('paused peer reaches final frame', async () => Math.abs((await time(guest)).time - (await time(host)).time - 5) < 0.1);
      } finally {
        proxy.delay(role, 0);
        await browser.video.evaluate(() => window.scrubAbort?.abort());
      }
    });
  }
  await record('rapid popup clicks accumulate seeks and the Play/Pause toggle responds immediately', async () => {
    await guest.video.evaluate(() => { document.querySelector('video').currentTime = 10; });
    await until('popup test position aligned', async () => Math.abs((await time(host)).time - 5) < 0.1 &&
      await guest.video.evaluate(() => window.__videoSyncPlayer.sample().intents.length === 0));
    await guest.popup.locator('#playback').waitFor({ state: 'visible' });
    proxy.delay('guest', 450);
    try {
      // Run the actual popup click handlers in one task, before any response can return.
      await guest.popup.evaluate(() => {
        for (const control of ['forward', 'forward', 'forward', 'back', 'back']) document.querySelector(`[data-control="${control}"]`).click();
      });
      await until('five popup seek clicks applied locally', async () => Math.abs((await time(guest)).time - 20) < 0.1);
      await until('five popup seek clicks synchronized', async () => Math.abs((await time(host)).time - 15) < 0.1);
      await guest.popup.evaluate(() => {
        const play = document.querySelector('#play');
        play.click();
        if (play.textContent !== 'Pause') throw new Error('Play toggle did not update immediately');
        play.click();
        if (play.textContent !== 'Abspielen') throw new Error('Pause toggle did not update immediately');
      });
      await new Promise(resolve => setTimeout(resolve, 2400));
      assert.ok((await time(host)).paused && (await time(guest)).paused);
      assert.equal((await guest.api('status')).room.state.wantsPlay, false);
    } finally { proxy.delay('guest', 0); }
  });
  await host.video.evaluate(() => { document.querySelector('video').currentTime = 10; });
  await until('test clip reset before remaining scenarios', async () => Math.abs((await time(guest)).time - 15) < 0.1);
  await record('buffering pauses both, then resumes; manual pause cancels recovery', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before buffering', async () => !(await time(host)).paused && !(await time(guest)).paused);
    // A deterministic unavailable-data condition exercises the real adapter and room transport.
    await guest.video.evaluate(() => Object.defineProperty(document.querySelector('video'), 'readyState', { configurable: true, get: () => 2 }));
    await until('buffering pause', async () => (await time(host)).paused && (await time(guest)).paused);
    await until('buffering guidance visible', async () => (await guest.popup.locator('#status').textContent()) === 'Dein Video lädt nach');
    await guest.video.evaluate(() => { delete document.querySelector('video').readyState; });
    await until('buffering recovery', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await guest.video.evaluate(() => Object.defineProperty(document.querySelector('video'), 'readyState', { configurable: true, get: () => 2 }));
    await until('second buffering pause', async () => (await time(host)).paused);
    await host.api('control', { control: 'pause' });
    await guest.video.evaluate(() => { delete document.querySelector('video').readyState; });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.ok((await time(host)).paused && (await time(guest)).paused);
  });
  await record('closing the popup leaves the active session intact', async () => {
    const popupUrl = guest.popup.url();
    await host.api('control', { control: 'play' });
    await until('both playing', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await guest.popup.goto('about:blank');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.ok(!(await time(host)).paused && !(await time(guest)).paused);
    await guest.popup.goto(popupUrl);
    await host.api('control', { control: 'pause' });
  });
  await record('network loss pauses both and reconnects the same room without losing scene anchors', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before disconnect', async () => !(await time(host)).paused && !(await time(guest)).paused);
    const before = (await host.api('status')).room;
    proxy.offline('guest');
    await until('offline pauses both', async () => (await time(host)).paused && (await time(guest)).paused, 15_000);
    await until('reconnect guidance visible', async () => (await guest.popup.locator('#status').textContent()) === 'Wir verbinden euch erneut');
    assert.equal((await host.api('status')).room.code, before.code);
    await new Promise(resolve => setTimeout(resolve, 3000));
    proxy.online();
    await until('same room recovers', async () => (await host.api('status')).room?.connected &&
      (await guest.api('status')).room?.connected &&
      (await guest.api('status')).room.state.epoch === (await host.api('status')).room.state.epoch, 25_000);
    assert.deepEqual((await host.api('status')).room.state.anchors, before.state.anchors);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok((await time(host)).paused && (await time(guest)).paused);
    await guest.api('control', { control: 'play' });
    await until('explicit resume after recovery', async () => !(await time(host)).paused && !(await time(guest)).paused);
    assert.ok(Math.abs((await time(guest)).time - (await time(host)).time - 5) < 0.5);
    await host.api('control', { control: 'pause' });
  });
  for (const [role, path, description] of [
    ['host', '', 'host network failure'], ['guest', '/events', 'one-way guest receive failure']
  ]) {
    await record(`${description} pauses both and recovers without a new room`, async () => {
      await host.api('control', { control: 'play' });
      await until('both playing before failure', async () => !(await time(host)).paused && !(await time(guest)).paused);
      const code = (await host.api('status')).room.code;
      proxy.offline(role, path);
      await until('both paused during failure', async () => (await time(host)).paused && (await time(guest)).paused, 15_000);
      await new Promise(resolve => setTimeout(resolve, 3000));
      assert.ok((await time(host)).paused && (await time(guest)).paused);
      proxy.online();
      await until('connection recovered', async () => (await host.api('status')).room?.connected && (await guest.api('status')).room?.connected, 25_000);
      assert.equal((await host.api('status')).room.code, code);
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.ok((await time(host)).paused && (await time(guest)).paused);
    });
  }
  await record('a slow player response pauses safely and retains the connected document and anchors', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before slow response', async () => !(await time(host)).paused && !(await time(guest)).paused);
    const before = await host.api('status');
    await host.video.evaluate(() => {
      // A tick makes one call: apply with its command, or sample. Delay the next one.
      const player = window.__videoSyncPlayer;
      let delayOnce = true;
      for (const action of ['sample', 'apply']) {
        const original = player[action];
        player[action] = async (...args) => {
          if (delayOnce) {
            delayOnce = false;
            await new Promise(resolve => setTimeout(resolve, 2800));
          }
          return original.apply(player, args);
        };
      }
    });
    await until('slow response pauses both', async () => (await time(host)).paused && (await time(guest)).paused, 10_000);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const after = await host.api('status');
    assert.equal(after.tabId, before.tabId);
    assert.equal(after.room.code, before.room.code);
    assert.deepEqual(after.room.state.anchors, before.room.state.anchors);
    assert.ok(after.local && (await time(host)).paused && (await time(guest)).paused);
    await guest.api('control', { control: 'play' });
    await until('play after player recovery', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await host.api('control', { control: 'pause' });
  });
  await record('realignment pauses both and requires two new confirmations', async () => {
    await guest.api('resync');
    await until('alignment reset', async () => (await host.api('status')).room?.state?.phase === 'aligning');
    assert.deepEqual((await host.api('status')).room.state.anchors, {});
    await host.api('ready');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal((await host.api('status')).room.state.phase, 'aligning');
    await guest.api('ready');
    await until('realigned', async () => (await host.api('status')).room?.state?.phase === 'synced');
  });
  await host.popup.locator('#playback').waitFor({ state: 'visible' });
  await host.popup.screenshot({ path: join(evidence, 'popup.png') });
  await host.video.screenshot({ path: join(evidence, 'demo.png'), fullPage: true });
  await record('a video change clears alignment and does not start the replacement video', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before video change', async () => !(await time(guest)).paused);
    await guest.video.getByRole('button', { name: 'Version A', exact: true }).click();
    await guest.video.waitForFunction(() => document.querySelector('video').currentSrc.endsWith('/scene-a.webm'));
    await until('video change resets alignment', async () => (await host.api('status')).room?.state?.phase === 'aligning');
    await until('both paused after video change', async () => (await time(host)).paused && (await time(guest)).paused);
    assert.deepEqual((await host.api('status')).room.state.anchors, {});
    await guest.video.waitForFunction(() => document.querySelector('video').readyState >= 3);
    const guestState = await guest.api('status');
    const tabId = guestState.tabId ?? await guest.popup.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, base);
    await guest.api('attach', { tabId });
    await until('new epoch received', async () => !(await guest.api('status')).room.resetting && (await guest.api('status')).room.state?.epoch === (await host.api('status')).room.state?.epoch);
    await host.api('ready'); await guest.api('ready');
    await until('ready after video change', async () => (await host.api('status')).room?.state?.phase === 'synced');
  });
  await record('closing a video tab pauses the peer and requires renewed alignment', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before tab close', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await guest.video.close();
    await until('tab close pauses peer', async () => (await time(host)).paused && (await host.api('status')).room?.state?.phase === 'aligning');
    guest.video = await guest.context.newPage();
    await guest.video.goto(base);
    await guest.video.waitForFunction(() => document.querySelector('video').readyState >= 3);
    const tabId = await guest.popup.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, base);
    await guest.api('attach', { tabId });
    await until('new tab epoch received', async () => !(await guest.api('status')).room.resetting && (await guest.api('status')).room.state?.epoch === (await host.api('status')).room.state?.epoch);
    await host.api('ready'); await guest.api('ready');
    await until('ready after tab replacement', async () => (await host.api('status')).room?.state?.phase === 'synced');
  });
  await record('leaving closes the room and pauses the remaining participant', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before leave', async () => !(await time(guest)).paused);
    await guest.api('leave');
    await until('room closed', async () => !(await host.api('status')).room && (await time(host)).paused);
  });
  assert.deepEqual(errors, [], 'No browser page errors');
  await writeFile(join(evidence, 'e2e.json'), JSON.stringify({ passed: results, errors }, null, 2));
} catch (error) {
  for (const browser of [host, guest].filter(Boolean)) {
    console.error(browser.label, JSON.stringify(await browser.api('status').catch(() => null)));
    console.error(browser.label, 'video', await browser.video.evaluate(() => ({ src: document.querySelector('video')?.src, currentSrc: document.querySelector('video')?.currentSrc, label: document.querySelector('#version')?.textContent })).catch(() => null), 'errors', errors);
    await browser.popup.screenshot({ path: join(evidence, `${browser.label}-failure.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await proxy.close();
  for (const context of contexts) await context.close();
  for (const profile of profiles) await rm(profile, { recursive: true, force: true });
}
