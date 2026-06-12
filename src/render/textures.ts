import * as THREE from 'three';

/** All textures are generated procedurally — the game ships zero image assets. */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Deterministic hash noise for texture generation. */
function hashNoise(x: number, y: number, seed = 7): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040888963407) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Arena floor: dark worn concrete tiles with grime. */
export function makeFloorTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(1024);
  g.fillStyle = '#23262b';
  g.fillRect(0, 0, 1024, 1024);
  // Grime noise
  for (let i = 0; i < 9000; i++) {
    const x = hashNoise(i, 1) * 1024;
    const y = hashNoise(i, 2) * 1024;
    const v = 26 + hashNoise(i, 3) * 28;
    g.fillStyle = `rgba(${v},${v + 3},${v + 7},${0.25 + hashNoise(i, 4) * 0.3})`;
    const s = 1 + hashNoise(i, 5) * 4;
    g.fillRect(x, y, s, s);
  }
  // Tile grid (8x8 tiles over the texture)
  g.strokeStyle = 'rgba(8,9,11,0.85)';
  g.lineWidth = 3;
  const step = 128;
  for (let i = 0; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 1024); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(1024, i * step); g.stroke();
  }
  // Subtle tile shading variation
  for (let tx = 0; tx < 8; tx++) {
    for (let ty = 0; ty < 8; ty++) {
      const v = hashNoise(tx, ty, 99);
      g.fillStyle = `rgba(${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},${0.025 + v * 0.02})`;
      g.fillRect(tx * step, ty * step, step, step);
    }
  }
  // Hazard scuffs
  for (let i = 0; i < 60; i++) {
    const x = hashNoise(i, 11) * 1024;
    const y = hashNoise(i, 12) * 1024;
    g.strokeStyle = `rgba(12,12,14,${0.2 + hashNoise(i, 13) * 0.3})`;
    g.lineWidth = 1 + hashNoise(i, 14) * 3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (hashNoise(i, 15) - 0.5) * 90, y + (hashNoise(i, 16) - 0.5) * 90);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Wall sides: riveted industrial panels. */
export function makeWallTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  g.fillStyle = '#3a4047';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const x = hashNoise(i, 21) * 256;
    const y = hashNoise(i, 22) * 256;
    const v = 48 + hashNoise(i, 23) * 26;
    g.fillStyle = `rgba(${v},${v + 4},${v + 9},0.4)`;
    g.fillRect(x, y, 2, 2);
  }
  // Panel seams
  g.strokeStyle = 'rgba(15,17,20,0.9)';
  g.lineWidth = 4;
  g.strokeRect(4, 4, 248, 248);
  g.beginPath(); g.moveTo(128, 4); g.lineTo(128, 252); g.stroke();
  // Rivets
  g.fillStyle = 'rgba(160,170,180,0.75)';
  for (const [x, y] of [[20, 20], [236, 20], [20, 236], [236, 236], [112, 20], [144, 236]]) {
    g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
  }
  // Top edge warning stripe
  g.save();
  g.globalAlpha = 0.5;
  for (let x = -32; x < 288; x += 64) {
    g.fillStyle = '#c8a23a';
    g.beginPath();
    g.moveTo(x, 0); g.lineTo(x + 24, 0); g.lineTo(x + 8, 14); g.lineTo(x - 16, 14);
    g.closePath(); g.fill();
  }
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial particle (smoke, flame base, glow). */
export function makeGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Irregular blood splat stamps — several variants, used by the splat-map. */
export function makeSplatTextures(count = 4): THREE.CanvasTexture[] {
  const out: THREE.CanvasTexture[] = [];
  for (let v = 0; v < count; v++) {
    const [c, g] = canvas(256);
    g.translate(128, 128);
    // Main blob
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    const lobes = 8 + v * 2;
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const r = 52 + hashNoise(i, v * 7 + 1) * 46;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.quadraticCurveTo(
        Math.cos(a - Math.PI / lobes) * (r + 26), Math.sin(a - Math.PI / lobes) * (r + 26), x, y);
    }
    g.closePath();
    g.fill();
    // Satellite droplets
    for (let i = 0; i < 26; i++) {
      const a = hashNoise(i, v * 13 + 3) * Math.PI * 2;
      const d = 60 + hashNoise(i, v * 13 + 4) * 62;
      const r = 2 + hashNoise(i, v * 13 + 5) * 8;
      g.globalAlpha = 0.55 + hashNoise(i, v * 13 + 6) * 0.45;
      g.beginPath();
      g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    out.push(tex);
  }
  return out;
}

/** Directional spray splat (for hits with a direction). */
export function makeSprayTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  g.translate(40, 128);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 60; i++) {
    const t = hashNoise(i, 31);
    const spread = (hashNoise(i, 32) - 0.5) * (30 + t * 80);
    const d = t * 190;
    const r = 2 + (1 - t) * 9 * hashNoise(i, 33);
    g.globalAlpha = 0.4 + (1 - t) * 0.6;
    g.beginPath();
    g.arc(d, spread, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
