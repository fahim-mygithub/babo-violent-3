// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ShadowInstances } from '../../src/render/babos';

describe('ShadowInstances', () => {
  it('is a single InstancedMesh with MAX_PLAYERS capacity', () => {
    const s = new ShadowInstances();
    expect(s.mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(s.mesh.count).toBe(8);
  });
  it('zeros the matrix scale for a dead/absent instance', () => {
    const s = new ShadowInstances();
    s.set(0, 3, 4, true);
    s.set(1, 0, 0, false); // dead → zeroed
    const m = new THREE.Matrix4();
    s.mesh.getMatrixAt(1, m);
    const sc = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
    expect(sc.length()).toBeCloseTo(0, 6);
  });
  it('places a live instance at the babo ground position', () => {
    const s = new ShadowInstances();
    s.set(0, 3, 4, true);
    const m = new THREE.Matrix4();
    s.mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
    expect(pos.x).toBeCloseTo(3, 6);
    expect(pos.z).toBeCloseTo(4, 6);
  });

  // InstancedMesh caches its bounding sphere on the first frustum check and
  // setMatrixAt never invalidates it; with culling ON, once the babos roam far
  // from the origin-centred initial bounds the WHOLE shadow mesh culls out on
  // every tier. frustumCulled MUST be false so the contact shadows always draw.
  it('disables frustum culling so a far-roaming instance never culls the whole mesh', () => {
    const s = new ShadowInstances();
    s.set(0, 500, 500, true); // far from the origin-centred initial bounds
    expect(s.mesh.frustumCulled).toBe(false);
  });

  // Desktop byte-identity: main's per-babo shadow used the default depthWrite
  // (true). The instanced material must match — NO depthWrite:false override.
  it('shadow material keeps default depthWrite (parity with main, no depthWrite:false)', () => {
    const s = new ShadowInstances();
    const mat = s.mesh.material as THREE.MeshBasicMaterial;
    expect(mat.depthWrite).toBe(true);
  });
});
