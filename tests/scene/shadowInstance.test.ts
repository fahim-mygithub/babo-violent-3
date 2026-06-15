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
});
