// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';

function stubAudio() {
  const calls = { resume: 0, silentBuffers: 0 };
  class FakeCtx {
    state = 'suspended';
    sampleRate = 48000;
    destination = {};
    currentTime = 0;
    createDynamicsCompressor() { return { threshold: {}, ratio: {}, connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource() { calls.silentBuffers++; return { buffer: null, connect() { return this; }, start() {}, stop() {} }; }
    resume() { calls.resume++; this.state = 'running'; return Promise.resolve(); }
  }
  (window as any).AudioContext = FakeCtx;
  (window as any).webkitAudioContext = undefined;
  return calls;
}

describe('iOS audio unlock', () => {
  it('plays a silent buffer once and sets unlocked, ignoring repeat gestures', () => {
    const calls = stubAudio();
    const a = new AudioEngine();
    a.unlock();
    a.unlock(); // a second gesture (e.g. touchend after pointerdown) must be a no-op
    expect(a.unlocked).toBe(true);
    expect(calls.silentBuffers).toBe(1);
  });
});
