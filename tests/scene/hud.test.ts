// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { combatAnchor } from '../../src/render/hud';

describe('combatAnchor', () => {
  it('returns the mouse anchor in desktop mode', () => {
    const a = combatAnchor(false, { x: 11, y: 22 }, () => ({ x: 333, y: 444, visible: true }));
    expect(a).toEqual({ x: 11, y: 22 });
  });
  it('returns the projected babo anchor in touch mode', () => {
    const a = combatAnchor(true, { x: 11, y: 22 }, () => ({ x: 333, y: 444, visible: true }));
    expect(a).toEqual({ x: 333, y: 444 });
  });
});
