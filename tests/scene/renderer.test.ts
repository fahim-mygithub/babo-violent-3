// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { cameraLead } from '../../src/render/renderer';

describe('cameraLead', () => {
  it('scales the aim-lead term by aimLeadScale', () => {
    const full = cameraLead(0, 16, 1);     // aim=0, aimDist=16, scale=1
    const damped = cameraLead(0, 16, 0.35); // touch
    expect(damped.dx).toBeLessThan(full.dx);
    expect(damped.dx).toBeCloseTo(full.dx * 0.35, 6);
  });
  it('is zero when aimDist is zero', () => {
    expect(cameraLead(0, 0, 1)).toEqual({ dx: 0, dy: 0 });
  });
});
