// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { Group, Mesh, Scene, SphereGeometry } from 'three';
import { setTierOverride } from '../../src/render/quality';
import { buildGunModel, disposeGunCache } from '../../src/render/gunModels';
import { buildClassVisual, disposeClassCache } from '../../src/render/baboShapes';
import { makeBaboMaterial } from '../../src/render/baboShader';
import { disposeLobbyScene } from '../../src/render/lobbyPreview';

afterEach(() => { disposeGunCache(); disposeClassCache(); setTierOverride('high'); });

// Build a minimal lobby-preview-shaped scene graph: a baboRoot with a body that
// carries the class roll bits + an uprightHolder, and a mount that holds the gun.
function buildPreviewLike() {
  const scene = new Scene();
  const baboRoot = new Group();
  const mount = new Group();
  const body = new Mesh(new SphereGeometry(0.5, 8, 6), makeBaboMaterial(0x808080, 0.5, 0.5));
  baboRoot.add(body, mount);
  scene.add(baboRoot);

  const visual = buildClassVisual('spider');
  for (const o of visual.roll) body.add(o);
  const uprightHolder = new Group();
  for (const o of visual.upright) uprightHolder.add(o);
  baboRoot.add(uprightHolder);

  const gun = buildGunModel('stinger');
  mount.add(gun);

  return { scene, baboRoot, mount, body, visual, uprightHolder, gun };
}

describe('LobbyPreview.dispose does not double-free cache-owned templates (mid tier)', () => {
  it('the blanket scene traverse never disposes a cache-owned gun/class geometry', () => {
    setTierOverride('mid'); // mergeStatics ON → gun/class come from the shared cache

    // A second clone proves the cache is live + shared (same geo refs).
    const sharedGun = buildGunModel('stinger');
    const sharedVisual = buildClassVisual('spider');

    const p = buildPreviewLike();

    // Spy on EVERY geometry currently reachable from the scene, counting disposes.
    const counts = new Map<unknown, number>();
    p.scene.traverse((o: any) => {
      if (o.geometry && !o.geometry.__spied) {
        o.geometry.__spied = true;
        const d = o.geometry.dispose.bind(o.geometry);
        o.geometry.dispose = () => { counts.set(o.geometry, (counts.get(o.geometry) ?? 0) + 1); d(); };
      }
    });
    // Collect the cache-owned geometries (those shared with the standalone clones).
    const cacheGeo = new Set<unknown>();
    for (const src of [sharedGun, sharedVisual.roll, sharedVisual.upright].flat() as any[]) {
      src.traverse((o: any) => { if (o.geometry) cacheGeo.add(o.geometry); });
    }
    expect(cacheGeo.size).toBeGreaterThan(0); // sanity: the cache really shares geo

    disposeLobbyScene(p.scene, p);

    // No cache-owned geometry was disposed at all (the guarded disposers skip
    // them, and the detach keeps the blanket traverse from reaching them).
    for (const g of cacheGeo) expect(counts.get(g) ?? 0).toBe(0);
    // And nothing was double-disposed.
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(1);

    // The cache is still intact afterwards (disposing it does not throw).
    expect(() => { disposeGunCache(); disposeClassCache(); }).not.toThrow();
  });

  it('still frees the per-instance body geometry + shader material', () => {
    setTierOverride('mid');
    const p = buildPreviewLike();
    let bodyGeoDisposed = 0;
    const g = p.body.geometry;
    const d = g.dispose.bind(g);
    g.dispose = () => { bodyGeoDisposed++; d(); };
    disposeLobbyScene(p.scene, p);
    expect(bodyGeoDisposed).toBe(1); // lobby-owned, freed exactly once
  });
});
