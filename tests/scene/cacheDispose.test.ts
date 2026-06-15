// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride } from '../../src/render/quality';
import { buildGunModel, disposeGunModel, disposeGunCache } from '../../src/render/gunModels';
import { buildClassVisual, disposeClassVisual, disposeClassCache } from '../../src/render/baboShapes';

afterEach(() => { disposeGunCache(); disposeClassCache(); setTierOverride('high'); });

describe('gun cache disposal guard (low/mid)', () => {
  it('does NOT dispose cache-owned geometry on per-instance dispose, but the cache can be disposed once', () => {
    setTierOverride('mid');
    const a = buildGunModel('stinger');
    const b = buildGunModel('stinger'); // shares cached geo/mat
    let disposed = 0;
    // Spy: count geometry.dispose calls across both instances
    a.traverse((o: any) => { if (o.geometry) { const d = o.geometry.dispose.bind(o.geometry); o.geometry.dispose = () => { disposed++; d(); }; } });
    disposeGunModel(a); // must skip cache-owned geo
    disposeGunModel(b);
    expect(disposed).toBe(0); // cache-owned, untouched by per-instance dispose
  });

  it('high tier keeps the proven per-instance path (no cache, dispose frees everything)', () => {
    setTierOverride('high');
    const a = buildGunModel('stinger');
    let disposed = 0;
    a.traverse((o: any) => { if (o.geometry) { const d = o.geometry.dispose.bind(o.geometry); o.geometry.dispose = () => { disposed++; d(); }; } });
    expect(() => { disposeGunModel(a); }).not.toThrow();
    expect(disposed).toBeGreaterThan(0); // per-instance geometry freed
  });
});

describe('class visual cache disposal guard (low/mid)', () => {
  it('does NOT dispose cache-owned geometry on per-instance dispose', () => {
    setTierOverride('mid');
    const a = buildClassVisual('spider');
    const b = buildClassVisual('spider');
    let disposed = 0;
    for (const o of [...a.roll, ...a.upright]) {
      o.traverse((c: any) => { if (c.geometry) { const d = c.geometry.dispose.bind(c.geometry); c.geometry.dispose = () => { disposed++; d(); }; } });
    }
    disposeClassVisual(a);
    disposeClassVisual(b);
    expect(disposed).toBe(0);
  });
});

describe('spawn -> swap-gun -> despawn -> respawn-same-class: no double-dispose (forced low/mid)', () => {
  it('never double-frees a shared cached gun geometry across the full lifecycle', () => {
    setTierOverride('mid'); // mergeStatics ON → cache path
    const disposeCounts = new Map<unknown, number>();
    const spy = (model: { traverse: (cb: (o: any) => void) => void }): void => {
      model.traverse((o: any) => {
        if (o.geometry && !(o.geometry.__spied)) {
          o.geometry.__spied = true;
          const d = o.geometry.dispose.bind(o.geometry);
          o.geometry.dispose = () => {
            disposeCounts.set(o.geometry, (disposeCounts.get(o.geometry) ?? 0) + 1);
            d();
          };
        }
      });
    };

    // Spawn babo A holding stinger.
    const a1 = buildGunModel('stinger'); spy(a1);
    // Swap gun: dispose the held model, build the new one.
    disposeGunModel(a1);
    const a2 = buildGunModel('workhorse'); spy(a2);
    // Despawn babo A: dispose its current held model.
    disposeGunModel(a2);
    // Respawn babo B with the SAME class/gun as A's first: must reuse the cache,
    // and disposing A earlier must NOT have freed the shared geometry.
    const b1 = buildGunModel('stinger'); spy(b1);
    disposeGunModel(b1);

    // No geometry was disposed more than once (no GL use-after-dispose).
    for (const [, n] of disposeCounts) expect(n).toBeLessThanOrEqual(1);

    // After the whole lifecycle the cache still owns live geometry — disposing the
    // cache frees it exactly once and does not throw.
    expect(() => disposeGunCache()).not.toThrow();
  });
});
