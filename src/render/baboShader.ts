import { Color, ShaderMaterial } from 'three';
import { QUALITY } from './quality';

/**
 * The diegetic-health Babo shader, shared by the in-match BaboPool and the
 * lobby preview so both read identically: a grid-etched glossy marble that
 * fills with blood from the bottom as HP drops, with a green→red health rim.
 * BV2-faithful — faceless; the held gun is the only oriented part.
 */
export const BABO_VERT = /* glsl */ `
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

export const BABO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uHp;       // 0..1
uniform float uCenterY;  // babo world centre height
uniform float uRadius;   // babo render radius (blood level scales with it)
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
  float level = uCenterY + uRadius * (-1.0 + 2.0 * fill)
              + sin(vWorldPos.x * 7.0 + uTime * 5.0) * 0.035 * fill;
  float h = vWorldPos.y;
  float band = uRadius * 0.06;
  float isBlood = smoothstep(level + band, level - band, h);

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

export interface BaboUniforms {
  uColor: { value: Color };
  uHp: { value: number };
  uCenterY: { value: number };
  uRadius: { value: number };
  uTime: { value: number };
  uBlink: { value: number };
  uBurn: { value: number };
  uFortify: { value: number };
  uOpacity: { value: number };
}

/**
 * A fresh Babo ShaderMaterial. `centerY`/`radius` default to the in-game ball.
 *
 * The `transparent` DEFAULT is tier-gated (QUALITY.baboBodyTransparent): TRUE on
 * high so the desktop render-pass ordering stays byte-identical to main; FALSE on
 * the mobile tiers, where the body is fully opaque except during a Phantom phase,
 * so paying for alpha blending + the transparent sort every frame is wasted. The
 * caller flips `mat.transparent` true on phase-in and false on phase-out (BaboPool's
 * phase guard / the lobby phantom demo); the per-frame `uOpacity` write is untouched.
 */
export function makeBaboMaterial(color: number, centerY = 0.5, radius = 0.5): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: BABO_VERT,
    fragmentShader: BABO_FRAG,
    transparent: QUALITY.baboBodyTransparent,
    uniforms: {
      uColor: { value: new Color(color) },
      uHp: { value: 1 },
      uCenterY: { value: centerY },
      uRadius: { value: radius },
      uTime: { value: 0 },
      uBlink: { value: 0 },
      uBurn: { value: 0 },
      uFortify: { value: 0 },
      uOpacity: { value: 1 },
    },
  });
}
