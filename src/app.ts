import { FixedLoop } from './core/loop';
import { C } from './data/constants';
import { ALL_CLASS_IDS, type ClassId } from './data/classes';
import { ALL_GUN_IDS, GUNS, STARTER_GUN, type GunId } from './data/weapons';
import { DEFAULT_MAP, MAPS } from './data/maps';
// initPhysics is light: the rapier WASM import lives *inside* it, pulled on first
// call (host/local launch), never at module load. The GameSim implementation is
// dynamically imported alongside it so the menu/entry chunk stays sim-free.
import { initPhysics } from './sim/sim';
import type { GameSim } from './sim/sim';
import { emptyInput, type GameEvent, type ModeId, type PlayerState } from './sim/types';
import type { GameRenderer, WorldView } from './render/renderer';
import type { Hud } from './render/hud';
import type { ScreenFx } from './render/screenfx';
import type { LobbyPreview } from './render/lobbyPreview';
import { shouldMountPreview } from './render/quality';
import { makeGunIcon } from './render/gunIcons';
import { InputManager } from './input';
import type { InputSource } from './input';
import { TouchControls, shouldUseTouch } from './touch/touchControls';
import { viewportSize, onViewportChange } from './core/viewport';
import { AudioEngine } from './audio/audio';
import { UI, type LobbyConfig, type LobbyViewPlayer } from './ui/screens';
import type { HostSession } from './net/host';
import type { ClientSession } from './net/client';
import { sanitizeName, type MatchSettings } from './net/types';

type Role = 'local' | 'host' | 'client';

// Re-export the node-safe lobby-preview gate (defined in quality.ts) so callers /
// tests can read it from the app entry without pulling the DOM-heavy LobbyPreview.
export { shouldMountPreview } from './render/quality';

const NAME_KEY = 'bv3-name';
const CLASS_KEY = 'bv3-class';
const GUN_KEY = 'bv3-gun';

function defaultScore(mode: ModeId): number {
  return mode === 'tdm' ? C.TDM_FRAG_LIMIT : mode === 'ctf' ? C.CTF_CAP_LIMIT : C.BOUNTY_WIN_SCORE;
}

/**
 * Host match-commit ordering. `enter` (= App.enterMatch, whose first act awaits
 * the render-chunk imports) MUST resolve — renderer + sim live — BEFORE `startMatch`
 * tells every client to begin. A rejected render-chunk import then never commits
 * the clients: it skips `startMatch` and runs `failToLobby` recovery instead, so
 * no client is stranded in a started match the host failed to enter.
 */
export async function commitHostMatch(
  enter: () => Promise<void>,
  startMatch: () => void,
  failToLobby: () => void,
): Promise<void> {
  try {
    await enter();
  } catch {
    failToLobby();
    return;
  }
  startMatch();
}

export class App {
  private ui: UI;
  private kbm = new InputManager();
  private touch: TouchControls | null = null;
  private activeSource: InputSource = this.kbm;
  private useTouch = false;
  private audio = new AudioEngine();

  // Lobby state
  private playerName: string;
  private classId: ClassId;
  private gunId: GunId;
  private cfg: LobbyConfig = { mode: 'tdm', botCount: 5, scoreLimit: defaultScore('tdm') };
  private host: HostSession | null = null;
  private client: ClientSession | null = null;

  // Animated lobby showcase (persists across lobby re-renders; re-parented each time)
  private lobbyPreview: LobbyPreview | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewIcon: HTMLCanvasElement | null = null; // static gun-icon fallback (low tier)
  private previewLoading = false; // guards the async LobbyPreview import from double-construction
  private prefetched = false;

  // Match state
  private role: Role = 'local';
  private sim: GameSim | null = null;
  private renderer: GameRenderer | null = null;
  private hud: Hud | null = null;
  private fx: ScreenFx | null = null;
  private loop: FixedLoop | null = null;
  private localId = 0;
  private endTimer = -1;
  private escAt = 0;
  private lastSettings: MatchSettings | null = null;
  // Screen Wake Lock sentinel; null when unheld (auto-released on hide → re-acquired).
  private wakeLock: { release?: () => Promise<void> } | null = null;
  // Viewport-change unsubscribe for the touch camera scalars (orientation flip).
  private viewportUnsub: (() => void) | null = null;

  constructor(private container: HTMLElement) {
    (window as unknown as { __bv3: App }).__bv3 = this; // debug/test handle
    this.ui = new UI(container);
    this.playerName = localStorage.getItem(NAME_KEY) ?? `Babo${Math.floor(Math.random() * 900 + 100)}`;
    const storedClass = localStorage.getItem(CLASS_KEY) as ClassId | null;
    this.classId = storedClass && ALL_CLASS_IDS.includes(storedClass) ? storedClass : 'spider';
    const storedGun = localStorage.getItem(GUN_KEY) as GunId | null;
    this.gunId = storedGun && ALL_GUN_IDS.includes(storedGun) ? storedGun : STARTER_GUN;
    this.kbm.enabled = false;
    window.addEventListener('keydown', this.onGlobalKey);
    // Broaden the unlock gesture set for iOS (pointerdown+touchend can both fire
    // from one tap) and de-register ALL of them on the first success so the
    // `unlocked` flag isn't relied on alone.
    const unlockEvents = ['pointerdown', 'touchend', 'keydown'] as const;
    const unlock = (): void => {
      this.audio.unlock();
      for (const ev of unlockEvents) window.removeEventListener(ev, unlock);
    };
    for (const ev of unlockEvents) window.addEventListener(ev, unlock);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  start(): void {
    this.showMenu();
  }

  // ---------------------------------------------------------------------------
  // Menu / lobby flows
  // ---------------------------------------------------------------------------

  private showMenu(): void {
    this.teardownMatch();
    this.disposeNet();
    this.disposeLobbyPreview();
    this.ui.showMenu({
      onPractice: () => this.showLocalLobby(),
      onHost: () => this.startHosting(),
      onJoin: (code) => this.joinGame(code),
    });
  }

  private pickClass(id: ClassId): void {
    this.classId = id;
    localStorage.setItem(CLASS_KEY, id);
    this.syncLoadout();
  }

  private pickGun(id: GunId): void {
    this.gunId = id;
    localStorage.setItem(GUN_KEY, id);
    this.syncLoadout();
  }

  private syncLoadout(): void {
    this.host?.setLocalLoadout(this.playerName, this.classId, this.gunId);
    this.client?.setLoadout(this.playerName, this.classId, this.gunId);
  }

  /** Commit an edited babo name (from the lobby), persist it, and sync to peers. */
  private setName(name: string): void {
    const n = sanitizeName(name); // same rule the host applies, so client isYou stays stable
    this.playerName = n;
    localStorage.setItem(NAME_KEY, n);
    this.syncLoadout();
  }

  /**
   * Mount the persistent animated showcase into the freshly-rendered lobby. The
   * lobby DOM is rebuilt on every pick, so the WebGL canvas is created once and
   * re-parented into each new `#preview-slot` rather than recreated (which would
   * leak GL contexts and flicker).
   */
  private mountLobbyPreview(): void {
    const slot = this.container.querySelector('#preview-slot');
    if (!slot) return;
    // S3.8: on low we never spin up a WebGL preview context — render a static gun
    // icon instead and bail before any start()/setLoadout()/resize() call.
    if (!shouldMountPreview()) {
      this.renderStaticGunIcon(slot);
      return;
    }
    // Already constructed: just re-parent + restate (synchronous, no flicker).
    if (this.lobbyPreview && this.previewCanvas) {
      slot.insertBefore(this.previewCanvas, slot.firstChild);
      this.lobbyPreview.setLoadout(this.classId, this.gunId);
      this.lobbyPreview.resize();
      return;
    }
    if (this.previewLoading) return; // import in flight; a later showLobby will mount it
    this.previewLoading = true;
    void import('./render/lobbyPreview')
      .then(({ LobbyPreview }) => {
        this.previewLoading = false;
        // The lobby may have been torn down (match entered / menu) while loading.
        const liveSlot = this.container.querySelector('#preview-slot');
        if (!liveSlot) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'preview-canvas';
        this.previewCanvas = canvas;
        this.lobbyPreview = new LobbyPreview(canvas);
        this.lobbyPreview.onCaption = (txt) => {
          const cap = document.getElementById('demo-caption');
          if (cap) {
            cap.textContent = txt ? `▶ ${txt}` : '';
            cap.classList.toggle('on', !!txt);
          }
        };
        this.lobbyPreview.start();
        liveSlot.insertBefore(canvas, liveSlot.firstChild);
        this.lobbyPreview.setLoadout(this.classId, this.gunId);
        this.lobbyPreview.resize();
      })
      .catch(() => { this.previewLoading = false; });
  }

  /**
   * Static gun-icon fallback for the low tier (no WebGL preview context). Draws the
   * 2D selector icon for the current gun into the preview slot; re-rendered on each
   * loadout pick. Tolerates being called repeatedly (replaces the prior icon).
   */
  private renderStaticGunIcon(slot: Element): void {
    const icon = makeGunIcon(this.gunId);
    icon.className = 'preview-canvas preview-static';
    this.previewIcon?.remove();
    this.previewIcon = icon;
    slot.insertBefore(icon, slot.firstChild);
  }

  private disposeLobbyPreview(): void {
    this.lobbyPreview?.dispose();
    this.previewCanvas?.remove();
    this.previewIcon?.remove();
    this.lobbyPreview = null;
    this.previewCanvas = null;
    this.previewIcon = null;
  }

  /**
   * Fire-and-forget warm of the rapier + render chunks the moment a lobby opens,
   * so the first cold local/host match doesn't freeze on a black screen while the
   * WASM + render bundle download. Rejections are harmless — they re-import on use.
   */
  private prefetchMatchChunks(): void {
    if (this.prefetched) return;
    this.prefetched = true;
    void import('@dimforge/rapier2d-compat').catch(() => {});
    void import('./render/renderer').catch(() => {});
    void import('./render/hud').catch(() => {});
    void import('./render/screenfx').catch(() => {});
  }

  private showLocalLobby(): void {
    const bots: LobbyViewPlayer[] = [];
    for (let i = 0; i < this.cfg.botCount; i++) {
      bots.push({
        name: C.BOT_NAMES[i % C.BOT_NAMES.length],
        classId: ALL_CLASS_IDS[i % ALL_CLASS_IDS.length],
        team: this.cfg.mode === 'bounty' ? -1 : (i + 1) % 2,
        bot: true,
      });
    }
    this.ui.showLobby({
      title: 'PRACTICE',
      name: this.playerName,
      players: [
        { name: this.playerName, classId: this.classId, gun: this.gunId, team: this.cfg.mode === 'bounty' ? -1 : 0, isYou: true, isHost: true },
        ...bots,
      ],
      cfg: this.cfg,
      selectedClass: this.classId,
      selectedGun: this.gunId,
      isHost: true,
      canConfigure: true,
      cb: {
        onClassPick: (id) => { this.pickClass(id); this.showLocalLobby(); },
        onGunPick: (id) => { this.pickGun(id); this.showLocalLobby(); },
        onNameChange: (name) => this.setName(name),
        onConfigChange: (cfg) => {
          const modeChanged = cfg.mode !== this.cfg.mode;
          this.cfg = cfg;
          if (modeChanged) this.cfg.scoreLimit = defaultScore(cfg.mode);
          this.showLocalLobby();
        },
        onStart: () => { void this.launchLocalMatch().catch(() => this.failToLobby()); },
        onLeave: () => this.showMenu(),
      },
    });
    this.mountLobbyPreview();
    this.prefetchMatchChunks();
  }

  private async startHosting(): Promise<void> {
    this.ui.showConnecting('OPENING LOBBY…', () => this.showMenu());
    try {
      const settings: MatchSettings = {
        mode: this.cfg.mode, mapId: DEFAULT_MAP,
        scoreLimit: this.cfg.scoreLimit, botCount: this.cfg.botCount,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      const { HostSession } = await import('./net/host'); // pulls the peerjs chunk on host
      this.host = await HostSession.create(this.playerName, this.classId, this.gunId, settings);
      this.host.onLobby = () => this.showHostLobby();
      this.host.onError = (msg) => { this.ui.toast(`Connection error: ${msg}`); };
      this.showHostLobby();
    } catch (err) {
      this.ui.toast(`Could not open lobby: ${(err as Error).message}`);
      this.showMenu();
    }
  }

  private showHostLobby(): void {
    const host = this.host;
    if (!host) return;
    const s = host.settings;
    const bots: LobbyViewPlayer[] = [];
    for (let i = 0; i < s.botCount; i++) {
      bots.push({
        name: C.BOT_NAMES[i % C.BOT_NAMES.length],
        classId: ALL_CLASS_IDS[i % ALL_CLASS_IDS.length],
        team: s.mode === 'bounty' ? -1 : 1, // placeholder; real teams assigned at start
        bot: true,
      });
    }
    this.ui.showLobby({
      title: 'HOST GAME',
      code: host.code,
      name: this.playerName,
      players: [
        ...host.players.map((p, i) => ({
          name: p.name, classId: p.classId, gun: p.gun,
          team: s.mode === 'bounty' ? -1 : i % 2,
          isHost: p.isHost, isYou: p.isHost, bot: false,
        })),
        ...bots,
      ],
      cfg: { mode: s.mode, botCount: s.botCount, scoreLimit: s.scoreLimit },
      selectedClass: this.classId,
      selectedGun: this.gunId,
      isHost: true,
      canConfigure: true,
      cb: {
        // host.onLobby (= showHostLobby) re-renders via broadcastLobby, so these
        // must NOT also call showHostLobby() inline or the lobby rebuilds twice.
        onClassPick: (id) => this.pickClass(id),
        onGunPick: (id) => this.pickGun(id),
        onNameChange: (name) => this.setName(name),
        onConfigChange: (cfg) => {
          host.updateSettings({
            mode: cfg.mode, botCount: cfg.botCount,
            scoreLimit: cfg.mode !== host.settings.mode ? defaultScore(cfg.mode) : cfg.scoreLimit,
          });
        },
        onStart: () => { void this.launchHostMatch().catch(() => this.failToLobby()); },
        onLeave: () => this.showMenu(),
      },
    });
    this.mountLobbyPreview();
    this.prefetchMatchChunks();
  }

  private async joinGame(code: string): Promise<void> {
    this.ui.showConnecting('CONNECTING…', () => this.showMenu());
    try {
      const { ClientSession } = await import('./net/client'); // pulls the peerjs chunk on join
      this.client = await ClientSession.join(code, this.playerName, this.classId, this.gunId);
      this.client.onLobby = () => this.showClientLobby();
      this.client.onClosed = (reason) => {
        this.ui.toast(reason === 'hostLeft' ? 'Host left — match over' : `Disconnected: ${reason}`);
        this.showMenu();
      };
      this.client.onStart = (settings, yourId) => this.launchClientMatch(settings, yourId);
      this.client.onEnd = (winner) => this.onClientMatchEnd(winner);
      this.showClientLobby();
    } catch (err) {
      this.ui.toast(`Could not join: ${(err as Error).message}`);
      this.showMenu();
    }
  }

  private showClientLobby(): void {
    const client = this.client;
    if (!client || !client.settings) return;
    const s = client.settings;
    this.ui.showLobby({
      title: 'LOBBY',
      name: this.playerName,
      players: client.players.map((p, i) => ({
        name: p.name, classId: p.classId, gun: p.gun,
        team: s.mode === 'bounty' ? -1 : i % 2,
        // Identify our own row by peer id, not name (names are editable/duplicable).
        isHost: p.isHost, isYou: !p.isHost && p.peerId === client.myPeerId, bot: p.bot,
      })),
      cfg: { mode: s.mode, botCount: s.botCount, scoreLimit: s.scoreLimit },
      selectedClass: this.classId,
      selectedGun: this.gunId,
      isHost: false,
      canConfigure: false,
      cb: {
        onClassPick: (id) => { this.pickClass(id); this.showClientLobby(); },
        onGunPick: (id) => { this.pickGun(id); this.showClientLobby(); },
        onNameChange: (name) => this.setName(name),
        onConfigChange: () => {},
        onStart: () => {},
        onLeave: () => this.showMenu(),
      },
    });
    this.mountLobbyPreview();
  }

  // ---------------------------------------------------------------------------
  // Match lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Build a sim, pulling the rapier chunk + .wasm and the GameSim implementation
   * here (never at boot). The CLIENT never calls this, so it never downloads Rapier.
   */
  private async loadSim(settings: MatchSettings): Promise<GameSim> {
    await initPhysics(); // pulls the rapier chunk + .wasm here, never at boot
    const { GameSim } = await import('./sim/sim');
    return new GameSim({
      mapId: settings.mapId, mode: settings.mode, seed: settings.seed,
      scoreLimit: settings.scoreLimit,
    });
  }

  private addBots(sim: GameSim, count: number, mode: ModeId, startTeam: number): void {
    for (let i = 0; i < count; i++) {
      sim.addPlayer(
        C.BOT_NAMES[i % C.BOT_NAMES.length],
        ALL_CLASS_IDS[Math.floor(Math.random() * ALL_CLASS_IDS.length)],
        mode === 'bounty' ? -1 : ((startTeam + i) % 2) as 0 | 1,
        true,
        // Varied bot loadouts feed the scavenge loop — their corpses drop these
        ALL_GUN_IDS[Math.floor(Math.random() * ALL_GUN_IDS.length)],
      );
    }
  }

  private async launchLocalMatch(): Promise<void> {
    const settings: MatchSettings = {
      mode: this.cfg.mode, mapId: DEFAULT_MAP,
      scoreLimit: this.cfg.scoreLimit, botCount: this.cfg.botCount,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    this.lastSettings = settings;
    this.role = 'local';
    const sim = await this.loadSim(settings);
    const me = sim.addPlayer(this.playerName, this.classId, settings.mode === 'bounty' ? -1 : 0, false, this.gunId);
    this.addBots(sim, settings.botCount, settings.mode, 1);
    this.localId = me.id;
    this.sim = sim;
    await this.enterMatch(settings.mapId);
  }

  private async launchHostMatch(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const settings = { ...host.settings, seed: Math.floor(Math.random() * 2 ** 31) };
    this.lastSettings = settings;
    this.role = 'host';
    const sim = await this.loadSim(settings);
    const assignments = new Map<string, number>();
    let teamCursor = 0;
    for (const lp of host.players) {
      const team = settings.mode === 'bounty' ? -1 : (teamCursor++ % 2) as 0 | 1;
      const p = sim.addPlayer(lp.name, lp.classId, team, false, lp.gun);
      if (lp.isHost) this.localId = p.id;
      else assignments.set(lp.peerId, p.id);
    }
    this.addBots(sim, settings.botCount, settings.mode, teamCursor);
    this.sim = sim;
    // Bring the renderer/sim live (enterMatch awaits the render-chunk imports)
    // BEFORE telling clients to start — a rejected import then never strands a
    // client in a started match the host failed to enter (commitHostMatch skips
    // startMatch and falls back to the lobby instead).
    await commitHostMatch(
      () => this.enterMatch(settings.mapId),
      () => host.startMatch(assignments),
      () => this.failToLobby(),
    );
  }

  // CLIENT path: never loads a sim and never imports Rapier — it renders the
  // host's authoritative view, so it only needs the render chunk.
  private launchClientMatch(settings: MatchSettings, yourId: number): void {
    this.role = 'client';
    this.lastSettings = settings;
    this.localId = yourId;
    this.sim = null;
    this.enterMatch(settings.mapId).catch(() => {
      this.ui.toast('Failed to load — check connection');
      this.showMenu();
    });
  }

  private async enterMatch(mapId: string): Promise<void> {
    // Pull the render chunk BEFORE hiding the lobby so a slow/failed load never
    // leaves a black screen — ui.hide() only runs once the imports resolve.
    const [{ GameRenderer }, { Hud }, { ScreenFx }] = await Promise.all([
      import('./render/renderer'), import('./render/hud'), import('./render/screenfx'),
    ]);
    this.ui.hide();
    this.disposeLobbyPreview();
    this.kbm.enabled = true;
    this.endTimer = -1;
    document.body.style.cursor = 'none';
    const map = MAPS[mapId] ?? MAPS.grinder;
    this.renderer = new GameRenderer(this.container, map);
    this.hud = new Hud(this.container, (x, y, h) => this.renderer!.project(x, y, h));
    this.fx = new ScreenFx(this.container);

    // Touch is built lazily, only when it's the effective source (coarse pointer
    // or the manual override). On desktop this stays false → activeSource is kbm,
    // no #touch-layer is created, and the input path is byte-identical.
    this.useTouch = shouldUseTouch();
    if (this.useTouch) {
      this.touch = new TouchControls(this.container, this.localId);
      this.touch.onLeave = () => this.showMenu();
      this.activeSource = this.touch;
      document.body.classList.add('touch-mode');
    } else {
      this.activeSource = this.kbm;
    }
    this.hud.touchMode = this.useTouch;

    // Touch camera (S1.13): zoom out 1.25× in portrait so the cramped vertical
    // FOV still shows the fight; damp the aim-lead so the auto-fire stick doesn't
    // yank the camera. On desktop useTouch is false → scalars stay 1/0/1 (camera
    // byte-unchanged). Recompute on every orientation/URL-bar flip.
    const applyTouchCam = (): void => {
      if (!this.renderer) return;
      const { w, h } = viewportSize();
      const isPortrait = h > w;
      this.renderer.aimLeadScale = this.useTouch ? 0.35 : 1;
      this.renderer.camDistScale = (this.useTouch && isPortrait) ? 1.25 : 1;
    };
    applyTouchCam();
    this.viewportUnsub = onViewportChange(applyTouchCam);

    this.loop = new FixedLoop(C.SIM_HZ, () => this.tick(), (_alpha, frameDt) => this.frame(frameDt), 5, this.role === 'host');
    this.loop.start();
    void this.acquireWakeLock();

    // Android-only progressive enhancement: go fullscreen so the URL bar / nav
    // chrome stop stealing vertical space. Gated on a coarse pointer AND the
    // presence of Element.requestFullscreen — iPhone Safari lacks it, so it
    // silently no-ops and falls back to the visualViewport/safe-area layout
    // (which never depends on fullscreen). NEVER lock orientation: portrait is a
    // product decision, not a programmatic constraint. Rejection is swallowed.
    const el = this.container as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (
      el.requestFullscreen &&
      typeof matchMedia === 'function' &&
      matchMedia('(pointer: coarse)').matches
    ) {
      el.requestFullscreen().catch(() => {
        /* iOS / user-denied: the layout works without fullscreen. */
      });
    }
  }

  private view(): WorldView | null {
    if (this.role === 'client') return this.client?.view ?? null;
    const sim = this.sim;
    if (!sim) return null;
    return {
      // Array, not the live Map iterator — every consumer iterates this view.
      players: [...sim.players.values()],
      projectiles: sim.projectiles,
      grenades: sim.grenades,
      pools: sim.pools,
      fires: sim.fires,
      smokes: sim.smokes,
      pickups: sim.pickups,
      mode: sim.mode,
    };
  }

  private localPlayer(view: WorldView | null): PlayerState | undefined {
    if (!view) return undefined;
    for (const p of view.players) if (p.id === this.localId) return p;
    return undefined;
  }

  private sampleInput(view: WorldView | null) {
    const local = this.localPlayer(view);
    if (!local) return emptyInput();
    return this.samplePos(local.x, local.y);
  }

  /**
   * Produce this frame's input given the local player's position. Split out from
   * sampleInput so the client tick path can feed predictedSelf() (S5.4) and avoid
   * forcing a full interpolated view rebuild just to read the own-babo position.
   */
  private samplePos(px: number, py: number) {
    if (!this.renderer) return emptyInput();
    // Touch path: the producer computes its own aim from the right stick, so it
    // gets a zero ground (no mouse unprojection) + the live world for aim-assist
    // (set via setWorld at the call site).
    if (this.activeSource === this.touch && this.touch) {
      return this.touch.sample({ x: 0, y: 0 }, px, py);
    }
    const ground = this.renderer.groundPoint(this.kbm.mouseX, this.kbm.mouseY);
    return this.kbm.sample(ground, px, py);
  }

  private tick(): void {
    if (this.role === 'client') {
      const client = this.client;
      if (!client) return;
      // Per-tick own-babo position comes from the predictor, never the full view —
      // so the tick loop doesn't trigger an interpolated rebuild. The touch source
      // still needs the live world for aim-assist, so only it reads client.view
      // (a cache hit within the frame thanks to view memoization).
      const self = client.predictedSelf();
      if (this.activeSource === this.touch && this.touch) this.touch.setWorld(client.view, this.localId);
      const input = self ? this.samplePos(self.x, self.y) : emptyInput();
      client.sendInput(input);
      return;
    }
    const sim = this.sim;
    if (!sim) return;
    const view = this.view();
    this.touch?.setWorld(view, this.localId);
    const input = this.sampleInput(view);
    sim.setInput(this.localId, input);
    this.host?.applyInputs(sim);
    sim.step();
    const events = sim.events.splice(0);
    this.dispatchEvents(events);
    this.host?.afterStep(sim, events);
    if (sim.mode.ended && this.endTimer < 0) {
      this.endTimer = 2.4; // linger on the carnage before the scoreboard
      this.host?.sendEnd(sim.mode.winner);
    }
  }

  private dispatchEvents(events: GameEvent[]): void {
    if (events.length === 0) return;
    const view = this.view();
    if (!view || !this.renderer || !this.hud || !this.fx) return;
    this.renderer.handleEvents(events, this.localId, view);
    this.hud.handleEvents(events, this.localId, view);
    this.fx.handleEvents(events, this.localId, view);
    this.audio.handleEvents(events, this.localId, view);
  }

  private frame(frameDt: number): void {
    if (this.role === 'client' && this.client) {
      this.client.update(frameDt);
      this.dispatchEvents(this.client.drainEvents());
    }
    const view = this.view();
    if (!view || !this.renderer || !this.hud || !this.fx) return;
    const local = this.localPlayer(view);
    // Touch aim laser (S1.10): draw along the grenade arc while it's held, else
    // the gun aim, only while the right stick / arc is active. Desktop leaves this
    // untouched (no touch source → no laser ever).
    if (this.touch) {
      const arc = this.touch.grenadeArc;
      this.renderer.setAimState(arc.active ? arc.aim : this.touch.aimAngle, arc.active || this.touch.aimActive);
    }
    this.renderer.render(view, this.localId, frameDt);
    this.hud.update(view, this.localId, { x: this.kbm.mouseX, y: this.kbm.mouseY }, this.activeSource.showScores, frameDt);
    // PICKUP button is shown only while the HUD pickup prompt is live (S1.7).
    this.touch?.setPickupVisible(this.hud.pickupPromptActive);
    this.fx.update(local, frameDt);
    this.audio.update(local, frameDt);

    if (this.endTimer > 0) {
      this.endTimer -= frameDt;
      if (this.endTimer <= 0) this.showEndScreen(view);
    }
  }

  private showEndScreen(view: WorldView): void {
    this.kbm.enabled = false;
    document.body.style.cursor = '';
    const players = [...view.players];
    this.ui.showEnd({
      mode: view.mode.mode,
      winner: view.mode.winner,
      players,
      localId: this.localId,
      onAgain: this.role !== 'client'
        ? () => {
            this.teardownMatch();
            const again = this.role === 'host' ? this.launchHostMatch() : this.launchLocalMatch();
            void again.catch(() => this.failToLobby());
          }
        : undefined,
      onMenu: () => this.showMenu(),
    });
  }

  /** A rejected match-entry import (chunk/WASM fetch failed) restores the lobby instead of a black screen. */
  private failToLobby(): void {
    this.teardownMatch();
    this.ui.toast('Failed to load — check connection');
    this.showMenu();
  }

  private onClientMatchEnd(_winner: number): void {
    // client.view reflects ended/winner once the 'end' message lands
    if (this.endTimer < 0) this.endTimer = 2.4;
  }

  // ---------------------------------------------------------------------------

  /**
   * Hidden tab → suspend audio ONLY (the FixedLoop keeps ticking so a host stays
   * authoritative). Foreground → re-arm audio and re-acquire the wake lock (it
   * auto-releases when hidden).
   */
  private onVisibility = (): void => {
    if (document.hidden) {
      this.audio.suspend();
    } else {
      this.audio.resumeIfUnlocked();
      void this.acquireWakeLock();
    }
  };

  /** Keep the screen awake during a match. Feature-detected + try/catch (iOS<16.4 degrades silently). */
  private async acquireWakeLock(): Promise<void> {
    if (!this.loop) return; // only during a match
    const navigator = window.navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release?: () => Promise<void> }> } };
    try {
      if (navigator.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* unsupported or denied — the screen may dim; harmless */ }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release?.();
    this.wakeLock = null;
  }

  private onGlobalKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.loop) {
      const now = performance.now();
      if (now - this.escAt < 1400) {
        if (this.role === 'host') this.host?.sendEnd(-1);
        this.showMenu();
      } else {
        this.escAt = now;
        this.ui.toast('Press ESC again to leave the match');
      }
    }
  };

  private teardownMatch(): void {
    this.releaseWakeLock();
    this.viewportUnsub?.();
    this.viewportUnsub = null;
    this.loop?.stop();
    this.loop = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.hud?.dispose();
    this.hud = null;
    this.fx?.dispose();
    this.fx = null;
    this.sim = null;
    this.touch?.dispose();
    this.touch = null;
    this.activeSource = this.kbm;
    this.useTouch = false;
    document.body.classList.remove('touch-mode');
    this.kbm.enabled = false;
    document.body.style.cursor = '';
  }

  private disposeNet(): void {
    this.host?.dispose();
    this.host = null;
    this.client?.dispose();
    this.client = null;
  }
}
