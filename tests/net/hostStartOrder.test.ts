// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { commitHostMatch } from '../../src/app';

// launchHostMatch must bring the renderer/sim live (enterMatch, whose first act
// awaits the render-chunk imports) BEFORE telling clients to start. Otherwise a
// rejected render-chunk import strands every client in a started match while the
// host falls back to the lobby. commitHostMatch encodes that ordering contract.
describe('commitHostMatch ordering', () => {
  it('awaits enterMatch BEFORE startMatch (renderer live before clients committed)', async () => {
    const order: string[] = [];
    let resolveEnter: () => void = () => {};
    const enter = vi.fn(() => new Promise<void>((res) => {
      resolveEnter = () => { order.push('enter'); res(); };
    }));
    const startMatch = vi.fn(() => { order.push('start'); });
    const failToLobby = vi.fn();

    const p = commitHostMatch(enter, startMatch, failToLobby);
    // enterMatch is in flight; startMatch must NOT have fired yet.
    expect(startMatch).not.toHaveBeenCalled();
    resolveEnter();
    await p;

    expect(order).toEqual(['enter', 'start']); // enter resolved first
    expect(startMatch).toHaveBeenCalledTimes(1);
    expect(failToLobby).not.toHaveBeenCalled();
  });

  it('a rejected render-chunk import never calls startMatch and restores the lobby', async () => {
    const enter = vi.fn(() => Promise.reject(new Error('chunk load failed')));
    const startMatch = vi.fn();
    const failToLobby = vi.fn();

    await commitHostMatch(enter, startMatch, failToLobby);

    expect(startMatch).not.toHaveBeenCalled(); // clients never committed
    expect(failToLobby).toHaveBeenCalledTimes(1); // lobby restored
  });
});
