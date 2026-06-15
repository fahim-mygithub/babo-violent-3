import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

describe('index.html network hints', () => {
  it('preconnects to the default PeerJS broker', () => {
    expect(html).toMatch(/<link rel="preconnect" href="https:\/\/0\.peerjs\.com" crossorigin>/);
    expect(html).toMatch(/<link rel="dns-prefetch" href="https:\/\/0\.peerjs\.com">/);
  });
  it('does NOT TLS-preconnect the UDP STUN endpoint', () => {
    // stun.l.google.com:19302 speaks UDP, not TLS — a preconnect just times out.
    expect(html).not.toMatch(/rel="preconnect"[^>]*stun\.l\.google\.com/);
  });
});
