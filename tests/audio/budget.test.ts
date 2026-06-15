// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { C } from '../../src/data/constants';

describe('audio voice budgeting', () => {
  it('exposes a voice ceiling constant ~24', () => {
    expect(C.AUDIO_MAX_VOICES).toBeGreaterThanOrEqual(16);
    expect(C.AUDIO_MAX_VOICES).toBeLessThanOrEqual(32);
  });
  it('canVoice() returns false once activeVoices hits the ceiling', () => {
    const a = new AudioEngine() as any;
    a.activeVoices = C.AUDIO_MAX_VOICES;
    expect(a.canVoice()).toBe(false);
    a.activeVoices = 0;
    expect(a.canVoice()).toBe(true);
  });
  it('throttles a non-local gun re-fired within 25ms', () => {
    const a = new AudioEngine() as any;
    a.lastGunAt = {};
    expect(a.gunThrottled('stinger', 1000)).toBe(false); // first shot
    a.noteGun('stinger', 1000);
    expect(a.gunThrottled('stinger', 1010)).toBe(true);  // <25ms later
    expect(a.gunThrottled('stinger', 1030)).toBe(false); // >25ms later
  });
});
