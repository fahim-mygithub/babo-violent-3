import { Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { MapDef } from '../data/maps';
import { makeSplatTextures, makeSprayTexture } from './textures';
import { QUALITY } from './quality';

/**
 * The visual blood layer: every splat is stamped once into a persistent
 * render-target texture draped over the floor — unlimited gore at a single
 * draw call. Never cleared during a match.
 */
export class SplatMap {
  readonly texture: Texture;

  private rt: WebGLRenderTarget;
  private stampScene = new Scene();
  private stampCam: OrthographicCamera;
  private queue: Mesh[] = [];
  private pool: Mesh[] = [];
  private splatMats: MeshBasicMaterial[];
  private sprayMat: MeshBasicMaterial;
  private rand = 1234567;
  private firstStamp = true;

  constructor(private mapW: number, private mapH: number) {
    // Persistent gore target: 2048 on high (today's literal), 1024 on mobile.
    const rtSize = QUALITY.splatRtSize;
    this.rt = new WebGLRenderTarget(rtSize, rtSize, {
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.texture = this.rt.texture;
    // Ortho camera over the whole arena in sim coordinates
    this.stampCam = new OrthographicCamera(-mapW / 2, mapW / 2, mapH / 2, -mapH / 2, 0.1, 10);
    this.stampCam.position.set(0, 0, 5);
    this.stampCam.lookAt(0, 0, 0);

    this.splatMats = makeSplatTextures().map(
      (t) => new MeshBasicMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.sprayMat = new MeshBasicMaterial({
      map: makeSprayTexture(), transparent: true, depthTest: false, depthWrite: false,
    });
  }

  private nextRand(): number {
    let t = (this.rand += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Queue a splat stamp at sim coords. dir gives spray orientation (0,0 = blob). */
  add(x: number, y: number, size: number, dirX = 0, dirY = 0): void {
    if (this.queue.length > 400) return; // hidden-tab backlog guard
    const directional = (dirX !== 0 || dirY !== 0) && this.nextRand() < 0.7;
    const mat = directional
      ? this.sprayMat
      : this.splatMats[Math.floor(this.nextRand() * this.splatMats.length)];
    const mesh = this.pool.pop() ?? new Mesh(new PlaneGeometry(1, 1));
    mesh.material = mat.clone();
    const m = mesh.material as MeshBasicMaterial;
    // Blood shade variation: deep arterial to dark dried
    const shade = 0.55 + this.nextRand() * 0.45;
    m.color.setRGB(0.55 * shade, 0.02 * shade, 0.03 * shade);
    m.opacity = 0.8 + this.nextRand() * 0.2;
    const s = size * (1.7 + this.nextRand() * 1.2);
    mesh.scale.set(s, s, 1);
    mesh.position.set(x, y, 1); // stamp space: XY = sim coords
    mesh.rotation.z = directional ? Math.atan2(dirY, dirX) : this.nextRand() * Math.PI * 2;
    this.queue.push(mesh);
  }

  /** Pre-stain the blood pit so the centre reads as the gore magnet. */
  stainPit(map: MapDef): void {
    if (!map.bloodPit) return;
    const { x, y, r } = map.bloodPit;
    for (let i = 0; i < 10; i++) {
      const a = this.nextRand() * Math.PI * 2;
      const d = this.nextRand() * r * 0.7;
      this.add(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.5 + this.nextRand() * 0.7);
    }
  }

  /** Render queued stamps into the persistent target. Call once per frame. */
  flush(renderer: WebGLRenderer): void {
    if (this.queue.length === 0 && !this.firstStamp) return;
    for (const m of this.queue) this.stampScene.add(m);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.rt);
    if (this.firstStamp) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      this.firstStamp = false;
    }
    renderer.autoClear = false;
    renderer.render(this.stampScene, this.stampCam);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    for (const m of this.queue) {
      this.stampScene.remove(m);
      ((m.material as MeshBasicMaterial)).dispose();
      this.pool.push(m);
    }
    this.queue.length = 0;
  }

  dispose(): void {
    this.rt.dispose();
  }
}
