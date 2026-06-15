/**
 * Fixed-step simulation loop with render interpolation alpha.
 * sim runs at a fixed tick; render is called every animation frame with
 * alpha = fraction of a tick elapsed.
 *
 * Hidden-tab resilience: rAF stops firing in background tabs, which would
 * freeze the sim — fatal when this browser is the multiplayer HOST. A
 * setInterval fallback keeps ticking (render skipped) while hidden.
 */
export class FixedLoop {
  readonly dt: number;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private interval = 0;
  private running = false;

  constructor(
    tickHz: number,
    private readonly tick: () => void,
    private readonly render: (alpha: number, frameDt: number) => void,
    private readonly maxCatchUp = 5,
    // Only the HOST keeps ticking while hidden (it's authoritative). Local/client
    // intentionally pause-and-resync on hidden, so they skip the keep-alive.
    private readonly keepAliveWhenHidden = false,
  ) {
    this.dt = 1 / tickHz;
  }

  private advance(doRender: boolean): void {
    const now = performance.now();
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    // Clamp huge gaps so we don't spiral after stalls. Hidden tabs get a much
    // larger budget: Chrome throttles timers to ~1 Hz back there, and the sim
    // must keep real-time pace when this browser hosts a match (~1s of sim
    // costs only a few ms).
    const maxGap = doRender ? this.dt * this.maxCatchUp : 1.2;
    if (frameDt > maxGap) frameDt = maxGap;
    this.acc += frameDt;
    while (this.acc >= this.dt) {
      this.tick();
      this.acc -= this.dt;
    }
    if (doRender) this.render(this.acc / this.dt, frameDt);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (): void => {
      if (!this.running) return;
      this.advance(true);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    // Background fallback: keep the sim alive while the tab is hidden. Host-only —
    // local/client pause-and-resync instead, so they never install this interval.
    if (this.keepAliveWhenHidden) {
      this.interval = window.setInterval(() => {
        if (this.running && document.hidden) this.advance(false);
      }, 50);
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.interval);
  }
}
