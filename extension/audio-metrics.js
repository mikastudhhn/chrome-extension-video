export const TEST_SECONDS = 8;

export class AudioMetrics {
  constructor() { this.samples = 0; this.squares = 0; this.peak = 0; this.activeSamples = 0; this.sampleRate = 0; }
  add({ samples, squares, peak, sampleRate }) {
    if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 192000 || !Number.isFinite(squares) || squares < 0 ||
        !Number.isFinite(peak) || peak < 0 || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return;
    this.samples += samples;
    this.squares += squares;
    this.peak = Math.max(this.peak, peak);
    if (Math.sqrt(squares / samples) > 0.0003) this.activeSamples += samples;
    this.sampleRate = sampleRate;
  }
  snapshot() {
    const duration = this.sampleRate ? this.samples / this.sampleRate : 0;
    const activeSeconds = this.sampleRate ? this.activeSamples / this.sampleRate : 0;
    const rms = this.samples ? Math.sqrt(this.squares / this.samples) : 0;
    return { duration: Math.round(duration * 10) / 10, activeSeconds: Math.round(activeSeconds * 10) / 10,
      rmsDb: rms > 0 ? Math.round(20 * Math.log10(rms)) : null, peak: this.peak, sampleRate: this.sampleRate,
      signalDetected: duration >= 3 && activeSeconds >= 1 };
  }
}

export function diagnosticOutcome(metrics) {
  if (metrics.duration < 3) return { outcome: 'unavailable', message: 'Zu wenige Tonproben empfangen. Bitte bei laufendem Video erneut testen.' };
  if (!metrics.signalDetected) return { outcome: 'silent', message: 'Kein ausreichender Ton gemessen. Ursache kann Stille, Stummschaltung oder ein Zugriffsschutz sein.' };
  return { outcome: 'signal', message: 'Tonproben empfangen. Das ist eine Voraussetzung für einen späteren Tonvergleich, noch kein Nachweis einer erfolgreichen Szenenerkennung.' };
}
