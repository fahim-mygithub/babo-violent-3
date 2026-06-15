import type { GunId } from '../data/weapons';
import { GUNS } from '../data/weapons';

/**
 * 2D selector icons for the lobby gun picker. Pure Canvas2D — deliberately free
 * of any Three import so the menu/lobby entry chunk can render gun icons without
 * pulling the whole `three` bundle (the held-weapon 3D models live in gunModels.ts).
 *
 * 192x80 backing store (2x retina), barrel points RIGHT, transparent background.
 * Filled in GUNS[id].color with a darker outline and a couple of detail strokes
 * so each gun is instantly distinguishable.
 */

const ICON_W = 192;
const ICON_H = 80;

/** "#rrggbb" from a 0xRRGGBB number. */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Darken a 0xRRGGBB colour toward black by `f` (0..1) and return a CSS string. */
function shade(color: number, f: number): string {
  const r = Math.round(((color >> 16) & 0xff) * (1 - f));
  const g = Math.round(((color >> 8) & 0xff) * (1 - f));
  const b = Math.round((color & 0xff) * (1 - f));
  return `rgb(${r},${g},${b})`;
}

/** Lighten a 0xRRGGBB colour toward white by `f` (0..1) and return a CSS string. */
function tint(color: number, f: number): string {
  const r = Math.round(((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * f);
  const g = Math.round(((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * f);
  const b = Math.round((color & 0xff) + (255 - (color & 0xff)) * f);
  return `rgb(${r},${g},${b})`;
}

/** Fill + dark-outline a rounded-rect path. */
function chip(
  g: CanvasRenderingContext2D, fill: string, outline: string,
  x: number, y: number, w: number, h: number, r = 4,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = outline;
  g.stroke();
}

type IconDraw = (g: CanvasRenderingContext2D, fill: string, line: string, color: number) => void;

const ICONS: Record<GunId, IconDraw> = {
  // stinger — stubby SMG: short body, tiny barrel, slanted mag, top stub
  stinger: (g, fill, line, color) => {
    chip(g, fill, line, 70, 30, 46, 22);          // body
    chip(g, shade(color, 0.25), line, 116, 36, 32, 9, 3); // short barrel
    chip(g, tint(color, 0.2), line, 78, 22, 16, 10, 2);   // top stub
    g.save();
    g.translate(86, 56); g.rotate(0.35);
    chip(g, shade(color, 0.15), line, -7, -2, 14, 26, 3); // slanted mag
    g.restore();
    chip(g, shade(color, 0.4), line, 66, 50, 11, 20, 3);  // grip
  },
  // workhorse — AR: receiver, long barrel, rail ridge, banana mag, stock
  workhorse: (g, fill, line, color) => {
    chip(g, fill, line, 56, 32, 58, 18);          // receiver
    chip(g, shade(color, 0.25), line, 114, 37, 56, 8, 3); // long barrel
    chip(g, tint(color, 0.2), line, 64, 24, 38, 8, 2);    // rail ridge
    chip(g, shade(color, 0.3), line, 162, 35, 10, 12, 2); // muzzle device
    chip(g, shade(color, 0.45), line, 36, 36, 22, 12, 3); // stock
    chip(g, shade(color, 0.4), line, 60, 48, 11, 18, 3);  // grip
    g.save();
    g.translate(92, 60); g.rotate(0.3);
    chip(g, shade(color, 0.12), line, -7, -4, 15, 28, 5); // banana mag
    g.restore();
  },
  // maw — shotgun: chunky body, twin fat barrels, slung pump
  maw: (g, fill, line, color) => {
    chip(g, fill, line, 58, 26, 38, 30);          // chunky receiver
    chip(g, shade(color, 0.28), line, 96, 26, 56, 13, 4); // upper barrel
    chip(g, shade(color, 0.28), line, 96, 41, 56, 13, 4); // lower barrel
    chip(g, tint(color, 0.15), line, 150, 24, 12, 32, 4); // flared choke
    chip(g, shade(color, 0.45), line, 100, 58, 40, 10, 3); // slung pump
    chip(g, shade(color, 0.4), line, 52, 54, 11, 18, 3);   // grip
  },
  // hurricane — minigun: bulky body, stacked barrel bundle, muzzle ring, drum
  hurricane: (g, fill, line, color) => {
    chip(g, fill, line, 50, 28, 42, 28);          // bulky body
    chip(g, shade(color, 0.5), line, 30, 22, 22, 36, 4);  // ammo drum
    for (let i = 0; i < 5; i++) {                  // barrel bundle
      chip(g, shade(color, 0.22 + i * 0.04), line, 92, 26 + i * 6, 56, 5, 2);
    }
    g.beginPath();                                 // muzzle ring
    g.ellipse(150, 40, 6, 18, 0, 0, Math.PI * 2);
    g.fillStyle = tint(color, 0.2); g.fill();
    g.lineWidth = 2; g.strokeStyle = line; g.stroke();
    chip(g, shade(color, 0.4), line, 60, 54, 11, 18, 3);  // grip
  },
  // thumper — rocket: fat tube, warhead nose cone, rear exhaust cone
  thumper: (g, fill, line, color) => {
    chip(g, fill, line, 54, 30, 78, 22);          // fat launch tube
    g.beginPath();                                 // warhead nose cone
    g.moveTo(132, 28); g.lineTo(168, 41); g.lineTo(132, 54); g.closePath();
    g.fillStyle = tint(color, 0.15); g.fill();
    g.lineWidth = 2; g.strokeStyle = line; g.stroke();
    g.beginPath();                                 // rear exhaust cone
    g.moveTo(54, 28); g.lineTo(34, 41); g.lineTo(54, 54); g.closePath();
    g.fillStyle = shade(color, 0.4); g.fill(); g.stroke();
    chip(g, tint(color, 0.25), line, 66, 22, 26, 9, 2);   // top sight block
    chip(g, shade(color, 0.4), line, 70, 50, 11, 18, 3);  // grip
  },
  // ion — plasma: rounded shell, glowing core+ring, flared emitter cup
  ion: (g, fill, line, color) => {
    chip(g, fill, line, 54, 32, 56, 18, 8);       // rounded shell
    chip(g, shade(color, 0.4), line, 70, 50, 16, 8, 3);   // energy cell
    g.save();                                      // emitter cup (flared, open)
    g.beginPath();
    g.moveTo(108, 28); g.lineTo(140, 22); g.lineTo(140, 60); g.lineTo(108, 54);
    g.closePath();
    g.fillStyle = shade(color, 0.2); g.fill();
    g.lineWidth = 2; g.strokeStyle = line; g.stroke();
    g.restore();
    g.beginPath();                                 // glowing core
    g.arc(78, 41, 9, 0, Math.PI * 2);
    g.fillStyle = tint(color, 0.45); g.fill();
    g.strokeStyle = line; g.stroke();
    g.beginPath();                                 // glow ring
    g.arc(78, 41, 13, 0, Math.PI * 2);
    g.lineWidth = 2; g.strokeStyle = tint(color, 0.3); g.stroke();
    chip(g, shade(color, 0.4), line, 50, 50, 11, 16, 3);  // grip
  },
  // lance — railgun: long thin spine, twin parallel rails, charge coils, tiny muzzle
  lance: (g, fill, line, color) => {
    chip(g, fill, line, 36, 36, 110, 10, 3);      // long spine
    chip(g, tint(color, 0.35), line, 40, 30, 100, 4, 2);  // upper rail
    chip(g, tint(color, 0.35), line, 40, 46, 100, 4, 2);  // lower rail
    chip(g, shade(color, 0.4), line, 26, 32, 14, 18, 3);  // breech
    for (const cx of [70, 100]) {                  // charge coils
      g.beginPath();
      g.arc(cx, 41, 8, 0, Math.PI * 2);
      g.lineWidth = 3; g.strokeStyle = tint(color, 0.2); g.stroke();
    }
    chip(g, shade(color, 0.3), line, 146, 38, 22, 6, 2);  // tiny muzzle
    chip(g, shade(color, 0.45), line, 22, 34, 16, 12, 3); // stock
    chip(g, shade(color, 0.4), line, 44, 48, 10, 16, 3);  // grip
  },
  // pyre — flamethrower: receiver, fat under tank, flared nozzle, pilot flame
  pyre: (g, fill, line, color) => {
    chip(g, fill, line, 58, 30, 40, 16);          // receiver
    chip(g, shade(color, 0.4), line, 40, 48, 56, 20, 9);  // fat fuel tank
    chip(g, shade(color, 0.28), line, 98, 34, 36, 9, 3);  // barrel
    g.beginPath();                                 // flared nozzle
    g.moveTo(134, 28); g.lineTo(160, 24); g.lineTo(160, 52); g.lineTo(134, 48);
    g.closePath();
    g.fillStyle = tint(color, 0.1); g.fill();
    g.lineWidth = 2; g.strokeStyle = line; g.stroke();
    g.beginPath();                                 // pilot flame nub
    g.arc(165, 30, 5, 0, Math.PI * 2);
    g.fillStyle = tint(color, 0.5); g.fill();
    chip(g, shade(color, 0.45), line, 54, 46, 11, 18, 3); // grip
  },
};

/**
 * Render a clean 2D side-silhouette selector icon for a gun. Backing store is
 * 192x80 (2x retina), barrel points RIGHT, transparent background. The caller
 * sizes the element via CSS; this never sets canvas.style.
 */
export function makeGunIcon(gunId: GunId): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_W;
  c.height = ICON_H;
  const g = c.getContext('2d')!;
  const color = GUNS[gunId].color;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  ICONS[gunId](g, hex(color), shade(color, 0.6), color);
  return c;
}
