import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { AudioMetrics, diagnosticOutcome } from '../extension/audio-metrics.js';

test('diagnostics distinguish real signal, silence and insufficient data without guessing DRM', () => {
  const metrics = new AudioMetrics();
  assert.equal(diagnosticOutcome(metrics.snapshot()).outcome, 'unavailable');
  for (let i = 0; i < 40; i++) metrics.add({ samples: 4800, sampleRate: 48000, squares: 0, peak: 0 });
  assert.equal(diagnosticOutcome(metrics.snapshot()).outcome, 'silent');
  assert.equal(metrics.snapshot().rmsDb, null);
  for (let i = 0; i < 20; i++) metrics.add({ samples: 4800, sampleRate: 48000, squares: 48, peak: 0.2 });
  assert.equal(diagnosticOutcome(metrics.snapshot()).outcome, 'signal');
  assert.equal(metrics.snapshot().duration, 6);
  assert.equal(metrics.snapshot().activeSeconds, 2);
  assert.equal(metrics.snapshot().rmsDb, -25);
});
test('invalid measurements do not contaminate the diagnostic', () => {
  const metrics = new AudioMetrics();
  for (const data of [{}, { samples: -1 }, { samples: 4800, sampleRate: 48000, squares: NaN, peak: 1 }]) metrics.add(data);
  assert.equal(metrics.snapshot().duration, 0);
});
test('opposite stereo phases are measured as audible and no raw audio leaves the meter', async () => {
  let Meter;
  const measurements = [];
  vm.runInNewContext(await readFile('extension/audio-meter-worklet.js', 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => measurements.push(value) }; } },
    sampleRate: 48000, registerProcessor: (_, implementation) => { Meter = implementation; }
  });
  const meter = new Meter();
  for (let i = 0; i < 40; i++) meter.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]]);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].squares / measurements[0].samples, 0.25);
  assert.deepEqual(Object.keys(measurements[0]).sort(), ['peak', 'sampleRate', 'samples', 'squares']);
});
