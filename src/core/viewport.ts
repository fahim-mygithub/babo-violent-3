export interface ViewportSize { w: number; h: number; }

/** Prefer visualViewport (iOS URL-bar aware); fall back to innerWidth/Height. */
export function viewportSize(): ViewportSize {
  const vv = window.visualViewport;
  if (vv) return { w: vv.width, h: vv.height };
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Subscribe to viewport changes. rAF-coalesces visualViewport resize+scroll and
 * window resize+orientationchange into a single callback per frame so the three
 * canvases never desync during a URL-bar transition. Returns an unsubscribe.
 */
export function onViewportChange(cb: () => void): () => void {
  let scheduled = false;
  const fire = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; cb(); });
  };
  const vv = window.visualViewport;
  vv?.addEventListener('resize', fire);
  vv?.addEventListener('scroll', fire);
  window.addEventListener('resize', fire);
  window.addEventListener('orientationchange', fire);
  return () => {
    vv?.removeEventListener('resize', fire);
    vv?.removeEventListener('scroll', fire);
    window.removeEventListener('resize', fire);
    window.removeEventListener('orientationchange', fire);
  };
}
