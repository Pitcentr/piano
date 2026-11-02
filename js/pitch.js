/** Pitch detection for a single piano note: YIN + a check against the stored fundamental. */

export function prepare(samples) {
  const out = new Float32Array(samples.length);
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] - mean;
    out[i] = value;
    energy += value * value;
  }
  return { signal: out, rms: Math.sqrt(energy / (samples.length || 1)) };
}

function parabolicMinimum(buffer, tau) {
  const x0 = tau > 0 ? tau - 1 : tau;
  const x2 = tau + 1 < buffer.length ? tau + 1 : tau;
  if (x0 === tau || x2 === tau) return tau;
  const s0 = buffer[x0];
  const s1 = buffer[tau];
  const s2 = buffer[x2];
  const denom = 2 * (2 * s1 - s2 - s0);
  if (!denom) return tau;
  return tau + (s2 - s0) / denom;
}

/**
 * YIN fundamental-frequency estimate.
 * Returns null when the signal is not a clear periodic tone.
 */
export function detectPitch(samples, sampleRate, threshold = 0.15) {
  const n = samples.length;
  if (n < 256) return null;
  const tauMin = Math.max(2, Math.floor(sampleRate / 1800));
  const tauMax = Math.min(Math.floor(n / 2) - 2, Math.floor(sampleRate / 70));
  if (tauMax <= tauMin + 2) return null;

  const window = n - tauMax;
  const diff = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float32Array(tauMax + 1);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmndf[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmndf[t] < threshold) {
      while (t + 1 <= tauMax && cmndf[t + 1] < cmndf[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;

  const refined = parabolicMinimum(cmndf, tau);
  if (!Number.isFinite(refined) || refined <= 0) return null;
  const freq = sampleRate / refined;
  if (freq < 70 || freq > 1800) return null;
  return { freq, confidence: 1 - cmndf[tau] };
}

export function goertzel(samples, sampleRate, freq) {
  const n = samples.length;
  if (!freq || n < 8) return 0;
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    s0 = samples[i] * window + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function downsample(signal, factor) {
  const n = Math.floor(signal.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += signal[i * factor + k];
    out[i] = sum / factor;
  }
  return out;
}

export function analyze(samples, sampleRate) {
  const { signal, rms } = prepare(samples);
  if (rms < 0.004) return { rms, signal, pitch: null };
  const coarse = downsample(signal, 2);
  const pitch = detectPitch(coarse, sampleRate / 2);
  return { rms, signal, pitch };
}

/** True when the heard pitch is the calibrated key, including a common octave slip. */
export function matchesTarget(freq, targetFreq, samples, sampleRate) {
  if (!freq || !targetFreq) return false;
  if (Math.abs(1200 * Math.log2(freq / targetFreq)) <= 55) return true;
  if (!samples) return false;
  for (const harmonic of [2, 3]) {
    const cents = Math.abs(1200 * Math.log2(freq / (targetFreq * harmonic)));
    if (cents > 55) continue;
    const atFundamental = goertzel(samples, sampleRate, targetFreq);
    const atHeard = goertzel(samples, sampleRate, freq);
    if (atHeard > 0 && atFundamental > atHeard * 0.18) return true;
  }
  return false;
}
