// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreenFx } from '../../src/render/screenfx';
import { emptyInput, type PlayerState } from '../../src/sim/types';

function ctxSpy() {
  return {
    clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(),
    fill: vi.fn(), createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    setTransform: vi.fn(), fillStyle: '', globalAlpha: 1,
  };
}

function makeLocal(hp: number): PlayerState {
  return { id: 0, name: 'me', classId: 'spider', team: -1, bot: false,
    x: 0, y: 0, vx: 0, vy: 0, aim: 0, hp, alive: true, respawnT: 0, invulnT: 0, spawnProt: false,
    gun: 'rifle', chosenGun: 'rifle', mag: 30, reloadT: 0, heat: 0, overheatT: 0, spin: 0, charge: 0,
    fireCD: 0, spreadAcc: 0, grenades: 0, equip: null, equipCount: 0, throwT: 0, throwing: false,
    abilityCD: 0, abilityT: 0, grappleActive: false, grappleX: 0, grappleY: 0, grappleLen: 0,
    fortifyActive: false, phaseActive: false, dashActive: false, burnT: 0, burnTick: 0, dripT: 0,
    inSlick: false, kills: 0, deaths: 0, score: 0, bounty: 0, carryingFlag: -1,
    input: emptyInput(), prevButtons: 0, lastAckSeq: -1 } as unknown as PlayerState;
}

describe('screenfx caching + early-out', () => {
  let spy: ReturnType<typeof ctxSpy>;
  beforeEach(() => {
    spy = ctxSpy();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(spy as unknown as CanvasRenderingContext2D);
  });

  it('skips the draw path entirely when idle (full HP, no splatters, no flash)', () => {
    const fx = new ScreenFx(document.createElement('div'));
    spy.clearRect.mockClear(); // ignore any construction-time clears
    fx.update(makeLocal(100), 1 / 60);
    expect(spy.clearRect).not.toHaveBeenCalled(); // early-out before any draw
  });

  it('reuses the cached radial gradient across frames at a stable danger level', () => {
    const fx = new ScreenFx(document.createElement('div'));
    for (let i = 0; i < 10; i++) fx.update(makeLocal(20), 1 / 60); // hpFrac 0.2, danger constant
    expect(spy.createRadialGradient.mock.calls.length).toBe(1); // built once, cached
  });
});
