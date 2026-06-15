// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewportSize } from '../../src/core/viewport';

const src = readFileSync(resolve(__dirname, '../../src/render/renderer.ts'), 'utf8');

describe('renderer reads viewport bus, not window directly', () => {
  it('groundPoint/project no longer divide by window.innerWidth/Height', () => {
    // Extract the groundPoint+project span and assert it uses cached vw/vh.
    const span = src.slice(src.indexOf('groundPoint('), src.indexOf('dispose()'));
    expect(span).not.toMatch(/window\.innerWidth/);
    expect(span).not.toMatch(/window\.innerHeight/);
    expect(span).toMatch(/this\.vw/);
    expect(span).toMatch(/this\.vh/);
  });
  it('groundPoint reuses a private Vector3 (no per-call allocation)', () => {
    const span = src.slice(src.indexOf('groundPoint('), src.indexOf('project('));
    expect(span).not.toMatch(/new Vector3\(\)/); // hit vector is reused, not allocated
    expect(span).toMatch(/this\.groundHit/);
  });
  it('subscribes to onViewportChange and unsubscribes in dispose', () => {
    expect(src).toMatch(/onViewportChange/);
    expect(src).toMatch(/import .*viewportSize.*from ['"]\.\.\/core\/viewport['"]/);
    expect(src).toMatch(/this\.offViewport\?\.\(\)/); // unsubscribed in dispose
  });

  // Desktop byte-identity: on a stable desktop viewport (no visualViewport, or one
  // matching innerWidth/Height) the cached vw/vh equal innerWidth/innerHeight, so the
  // unprojection denominators in groundPoint/project are byte-identical to the old
  // window.innerWidth/Height code path — aim does not shift on desktop.
  it('cached vw/vh equal innerWidth/innerHeight on a stable desktop viewport', () => {
    (window as any).visualViewport = undefined;
    (window as any).innerWidth = 1920;
    (window as any).innerHeight = 1080;
    expect(viewportSize()).toEqual({ w: 1920, h: 1080 });

    // A visualViewport that mirrors the window (desktop, no URL bar) is also identical.
    (window as any).visualViewport = { width: 1920, height: 1080, addEventListener() {}, removeEventListener() {} };
    expect(viewportSize()).toEqual({ w: window.innerWidth, h: window.innerHeight });

    // And the NDC math is unchanged: (clientX/vw)*2-1 with vw===innerWidth is the
    // same value the old window.innerWidth path produced for the same input.
    const { w, h } = viewportSize();
    const clientX = 640, clientY = 360;
    const ndcOld = { x: (clientX / window.innerWidth) * 2 - 1, y: -(clientY / window.innerHeight) * 2 + 1 };
    const ndcNew = { x: (clientX / w) * 2 - 1, y: -(clientY / h) * 2 + 1 };
    expect(ndcNew).toEqual(ndcOld);
  });
});
