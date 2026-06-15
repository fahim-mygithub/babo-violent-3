/**
 * Single mutable runtime config read by render / input / net / shell.
 * NEVER imported by src/sim/** (enforced by tests/purity.test.ts). Sim-scoped
 * flags (PROJECTILE_LANCE, PLAYER_CCD, SIM_BASELINE_V, …) live in constants.ts.
 *
 * Forcing { tier:'high', touch:false, projectileLance:false } reproduces today's
 * exact desktop build at every phase boundary.
 */
export type Tier = 'high' | 'mid' | 'low';

export interface RuntimeConfig {
  tier: Tier;
  touch: boolean;
  /** UI/render mirror of constants FLAGS.PROJECTILE_LANCE for shell wiring. */
  projectileLance: boolean;
}

const DEFAULTS: RuntimeConfig = { tier: 'high', touch: false, projectileLance: false };

/** Live, mutable singleton — importers keep this exact reference. */
export const RUNTIME: RuntimeConfig = { ...DEFAULTS };

/** Restore desktop defaults (used by tests and source hot-swap). */
export function resetRuntime(): void {
  RUNTIME.tier = DEFAULTS.tier;
  RUNTIME.touch = DEFAULTS.touch;
  RUNTIME.projectileLance = DEFAULTS.projectileLance;
}
