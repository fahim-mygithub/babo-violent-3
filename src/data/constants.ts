/** v1 starting values from the design doc §12 — all tunable. */
export const C = {
  BABO_RADIUS: 0.5,
  MAX_HP: 100,
  HEALTH_PACK_HEAL: 60,

  SIM_HZ: 60,
  SNAPSHOT_HZ: 20,
  INTERP_BUFFER_MS: 100,

  RESPAWN_DELAY: 3.0,
  SPAWN_INVULN: 1.5,

  // Blood
  SLICK_ZONE_CAP: 24,
  SLICK_DAMPING_MULT: 0.4,
  POOL_LIFETIME: 20,        // congeal time for physical pools
  WOUNDED_TRAIL_HP: 0.35,   // fraction of max HP below which you drip
  WOUNDED_DRIP_INTERVAL: 0.45,
  DEATH_POP_RADIUS: 2.5,
  DEATH_POP_IMPULSE: 6,
  DEATH_POOL_RADIUS: 1.6,
  MIN_PHYSICAL_POOL_RADIUS: 0.9, // pools smaller than this stay visual-only

  // Fire
  FIRE_ZONE_DPS: 22,
  FIRE_ZONE_LIFETIME: 4.5,
  BURN_TICK: 0.25,

  // Loot
  CORPSE_DROP_TTL: 30,
  EQUIPMENT_RESPAWN: 20,
  PICKUP_RADIUS: 0.85,      // auto-pickup contact distance
  GUN_PICKUP_RADIUS: 1.2,   // E-press radius

  // Modes
  TDM_FRAG_LIMIT: 50,
  TDM_TIME_LIMIT: 600,
  BOUNTY_WIN_SCORE: 30,
  BOUNTY_TIME_LIMIT: 600,
  BOUNTY_LEADER_BONUS: 5,
  CTF_CAP_LIMIT: 3,
  CTF_TIME_LIMIT: 600,
  FLAG_PICKUP_RADIUS: 1.0,
  FLAG_RETURN_TIME: 12,

  // Grenades / throw
  GRENADE_FUSE: 1.1,        // after landing
  GRENADE_MIN_RANGE: 3,
  GRENADE_MAX_RANGE: 14,
  GRENADE_AIM_TIME: 0.9,    // hold time to reach max range
  FRAG_DAMAGE: 55,
  FRAG_RADIUS: 3.0,
  FRAG_IMPULSE: 18,
  MOLOTOV_RADIUS: 2.2,
  SMOKE_RADIUS: 2.8,
  SMOKE_LIFETIME: 8,
  START_GRENADES: 2,
  GRENADE_CAP: 3,
  EQUIP_CAP: 2,

  // Physics
  WALL_HEIGHT: 1.6,         // visual wall height (grenades arc over)
  MOVE_FORCE_SCALE: 1.0,
  PROJECTILE_MAX_DIST: 40,
  /** Knockback impulse on a babo struck by the lance rail (hitscan + projectile). */
  LANCE_KNOCK: 10,

  // Bots
  BOT_NAMES: ['Crusher', 'Gibs', 'Rolo', 'Hemo', 'Splat', 'Maul', 'Vex', 'Plasma', 'Tank', 'Drip'],

  // --- Sim flag scaffolding (inert; consumed by later phases) -------------
  /** Per-babo continuous collision detection (sim.ts:139). false → drop CCD (S5.2a, D-SHIFT). */
  PLAYER_CCD: false, // babo per-tick displacement ≪ radius at 60Hz; CCD off saves mobile CPU
  /** D-SHIFT bundle version (distSq swaps + CCD). Bump re-baselines the golden hash (S5.1d/S5.8). */
  SIM_BASELINE_V: 2,
  /** Per-tick projectile cap; grief/lag-spam guard, drops oldest BULLET only (S2.7). */
  MAX_PROJECTILES: 256,
  /** Global concurrent WebAudio voice ceiling (S5.7c). */
  AUDIO_MAX_VOICES: 24,
  /** Per-gun min inter-shot interval (ms): drop a non-local 'shot' voice if the same gun fired more recently (S5.7c). */
  AUDIO_GUN_MIN_INTERVAL_MS: 25,
} as const;

/**
 * Sim feature flags. Imported by the sim AND tests (stays headless/deterministic
 * — NOT window.__bv3). MUST be identical on host + all clients (build/match
 * constant). Flag-ON and flag-OFF are DIFFERENT RNG streams once S2 routes the
 * Lance through fireProjectiles (S2.8), so each gets its own golden baseline.
 */
export const FLAGS = {
  /** false → exact legacy hitscan fireLance + old 'rail' event (desktop default). */
  PROJECTILE_LANCE: false,
  /** Per-tick projectile cap (mirrors C.MAX_PROJECTILES); applies to all guns (S2.7). */
  MAX_PROJECTILES: C.MAX_PROJECTILES,
} as const;
