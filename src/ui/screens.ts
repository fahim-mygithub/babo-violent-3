import { ALL_CLASS_IDS, CLASSES, type ClassId } from '../data/classes';
import { ALL_GUN_IDS, GUNS, type GunId } from '../data/weapons';
import type { ModeId, PlayerState } from '../sim/types';

export interface LobbyViewPlayer {
  name: string;
  classId: ClassId;
  gun?: GunId;
  team: number;
  isHost?: boolean;
  isYou?: boolean;
  bot?: boolean;
}

export interface LobbyConfig {
  mode: ModeId;
  botCount: number;
  scoreLimit: number;
}

export interface MenuCallbacks {
  onPractice: () => void;
  onHost: () => void;
  onJoin: (code: string) => void;
}

export interface LobbyCallbacks {
  onClassPick: (id: ClassId) => void;
  onGunPick: (id: GunId) => void;
  onConfigChange: (cfg: LobbyConfig) => void;
  onStart: () => void;
  onLeave: () => void;
}

const MODE_NAMES: Record<ModeId, string> = {
  tdm: 'Team Deathmatch',
  bounty: 'High Bounty (FFA)',
  ctf: 'Capture the Flag',
};

/** DOM screen manager: menu, lobby, end screen, toasts, how-to-play. */
export class UI {
  private root: HTMLElement;
  private current: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.root = container;
  }

  private swap(el: HTMLElement | null): void {
    this.current?.remove();
    this.current = el;
    if (el) this.root.appendChild(el);
  }

  hide(): void {
    this.swap(null);
  }

  toast(msg: string, ms = 2600): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------------------------------------------------------------------

  showMenu(cb: MenuCallbacks): void {
    const el = document.createElement('div');
    el.className = 'screen';
    el.innerHTML = `
      <div class="title">BABO<span class="v3"> VIOLENT 3</span></div>
      <div class="subtitle">blood is terrain · recoil is movement</div>
      <div class="menu-col">
        <button class="btn primary" data-act="practice">PRACTICE VS BOTS</button>
        <button class="btn" data-act="host">HOST GAME</button>
        <div class="row">
          <input class="field" id="join-code" placeholder="JOIN CODE" maxlength="24" spellcheck="false">
          <button class="btn" data-act="join" style="white-space:nowrap">JOIN</button>
        </div>
        <button class="btn" data-act="howto">HOW TO PLAY</button>
      </div>
      <div class="footnote">P2P · no servers · a spiritual successor to Babo Violent 2</div>
    `;
    el.querySelector('[data-act="practice"]')!.addEventListener('click', cb.onPractice);
    el.querySelector('[data-act="host"]')!.addEventListener('click', cb.onHost);
    const codeInput = el.querySelector('#join-code') as HTMLInputElement;
    const join = () => {
      const code = codeInput.value.trim();
      if (code) cb.onJoin(code);
      else this.toast('Enter a join code first');
    };
    el.querySelector('[data-act="join"]')!.addEventListener('click', join);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    el.querySelector('[data-act="howto"]')!.addEventListener('click', () => this.showHowTo(() => this.showMenu(cb)));
    this.swap(el);
  }

  showHowTo(onBack: () => void): void {
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <div class="title" style="font-size:34px">HOW TO PLAY</div>
      <div class="howto">
        <h4>THE BASICS</h4>
        You are a <b>Babo</b> — a blood-filled rolling sphere. Move with <span class="key">WASD</span>,
        aim with the <b>mouse</b>, fire with <span class="key">LMB</span>. Your health shows <b>on your
        Babo</b>: the redder and fuller it looks, the closer you are to popping.
        <h4>MOMENTUM IS THE SKILL</h4>
        You never stop on a dime. Heavy guns <b>shove you backwards</b> when fired — use the
        Thumper to rocket-jump, the Maw to kick away from danger, the Hurricane as a thruster.
        <h4>BLOOD IS TERRAIN</h4>
        Blood pools are <b>slick</b> — you'll slide through them. Fire (Pyre, Molotov) <b>ignites</b>
        them. Wounded enemies drip a trail you can follow.
        <h4>THE LOOT LOOP</h4>
        Kills pop the victim, dropping their <b>gun + a health pack</b>. Health is auto-pickup;
        guns need <span class="key">E</span> (one-gun swap). Equipment spawns on map nodes.
        <h4>EVERYTHING ELSE</h4>
        <span class="key">SPACE</span> class ability · <span class="key">RMB hold</span> aim grenade
        arc, release to lob over walls · <span class="key">TAB</span> scoreboard
      </div>
      <button class="btn" style="width:200px">BACK</button>
    `;
    el.querySelector('button')!.addEventListener('click', onBack);
    this.swap(el);
  }

  // ---------------------------------------------------------------------------

  showLobby(opts: {
    title: string;
    code?: string;
    players: LobbyViewPlayer[];
    cfg: LobbyConfig;
    selectedClass: ClassId;
    selectedGun: GunId;
    isHost: boolean;
    canConfigure: boolean;
    cb: LobbyCallbacks;
  }): void {
    const { players, cfg, selectedClass, selectedGun, isHost, canConfigure, cb } = opts;
    const el = document.createElement('div');
    el.className = 'screen';

    const classCards = ALL_CLASS_IDS.map((id) => {
      const c = CLASSES[id];
      const col = '#' + c.color.toString(16).padStart(6, '0');
      return `
        <div class="class-card ${id === selectedClass ? 'sel' : ''}" data-class="${id}">
          <div class="ball" style="background: radial-gradient(circle at 35% 30%, ${col}, #16181d 90%)"></div>
          <div class="cname">${c.name}</div>
          <div class="crole">${c.role}</div>
        </div>`;
    }).join('');

    const sel = CLASSES[selectedClass];
    const maxMass = 5, maxSpeed = 18;
    const detail = `
      <div class="class-detail">
        <b>${sel.name}</b> — <span class="ab">${sel.ability.name}</span>: ${sel.ability.description}
        <div class="stat-bars">
          <div class="sb"><label>Speed</label><div class="bar"><i style="width:${(sel.maxSpeed / maxSpeed) * 100}%"></i></div></div>
          <div class="sb"><label>Mass</label><div class="bar"><i style="width:${(sel.mass / maxMass) * 100}%"></i></div></div>
          <div class="sb"><label>Cooldown</label><div class="bar"><i style="width:${(sel.ability.cooldown / 6) * 100}%"></i></div></div>
        </div>
      </div>`;

    const gun = GUNS[selectedGun];
    const gunChips = ALL_GUN_IDS.map((id) => {
      const g = GUNS[id];
      const col = '#' + g.color.toString(16).padStart(6, '0');
      return `
        <div class="gun-chip ${id === selectedGun ? 'sel' : ''}" data-gun="${id}" title="${g.identity}">
          <span class="dot" style="background:${col}"></span>${g.name}
        </div>`;
    }).join('');
    const gunDetail = `
      <div class="class-detail" style="min-height:20px;margin-top:8px">
        <b>${gun.name}</b> — ${gun.identity} ·
        ${gun.sustain === 'reload' ? `mag ${gun.magSize}` : 'heat'} · recoil ${gun.recoil}
      </div>`;

    const rows = players.map((p) => `
      <div class="player-row ${p.team === 0 ? 't0' : p.team === 1 ? 't1' : 'ffa'}">
        <span>${p.isYou ? '▸ ' : ''}${p.name}${p.bot ? ' <span class="tag">BOT</span>' : ''}</span>
        <span class="tag">${CLASSES[p.classId].name}${p.gun ? ' · ' + GUNS[p.gun].name : ''}${p.isHost ? ' · HOST' : ''}</span>
      </div>`).join('');

    const codeBlock = opts.code
      ? `<h3>Join code — click to copy</h3><div class="join-code" id="code">${opts.code}</div>
         <div class="hint" style="margin-top:8px">friends: menu → enter code → JOIN</div>`
      : '';

    const configBlock = canConfigure ? `
      <div class="opt-row"><label>Mode</label>
        <select id="cfg-mode">
          ${(['tdm', 'bounty', 'ctf'] as ModeId[]).map((m) =>
            `<option value="${m}" ${cfg.mode === m ? 'selected' : ''}>${MODE_NAMES[m]}</option>`).join('')}
        </select>
      </div>
      <div class="opt-row"><label>Bots</label>
        <input type="number" id="cfg-bots" min="0" max="7" value="${cfg.botCount}" style="width:64px">
      </div>
      <div class="opt-row"><label>Score limit</label>
        <input type="number" id="cfg-score" min="1" max="100" value="${cfg.scoreLimit}" style="width:64px">
      </div>`
      : `<div class="opt-row"><label>Mode</label><span>${MODE_NAMES[cfg.mode]}</span></div>
         <div class="opt-row"><label>Score limit</label><span>${cfg.scoreLimit}</span></div>`;

    el.innerHTML = `
      <div class="title" style="font-size:30px">${opts.title}</div>
      <div class="lobby">
        <div class="panel">
          <h3>Pick your chassis</h3>
          <div class="class-grid">${classCards}</div>
          ${detail}
          <h3 style="margin-top:14px">Pick your gun</h3>
          <div class="gun-row">${gunChips}</div>
          ${gunDetail}
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="panel">${codeBlock}
            <h3 style="margin-top:${opts.code ? '14px' : '0'}">Match</h3>
            ${configBlock}
          </div>
          <div class="panel" style="flex:1">
            <h3>Players (${players.length})</h3>
            <div class="player-list">${rows}</div>
          </div>
          <div class="row">
            <button class="btn small" id="leave">LEAVE</button>
            ${isHost ? '<button class="btn primary" id="start" style="flex:1">START MATCH</button>'
                     : '<div class="hint" style="flex:1">waiting for host to start…</div>'}
          </div>
        </div>
      </div>
    `;

    el.querySelectorAll('.class-card').forEach((card) => {
      card.addEventListener('click', () => cb.onClassPick((card as HTMLElement).dataset.class as ClassId));
    });
    el.querySelectorAll('.gun-chip').forEach((chip) => {
      chip.addEventListener('click', () => cb.onGunPick((chip as HTMLElement).dataset.gun as GunId));
    });
    el.querySelector('#code')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(opts.code!);
      this.toast('Code copied');
    });
    if (canConfigure) {
      const read = (): LobbyConfig => ({
        mode: (el.querySelector('#cfg-mode') as HTMLSelectElement).value as ModeId,
        botCount: Math.max(0, Math.min(7, Number((el.querySelector('#cfg-bots') as HTMLInputElement).value) || 0)),
        scoreLimit: Math.max(1, Math.min(100, Number((el.querySelector('#cfg-score') as HTMLInputElement).value) || 1)),
      });
      for (const id of ['#cfg-mode', '#cfg-bots', '#cfg-score']) {
        el.querySelector(id)?.addEventListener('change', () => cb.onConfigChange(read()));
      }
    }
    el.querySelector('#leave')!.addEventListener('click', cb.onLeave);
    el.querySelector('#start')?.addEventListener('click', cb.onStart);
    this.swap(el);
  }

  // ---------------------------------------------------------------------------

  showEnd(opts: {
    mode: ModeId;
    winner: number;
    players: PlayerState[];
    localId: number;
    onAgain?: () => void;
    onMenu: () => void;
  }): void {
    const { mode, winner, players, localId } = opts;
    const local = players.find((p) => p.id === localId);
    let won: boolean;
    let titleText: string;
    if (mode === 'bounty') {
      won = winner === localId;
      const wp = players.find((p) => p.id === winner);
      titleText = winner === -1 ? 'DRAW' : won ? 'VICTORY' : `${wp?.name ?? '?'} WINS`;
    } else {
      won = winner !== -1 && local?.team === winner;
      titleText = winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    }

    const sorted = [...players].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const rows = sorted.map((p) => `
      <tr class="${p.id === localId ? 'me' : ''}">
        <td>${p.name}${p.bot ? ' (bot)' : ''}</td>
        <td>${CLASSES[p.classId].name}</td>
        <td>${p.kills}</td>
        <td>${p.deaths}</td>
        <td>${p.score}</td>
      </tr>`).join('');

    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <div class="end-title ${won ? 'win' : 'lose'}">${titleText}</div>
      <table class="end-table">
        <tr><th>Player</th><th>Class</th><th>K</th><th>D</th><th>Score</th></tr>
        ${rows}
      </table>
      <div class="row" style="margin-top:10px">
        ${opts.onAgain ? '<button class="btn primary" id="again">PLAY AGAIN</button>' : ''}
        <button class="btn" id="menu">MAIN MENU</button>
      </div>
    `;
    el.querySelector('#again')?.addEventListener('click', opts.onAgain!);
    el.querySelector('#menu')!.addEventListener('click', opts.onMenu);
    this.swap(el);
  }

  /** Lightweight non-blocking connecting indicator. */
  showConnecting(text: string, onCancel: () => void): void {
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <div class="title" style="font-size:26px">${text}</div>
      <button class="btn small">CANCEL</button>
    `;
    el.querySelector('button')!.addEventListener('click', onCancel);
    this.swap(el);
  }
}
