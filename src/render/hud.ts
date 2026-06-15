import { C } from '../data/constants';
import { viewportSize, onViewportChange } from '../core/viewport';
import { CLASSES } from '../data/classes';
import { GUNS } from '../data/weapons';
import { EQUIPMENT } from '../data/equipment';
import type { GameEvent, PlayerState } from '../sim/types';
import type { WorldView } from './renderer';

interface FeedEntry { text: string; color: string; ttl: number }
interface DamageArc { angle: number; ttl: number }

const TAU = Math.PI * 2;

/**
 * Canvas-2D HUD overlay. Everything combat-critical hugs the crosshair —
 * ammo/heat arc, reload sweep, ability radial — so eyes stay on the Babo.
 */
export class Hud {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private feed: FeedEntry[] = [];
  private damageArcs: DamageArc[] = [];
  private hitMarkerT = 0;
  private killMarkerT = 0;
  private leaderPulse = 0;
  // CSS-px draw size. The canvas backing store is DPR-scaled; all draw code reads these.
  private cssW = 0;
  private cssH = 0;
  private offViewport: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    private project: (x: number, y: number, h?: number) => { x: number; y: number; visible: boolean },
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '10',
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
    const byId = new Map<number, PlayerState>();
    for (const p of view.players) byId.set(p.id, p);
    const local = byId.get(localId);
    for (const ev of events) {
      switch (ev.t) {
        case 'hit':
          if (ev.attacker === localId && ev.target !== localId) this.hitMarkerT = 0.22;
          if (ev.target === localId && local && this.damageArcs.length < 12) {
            const atk = byId.get(ev.attacker);
            if (atk) this.damageArcs.push({ angle: Math.atan2(atk.y - local.y, atk.x - local.x), ttl: 1.2 });
          }
          break;
        case 'death': {
          if (ev.killer === localId && ev.victim !== localId) this.killMarkerT = 0.45;
          const killer = byId.get(ev.killer);
          const victim = byId.get(ev.victim);
          const kn = killer && ev.killer !== ev.victim ? killer.name : '';
          const vn = victim ? victim.name : '?';
          const weapon = ev.gun === 'world' ? 'KO' : GUNS[ev.gun]?.name ?? ev.gun;
          this.feed.push({
            text: kn ? `${kn}  [${weapon}]  ${vn}` : `${vn} died`,
            color: ev.killer === localId ? '#ffd060' : ev.victim === localId ? '#ff6060' : '#d8dce0',
            ttl: 4.5,
          });
          if (this.feed.length > 5) this.feed.shift();
          break;
        }
        case 'leaderKilled':
          this.feed.push({ text: `BOUNTY CLAIMED (+${C.BOUNTY_LEADER_BONUS})`, color: '#ffc83a', ttl: 4 });
          break;
        default:
          break;
      }
    }
  }

  update(
    view: WorldView, localId: number, mouse: { x: number; y: number },
    showScores: boolean, dt: number,
  ): void {
    const g = this.g;
    const W = this.cssW;
    const H = this.cssH;
    g.clearRect(0, 0, W, H);

    let local: PlayerState | undefined;
    const players: PlayerState[] = [];
    for (const p of view.players) {
      players.push(p);
      if (p.id === localId) local = p;
    }
    if (!local) return;

    this.hitMarkerT = Math.max(0, this.hitMarkerT - dt);
    this.killMarkerT = Math.max(0, this.killMarkerT - dt);
    this.leaderPulse += dt;

    if (local.alive) this.drawCrosshair(g, local, mouse);
    this.drawDamageArcs(g, W, H, dt);
    this.drawFeed(g, W, dt);
    this.drawStatus(g, W, view, players, localId);
    this.drawPickupPrompt(g, view, local);
    if (!local.alive) this.drawRespawn(g, W, H, local);
    if (view.mode.mode === 'bounty' && view.mode.leaderId === localId) this.drawMarked(g, W);
    if (showScores || view.mode.ended) this.drawScoreboard(g, W, H, view, players, localId);
  }

  // --- Crosshair cluster ----------------------------------------------------

  private drawCrosshair(g: CanvasRenderingContext2D, p: PlayerState, mouse: { x: number; y: number }): void {
    const { x, y } = mouse;
    const gun = GUNS[p.gun];
    const cls = CLASSES[p.classId];

    // Reticle
    g.strokeStyle = this.hitMarkerT > 0 ? '#ff5050' : 'rgba(240,245,250,0.95)';
    g.lineWidth = 1.6;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      g.beginPath();
      g.moveTo(x + dx * 5, y + dy * 5);
      g.lineTo(x + dx * 11, y + dy * 11);
      g.stroke();
    }
    g.fillStyle = 'rgba(240,245,250,0.9)';
    g.beginPath(); g.arc(x, y, 1.5, 0, TAU); g.fill();

    // Hit / kill markers
    if (this.hitMarkerT > 0 || this.killMarkerT > 0) {
      const kill = this.killMarkerT > 0;
      const t = kill ? this.killMarkerT / 0.45 : this.hitMarkerT / 0.22;
      g.strokeStyle = kill ? `rgba(255,60,60,${t})` : `rgba(255,255,255,${t})`;
      g.lineWidth = kill ? 3 : 2;
      const r0 = 6, r1 = kill ? 18 : 14;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        g.beginPath();
        g.moveTo(x + sx * r0, y + sy * r0);
        g.lineTo(x + sx * r1, y + sy * r1);
        g.stroke();
      }
    }

    // Left arc: ammo (segments) or heat (fill). Hugs the crosshair.
    const R = 24;
    const a0 = Math.PI * 0.75; // upper-left
    const a1 = Math.PI * 1.25; // lower-left
    g.lineWidth = 4;
    if (gun.sustain === 'reload') {
      const mag = gun.magSize!;
      if (p.reloadT > 0) {
        // Reload sweep
        const frac = 1 - p.reloadT / gun.reloadTime!;
        g.strokeStyle = 'rgba(120,130,140,0.5)';
        g.beginPath(); g.arc(x, y, R, a0, a1); g.stroke();
        g.strokeStyle = '#ffd060';
        g.beginPath(); g.arc(x, y, R, a0, a0 + (a1 - a0) * frac); g.stroke();
        if (Math.sin(performance.now() / 90) > 0) {
          g.fillStyle = '#ffd060';
          g.font = 'bold 10px monospace';
          g.textAlign = 'center';
          g.fillText('RELOADING', x, y + R + 16);
        }
      } else {
        const segs = Math.min(mag, 20);
        const gap = 0.022;
        const segArc = (a1 - a0) / segs;
        const filled = Math.ceil((p.mag / mag) * segs);
        for (let i = 0; i < segs; i++) {
          g.strokeStyle = i < filled
            ? (p.mag / mag < 0.25 ? '#ff7040' : 'rgba(140,220,255,0.95)')
            : 'rgba(120,130,140,0.35)';
          g.beginPath();
          g.arc(x, y, R, a0 + i * segArc + gap, a0 + (i + 1) * segArc - gap);
          g.stroke();
        }
      }
    } else {
      // Heat fill
      g.strokeStyle = 'rgba(120,130,140,0.35)';
      g.beginPath(); g.arc(x, y, R, a0, a1); g.stroke();
      const hot = p.heat;
      const overheated = p.overheatT > 0;
      g.strokeStyle = overheated
        ? (Math.sin(performance.now() / 70) > 0 ? '#ff3020' : '#802018')
        : hot > 0.75 ? '#ff7040' : '#57c8e8';
      g.beginPath(); g.arc(x, y, R, a0, a0 + (a1 - a0) * hot); g.stroke();
      if (overheated) {
        g.fillStyle = '#ff5040';
        g.font = 'bold 10px monospace';
        g.textAlign = 'center';
        g.fillText('OVERHEAT', x, y + R + 16);
      }
    }

    // Spin-up / charge indicator (inner left arc)
    if (gun.spinUp && p.spin > 0) {
      g.lineWidth = 2.5;
      g.strokeStyle = p.spin >= 1 ? '#aef0ff' : 'rgba(174,240,255,0.55)';
      g.beginPath(); g.arc(x, y, R - 7, a0, a0 + (a1 - a0) * p.spin); g.stroke();
    }
    if (gun.chargeTime && p.charge > 0) {
      g.lineWidth = 2.5;
      g.strokeStyle = p.charge >= 1 ? '#d8b0ff' : 'rgba(176,112,255,0.7)';
      g.beginPath(); g.arc(x, y, R - 7, a0, a0 + (a1 - a0) * p.charge); g.stroke();
    }

    // Right arc: ability cooldown radial
    const b0 = -Math.PI * 0.25;
    const b1 = Math.PI * 0.25;
    const cd = cls.ability.cooldown;
    const ready = p.abilityCD <= 0;
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(120,130,140,0.35)';
    g.beginPath(); g.arc(x, y, R, b0, b1); g.stroke();
    g.strokeStyle = ready
      ? `rgba(140,255,170,${0.75 + 0.25 * Math.sin(performance.now() / 200)})`
      : 'rgba(200,210,225,0.6)';
    const frac = ready ? 1 : 1 - Math.min(1, p.abilityCD / cd);
    g.beginPath(); g.arc(x, y, R, b0, b0 + (b1 - b0) * frac); g.stroke();
    if (p.abilityT > 0 && (p.fortifyActive || p.phaseActive || p.dashActive)) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, R - 7, b0, b0 + (b1 - b0) * Math.min(1, p.abilityT)); g.stroke();
    }

    // Bottom: grenade pips + equipment
    let px = x - 12;
    const py = y + R + 4;
    for (let i = 0; i < p.grenades; i++) {
      g.fillStyle = '#9aa84a';
      g.beginPath(); g.arc(px, py, 3, 0, TAU); g.fill();
      px += 9;
    }
    if (p.equip && p.equipCount > 0) {
      const eq = EQUIPMENT[p.equip];
      g.fillStyle = '#' + eq.color.toString(16).padStart(6, '0');
      g.font = 'bold 9px monospace';
      g.textAlign = 'left';
      g.fillText(`${eq.name.toUpperCase()} ×${p.equipCount}`, x + 14, py + 3);
    }

    // Gun name (subtle, below)
    g.fillStyle = 'rgba(220,228,236,0.55)';
    g.font = '10px monospace';
    g.textAlign = 'center';
    g.fillText(gun.name.toUpperCase(), x, y - R - 8);
  }

  // --- Screen-edge directional damage ----------------------------------------

  private drawDamageArcs(g: CanvasRenderingContext2D, W: number, H: number, dt: number): void {
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) * 0.3;
    let w = 0;
    for (const arc of this.damageArcs) {
      arc.ttl -= dt;
      if (arc.ttl <= 0) continue;
      const alpha = Math.min(1, arc.ttl) * 0.6;
      g.strokeStyle = `rgba(255,40,30,${alpha})`;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(cx, cy, r, arc.angle - 0.22, arc.angle + 0.22);
      g.stroke();
      this.damageArcs[w++] = arc;
    }
    this.damageArcs.length = w;
  }

  // --- Feed / status / scoreboard --------------------------------------------

  private drawFeed(g: CanvasRenderingContext2D, W: number, dt: number): void {
    let y = 64;
    let w = 0;
    g.font = '13px monospace';
    g.textAlign = 'right';
    for (const e of this.feed) {
      e.ttl -= dt;
      if (e.ttl <= 0) continue;
      g.fillStyle = e.color.replace(')', '');
      g.globalAlpha = Math.min(1, e.ttl);
      g.fillStyle = e.color;
      g.fillText(e.text, W - 18, y);
      y += 19;
      this.feed[w++] = e;
    }
    this.feed.length = w;
    g.globalAlpha = 1;
  }

  private drawStatus(
    g: CanvasRenderingContext2D, W: number, view: WorldView,
    players: PlayerState[], localId: number,
  ): void {
    const m = view.mode;
    const t = Math.max(0, m.timeLeft);
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60).toString().padStart(2, '0');
    g.textAlign = 'center';
    g.font = 'bold 17px monospace';
    g.fillStyle = 'rgba(235,240,245,0.92)';
    g.fillText(`${mm}:${ss}`, W / 2, 30);
    g.font = '12px monospace';
    if (m.mode === 'tdm' || m.mode === 'ctf') {
      g.fillStyle = '#6aa8ff';
      g.textAlign = 'right';
      g.fillText(`BLUE ${m.teamScores[0]}`, W / 2 - 36, 30);
      g.fillStyle = '#ff6a6a';
      g.textAlign = 'left';
      g.fillText(`${m.teamScores[1]} RED`, W / 2 + 36, 30);
      g.fillStyle = 'rgba(180,190,200,0.7)';
      g.textAlign = 'center';
      g.fillText(m.mode === 'tdm' ? `first to ${m.scoreLimit}` : `${m.scoreLimit} caps`, W / 2, 47);
    } else {
      const sorted = [...players].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      g.fillStyle = 'rgba(180,190,200,0.7)';
      g.fillText(`HIGH BOUNTY · first to ${m.scoreLimit}`, W / 2, 47);
      if (top && top.score > 0) {
        g.fillStyle = '#ffc83a';
        g.fillText(`top: ${top.name} (${top.score})`, W / 2, 62);
      }
      const you = players.find((p) => p.id === localId);
      if (you) {
        g.fillStyle = 'rgba(235,240,245,0.9)';
        g.font = 'bold 13px monospace';
        g.fillText(`your score: ${you.score}`, W / 2, 79);
      }
    }
  }

  private drawPickupPrompt(g: CanvasRenderingContext2D, view: WorldView, local: PlayerState): void {
    if (!local.alive) return;
    for (const pk of view.pickups) {
      if (pk.kind !== 'gun' || !pk.gun) continue;
      const d = Math.hypot(pk.x - local.x, pk.y - local.y);
      if (d > C.GUN_PICKUP_RADIUS) continue;
      const pos = this.project(pk.x, pk.y, 0.8);
      if (!pos.visible) continue;
      g.font = 'bold 12px monospace';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(10,12,14,0.7)';
      const label = `[E] swap to ${GUNS[pk.gun].name}`;
      const tw = g.measureText(label).width;
      g.fillRect(pos.x - tw / 2 - 6, pos.y - 12, tw + 12, 18);
      g.fillStyle = '#ffd060';
      g.fillText(label, pos.x, pos.y + 1);
      break;
    }
  }

  private drawRespawn(g: CanvasRenderingContext2D, W: number, H: number, local: PlayerState): void {
    g.fillStyle = 'rgba(8,4,6,0.45)';
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.font = 'bold 26px monospace';
    g.fillStyle = '#ff6a6a';
    g.fillText('SPLATTERED', W / 2, H / 2 - 24);
    g.font = '15px monospace';
    g.fillStyle = 'rgba(230,235,240,0.85)';
    g.fillText(`respawn in ${Math.max(0, local.respawnT).toFixed(1)}s`, W / 2, H / 2 + 8);
  }

  private drawMarked(g: CanvasRenderingContext2D, W: number): void {
    const pulse = 0.6 + 0.4 * Math.sin(this.leaderPulse * 5);
    g.textAlign = 'center';
    g.font = 'bold 15px monospace';
    g.fillStyle = `rgba(255,200,58,${pulse})`;
    g.fillText('⚠ YOU ARE MARKED — everyone sees you ⚠', W / 2, 100);
  }

  private drawScoreboard(
    g: CanvasRenderingContext2D, W: number, H: number, view: WorldView,
    players: PlayerState[], localId: number,
  ): void {
    const sorted = [...players].sort((a, b) =>
      a.team !== b.team ? a.team - b.team : b.score - a.score);
    const rowH = 24;
    const bw = 560;
    const bh = 70 + sorted.length * rowH;
    const bx = (W - bw) / 2;
    const by = (H - bh) / 2;
    g.fillStyle = 'rgba(10,12,16,0.88)';
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = 'rgba(140,150,165,0.5)';
    g.strokeRect(bx, by, bw, bh);

    g.textAlign = 'center';
    g.font = 'bold 16px monospace';
    g.fillStyle = '#e8edf2';
    const title = view.mode.mode === 'tdm' ? 'TEAM DEATHMATCH'
      : view.mode.mode === 'ctf' ? 'CAPTURE THE FLAG' : 'HIGH BOUNTY';
    g.fillText(title, W / 2, by + 26);

    g.font = '12px monospace';
    g.textAlign = 'left';
    g.fillStyle = 'rgba(160,170,180,0.8)';
    g.fillText('NAME', bx + 24, by + 50);
    g.fillText('CLASS', bx + 220, by + 50);
    g.textAlign = 'right';
    g.fillText('K', bx + bw - 150, by + 50);
    g.fillText('D', bx + bw - 105, by + 50);
    g.fillText(view.mode.mode === 'bounty' ? 'SCORE' : 'PTS', bx + bw - 30, by + 50);

    sorted.forEach((p, i) => {
      const y = by + 70 + i * rowH;
      if (p.id === localId) {
        g.fillStyle = 'rgba(255,210,96,0.12)';
        g.fillRect(bx + 8, y - 15, bw - 16, rowH - 3);
      }
      g.textAlign = 'left';
      g.fillStyle = p.team === 0 ? '#6aa8ff' : p.team === 1 ? '#ff6a6a' : '#e0d8b0';
      const marker = view.mode.leaderId === p.id ? ' 👑' : '';
      g.fillText(`${p.name}${p.bot ? '·bot' : ''}${marker}`, bx + 24, y);
      g.fillStyle = 'rgba(200,208,216,0.85)';
      g.fillText(CLASSES[p.classId].name, bx + 220, y);
      g.textAlign = 'right';
      g.fillText(String(p.kills), bx + bw - 150, y);
      g.fillText(String(p.deaths), bx + bw - 105, y);
      g.fillStyle = '#ffd060';
      g.fillText(String(p.score), bx + bw - 30, y);
    });
  }

  dispose(): void {
    this.offViewport?.();
    this.offViewport = null;
    this.canvas.remove();
  }
}
