// Sound effects synthesized with the Web Audio API: no audio files.
// The context is created lazily on first use (browsers require a user gesture).

export type Sfx =
  | 'move' | 'capture' | 'select' | 'click' | 'coin' | 'call' | 'flip'
  | 'lie' | 'true' | 'check' | 'showdown' | 'win' | 'lose' | 'error' | 'step' | 'turn';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.6;
let muted = false;

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = muted ? 0 : volume;
}

export function setMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = muted ? 0 : volume;
}

function audio(): { ac: AudioContext; out: GainNode } | null {
  if (muted) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return { ac: ctx, out: master! };
  } catch {
    return null;
  }
}

/** One enveloped oscillator note. */
function tone(freq: number, start: number, dur: number, opts: { type?: OscillatorType; gain?: number; slide?: number } = {}): void {
  const a = audio();
  if (!a) return;
  const t = a.ac.currentTime + start;
  const osc = a.ac.createOscillator();
  const g = a.ac.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A burst of filtered noise (wood knocks, whooshes, crashes). */
function noise(start: number, dur: number, opts: { freq?: number; q?: number; gain?: number; type?: BiquadFilterType } = {}): void {
  const a = audio();
  if (!a) return;
  const t = a.ac.currentTime + start;
  const len = Math.max(1, Math.floor(a.ac.sampleRate * dur));
  const buf = a.ac.createBuffer(1, len, a.ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.ac.createBufferSource();
  src.buffer = buf;
  const filter = a.ac.createBiquadFilter();
  filter.type = opts.type ?? 'bandpass';
  filter.frequency.value = opts.freq ?? 800;
  filter.Q.value = opts.q ?? 1;
  const g = a.ac.createGain();
  g.gain.value = opts.gain ?? 0.4;
  src.connect(filter).connect(g).connect(a.out);
  src.start(t);
}

export function play(s: Sfx): void {
  switch (s) {
    case 'move':
      noise(0, 0.08, { freq: 500, q: 2, gain: 0.7 });
      tone(140, 0, 0.09, { type: 'triangle', gain: 0.25, slide: 0.7 });
      break;
    case 'capture':
      noise(0, 0.12, { freq: 400, q: 1.5, gain: 0.8 });
      tone(110, 0, 0.14, { type: 'triangle', gain: 0.35, slide: 0.6 });
      noise(0.05, 0.08, { freq: 1200, q: 3, gain: 0.3 });
      break;
    case 'select':
      tone(660, 0, 0.06, { type: 'triangle', gain: 0.12 });
      break;
    case 'click':
      noise(0, 0.03, { freq: 2000, q: 4, gain: 0.25 });
      break;
    case 'step':
      tone(523, 0, 0.12, { type: 'triangle', gain: 0.18 });
      tone(784, 0.08, 0.16, { type: 'triangle', gain: 0.16 });
      break;
    case 'coin':
      tone(1568, 0, 0.18, { type: 'square', gain: 0.06 });
      tone(2093, 0.06, 0.25, { type: 'square', gain: 0.05 });
      tone(2637, 0.12, 0.3, { type: 'sine', gain: 0.08 });
      break;
    case 'call':
      noise(0, 0.18, { freq: 180, q: 0.8, gain: 0.9, type: 'lowpass' });
      tone(98, 0, 0.25, { type: 'sine', gain: 0.5, slide: 0.5 });
      break;
    case 'flip':
      noise(0, 0.22, { freq: 3000, q: 0.6, gain: 0.25, type: 'highpass' });
      break;
    case 'lie':
      tone(196, 0, 0.5, { type: 'sawtooth', gain: 0.18 });
      tone(185, 0, 0.5, { type: 'sawtooth', gain: 0.18 });
      tone(139, 0.12, 0.6, { type: 'sawtooth', gain: 0.18 });
      noise(0, 0.5, { freq: 5000, q: 0.5, gain: 0.35, type: 'highpass' });
      break;
    case 'true':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.35, { type: 'triangle', gain: 0.16 }));
      break;
    case 'check':
      tone(880, 0, 0.12, { type: 'square', gain: 0.07 });
      tone(880, 0.16, 0.12, { type: 'square', gain: 0.07 });
      break;
    case 'showdown':
      tone(55, 0, 1.6, { type: 'sawtooth', gain: 0.2 });
      tone(82, 0.2, 1.4, { type: 'sawtooth', gain: 0.12 });
      noise(0, 1.2, { freq: 120, q: 0.7, gain: 0.5, type: 'lowpass' });
      break;
    case 'win':
      [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, { type: 'triangle', gain: 0.18 }));
      break;
    case 'lose':
      [392, 370, 349, 262].forEach((f, i) => tone(f, i * 0.22, 0.4, { type: 'triangle', gain: 0.16 }));
      break;
    case 'turn':
      tone(659, 0, 0.14, { type: 'triangle', gain: 0.1 });
      tone(880, 0.1, 0.2, { type: 'triangle', gain: 0.1 });
      break;
    case 'error':
      tone(220, 0, 0.12, { type: 'square', gain: 0.06, slide: 0.8 });
      break;
  }
}
