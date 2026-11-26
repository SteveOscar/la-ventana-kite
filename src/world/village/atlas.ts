import * as THREE from 'three';
import { mulberry32 } from '../../core/math.ts';
import type { UVRect } from './builder.ts';

/**
 * One procedurally painted atlas for every village surface. RGB is the paint;
 * alpha is a tint mask: 1 = multiply by the vertex colour (stucco, thatch,
 * sheet metal), 0 = use the texel as is (glass, doors, signs, flags).
 */
const SIZE = 1024;
const CELL = 128;
const GUT = 4;

export interface Atlas {
  texture: THREE.DataTexture;
  /** Constant UV of a pure-white, fully tinted texel. */
  plain: [number, number];
  tiles: Record<TileName, UVRect>;
}

export type TileName =
  | 'gPlain' | 'gPlain2' | 'gWinBars' | 'gWinAlu' | 'gWinShutA' | 'gWinShutB' | 'gDoorWood' | 'gDoorMetal'
  | 'gDoorDouble' | 'gShopShutter' | 'gShopOpen' | 'gWinArch' | 'gGate' | 'gBlock' | 'gBlockHole' | 'gDoorGlass'
  | 'uPlain' | 'uPlain2' | 'uWinBars' | 'uWinAlu' | 'uWinShut' | 'uBalcony' | 'uBlock' | 'uBlockHole'
  | 'white' | 'thatch' | 'corrugated' | 'clay' | 'chDoor' | 'chBelfry' | 'chOculus' | 'chWindow'
  | 'signAbarrotes' | 'signMariscos' | 'signTacos' | 'signPurificadora'
  | 'rvSide' | 'vanSide' | 'awning' | 'tent'
  | 'flagMx' | 'bannerA' | 'bannerB' | 'bannerC' | 'mural' | 'blockPlinth';

const LAYOUT: Record<TileName, [number, number, number?, number?]> = {
  gPlain: [0, 0], gPlain2: [1, 0], gWinBars: [2, 0], gWinAlu: [3, 0], gWinShutA: [4, 0], gWinShutB: [5, 0], gDoorWood: [6, 0], gDoorMetal: [7, 0],
  gDoorDouble: [0, 1], gShopShutter: [1, 1], gShopOpen: [2, 1], gWinArch: [3, 1], gGate: [4, 1], gBlock: [5, 1], gBlockHole: [6, 1], gDoorGlass: [7, 1],
  uPlain: [0, 2], uPlain2: [1, 2], uWinBars: [2, 2], uWinAlu: [3, 2], uWinShut: [4, 2], uBalcony: [5, 2], uBlock: [6, 2], uBlockHole: [7, 2],
  white: [0, 3], thatch: [1, 3], corrugated: [2, 3], clay: [3, 3], chDoor: [4, 3], chBelfry: [5, 3], chOculus: [6, 3], chWindow: [7, 3],
  signAbarrotes: [0, 4, 4], signMariscos: [4, 4, 4], signTacos: [0, 5, 4], signPurificadora: [4, 5, 4],
  rvSide: [0, 6, 3], vanSide: [3, 6, 2], awning: [5, 6], tent: [6, 6], blockPlinth: [7, 6],
  flagMx: [0, 7], bannerA: [1, 7], bannerB: [2, 7], bannerC: [3, 7], mural: [4, 7, 2],
};

type Ctx = CanvasRenderingContext2D;

class Painter {
  readonly c: Ctx;
  readonly m: Ctx;
  constructor(c: Ctx, m: Ctx) {
    this.c = c;
    this.m = m;
  }
  /** Filled rect on both layers. */
  rect(x: number, y: number, w: number, h: number, color: string, tint: boolean) {
    this.c.fillStyle = color;
    this.c.fillRect(x, y, w, h);
    this.m.fillStyle = tint ? '#fff' : '#000';
    this.m.fillRect(x, y, w, h);
  }
  /** Arbitrary path filled on both layers. */
  path(build: (ctx: Ctx) => void, color: string, tint: boolean) {
    for (const [ctx, fill] of [[this.c, color], [this.m, tint ? '#fff' : '#000']] as const) {
      ctx.beginPath();
      build(ctx);
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }
  /** Colour-only detail (keeps the mask underneath). */
  paint(color: string, fn: (ctx: Ctx) => void) {
    this.c.fillStyle = color;
    this.c.strokeStyle = color;
    fn(this.c);
  }
  text(s: string, x: number, y: number, font: string, color: string, tint: boolean, maxW?: number) {
    for (const [ctx, fill] of [[this.c, color], [this.m, tint ? '#fff' : '#000']] as const) {
      ctx.font = font;
      ctx.fillStyle = fill;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (maxW === undefined) ctx.fillText(s, x, y);
      else ctx.fillText(s, x, y, maxW);
    }
  }
}

const grey = (k: number) => {
  const v = Math.round(Math.max(0, Math.min(1, k)) * 255);
  return `rgb(${v},${v},${v})`;
};

export function buildAtlas(): Atlas {
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = SIZE;
    cv.height = SIZE;
    return cv.getContext('2d', { willReadFrequently: true })!;
  };
  const c = mk(), m = mk();
  const p = new Painter(c, m);
  const rnd = mulberry32(4242);
  const regions: [number, number, number, number][] = [];
  const box = (name: TileName) => {
    const [col, row, w = 1, h = 1] = LAYOUT[name];
    const x = col * CELL + GUT, y = row * CELL + GUT;
    const bw = w * CELL - GUT * 2, bh = h * CELL - GUT * 2;
    return { x, y, w: bw, h: bh };
  };

  // ---------- walls ----------
  const stucco = (x: number, y: number, w: number, h: number, k = 0.95, stains = 6) => {
    p.rect(x, y, w, h, grey(k), true);
    // Dusty, sun-faded patches and a warmer, dirtier foot of the wall.
    for (let i = 0; i < stains; i++) {
      const sx = x + rnd() * w, sy = y + rnd() * h, r = 6 + rnd() * 18;
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(${rnd() < 0.5 ? '205,195,180' : '255,255,255'},${0.04 + rnd() * 0.07})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    const g = c.createLinearGradient(0, y + h - 30, 0, y + h);
    g.addColorStop(0, 'rgba(190,170,140,0)');
    g.addColorStop(1, 'rgba(190,170,140,0.35)');
    c.fillStyle = g;
    c.fillRect(x, y + h - 30, w, 30);
  };
  const baseBand = (x: number, y: number, w: number, h: number) => {
    const bh = 18;
    p.rect(x, y + h - bh, w, bh, grey(0.6), true);
    p.paint('rgba(255,255,255,0.25)', (ctx) => ctx.fillRect(x, y + h - bh, w, 1.5));
    p.paint('rgba(120,100,80,0.25)', (ctx) => ctx.fillRect(x, y + h - 6, w, 6));
  };
  const glass = (x: number, y: number, w: number, h: number) => {
    const g = c.createLinearGradient(x, y, x + w * 0.3, y + h);
    g.addColorStop(0, '#5f7487');
    g.addColorStop(0.45, '#2c3a47');
    g.addColorStop(1, '#1d262e');
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    m.fillStyle = '#000';
    m.fillRect(x, y, w, h);
    // Sky reflection streak.
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.fillStyle = 'rgba(200,225,240,0.18)';
    c.beginPath();
    c.moveTo(x + w * 0.15, y);
    c.lineTo(x + w * 0.45, y);
    c.lineTo(x + w * 0.05, y + h);
    c.lineTo(x - w * 0.25, y + h);
    c.fill();
    c.restore();
  };
  const lintelShadow = (x: number, y: number, w: number) => p.paint('rgba(0,0,0,0.25)', (ctx) => ctx.fillRect(x, y, w, 3));
  const sill = (x: number, y: number, w: number) => {
    p.rect(x - 3, y, w + 6, 4, '#dcd8cf', false);
    p.paint('rgba(0,0,0,0.18)', (ctx) => ctx.fillRect(x - 3, y + 4, w + 6, 2));
  };
  const frame = (x: number, y: number, w: number, h: number, color: string, t = 3) => {
    p.rect(x - t, y - t, w + t * 2, h + t * 2, color, false);
  };
  const bars = (x: number, y: number, w: number, h: number) => {
    p.paint('#1b1b1b', (ctx) => {
      for (let bx = x + 4; bx < x + w - 1; bx += 7) ctx.fillRect(bx, y, 2, h);
      ctx.fillRect(x, y + 3, w, 2);
      ctx.fillRect(x, y + h - 5, w, 2);
      ctx.lineWidth = 1.6;
      for (let bx = x + 4; bx < x + w - 8; bx += 14) {
        ctx.beginPath();
        ctx.arc(bx + 4.5, y + 11, 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  };
  const windowBars = (b: { x: number; y: number; w: number; h: number }, top: number, bottom: number) => {
    const wx = b.x + 36, ww = 48;
    frame(wx, b.y + top, ww, bottom - top, '#ebe9e3');
    glass(wx, b.y + top, ww, bottom - top);
    bars(wx, b.y + top, ww, bottom - top);
    lintelShadow(wx - 3, b.y + top - 3, ww + 6);
    sill(wx, b.y + bottom + 3, ww);
  };
  const windowAlu = (b: { x: number; y: number; w: number; h: number }, top: number, bottom: number) => {
    const wx = b.x + 32, ww = 56;
    frame(wx, b.y + top, ww, bottom - top, '#b8bcbf');
    glass(wx, b.y + top, ww, bottom - top);
    p.rect(wx + ww / 2 - 1, b.y + top, 2.5, bottom - top, '#b8bcbf', false);
    lintelShadow(wx - 3, b.y + top - 3, ww + 6);
    sill(wx, b.y + bottom + 3, ww);
  };
  const windowShutters = (b: { x: number; y: number; w: number; h: number }, top: number, bottom: number, shutter: string) => {
    const wx = b.x + 38, ww = 44;
    frame(wx, b.y + top, ww, bottom - top, '#efece6');
    glass(wx, b.y + top, ww, bottom - top);
    p.rect(wx + ww / 2 - 1, b.y + top, 2, bottom - top, '#efece6', false);
    for (const sx of [wx - 3 - 22, wx + ww + 3]) {
      p.rect(sx, b.y + top - 2, 22, bottom - top + 4, shutter, false);
      p.paint('rgba(0,0,0,0.28)', (ctx) => {
        for (let yy = b.y + top + 2; yy < b.y + bottom; yy += 5) ctx.fillRect(sx + 3, yy, 16, 1.5);
      });
    }
    lintelShadow(wx - 3, b.y + top - 3, ww + 6);
    sill(wx, b.y + bottom + 3, ww);
  };
  const door = (b: { x: number; y: number; w: number; h: number }, dx: number, dw: number, top: number, color: string, kind: 'wood' | 'metal' | 'glass') => {
    const x = b.x + dx, y = b.y + top, h = b.h - top;
    frame(x, y, dw, h + 3, '#e4e1da', 3);
    p.rect(x, y, dw, h, color, false);
    if (kind === 'wood') {
      p.paint('rgba(0,0,0,0.22)', (ctx) => {
        for (let px = x + 5; px < x + dw; px += 6) ctx.fillRect(px, y, 1, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 5, y + 6, dw - 10, h * 0.38);
        ctx.strokeRect(x + 5, y + h * 0.5, dw - 10, h * 0.42);
      });
    } else if (kind === 'metal') {
      glass(x + 6, y + 8, dw - 12, h * 0.36);
      bars(x + 6, y + 8, dw - 12, h * 0.36);
      p.paint('rgba(255,255,255,0.12)', (ctx) => ctx.fillRect(x + 6, y + h * 0.55, dw - 12, h * 0.38));
    } else {
      glass(x + 3, y + 3, dw - 6, h - 6);
      p.rect(x + dw / 2 - 1, y, 2, h, '#b8bcbf', false);
    }
    p.paint('#c9a54a', (ctx) => ctx.fillRect(x + dw - 8, y + h * 0.52, 3, 3));
    lintelShadow(x - 3, y - 3, dw + 6);
    p.rect(x - 4, b.y + b.h - 3, dw + 8, 3, '#bdb8ae', false);
  };
  const blocks = (x: number, y: number, w: number, h: number) => {
    p.rect(x, y, w, h, grey(0.92), true);
    c.fillStyle = 'rgba(70,70,70,0.35)';
    for (let row = 0, yy = y; yy < y + h; row++, yy += 8) {
      c.fillRect(x, yy, w, 1);
      for (let xx = x + (row % 2 ? 8 : 0); xx < x + w; xx += 16) c.fillRect(xx, yy, 1, 8);
    }
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '40,40,40'},0.07)`;
      c.fillRect(x + Math.floor(rnd() * (w / 16)) * 16 + (rnd() < 0.5 ? 8 : 0), y + Math.floor(rnd() * (h / 8)) * 8 + 1, 15, 7);
    }
  };

  {
    const b = box('gPlain');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
  }
  {
    const b = box('gPlain2');
    stucco(b.x, b.y, b.w, b.h, 0.93, 8);
    baseBand(b.x, b.y, b.w, b.h);
  }
  {
    const b = box('gWinBars');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    windowBars(b, 32, 80);
  }
  {
    const b = box('gWinAlu');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    windowAlu(b, 34, 80);
  }
  {
    const b = box('gWinShutA');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    windowShutters(b, 32, 80, '#2a8a84');
  }
  {
    const b = box('gWinShutB');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    windowShutters(b, 32, 80, '#7b4a2b');
  }
  {
    const b = box('gDoorWood');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    door(b, 40, 40, 34, '#6e4527', 'wood');
  }
  {
    const b = box('gDoorMetal');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    door(b, 40, 40, 34, '#2d5248', 'metal');
  }
  {
    const b = box('gDoorDouble');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    door(b, 28, 64, 30, '#5d3920', 'wood');
    p.paint('rgba(0,0,0,0.5)', (ctx) => ctx.fillRect(b.x + 59, b.y + 30, 2, b.h - 30));
  }
  {
    const b = box('gShopShutter');
    stucco(b.x, b.y, b.w, b.h, 0.95, 3);
    const x = b.x + 8, y = b.y + 24, w = b.w - 16, h = b.h - 24;
    p.rect(x - 2, y - 8, w + 4, 8, '#7d8286', false);
    p.rect(x, y, w, h, '#a3a8ab', false);
    p.paint('rgba(0,0,0,0.22)', (ctx) => {
      for (let yy = y + 2; yy < y + h; yy += 3) ctx.fillRect(x, yy, w, 1);
    });
    p.paint('rgba(255,255,255,0.18)', (ctx) => {
      for (let yy = y + 1; yy < y + h; yy += 6) ctx.fillRect(x, yy, w, 1);
    });
    p.paint('rgba(120,70,40,0.25)', (ctx) => {
      for (let i = 0; i < 5; i++) ctx.fillRect(x + rnd() * w, y + h * 0.3, 2 + rnd() * 3, h * 0.7);
    });
    p.rect(x, b.y + b.h - 5, w, 5, '#55595c', false);
  }
  {
    const b = box('gShopOpen');
    stucco(b.x, b.y, b.w, b.h, 0.95, 3);
    const x = b.x + 10, y = b.y + 26, w = b.w - 20, h = b.h - 26;
    p.rect(x, y, w, h, '#231d19', false);
    const goods = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#ffffff', '#457b9d', '#f15bb5', '#90be6d'];
    for (let sy = y + 8; sy < y + h - 34; sy += 15) {
      p.rect(x + 3, sy + 11, w - 6, 2, '#6b5847', false);
      for (let sx = x + 4; sx < x + w - 8; sx += 5 + rnd() * 4) p.rect(sx, sy + 2 + rnd() * 3, 3 + rnd() * 3, 9 - rnd() * 3, goods[Math.floor(rnd() * goods.length)], false);
    }
    // A drinks fridge and the counter.
    p.rect(x + w - 30, y + 8, 24, h - 8, '#c8102e', false);
    glass(x + w - 26, y + 14, 16, h - 32);
    p.rect(x, b.y + b.h - 26, w - 34, 26, '#d8d1c4', false);
    lintelShadow(x, y, w);
  }
  {
    const b = box('gWinArch');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    const wx = b.x + 38, ww = 44, top = b.y + 30, bot = b.y + 82;
    p.path((ctx) => {
      ctx.moveTo(wx - 4, bot);
      ctx.lineTo(wx - 4, top + 22);
      ctx.arc(wx + ww / 2, top + 22, ww / 2 + 4, Math.PI, 0);
      ctx.lineTo(wx + ww + 4, bot);
    }, '#efe9dc', false);
    c.save();
    c.beginPath();
    c.moveTo(wx, bot);
    c.lineTo(wx, top + 22);
    c.arc(wx + ww / 2, top + 22, ww / 2, Math.PI, 0);
    c.lineTo(wx + ww, bot);
    c.clip();
    glass(wx, top, ww, bot - top);
    c.restore();
    bars(wx, top + 20, ww, bot - top - 20);
    sill(wx, bot + 1, ww);
  }
  {
    const b = box('gGate');
    stucco(b.x, b.y, b.w, b.h, 0.95, 3);
    baseBand(b.x, b.y, b.w, b.h);
    const x = b.x + 8, y = b.y + 30, w = b.w - 16, h = b.h - 30;
    p.rect(x, y, w, h, '#4f6680', false);
    p.paint('rgba(0,0,0,0.25)', (ctx) => {
      for (let xx = x + 4; xx < x + w; xx += 8) ctx.fillRect(xx, y + 14, 2, h - 14);
      ctx.fillRect(x + w / 2 - 1, y, 2, h);
    });
    p.paint('#1c1c1c', (ctx) => {
      for (let xx = x + 3; xx < x + w; xx += 6) ctx.fillRect(xx, y + 2, 1.5, 11);
    });
    lintelShadow(x, y, w);
  }
  {
    const b = box('gBlock');
    blocks(b.x, b.y, b.w, b.h);
  }
  {
    const b = box('gBlockHole');
    blocks(b.x, b.y, b.w, b.h);
    p.rect(b.x + 38, b.y + 34, 44, 46, '#1e1a17', false);
    p.paint('rgba(255,255,255,0.08)', (ctx) => ctx.fillRect(b.x + 38, b.y + 70, 44, 10));
  }
  {
    const b = box('gDoorGlass');
    stucco(b.x, b.y, b.w, b.h);
    baseBand(b.x, b.y, b.w, b.h);
    door(b, 26, 68, 26, '#b8bcbf', 'glass');
  }
  // Upper floors.
  {
    const b = box('uPlain');
    stucco(b.x, b.y, b.w, b.h, 0.95, 5);
  }
  {
    const b = box('uPlain2');
    stucco(b.x, b.y, b.w, b.h, 0.93, 9);
  }
  {
    const b = box('uWinBars');
    stucco(b.x, b.y, b.w, b.h);
    windowBars(b, 28, 76);
  }
  {
    const b = box('uWinAlu');
    stucco(b.x, b.y, b.w, b.h);
    windowAlu(b, 30, 76);
  }
  {
    const b = box('uWinShut');
    stucco(b.x, b.y, b.w, b.h);
    windowShutters(b, 28, 76, '#2f6f9f');
  }
  {
    const b = box('uBalcony');
    stucco(b.x, b.y, b.w, b.h);
    door(b, 30, 60, 22, '#b8bcbf', 'glass');
    p.paint('#1b1b1b', (ctx) => {
      ctx.fillRect(b.x + 20, b.y + 78, 80, 3);
      for (let xx = b.x + 22; xx < b.x + 100; xx += 6) ctx.fillRect(xx, b.y + 78, 1.6, b.h - 80);
    });
    p.rect(b.x + 16, b.y + b.h - 5, 88, 5, '#cfcac0', false);
  }
  {
    const b = box('uBlock');
    blocks(b.x, b.y, b.w, b.h);
  }
  {
    const b = box('uBlockHole');
    blocks(b.x, b.y, b.w, b.h);
    p.rect(b.x + 36, b.y + 30, 48, 46, '#1e1a17', false);
  }
  {
    const b = box('blockPlinth');
    blocks(b.x, b.y, b.w, b.h);
  }

  // ---------- roofs and materials ----------
  {
    const b = box('white');
    p.rect(b.x - GUT, b.y - GUT, b.w + GUT * 2, b.h + GUT * 2, '#ffffff', true);
  }
  {
    const b = box('thatch');
    p.rect(b.x, b.y, b.w, b.h, grey(0.78), true);
    c.save();
    c.beginPath();
    c.rect(b.x, b.y, b.w, b.h);
    c.clip();
    for (let i = 0; i < 1400; i++) {
      const x = b.x + rnd() * b.w, y = b.y - 10 + rnd() * (b.h + 10);
      const len = 8 + rnd() * 22;
      const k = 0.45 + rnd() * 0.6;
      c.strokeStyle = grey(k);
      c.globalAlpha = 0.55;
      c.lineWidth = 0.8 + rnd() * 0.8;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (rnd() - 0.5) * 4, y + len);
      c.stroke();
    }
    c.globalAlpha = 1;
    // Overlapping layers read as soft horizontal bands.
    for (let y = b.y; y < b.y + b.h; y += 20) {
      const g = c.createLinearGradient(0, y, 0, y + 20);
      g.addColorStop(0, 'rgba(0,0,0,0.0)');
      g.addColorStop(0.85, 'rgba(0,0,0,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      c.fillStyle = g;
      c.fillRect(b.x, y, b.w, 20);
    }
    c.restore();
  }
  {
    const b = box('corrugated');
    for (let x = b.x; x < b.x + b.w; x += 8) {
      const g = c.createLinearGradient(x, 0, x + 8, 0);
      g.addColorStop(0, grey(0.62));
      g.addColorStop(0.45, grey(1.0));
      g.addColorStop(1, grey(0.7));
      c.fillStyle = g;
      c.fillRect(x, b.y, 8, b.h);
    }
    m.fillStyle = '#fff';
    m.fillRect(b.x, b.y, b.w, b.h);
    for (let i = 0; i < 6; i++) {
      c.fillStyle = 'rgba(150,80,40,0.25)';
      c.fillRect(b.x + rnd() * b.w, b.y + rnd() * b.h * 0.5, 3 + rnd() * 6, 20 + rnd() * 50);
    }
    c.fillStyle = 'rgba(0,0,0,0.2)';
    c.fillRect(b.x, b.y + b.h / 2, b.w, 1.5);
  }
  {
    const b = box('clay');
    p.rect(b.x, b.y, b.w, b.h, grey(0.85), true);
    for (let row = 0, y = b.y; y < b.y + b.h; row++, y += 20) {
      for (let x = b.x - (row % 2 ? 6 : 0); x < b.x + b.w; x += 12) {
        const g = c.createLinearGradient(x, 0, x + 12, 0);
        g.addColorStop(0, grey(0.6));
        g.addColorStop(0.5, grey(1.0));
        g.addColorStop(1, grey(0.62));
        c.fillStyle = g;
        c.fillRect(x, y, 12, 20);
      }
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(b.x, y + 18, b.w, 2);
    }
  }
  // Chapel pieces.
  {
    const b = box('chDoor');
    p.rect(b.x, b.y, b.w, b.h, grey(0.97), true);
    const x = b.x + 22, w = 76, top = b.y + 18, spring = b.y + 52;
    p.path((ctx) => {
      ctx.moveTo(x - 7, b.y + b.h);
      ctx.lineTo(x - 7, spring);
      ctx.arc(x + w / 2, spring, w / 2 + 7, Math.PI, 0);
      ctx.lineTo(x + w + 7, b.y + b.h);
    }, '#e2d6bb', false);
    p.path((ctx) => {
      ctx.moveTo(x, b.y + b.h);
      ctx.lineTo(x, spring);
      ctx.arc(x + w / 2, spring, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, b.y + b.h);
    }, '#4a2a16', false);
    p.paint('rgba(0,0,0,0.45)', (ctx) => ctx.fillRect(x + w / 2 - 1, top, 2, b.y + b.h - top));
    p.paint('#b08d3c', (ctx) => {
      for (let yy = spring; yy < b.y + b.h - 6; yy += 10) for (let xx = x + 8; xx < x + w - 4; xx += 12) ctx.fillRect(xx, yy, 2, 2);
    });
  }
  {
    const b = box('chBelfry');
    p.rect(b.x, b.y, b.w, b.h, grey(0.97), true);
    const x = b.x + 28, w = 64, spring = b.y + 44, bottom = b.y + b.h - 10;
    p.path((ctx) => {
      ctx.moveTo(x, bottom);
      ctx.lineTo(x, spring);
      ctx.arc(x + w / 2, spring, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, bottom);
    }, '#2a211c', false);
    // Bronze bell.
    p.path((ctx) => {
      const cx = x + w / 2;
      ctx.moveTo(cx - 6, spring - 8);
      ctx.quadraticCurveTo(cx - 10, spring + 18, cx - 22, spring + 34);
      ctx.lineTo(cx + 22, spring + 34);
      ctx.quadraticCurveTo(cx + 10, spring + 18, cx + 6, spring - 8);
    }, '#9a7a35', false);
    p.paint('rgba(255,230,160,0.35)', (ctx) => ctx.fillRect(x + w / 2 - 14, spring + 4, 5, 26));
    p.rect(b.x, bottom, b.w, 10, grey(0.85), true);
  }
  {
    const b = box('chOculus');
    p.rect(b.x, b.y, b.w, b.h, grey(0.97), true);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    p.path((ctx) => ctx.arc(cx, cy, 44, 0, Math.PI * 2), '#e2d6bb', false);
    const cols = ['#1d4e89', '#f2c14e', '#c1272d', '#2a9d8f', '#1d4e89', '#f2c14e', '#c1272d', '#7b2cbf'];
    for (let i = 0; i < 8; i++) {
      p.path((ctx) => {
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, 36, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
      }, cols[i], false);
    }
    p.path((ctx) => ctx.arc(cx, cy, 9, 0, Math.PI * 2), '#f6e7b0', false);
    p.paint('rgba(0,0,0,0.6)', (ctx) => {
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos((i / 8) * Math.PI * 2) * 36, cy + Math.sin((i / 8) * Math.PI * 2) * 36);
        ctx.stroke();
      }
    });
  }
  {
    const b = box('chWindow');
    p.rect(b.x, b.y, b.w, b.h, grey(0.97), true);
    const x = b.x + 44, w = 32, spring = b.y + 36, bottom = b.y + 96;
    p.path((ctx) => {
      ctx.moveTo(x - 5, bottom + 4);
      ctx.lineTo(x - 5, spring);
      ctx.arc(x + w / 2, spring, w / 2 + 5, Math.PI, 0);
      ctx.lineTo(x + w + 5, bottom + 4);
    }, '#e2d6bb', false);
    const cols = ['#1d4e89', '#f2c14e', '#c1272d', '#2a9d8f'];
    for (let i = 0; i < 6; i++) {
      const yy = spring - 10 + i * 12;
      p.rect(x, yy, w, 12, cols[i % 4], false);
    }
    p.path((ctx) => {
      ctx.moveTo(x, spring);
      ctx.arc(x + w / 2, spring, w / 2, Math.PI, 0);
    }, '#f2c14e', false);
    p.paint('rgba(0,0,0,0.5)', (ctx) => ctx.fillRect(x + w / 2 - 1, spring - 14, 2, bottom - spring + 14));
  }

  // ---------- painted signs ----------
  const sign = (name: TileName, bg: string, fg: string, text: string, sub: string | null, accent?: string) => {
    const b = box(name);
    p.rect(b.x, b.y, b.w, b.h, bg, false);
    if (accent) {
      p.rect(b.x, b.y, b.w, 10, accent, false);
      p.rect(b.x, b.y + b.h - 10, b.w, 10, accent, false);
    }
    const cy = b.y + b.h / 2 + (sub ? -12 : 0);
    p.text(text, b.x + b.w / 2, cy, `900 ${sub ? 62 : 74}px "Arial Black", Impact, sans-serif`, fg, false, b.w - 30);
    if (sub) p.text(sub, b.x + b.w / 2, b.y + b.h - 26, `700 26px "Arial", sans-serif`, fg, false, b.w - 40);
    // Weathering.
    for (let i = 0; i < 30; i++) {
      c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.1})`;
      c.fillRect(b.x + rnd() * b.w, b.y + rnd() * b.h, 4 + rnd() * 20, 2 + rnd() * 5);
    }
  };
  sign('signAbarrotes', '#f6f1e4', '#c1272d', 'ABARROTES', 'LA GUADALUPANA', '#1d4e89');
  sign('signMariscos', '#1fa8a0', '#ffffff', 'MARISCOS', 'CÓCTELES · CEVICHE · TACOS', '#f2c14e');
  sign('signTacos', '#f2c14e', '#b3261e', 'TACOS', 'DOÑA LUPE · PESCADO Y CAMARÓN', '#b3261e');
  sign('signPurificadora', '#1d64b0', '#ffffff', 'PURIFICADORA', 'AGUA · HIELO', '#7cc4f0');

  // ---------- vehicles, canvas, flags ----------
  {
    const b = box('rvSide');
    p.rect(b.x, b.y, b.w, b.h, '#f3f2ee', false);
    // Swoosh graphics take the vertex colour.
    for (const [off, th] of [[0, 9], [14, 5]] as const) {
      p.path((ctx) => {
        ctx.moveTo(b.x, b.y + 78 + off);
        ctx.bezierCurveTo(b.x + b.w * 0.35, b.y + 70 + off, b.x + b.w * 0.6, b.y + 104 + off, b.x + b.w, b.y + 60 + off);
        ctx.lineTo(b.x + b.w, b.y + 60 + off + th);
        ctx.bezierCurveTo(b.x + b.w * 0.6, b.y + 104 + off + th, b.x + b.w * 0.35, b.y + 70 + off + th, b.x, b.y + 78 + off + th);
      }, grey(0.9), true);
    }
    for (const [wx, ww] of [[26, 46], [150, 56], [214, 26]]) {
      p.rect(b.x + wx - 2, b.y + 26, ww + 4, 30, '#9a9a9a', false);
      p.rect(b.x + wx, b.y + 28, ww, 26, '#1e2830', false);
      p.paint('rgba(255,255,255,0.12)', (ctx) => ctx.fillRect(b.x + wx + 4, b.y + 30, ww * 0.3, 22));
    }
    // Entry door.
    p.paint('rgba(0,0,0,0.45)', (ctx) => {
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x + 96, b.y + 22, 30, b.h - 30);
    });
    p.rect(b.x + 102, b.y + 30, 18, 18, '#1e2830', false);
    p.rect(b.x, b.y + b.h - 8, b.w, 8, '#bdbdbd', false);
  }
  {
    const b = box('vanSide');
    // Two-tone camper van: white top, vertex-coloured body.
    p.rect(b.x, b.y, b.w, b.h * 0.46, '#f2efe6', false);
    p.rect(b.x, b.y + b.h * 0.46, b.w, b.h * 0.54, grey(0.95), true);
    p.rect(b.x, b.y + b.h * 0.46 - 2, b.w, 3, '#c9c9c9', false);
    for (const [wx, ww] of [[14, 52], [74, 66], [148, 72]]) {
      p.rect(b.x + wx, b.y + 12, ww, 34, '#1d262d', false);
      p.paint('rgba(255,255,255,0.1)', (ctx) => ctx.fillRect(b.x + wx + 4, b.y + 14, ww * 0.25, 30));
    }
    p.paint('rgba(0,0,0,0.35)', (ctx) => {
      ctx.fillRect(b.x + 70, b.y + 12, 1.5, b.h - 20);
      ctx.fillRect(b.x + 144, b.y + 12, 1.5, b.h - 20);
    });
    p.rect(b.x, b.y + b.h - 10, b.w, 10, '#3a3a3a', false);
  }
  {
    const b = box('awning');
    for (let i = 0; i < 12; i++) {
      const x = b.x + (i * b.w) / 12;
      p.rect(x, b.y, b.w / 12 + 0.5, b.h, i % 2 ? '#f4f2ec' : grey(0.92), i % 2 === 0);
    }
    p.paint('rgba(0,0,0,0.15)', (ctx) => ctx.fillRect(b.x, b.y + b.h - 6, b.w, 6));
  }
  {
    const b = box('tent');
    p.rect(b.x, b.y, b.w, b.h, grey(0.95), true);
    p.paint('rgba(0,0,0,0.18)', (ctx) => {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2, b.y);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h);
      ctx.stroke();
    });
    p.rect(b.x, b.y + b.h - 22, b.w, 22, '#3b3f44', false);
  }
  {
    const b = box('flagMx');
    const w3 = b.w / 3;
    p.rect(b.x, b.y, w3 + 1, b.h, '#006847', false);
    p.rect(b.x + w3, b.y, w3 + 1, b.h, '#f7f7f2', false);
    p.rect(b.x + w3 * 2, b.y, w3, b.h, '#ce1126', false);
    // Coat of arms, drawn narrow because the flag stretches it sideways.
    p.path((ctx) => ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, 9, 15, 0, 0, Math.PI * 2), '#8a6a2a', false);
    p.path((ctx) => ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2 + 12, 11, 5, 0, 0, Math.PI), '#3d7a3a', false);
  }
  const banner = (name: TileName, bg: string, fg: string, edge: string, text: string) => {
    const b = box(name);
    p.rect(b.x, b.y, b.w, b.h, bg, false);
    p.rect(b.x, b.y, 18, b.h, edge, false);
    // Text runs up the banner; the tile maps to a tall, narrow cloth.
    for (const [ctx, fill] of [[c, fg], [m, '#000']] as const) {
      ctx.save();
      ctx.translate(b.x + b.w / 2 + 8, b.y + b.h - 8);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(0.3, 1);
      ctx.font = '900 70px "Arial Black", Impact, sans-serif';
      ctx.fillStyle = fill;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0, (b.h - 16) / 0.3);
      ctx.restore();
    }
  };
  banner('bannerA', '#13b5ae', '#ffffff', '#0b3d5c', 'KITE SCHOOL');
  banner('bannerB', '#ff7a1a', '#ffffff', '#ffd23f', 'KITEBOARDING');
  banner('bannerC', '#e63946', '#ffffff', '#1d3557', 'LESSONS · RENTALS');
  {
    const b = box('mural');
    const g = c.createLinearGradient(0, b.y, 0, b.y + b.h);
    g.addColorStop(0, '#7cc6e8');
    g.addColorStop(0.55, '#2b8fc6');
    g.addColorStop(1, '#105f8f');
    c.fillStyle = g;
    c.fillRect(b.x, b.y, b.w, b.h);
    m.fillStyle = '#000';
    m.fillRect(b.x, b.y, b.w, b.h);
    p.path((ctx) => ctx.arc(b.x + 200, b.y + 26, 16, 0, Math.PI * 2), '#ffd23f', false);
    // Whale tail and a leaping mobula.
    p.path((ctx) => {
      const x = b.x + 70, y = b.y + 80;
      ctx.moveTo(x, y + 30);
      ctx.quadraticCurveTo(x - 4, y, x - 34, y - 18);
      ctx.quadraticCurveTo(x - 6, y - 10, x, y - 2);
      ctx.quadraticCurveTo(x + 6, y - 10, x + 34, y - 18);
      ctx.quadraticCurveTo(x + 4, y, x + 6, y + 30);
    }, '#1d2b36', false);
    p.path((ctx) => {
      const x = b.x + 170, y = b.y + 64;
      ctx.moveTo(x - 30, y + 6);
      ctx.quadraticCurveTo(x - 6, y - 14, x, y - 4);
      ctx.quadraticCurveTo(x + 6, y - 14, x + 30, y + 6);
      ctx.quadraticCurveTo(x + 4, y + 4, x, y + 14);
      ctx.quadraticCurveTo(x - 4, y + 4, x - 30, y + 6);
    }, '#2a2f38', false);
    p.paint('rgba(255,255,255,0.6)', (ctx) => {
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(b.x + 40 + i * 50, b.y + b.h - 14, 18, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
      }
    });
  }

  // ---------- combine: RGB from paint, A from mask; fill gutters; flip rows ----------
  for (const name of Object.keys(LAYOUT) as TileName[]) {
    const b = box(name);
    regions.push([b.x, b.y, b.x + b.w, b.y + b.h]);
  }
  const ci = c.getImageData(0, 0, SIZE, SIZE).data;
  const mi = m.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Uint8Array(SIZE * SIZE * 4);
  const hash = mulberry32(99);
  for (let y = 0; y < SIZE; y++) {
    const src = y * SIZE * 4, dst = (SIZE - 1 - y) * SIZE * 4;
    for (let x = 0; x < SIZE; x++) {
      const s = src + x * 4, d = dst + x * 4;
      const n = (hash() - 0.5) * 9;
      out[d] = clampByte(ci[s] + n);
      out[d + 1] = clampByte(ci[s + 1] + n);
      out[d + 2] = clampByte(ci[s + 2] + n);
      out[d + 3] = mi[s];
    }
  }
  // Gutters copy the edge texels so mipmaps do not bleed between tiles.
  const at = (x: number, y: number) => ((SIZE - 1 - y) * SIZE + x) * 4;
  for (const [x0, y0, x1, y1] of regions) {
    for (let y = y0 - GUT; y < y1 + GUT; y++) {
      for (let x = x0 - GUT; x < x1 + GUT; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const sx = Math.min(x1 - 1, Math.max(x0, x)), sy = Math.min(y1 - 1, Math.max(y0, y));
        const s = at(sx, sy), d = at(x, y);
        out[d] = out[s];
        out[d + 1] = out[s + 1];
        out[d + 2] = out[s + 2];
        out[d + 3] = out[s + 3];
      }
    }
  }
  const whiteBox = box('white');
  for (let y = whiteBox.y - GUT; y < whiteBox.y + whiteBox.h + GUT; y++) {
    for (let x = whiteBox.x - GUT; x < whiteBox.x + whiteBox.w + GUT; x++) {
      const d = at(x, y);
      out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(out, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const tiles = {} as Record<TileName, UVRect>;
  for (const name of Object.keys(LAYOUT) as TileName[]) {
    const b = box(name);
    tiles[name] = [(b.x + 0.5) / SIZE, 1 - (b.y + b.h - 0.5) / SIZE, (b.x + b.w - 0.5) / SIZE, 1 - (b.y + 0.5) / SIZE];
  }
  const plain: [number, number] = [(whiteBox.x + whiteBox.w / 2) / SIZE, 1 - (whiteBox.y + whiteBox.h / 2) / SIZE];
  return { texture, plain, tiles };
}

function clampByte(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Sub-rectangle of a tile (fractions 0..1, v from the bottom). */
export function subUV(r: UVRect, u0: number, v0: number, u1: number, v1: number): UVRect {
  return [r[0] + (r[2] - r[0]) * u0, r[1] + (r[3] - r[1]) * v0, r[0] + (r[2] - r[0]) * u1, r[1] + (r[3] - r[1]) * v1];
}
