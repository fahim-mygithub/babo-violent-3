import { C } from '../data/constants';
import { viewportSize, onViewportChange } from '../core/viewport';
import type { GameEvent, PlayerState } from '../sim/types';
import type { WorldView } from './renderer';

interface Splatter { x: number; y: number; r: number; rot: number; ttl: number; maxTtl: number }

/**
 * Full-screen feedback: low-HP vignette + heartbeat pulse, blood splatter when
 * something pops near you, brief red flash when you take a big hit.
 */
export class ScreenFx {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private splatters: Splatter[] = [];
  private hurtFlash = 0;
  private heartbeat = 0;
  // CSS-px draw size. The canvas backing store is DPR-scaled; all draw code reads these.
  private cssW = 0;
  private cssH = 0;
  private offViewport: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'fx-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9',
    } as CSSStyleDeclaration);
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.resize();
    this.offViewport = onViewportChange(() => this.resize());
  }

  private resize(): void {
    const { w, h } = viewportSize();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
  }

  handleEvents(events: GameEvent[], localId: number, view: WorldView): void {
    let local: PlayerState | undefined;
    for (const p of view.players) if (p.id === localId) { local = p; break; }
    for (const ev of events) {
      if (ev.t === 'pop' && local) {
        const d = Math.hypot(ev.x - local.x, ev.y - local.y);
        if (d < 7) this.addSplatter(1 - d / 7, ev.player === localId);
      } else if (ev.t === 'hit' && ev.target === localId && ev.damage >= 12) {
        this.hurtFlash = Math.min(0.5, this.hurtFlash + ev.damage / 130);
      }
    }
  }

  private addSplatter(intensity: number, own: boolean): void {
    const W = this.cssW;
    const H = this.cssH;
    const count = Math.round(2 + intensity * 3) + (own ? 3 : 0);
    for (let i = 0; i < count; i++) {
      if (this.splatters.length >= 14) this.splatters.shift();
      this.splatters.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: (18 + Math.random() * 55) * (0.4 + intensity * 0.6),
        rot: Math.random() * Math.PI * 2,
        ttl: 0.9 + Math.random() * 0.9,
        maxTtl: 1.8,
      });
    }
  }

  update(local: PlayerState | undefined, dt: number): void {
    const g = this.g;
    const W = this.cssW;
    const H = this.cssH;
    g.clearRect(0, 0, W, H);

    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);
    this.heartbeat += dt;

    // Screen splatter blobs
    let w = 0;
    for (const s of this.splatters) {
      s.ttl -= dt;
      if (s.ttl <= 0) continue;
      const alpha = Math.min(1, s.ttl / (s.maxTtl * 0.5)) * 0.38;
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.rot);
      g.fillStyle = `rgba(112,4,8,${alpha})`;
      g.beginPath();
      g.ellipse(0, 0, s.r, s.r * 0.62, 0, 0, Math.PI * 2);
      g.fill();
      // drip
      g.fillStyle = `rgba(90,3,6,${alpha * 0.8})`;
      g.fillRect(-s.r * 0.06, 0, s.r * 0.12, s.r * (1 + (1 - s.ttl / s.maxTtl) * 1.4));
      g.restore();
      this.splatters[w++] = s;
    }
    this.splatters.length = w;

    // Hurt flash
    if (this.hurtFlash > 0) {
      g.fillStyle = `rgba(180,10,12,${this.hurtFlash})`;
      g.fillRect(0, 0, W, H);
    }

    // Low-HP vignette + heartbeat
    if (local && local.alive) {
      const hpFrac = local.hp / C.MAX_HP;
      if (hpFrac < 0.45) {
        const danger = 1 - hpFrac / 0.45;
        const beat = Math.pow(Math.max(0, Math.sin(this.heartbeat * (4 + danger * 4))), 6);
        const intensity = danger * (0.45 + beat * 0.25);
        const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
        grad.addColorStop(0, 'rgba(120,0,4,0)');
        grad.addColorStop(1, `rgba(120,0,4,${intensity})`);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
    }
  }

  dispose(): void {
    this.offViewport?.();
    this.offViewport = null;
    this.canvas.remove();
  }
}
