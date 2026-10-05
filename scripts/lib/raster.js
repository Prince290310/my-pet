'use strict';
// Minimal pixel-art toolkit: shape masks (ellipse, capsule, polygon, spline) that get
// "painted" with rim-light shading + a 1px outline, plus an RGBA bitmap to compose into.

function hex(c) {
  if (Array.isArray(c)) return c;
  const n = parseInt(c.slice(1), 16);
  if (c.length === 9) return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

class Bitmap {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
  }
  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.inside(x, y)) return;
    const [r, g, b, a] = hex(color);
    const i = (y * this.w + x) * 4;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
    this.px[i + 3] = a;
  }
  alpha(x, y) {
    if (!this.inside(x, y)) return 0;
    return this.px[(y * this.w + x) * 4 + 3];
  }
  /** Draw rows of characters; map: char -> color. '.' and ' ' are transparent. */
  pattern(x0, y0, rows, map) {
    rows.forEach((row, dy) => {
      [...row].forEach((ch, dx) => {
        if (map[ch]) this.set(x0 + dx, y0 + dy, map[ch]);
      });
    });
  }
  /** Pattern with an automatic 1px outline around its opaque pixels. */
  stamp(x0, y0, rows, map, outline) {
    const m = new Mask(this.w, this.h);
    rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && m.set(x0 + dx, y0 + dy)));
    if (outline) m.outlinePixels().forEach(([x, y]) => this.set(x, y, outline));
    this.pattern(x0, y0, rows, map);
  }
  line(x1, y1, x2, y2, color) {
    const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let i = 0; i <= n; i++) this.set(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, color);
  }
  blit(src, dx, dy, flipX = false) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const sx = flipX ? src.w - 1 - x : x;
        const si = (y * src.w + sx) * 4;
        if (src.px[si + 3] === 0) continue;
        const tx = dx + x, ty = dy + y;
        if (!this.inside(tx, ty)) continue;
        const ti = (ty * this.w + tx) * 4;
        for (let k = 0; k < 4; k++) this.px[ti + k] = src.px[si + k];
      }
    }
  }
  /** Nearest-neighbour upscale. */
  scaled(n) {
    const out = new Bitmap(this.w * n, this.h * n);
    for (let y = 0; y < out.h; y++) {
      for (let x = 0; x < out.w; x++) {
        const si = (Math.floor(y / n) * this.w + Math.floor(x / n)) * 4;
        const ti = (y * out.w + x) * 4;
        for (let k = 0; k < 4; k++) out.px[ti + k] = this.px[si + k];
      }
    }
    return out;
  }
  crop(x0, y0, w, h) {
    const out = new Bitmap(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!this.inside(x0 + x, y0 + y)) continue;
        const si = ((y0 + y) * this.w + x0 + x) * 4;
        const ti = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) out.px[ti + k] = this.px[si + k];
      }
    }
    return out;
  }
}

class Mask {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h);
  }
  get(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.d[y * this.w + x] : 0;
  }
  set(x, y, v = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = v;
  }
  _each(x0, y0, x1, y1, test, v) {
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.h - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) if (test(x + 0.5, y + 0.5)) this.d[y * this.w + x] = v;
    }
    return this;
  }
  ellipse(cx, cy, rx, ry, v = 1) {
    return this._each(cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1, (x, y) => {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      return dx * dx + dy * dy <= 1;
    }, v);
  }
  /** Tapered capsule from (x1,y1) radius r1 to (x2,y2) radius r2. */
  capsule(x1, y1, x2, y2, r1, r2 = r1, v = 1) {
    const r = Math.max(r1, r2);
    const vx = x2 - x1, vy = y2 - y1;
    const l2 = vx * vx + vy * vy || 1e-6;
    return this._each(Math.min(x1, x2) - r - 1, Math.min(y1, y2) - r - 1, Math.max(x1, x2) + r + 1, Math.max(y1, y2) + r + 1, (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / l2));
      const px = x1 + vx * t, py = y1 + vy * t;
      const rr = r1 + (r2 - r1) * t;
      return (x - px) ** 2 + (y - py) ** 2 <= rr * rr;
    }, v);
  }
  poly(pts, v = 1) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return this._each(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (x, y) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, v);
  }
  rect(x, y, w, h, v = 1) {
    return this._each(x, y, x + w - 1, y + h - 1, () => true, v);
  }
  /** Smooth tapered stroke through points (Catmull-Rom), radius r0 at start -> r1 at end. */
  spline(pts, r0, r1, v = 1) {
    const samples = catmull(pts, 10);
    let total = 0;
    const acc = [0];
    for (let i = 1; i < samples.length; i++) {
      total += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
      acc.push(total);
    }
    for (let i = 1; i < samples.length; i++) {
      const ra = r0 + (r1 - r0) * (acc[i - 1] / (total || 1));
      const rb = r0 + (r1 - r0) * (acc[i] / (total || 1));
      this.capsule(samples[i - 1][0], samples[i - 1][1], samples[i][0], samples[i][1], ra, rb, v);
    }
    return this;
  }
  /** Empty pixels 4-adjacent to filled ones. */
  outlinePixels() {
    const out = [];
    for (let y = -1; y <= this.h; y++) {
      for (let x = -1; x <= this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) out.push([x, y]);
      }
    }
    return out;
  }
  /** y of the top-most filled pixel in column x (or -1). */
  top(x) {
    for (let y = 0; y < this.h; y++) if (this.get(x, y)) return y;
    return -1;
  }
}

function catmull(pts, steps) {
  if (pts.length < 2) return pts.slice();
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Paint a mask into the bitmap with rim-light shading (light from above) and an outline.
 * pal: { base, rim, rim2, dark, outline }
 */
function paint(bmp, mask, pal, opts = {}) {
  // cover: mask of the part drawn *behind* this one. Edges that fall inside it become a soft
  // seam (pal.seam) instead of a hard outline, and get no rim light - so limbs blend into the body.
  const { outline = true, rim = true, cover = null } = opts;
  const behind = (x, y) => !!(cover && cover.get(x, y));
  const open = (x, y) => !mask.get(x, y) && !behind(x, y);
  if (outline) mask.outlinePixels().forEach(([x, y]) => bmp.set(x, y, behind(x, y) ? pal.seam || pal.dark : pal.outline));
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!mask.get(x, y)) continue;
      let c = pal.base;
      if (rim && open(x, y - 1)) c = pal.rim;
      else if (rim && open(x, y - 2) && !mask.get(x, y - 2)) c = pal.rim2;
      else if (!mask.get(x, y + 1)) c = pal.dark;
      else if (rim && open(x - 1, y)) c = pal.rim2;
      bmp.set(x, y, c);
    }
  }
}

/** Two-bone IK: joint between a and b with bone lengths l1, l2. bend = +1 / -1 picks the side. */
function ik(a, b, l1, l2, bend) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let d = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / d, uy = dy / d;
  d = Math.min(d, l1 + l2 - 1e-3);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  return [a[0] + ux * along - uy * h * bend, a[1] + uy * along + ux * h * bend];
}

module.exports = { hex, Bitmap, Mask, paint, ik, catmull };
