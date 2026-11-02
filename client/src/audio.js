// Tous les sons sont synthétisés : aucun fichier à charger, aucune licence à gérer.
export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** Les navigateurs exigent un geste utilisateur avant de produire du son. */
  unlock() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    this.noise = this.makeNoise(4);
    this.startSea();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.8;
  }

  makeNoise(seconds) {
    const size = this.ctx.sampleRate * seconds;
    const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  burst({ duration, type = 'lowpass', from, to, gain, delay = 0, q = 0.7 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 3);
    src.stop(t + duration + 0.05);
  }

  thump({ from, to, duration, gain, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  startSea() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const depth = this.ctx.createGain();
    depth.gain.value = 0.022;
    lfo.connect(depth).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();
  }

  gun() {
    this.thump({ from: 120, to: 34, duration: 0.65, gain: 0.8 });
    this.burst({ duration: 0.7, from: 2600, to: 120, gain: 0.5 });
  }

  whistle() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(380, t + 1.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.02, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 1.4);
  }

  splash() {
    this.burst({ duration: 0.25, from: 1800, to: 500, gain: 0.3 });
    this.burst({ duration: 1.5, type: 'bandpass', from: 2400, to: 500, gain: 0.34, delay: 0.05 });
  }

  explosion(big) {
    this.thump({ from: 90, to: 24, duration: big ? 1.8 : 1.1, gain: 1 });
    this.burst({ duration: big ? 2.6 : 1.5, from: 3200, to: 60, gain: 0.8 });
    this.burst({ duration: 2.6, type: 'bandpass', from: 700, to: 90, gain: 0.3, delay: 0.14 });
  }

  blip(freq = 880) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  alert() {
    this.blip(660);
    setTimeout(() => this.blip(880), 130);
  }
}
