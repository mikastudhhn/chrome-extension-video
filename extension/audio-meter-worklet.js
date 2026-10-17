// Only aggregate levels leave this processor. No recording or PCM buffer is retained.
class AudioMeter extends AudioWorkletProcessor {
  constructor() { super(); this.samples = 0; this.squares = 0; this.peak = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    // Measure channels independently so opposite stereo phases cannot cancel out.
    for (let i = 0; i < channels[0].length; i++) {
      let squares = 0;
      for (const channel of channels) { squares += channel[i] ** 2; this.peak = Math.max(this.peak, Math.abs(channel[i])); }
      this.squares += squares / channels.length;
      this.samples++;
    }
    if (this.samples >= sampleRate / 10) {
      this.port.postMessage({ samples: this.samples, squares: this.squares, peak: this.peak, sampleRate });
      this.samples = 0; this.squares = 0; this.peak = 0;
    }
    return true;
  }
}
registerProcessor('video-sync-meter', AudioMeter);
