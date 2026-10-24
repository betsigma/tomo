// build/make-icons.js
// ---------------------------------------------------------------------------
// Turn build/icon-source.png (a palette PNG of pixel art) into app icons:
//   - build/icon.png : 512x512 RGBA, white background made transparent
//   - build/icon.ico : 16, 24, 32, 48, 64, 128, 256 sizes
// The background is removed by a flood fill from the four corners, so anything
// ENCLOSED by the dark plum outline (the paper inside the window) is kept.
// All scaling is nearest-neighbor so the pixel art stays crisp.
//
// No external dependencies: PNG is decoded/encoded with Node's zlib, and the
// ICO is assembled by hand (PNG-compressed entries).
//
// Run: node build/make-icons.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD = __dirname;
const SRC = path.join(BUILD, 'icon-source.png');
const OUT_PNG = path.join(BUILD, 'icon.png');
const OUT_ICO = path.join(BUILD, 'icon.ico');

// ---------------------------------------------------------------------------
// PNG decode (8-bit, colour type 3 = palette, no interlace)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8; // skip signature
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (colorType !== 3) throw new Error('Expected palette PNG (colour type 3), got ' + colorType);
  if (bitDepth !== 8) throw new Error('Expected 8-bit PNG, got ' + bitDepth);
  if (interlace !== 0) throw new Error('Interlaced PNG not supported');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 1;                 // palette index fits in one byte
  const stride = w * bpp;
  const idx = Buffer.alloc(w * h);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[rp++];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error('Bad filter ' + filter);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(idx, y * w);
    prev = cur;
  }

  // Palette -> RGBA
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = idx[i];
    rgba[i * 4] = plte[p * 3];
    rgba[i * 4 + 1] = plte[p * 3 + 1];
    rgba[i * 4 + 2] = plte[p * 3 + 2];
    rgba[i * 4 + 3] = trns && p < trns.length ? trns[p] : 255;
  }
  return { width: w, height: h, data: rgba, plte: plte ? Buffer.from(plte) : null, trns: trns ? Buffer.from(trns) : null };
}

// ---------------------------------------------------------------------------
// PNG encode (8-bit RGBA)
// ---------------------------------------------------------------------------
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// Flood fill the background (from the corners) to transparent
// ---------------------------------------------------------------------------
// Background = a transparent pixel, or a near-white one (this source is already
// transparent outside the square, but a faint white fringe can remain). Only
// pixels CONNECTED to a corner are cleared, so the cream paper inside the window
// and the white sparkles painted on the pink are all preserved, as is the dark
// plum outline (never near-white).
function floodBackgroundTransparent(img, whiteThreshold = 235) {
  const { width: w, height: h, data } = img;
  const isBg = (i) => {
    if (data[i + 3] === 0) return true;                                  // transparent
    return Math.min(data[i], data[i + 1], data[i + 2]) >= whiteThreshold; // near-white fringe
  };

  const seen = new Uint8Array(w * h);
  const stack = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let cleared = 0;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const pi = y * w + x;
    if (seen[pi]) continue;
    const i = pi * 4;
    if (!isBg(i)) continue;
    seen[pi] = 1;
    if (data[i + 3] !== 0) cleared++;
    data[i + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  console.log(`   flood fill from the corners: cleared ${cleared} solid pixel(s) (transparent + near-white)`);
  return img;
}

// ---------------------------------------------------------------------------
// Nearest-neighbor scale
// ---------------------------------------------------------------------------
function nearest(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const s = (sy * sw + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: dw, height: dh, data: out };
}

// ---------------------------------------------------------------------------
// Simplified icon (for tiny sizes): pink rounded square + yellow star + bars
// ---------------------------------------------------------------------------
const PLUM = [0x6b, 0x2d, 0x4f];
const PINK = [0xf8, 0xa3, 0xc4];
const LAV = [0xd4, 0xbf, 0xff];
const BUTTER = [0xfb, 0xe8, 0xa0];
const BLUE = [0xaf, 0xc6, 0xff];
const LIGHT = [0xff, 0xf3, 0xf7];

function insideRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - 1 - r);
  const cy = Math.min(Math.max(y, r), h - 1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function starMask(size) {
  // 5-point star rasterized by the even-odd rule.
  const pts = [];
  const cx = size / 2, cy = size / 2 + size * 0.03;
  const R = size * 0.5, r = size * 0.21;
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  const inPoly = (px, py) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const mask = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inPoly(x + 0.5, y + 0.5)) mask.push([x, y]);
  return mask;
}

function drawSimplified(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const px = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  };

  // A rounded rectangle with a 1px outline.
  const fillRounded = (x0, y0, w, h, r, fill, outline) => {
    const at = (lx, ly) => insideRoundedRect(lx, ly, w, h, r);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const lx = x - x0, ly = y - y0;
        if (!at(lx, ly)) continue;
        const edge = !at(lx - 1, ly) || !at(lx + 1, ly) || !at(lx, ly - 1) || !at(lx, ly + 1);
        px(x, y, edge ? outline : fill);
      }
    }
  };

  // Pink rounded square with a plum outline, and a light-pink window panel.
  const margin = Math.max(1, Math.round(size * 0.06));
  const w = size - margin * 2;
  fillRounded(margin, margin, w, w, Math.max(2, Math.round(size * 0.22)), PINK, PLUM);

  const wx0 = margin + Math.round(w * 0.44);
  const wx1 = margin + w - Math.round(w * 0.08);
  const wy0 = margin + Math.round(w * 0.12);
  const wy1 = margin + w - Math.round(w * 0.12);
  fillRounded(wx0, wy0, wx1 - wx0, wy1 - wy0, Math.max(1, Math.round(size * 0.1)), LIGHT, PLUM);

  // Coloured clock bars inside the window: as many as fit the space.
  const bx0 = wx0 + 2, bx1 = wx1 - 1;
  const barH = Math.max(1, Math.round(w * 0.12));
  const gap = Math.max(1, Math.round(w * 0.06));
  const innerTop = wy0 + 1, innerBot = wy1 - 2, innerH = innerBot - innerTop + 1;
  const fit = Math.max(1, Math.min(4, Math.floor((innerH + gap) / (barH + gap))));
  const colors = [PINK, LAV, BUTTER, BLUE].slice(0, fit);
  const stackH = colors.length * barH + (colors.length - 1) * gap;
  const top = innerTop + Math.floor((innerH - stackH) / 2);
  colors.forEach((c, i) => {
    const y0 = top + i * (barH + gap);
    for (let y = y0; y < y0 + barH; y++) for (let x = bx0; x < bx1; x++) px(x, y, c);
  });

  // Yellow star, top left (with a 1px plum outline).
  const starSize = Math.max(5, Math.round(size * 0.34));
  const sx0 = margin, sy0 = margin;
  const mask = starMask(starSize);
  for (const [mx, my] of mask) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) px(sx0 + mx + ox, sy0 + my + oy, PLUM);
  }
  for (const [mx, my] of mask) px(sx0 + mx, sy0 + my, BUTTER);

  return { width: size, height: size, data };
}

// ---------------------------------------------------------------------------
// ICO (PNG-compressed entries)
// ---------------------------------------------------------------------------
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const images = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
    images.push(e.png);
  });
  return Buffer.concat([header, dir, ...images]);
}

// ---------------------------------------------------------------------------
// Probe mode: print pixel samples for debugging
// ---------------------------------------------------------------------------
if (process.argv[2] === 'probe') {
  const img = decodePng(SRC);
  const { width: w, height: h, data } = img;
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    return `(${x},${y}) rgba(${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]})`;
  };
  console.log(`${w}x${h}`);
  console.log('corners:', [sample(0, 0), sample(w - 1, 0), sample(0, h - 1), sample(w - 1, h - 1)].join('  '));
  console.log('edge mid:', sample(w >> 1, 3), sample(w >> 1, h - 4), sample(3, h >> 1), sample(w - 4, h >> 1));
  const hist = {};
  for (let i = 3; i < data.length; i += 4) hist[data[i]] = (hist[data[i]] || 0) + 1;
  console.log('alpha histogram (top):', Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6));
  const colors = {};
  for (let i = 0; i < data.length; i += 4) {
    const k = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
    colors[k] = (colors[k] || 0) + 1;
  }
  console.log('top colours:', Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 8));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Reading', path.relative(process.cwd(), SRC));
const src = decodePng(SRC);
console.log(`   ${src.width}x${src.height}, palette ${src.plte.length / 3} colours`);

const cleaned = floodBackgroundTransparent(src);

// 512 app icon (nearest-neighbor from the full art). Also copied into src/ so
// the settings header can use it (and so it is packaged with the app).
const icon512 = nearest(cleaned, 512, 512);
const png512 = encodePng(512, 512, icon512.data);
fs.writeFileSync(OUT_PNG, png512);
fs.writeFileSync(path.join(BUILD, '..', 'src', 'icon.png'), png512);
console.log('Wrote', path.relative(process.cwd(), OUT_PNG), 'and src/icon.png');

// ICO sizes. 16/32 use the simplified art; the rest use the full art.
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((size) => {
  const img = (size <= 32) ? drawSimplified(size) : nearest(cleaned, size, size);
  return { size, png: encodePng(size, size, img.data) };
});
fs.writeFileSync(OUT_ICO, buildIco(entries));
console.log('Wrote', path.relative(process.cwd(), OUT_ICO), `(${SIZES.join(', ')})`);

// Preview dump (opt-in with --preview) so the small sizes can be eyeballed.
if (!process.argv.includes('--preview')) { console.log('Done.'); return; }
const previewDir = path.join(BUILD, '.preview');
fs.mkdirSync(previewDir, { recursive: true });
for (const size of SIZES) {
  const full = nearest(cleaned, size, size);
  const simp = drawSimplified(size);
  fs.writeFileSync(path.join(previewDir, `full-${size}.png`), encodePng(size, size, full.data));
  fs.writeFileSync(path.join(previewDir, `simplified-${size}.png`), encodePng(size, size, simp.data));
  if (size <= 48) {                    // zoomed copies for eyeballing tiny sizes
    const zf = Math.round(256 / size);
    const zFull = nearest(full, size * zf, size * zf);
    const zSimp = nearest(simp, size * zf, size * zf);
    fs.writeFileSync(path.join(previewDir, `full-${size}-zoom.png`), encodePng(zFull.width, zFull.height, zFull.data));
    fs.writeFileSync(path.join(previewDir, `simplified-${size}-zoom.png`), encodePng(zSimp.width, zSimp.height, zSimp.data));
  }
}
fs.writeFileSync(path.join(previewDir, 'icon-512.png'), encodePng(512, 512, icon512.data));
console.log('Preview PNGs in', path.relative(process.cwd(), previewDir));
