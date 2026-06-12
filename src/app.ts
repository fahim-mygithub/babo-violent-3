import { FixedLoop } from './core/loop';
import { C } from './data/constants';
import { ALL_CLASS_IDS, type ClassId } from './data/classes';
import { ALL_GUN_IDS, GUNS, STARTER_GUN, type GunId } from './data/weapons';
import { DEFAULT_MAP, MAPS } from './data/maps';
import { GameSim } from './sim/sim';
import { emptyInput, type GameEvent, type ModeId, type PlayerState } from './sim/types';
import { GameRenderer, type WorldView } from './render/renderer';
import { Hud } from './render/hud';
import { ScreenFx } from './render/screenfx';
import { LobbyPreview } from './render/lobbyPreview';
import { InputManager } from './input';
import { AudioEngine } from './audio/audio';
import { UI, type LobbyConfig, type LobbyViewPlayer } from './ui/screens';
import { HostSession } from './net/host';
import { ClientSession } from './net/client';
import { sanitizeName, type MatchSettings } from './net/types';

type Role = 'local' | 'host' | 'client';

const NAME_KEY = 'bv3-name';
const CLASS_KEY = 'bv3-class';
const GUN_KEY = 'bv3-gun';

function defaultScore(mode: ModeId): number {
  return mode === 'tdm' ? C.TDM_FRAG_LIMIT : mode === 'ctf' ? C.CTF_CAP_LIMIT : C.BOUNTY_WIN_SCORE;
}

export class App {
  private ui: UI;
  private input = new InputManager();
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

  constructor(private container: HTMLElement) {
    (window as unknown as { __bv3: App }).__bv3 = this; // debug/test handle
    this.ui = new UI(container);
    this.playerName = localStorage.getItem(NAME_KEY) ?? `Babo${Math.floor(Math.random() * 900 + 100)}`;
    const storedClass = localStorage.getItem(CLASS_KEY) as ClassId | null;
    this.classId = storedClass && ALL_CLASS_IDS.includes(storedClass) ? storedClass : 'spider';
    const storedGun = localStorage.getItem(GUN_KEY) as GunId | null;
    this.gunId = storedGun && ALL_GUN_IDS.includes(storedGun) ? storedGun : STARTER_GUN;
    this.input.enabled = false;
    window.addEventListener('keydown', this.onGlobalKey);
    window.addEventListener('pointerdown', () => this.audio.resume(), { once: true });
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
    if (!this.lobbyPreview || !this.previewCanvas) {
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
    }
    slot.insertBefore(this.previewCanvas, slot.firstChild);
    this.lobbyPreview.setLoadout(this.classId, this.gunId);
    this.lobbyPreview.resize();
  }

  private disposeLobbyPreview(): void {
    this.lobbyPreview?.dispose();
    this.previewCanvas?.remove();
    this.lobbyPreview = null;
    this.previewCanvas = null;
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
        onStart: () => this.launchLocalMatch(),
        onLeave: () => this.showMenu(),
      },
    });
    this.mountLobbyPreview();
  }

  private async startHosting(): Promise<void> {
    this.ui.showConnecting('OPENING LOBBY…', () => this.showMenu());
    try {
      const settings: MatchSettings = {
        mode: this.cfg.mode, mapId: DEFAULT_MAP,
        scoreLimit: this.cfg.scoreLimit, botCount: this.cfg.botCount,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
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
        onStart: () => this.launchHostMatch(),
        onLeave: () => this.showMenu(),
      },
    });
    this.mountLobbyPreview();
  }

  private async joinGame(code: string): Promise<void> {
    this.ui.showConnecting('CONNECTING…', () => this.showMenu());
    try {
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

  private buildSim(settings: MatchSettings): GameSim {
    const sim = new GameSim({
      mapId: settings.mapId, mode: settings.mode, seed: settings.seed,
      scoreLimit: settings.scoreLimit,
    });
    return sim;
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

  private launchLocalMatch(): void {
    const settings: MatchSettings = {
      mode: this.cfg.mode, mapId: DEFAULT_MAP,
      scoreLimit: this.cfg.scoreLimit, botCount: this.cfg.botCount,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    this.lastSettings = settings;
    this.role = 'local';
    const sim = this.buildSim(settings);
    const me = sim.addPlayer(this.playerName, this.classId, settings.mode === 'bounty' ? -1 : 0, false, this.gunId);
    this.addBots(sim, settings.botCount, settings.mode, 1);
    this.localId = me.id;
    this.sim = sim;
    this.enterMatch(settings.mapId);
  }

  private launchHostMatch(): void {
    const host = this.host;
    if (!host) return;
    const settings = { ...host.settings, seed: Math.floor(Math.random() * 2 ** 31) };
    this.lastSettings = settings;
    this.role = 'host';
    const sim = this.buildSim(settings);
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
    host.startMatch(assignments);
    this.enterMatch(settings.mapId);
  }

  private launchClientMatch(settings: MatchSettings, yourId: number): void {
    this.role = 'client';
    this.lastSettings = settings;
    this.localId = yourId;
    this.sim = null;
    this.enterMatch(settings.mapId);
  }

  private enterMatch(mapId: string): void {
    this.ui.hide();
    this.disposeLobbyPreview();
    this.input.enabled = true;
    this.endTimer = -1;
    document.body.style.cursor = 'none';
    const map = MAPS[mapId] ?? MAPS.grinder;
    this.renderer = new GameRenderer(this.container, map);
    this.hud = new Hud(this.container, (x, y, h) => this.renderer!.project(x, y, h));
    this.fx = new ScreenFx(this.container);
    this.loop = new FixedLoop(C.SIM_HZ, () => this.tick(), (_alpha, frameDt) => this.frame(frameDt));
    this.loop.start();
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
    if (!local || !this.renderer) return emptyInput();
    const ground = this.renderer.groundPoint(this.input.mouseX, this.input.mouseY);
    return this.input.sample(ground, local.x, local.y);
  }

  private tick(): void {
    if (this.role === 'client') {
      const client = this.client;
      if (!client) return;
      const input = this.sampleInput(client.view);
      client.sendInput(input);
      return;
    }
    const sim = this.sim;
    if (!sim) return;
    const input = this.sampleInput(this.view());
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
    this.renderer.render(view, this.localId, frameDt);
    this.hud.update(view, this.localId, { x: this.input.mouseX, y: this.input.mouseY }, this.input.showScores, frameDt);
    this.fx.update(local, frameDt);
    this.audio.update(local, frameDt);

    if (this.endTimer > 0) {
      this.endTimer -= frameDt;
      if (this.endTimer <= 0) this.showEndScreen(view);
    }
  }

  private showEndScreen(view: WorldView): void {
    this.input.enabled = false;
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
            if (this.role === 'host') this.launchHostMatch();
            else this.launchLocalMatch();
          }
        : undefined,
      onMenu: () => this.showMenu(),
    });
  }

  private onClientMatchEnd(_winner: number): void {
    // client.view reflects ended/winner once the 'end' message lands
    if (this.endTimer < 0) this.endTimer = 2.4;
  }

  // ---------------------------------------------------------------------------

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
    this.loop?.stop();
    this.loop = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.hud?.dispose();
    this.hud = null;
    this.fx?.dispose();
    this.fx = null;
    this.sim = null;
    this.input.enabled = false;
    document.body.style.cursor = '';
  }

  private disposeNet(): void {
    this.host?.dispose();
    this.host = null;
    this.client?.dispose();
    this.client = null;
  }
}
