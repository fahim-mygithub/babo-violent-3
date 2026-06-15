import { C } from '../data/constants';
import type { GunId } from '../data/weapons';
import type { GameEvent, PlayerState } from '../sim/types';
import type { WorldView } from '../render/renderer';

/**
 * WebAudio synth engine — every sound is synthesized, zero audio assets.
 * Consumes GameEvents each tick; distance-attenuates by the local player.
 */
export class AudioEngine {
  enabled = true;
  /** Set once the first user gesture has unlocked WebAudio (so repeat gestures no-op). */
  unlocked = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private voicesThisBatch = 0;
  private heartPhase = 0;
  private sizzleAt = 0;

  /**
   * Call from the FIRST user gesture to unlock WebAudio (iOS Safari requires a
   * silent buffer played inside the gesture). Idempotent via `unlocked` so a tap
   * firing both pointerdown+touchend doesn't double-kick the context.
   */
  unlock(): void {
    if (this.unlocked) return;
    if (!this.ctx) {
      // iOS Safari (and older WebKit) only expose webkitAudioContext.
      const Ctx = (typeof window !== 'undefined' && (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) as typeof AudioContext | undefined;
      if (!Ctx) return; // no WebAudio (jsdom without a stub) — stay silent, never throw
      this.ctx = new Ctx();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(comp);
      // 1s of white noise, reused by every noise voice
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    // A silent 1-sample buffer played inside the gesture is what actually unlocks
    // iOS WebAudio — resume() alone is not enough on Safari.
    const s = this.ctx.createBufferSource();
    s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    s.connect(this.ctx.destination);
    s.start(0);
    s.stop(this.ctx.currentTime + 0.001);
    // 'interrupted' (iOS phone call / Siri) and 'suspended' both need a resume.
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.unlocked = true;
  }

  /** Re-arm audio after the tab returns to the foreground (visibilitychange). */
  resumeIfUnlocked(): void {
    if (this.unlocked && this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
  }

  /** Suspend ONLY the AudioContext when the tab is hidden (the sim loop keeps ticking). */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /** Filtered noise burst with a gain envelope and optional filter sweep. */
  private noise(opts: {
    dur: number; gain: number;
    type?: BiquadFilterType; f0?: number; f1?: number; q?: number;
    attack?: number; delay?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = opts.type ?? 'lowpass';
    filt.frequency.setValueAtTime(opts.f0 ?? 1000, t0);
    if (opts.f1 !== undefined) filt.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
    filt.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + opts.dur + 0.05);
  }

  /** Oscillator voice with pitch sweep + envelope. */
  private tone(opts: {
    type: OscillatorType; f0: number; f1?: number; dur: number; gain: number;
    attack?: number; delay?: number; detune?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(20, opts.f0), t0);
    if (opts.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
    if (opts.detune) osc.detune.value = opts.detune;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  // -------------------------------------------------------------------------

  private gunShot(gun: GunId, v: number): void {
    switch (gun) {
      case 'stinger':
        this.noise({ dur: 0.05, gain: 0.5 * v, type: 'bandpass', f0: 3000, q: 1.2 });
        break;
      case 'workhorse':
        this.noise({ dur: 0.08, gain: 0.6 * v, type: 'bandpass', f0: 1500, f1: 600 });
        this.tone({ type: 'square', f0: 220, f1: 90, dur: 0.05, gain: 0.18 * v });
        break;
      case 'maw':
        this.noise({ dur: 0.22, gain: 0.85 * v, type: 'lowpass', f0: 900, f1: 200 });
        this.tone({ type: 'sine', f0: 110, f1: 45, dur: 0.18, gain: 0.5 * v });
        break;
      case 'hurricane':
        this.noise({ dur: 0.035, gain: 0.42 * v, type: 'bandpass', f0: 2200 + Math.random() * 600, q: 1.5 });
        break;
      case 'thumper':
        this.noise({ dur: 0.3, gain: 0.7 * v, type: 'lowpass', f0: 700, f1: 120 });
        this.tone({ type: 'sine', f0: 120, f1: 40, dur: 0.28, gain: 0.55 * v });
        break;
      case 'ion':
        this.tone({ type: 'square', f0: 820, f1: 300, dur: 0.07, gain: 0.3 * v });
        break;
      case 'lance':
        this.noise({ dur: 0.18, gain: 0.7 * v, type: 'highpass', f0: 900, f1: 300 });
        this.tone({ type: 'sawtooth', f0: 2100, f1: 180, dur: 0.16, gain: 0.4 * v });
        break;
      case 'pyre':
        this.noise({ dur: 0.1, gain: 0.12 * v, type: 'lowpass', f0: 1600, attack: 0.03 });
        break;
    }
  }

  handleEvents(events: GameEvent[], localId: number, view: WorldView): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (document.hidden) return; // hidden-tab catch-up would blast a tick burst at once
    let local: PlayerState | undefined;
    for (const p of view.players) if (p.id === localId) { local = p; break; }
    this.voicesThisBatch = 0;

    const vol = (x: number, y: number, isLocal = false): number => {
      if (isLocal || !local) return 1;
      const d = Math.hypot(x - local.x, y - local.y);
      return Math.max(0, 1 - d / 28);
    };

    for (const ev of events) {
      if (this.voicesThisBatch > 10) break;
      switch (ev.t) {
        case 'shot': {
          const v = vol(ev.x, ev.y, ev.player === localId);
          if (v < 0.05) break;
          this.voicesThisBatch++;
          this.gunShot(ev.gun, v);
          break;
        }
        case 'hit':
          if (ev.attacker === localId) {
            this.tone({ type: 'square', f0: 1050, dur: 0.025, gain: 0.22 });
            this.voicesThisBatch++;
          }
          break;
        case 'pop': {
          const v = vol(ev.x, ev.y, ev.player === localId);
          if (v < 0.05) break;
          this.voicesThisBatch += 2;
          // The signature wet pop
          this.tone({ type: 'sine', f0: 300, f1: 60, dur: 0.18, gain: 0.7 * v });
          this.noise({ dur: 0.22, gain: 0.55 * v, type: 'lowpass', f0: 1400, f1: 250 });
          this.tone({ type: 'sine', f0: 70, f1: 35, dur: 0.25, gain: 0.45 * v });
          break;
        }
        case 'death':
          if (ev.killer === localId && ev.victim !== localId) {
            this.tone({ type: 'sine', f0: 160, f1: 70, dur: 0.22, gain: 0.5, delay: 0.05 });
            this.voicesThisBatch++;
          }
          break;
        case 'explosion': {
          const v = vol(ev.x, ev.y);
          if (v < 0.05) break;
          this.voicesThisBatch += 2;
          this.noise({ dur: 0.5, gain: 0.9 * v, type: 'lowpass', f0: 800, f1: 90 });
          this.tone({ type: 'sine', f0: 60, f1: 30, dur: 0.45, gain: 0.6 * v });
          break;
        }
        case 'reloadStart':
          if (ev.player === localId) this.tone({ type: 'square', f0: 500, dur: 0.03, gain: 0.16 });
          break;
        case 'reloadDone':
          if (ev.player === localId) {
            this.tone({ type: 'square', f0: 650, dur: 0.03, gain: 0.18 });
            this.tone({ type: 'square', f0: 880, dur: 0.04, gain: 0.18, delay: 0.07 });
          }
          break;
        case 'overheat':
          if (ev.player === localId) this.noise({ dur: 0.6, gain: 0.35, type: 'lowpass', f0: 4200, f1: 480 });
          break;
        case 'spinup':
          if (ev.player === localId) {
            this.tone(ev.on
              ? { type: 'sawtooth', f0: 80, f1: 230, dur: 0.3, gain: 0.14 }
              : { type: 'sawtooth', f0: 220, f1: 70, dur: 0.4, gain: 0.1 });
          }
          break;
        case 'chargeReady':
          if (ev.player === localId) this.tone({ type: 'sine', f0: 1400, dur: 0.06, gain: 0.2 });
          break;
        case 'grenadeThrow': {
          const v = vol(ev.x, ev.y, ev.player === localId);
          if (v > 0.05) this.noise({ dur: 0.12, gain: 0.16 * v, type: 'bandpass', f0: 700, f1: 1600, attack: 0.02 });
          break;
        }
        case 'grenadeBounce': {
          const v = vol(ev.x, ev.y);
          if (v > 0.05) this.tone({ type: 'square', f0: 2500, f1: 1700, dur: 0.03, gain: 0.14 * v });
          break;
        }
        case 'smokePop': {
          const v = vol(ev.x, ev.y);
          if (v > 0.05) this.noise({ dur: 0.3, gain: 0.2 * v, type: 'lowpass', f0: 900, f1: 280, attack: 0.02 });
          break;
        }
        case 'fireIgnite': {
          const v = vol(ev.x, ev.y);
          if (v > 0.05) this.noise({ dur: 0.4, gain: 0.35 * v, type: 'bandpass', f0: 500, f1: 2400, attack: 0.05 });
          break;
        }
        case 'burn':
          if (ev.player === localId && performance.now() - this.sizzleAt > 480) {
            this.sizzleAt = performance.now();
            this.noise({ dur: 0.18, gain: 0.22, type: 'highpass', f0: 2600 });
          }
          break;
        case 'pickup':
          if (ev.player === localId) {
            if (ev.kind === 'health') {
              this.tone({ type: 'sine', f0: 520, dur: 0.06, gain: 0.2 });
              this.tone({ type: 'sine', f0: 780, dur: 0.09, gain: 0.2, delay: 0.07 });
            } else if (ev.kind === 'gun') {
              this.noise({ dur: 0.06, gain: 0.3, type: 'bandpass', f0: 900, q: 2 });
              this.tone({ type: 'square', f0: 240, dur: 0.05, gain: 0.2, delay: 0.05 });
            } else {
              this.tone({ type: 'sine', f0: 940, dur: 0.05, gain: 0.16 });
            }
          }
          break;
        case 'abilityCast': {
          const v = vol(ev.x, ev.y, ev.player === localId);
          if (v < 0.05) break;
          this.voicesThisBatch++;
          switch (ev.ability) {
            case 'dash':
              this.noise({ dur: 0.25, gain: 0.4 * v, type: 'bandpass', f0: 300, f1: 1400, attack: 0.03 });
              break;
            case 'phase':
              this.tone({ type: 'sine', f0: 600, f1: 1200, dur: 0.25, gain: 0.16 * v });
              this.tone({ type: 'sine', f0: 604, f1: 1210, dur: 0.25, gain: 0.16 * v, detune: 12 });
              break;
            case 'fortify':
              this.tone({ type: 'square', f0: 140, f1: 70, dur: 0.16, gain: 0.3 * v });
              this.noise({ dur: 0.1, gain: 0.2 * v, type: 'bandpass', f0: 1800, q: 3 });
              break;
            case 'grapple':
              this.noise({ dur: 0.14, gain: 0.22 * v, type: 'bandpass', f0: 1200, f1: 2600, attack: 0.01 });
              break;
            case 'gravityWell':
              this.tone({ type: 'sine', f0: 180, f1: 90, dur: 0.5, gain: 0.3 * v });
              this.tone({ type: 'sine', f0: 186, f1: 95, dur: 0.5, gain: 0.2 * v });
              break;
          }
          break;
        }
        case 'dashImpact': {
          const v = vol(ev.x, ev.y);
          if (v > 0.05) {
            this.tone({ type: 'sine', f0: 130, f1: 50, dur: 0.14, gain: 0.5 * v });
            this.noise({ dur: 0.08, gain: 0.3 * v, type: 'lowpass', f0: 700 });
          }
          break;
        }
        case 'rail':
          break; // covered by the lance 'shot'
        case 'leaderChange':
          if (ev.player === localId) {
            this.tone({ type: 'square', f0: 740, f1: 700, dur: 0.14, gain: 0.22 });
            this.tone({ type: 'square', f0: 587, f1: 560, dur: 0.2, gain: 0.22, delay: 0.16 });
          }
          break;
        case 'leaderKilled':
          this.tone({ type: 'sine', f0: 660, dur: 0.08, gain: 0.2 });
          this.tone({ type: 'sine', f0: 990, dur: 0.12, gain: 0.2, delay: 0.09 });
          break;
        case 'flagTaken':
          this.tone({ type: 'square', f0: 520, dur: 0.08, gain: 0.18 });
          this.tone({ type: 'square', f0: 660, dur: 0.08, gain: 0.18, delay: 0.09 });
          break;
        case 'flagCapped':
          this.tone({ type: 'square', f0: 520, dur: 0.08, gain: 0.2 });
          this.tone({ type: 'square', f0: 660, dur: 0.08, gain: 0.2, delay: 0.09 });
          this.tone({ type: 'square', f0: 880, dur: 0.14, gain: 0.2, delay: 0.18 });
          break;
        case 'matchEnd':
          this.tone({ type: 'sine', f0: 440, dur: 0.16, gain: 0.25 });
          this.tone({ type: 'sine', f0: 330, dur: 0.16, gain: 0.25, delay: 0.18 });
          this.tone({ type: 'sine', f0: 550, dur: 0.34, gain: 0.25, delay: 0.36 });
          break;
        default:
          break;
      }
    }
  }

  /** Per-frame: heartbeat when low HP. */
  update(local: PlayerState | undefined, dt: number): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (!local || !local.alive || local.hp >= C.MAX_HP * C.WOUNDED_TRAIL_HP) {
      this.heartPhase = 0;
      return;
    }
    const danger = 1 - local.hp / (C.MAX_HP * C.WOUNDED_TRAIL_HP);
    const rate = 1 + danger; // 1..2 Hz
    this.heartPhase += dt * rate;
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      const g = 0.18 + danger * 0.15;
      this.tone({ type: 'sine', f0: 58, f1: 40, dur: 0.09, gain: g });
      this.tone({ type: 'sine', f0: 52, f1: 38, dur: 0.08, gain: g * 0.8, delay: 0.14 });
    }
  }
}
