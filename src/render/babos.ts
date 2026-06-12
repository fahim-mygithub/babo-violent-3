import * as THREE from 'three';
import { C } from '../data/constants';
import { CLASSES } from '../data/classes';
import { GUNS } from '../data/weapons';
import type { PlayerState } from '../sim/types';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Diegetic-health Babo: the sphere visibly fills with blood as it takes
 * damage, with a green→red rim glow. Body rolls with velocity; the eye shell
 * stays upright and tracks aim.
 */
const baboVert = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec3 vLocal;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const baboFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uHp;       // 0..1
uniform float uCenterY;  // babo world centre height
uniform float uTime;
uniform float uBlink;    // spawn invulnerability
uniform float uBurn;
uniform float uFortify;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec3 vLocal;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // Blood fills from the bottom as hp drops, with a slosh wobble
  float fill = 1.0 - uHp;
  float level = -0.5 + fill + sin(vWorldPos.x * 7.0 + uTime * 5.0) * 0.035 * fill;
  float h = vWorldPos.y - uCenterY; // -0.5..0.5 on the sphere
  float isBlood = smoothstep(level + 0.03, level - 0.03, h);

  vec3 shell = uColor;
  // BV2-style globe grid etched into the shell — rolls with the ball, which
  // is what makes the rolling readable (the original babos had no face).
  vec3 lp = normalize(vLocal);
  float lon = atan(lp.z, lp.x);
  float lat = acos(clamp(lp.y, -1.0, 1.0));
  float gridD = min(
    abs(fract(lon * 6.0 / 6.2831853) - 0.5),
    abs(fract(lat * 6.0 / 3.1415926) - 0.5)
  );
  float gridLine = smoothstep(0.085, 0.045, gridD);
  shell = mix(shell, shell * 0.42, gridLine * 0.85);
  shell = mix(shell, shell * 1.6 + vec3(0.18), uFortify * 0.6); // fortified sheen
  vec3 blood = vec3(0.42, 0.012, 0.02);
  // interior darkens as it fills (deeper pool)
  blood *= 0.75 + 0.25 * (1.0 - fill);
  vec3 base = mix(shell, blood, isBlood);

  // Simple lighting: key directional + ambient
  vec3 L = normalize(vec3(0.4, 1.0, 0.3));
  float diff = max(dot(N, L), 0.0);
  vec3 col = base * (0.45 + 0.62 * diff);

  // Specular ball highlight
  vec3 H = normalize(L + V);
  col += vec3(1.0) * pow(max(dot(N, H), 0.0), 60.0) * 0.5;

  // Health rim: green when healthy, red when hurt
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
  vec3 rim = mix(vec3(0.9, 0.12, 0.05), vec3(0.15, 0.9, 0.25), uHp);
  col += rim * fres * (0.55 + 0.45 * sin(uTime * 3.0) * (1.0 - uHp));

  // Burning
  col += vec3(1.0, 0.45, 0.05) * uBurn * (0.5 + 0.5 * sin(uTime * 24.0));
  // Spawn blink
  col = mix(col, vec3(1.0), uBlink);

  gl_FragColor = vec4(col, uOpacity);
}
`;

interface BaboVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  eyes: THREE.Group;
  gun: THREE.Mesh;
  gunMat: THREE.MeshStandardMaterial;
  shadow: THREE.Mesh;
  marker: THREE.Mesh;      // bounty leader crown
  flagPole: THREE.Group;   // CTF carry indicator
  nameTag: THREE.Sprite;
}

/** BV2-style floating name tag (canvas-rendered, white with dark outline). */
function makeNameSprite(name: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.font = 'bold 24px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(name, 128, 24);
  g.fillStyle = 'rgba(235,240,245,0.95)';
  g.fillText(name, 128, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sprite.scale.set(2.2, 0.41, 1);
  sprite.position.y = 1.05;
  return sprite;
}

export class BaboPool {
  private visuals = new Map<number, BaboVisual>();
  private sphereGeo = new THREE.SphereGeometry(C.BABO_RADIUS, 28, 20);
  private shadowGeo = new THREE.CircleGeometry(C.BABO_RADIUS * 1.1, 20);
  private shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  private tmpAxis = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();

  constructor(private scene: THREE.Scene) {}

  private create(p: PlayerState): BaboVisual {
    const cls = CLASSES[p.classId];
    const group = new THREE.Group();

    const mat = new THREE.ShaderMaterial({
      vertexShader: baboVert,
      fragmentShader: baboFrag,
      transparent: true,
      uniforms: {
        uColor: { value: new THREE.Color(cls.color) },
        uHp: { value: 1 },
        uCenterY: { value: C.BABO_RADIUS },
        uTime: { value: 0 },
        uBlink: { value: 0 },
        uBurn: { value: 0 },
        uFortify: { value: 0 },
        uOpacity: { value: 1 },
      },
    });
    const body = new THREE.Mesh(this.sphereGeo, mat);
    group.add(body);

    // Aim mount: upright group that yaws to aim while the ball rolls under it.
    // True to BV2, the babo has no face — the held gun is the only oriented part.
    const eyes = new THREE.Group();
    group.add(eyes);

    // Held gun: a stubby barrel pointing along aim
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4, metalness: 0.6 });
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.13), gunMat);
    gun.position.set(0.55, 0.05, 0);
    eyes.add(gun);

    const shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -C.BABO_RADIUS + 0.02;
    group.add(shadow);

    // Bounty leader crown: visible through walls
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.42, 4),
      new THREE.MeshBasicMaterial({ color: 0xffc83a, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.position.y = 1.6; // above the name tag
    marker.rotation.x = Math.PI;
    marker.renderOrder = 999;
    marker.visible = false;
    group.add(marker);

    // CTF flag indicator
    const flagPole = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xcccccc }),
    );
    pole.position.y = 1.1;
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.45, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xff3333, side: THREE.DoubleSide }),
    );
    cloth.position.set(0.24, 1.4, 0);
    flagPole.add(pole, cloth);
    flagPole.visible = false;
    group.add(flagPole);

    const nameTag = makeNameSprite(p.name);
    group.add(nameTag);

    this.scene.add(group);
    const vis: BaboVisual = { group, body, mat, eyes, gun, gunMat, shadow, marker, flagPole, nameTag };
    this.visuals.set(p.id, vis);
    return vis;
  }

  update(players: Iterable<PlayerState>, dt: number, time: number, leaderId: number): void {
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      const vis = this.visuals.get(p.id) ?? this.create(p);
      vis.group.visible = p.alive;
      if (!p.alive) continue;

      vis.group.position.set(p.x, C.BABO_RADIUS, p.y);

      // Roll the body by velocity (axis ⟂ velocity on the ground plane)
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 0.05) {
        this.tmpAxis.set(p.vy, 0, -p.vx).normalize().negate();
        this.tmpQuat.setFromAxisAngle(this.tmpAxis, (speed * dt) / C.BABO_RADIUS);
        vis.body.quaternion.premultiply(this.tmpQuat);
      }

      // Eyes + gun face aim (sim aim angle → XZ yaw)
      vis.eyes.rotation.y = -p.aim;

      const u = vis.mat.uniforms;
      u.uHp.value = Math.max(0, p.hp) / C.MAX_HP;
      u.uCenterY.value = C.BABO_RADIUS;
      u.uTime.value = time;
      u.uBlink.value = p.invulnT > 0 ? (Math.sin(time * 22) > 0 ? 0.55 : 0) : 0;
      u.uBurn.value = p.burnT > 0 ? 1 : 0;
      u.uFortify.value = p.fortifyActive ? 1 : 0;
      u.uOpacity.value = p.phaseActive ? 0.32 : 1;

      vis.gunMat.color.setHex(GUNS[p.gun].color);
      vis.marker.visible = p.id === leaderId;
      if (vis.marker.visible) vis.marker.rotation.y = time * 2;
      vis.flagPole.visible = p.carryingFlag !== -1;
      if (p.carryingFlag !== -1) {
        (vis.flagPole.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>)
          .material.color.setHex(p.carryingFlag === 0 ? 0x4a8cff : 0xff4a4a);
      }
    }
    // Remove visuals for departed players
    for (const [id, vis] of this.visuals) {
      if (!seen.has(id)) {
        this.scene.remove(vis.group);
        vis.mat.dispose();
        this.visuals.delete(id);
      }
    }
  }
}
