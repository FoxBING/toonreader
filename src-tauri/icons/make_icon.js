// Generates icons/icon.ico (64x64, 32bpp) without external deps.
// Run: node make_icon.js
const fs = require('fs');
const path = require('path');

const W = 64, H = 64;

// rounded-rect SDF helpers
function insideRounded(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r);
  const qy = Math.abs(y - cy) - (half - r);
  const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
  return Math.sqrt(dx * dx + dy * dy) - r <= 0;
}
function insideRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// pixel colors, bottom-up BGRA
const rowBytes = W * 4;
const pix = Buffer.alloc(rowBytes * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (insideRounded(x + 0.5, y + 0.5, 32, 32, 25, 10)) {
      // vertical gradient bg
      const t = y / (H - 1);
      r = Math.round(28 + t * 34);
      g = Math.round(24 + t * 22);
      b = Math.round(52 + t * 60);
      a = 255;
      // white center strip (the webtoon column), rounded ends
      if (insideRounded(x + 0.5, y + 0.5, 32, 32, 5.5, 5, 0) || insideRect(x, y, 27, 12, 36, 51)) {
        if (insideRect(x, y, 27, 12, 36, 51) || (Math.hypot(x + 0.5 - 32, y + 0.5 - 17.5) <= 5) || (Math.hypot(x + 0.5 - 32, y + 0.5 - 46.5) <= 5)) {
          r = 240; g = 240; b = 248;
        }
      }
      // two side accent bars
      if (insideRect(x, y, 20, 22, 24, 42)) { r = 124; g = 108; b = 255; }
      if (insideRect(x, y, 39, 22, 43, 42)) { r = 124; g = 108; b = 255; }
    }
    const o = (H - 1 - y) * rowBytes + x * 4; // bottom-up
    pix[o] = b; pix[o + 1] = g; pix[o + 2] = r; pix[o + 3] = a;
  }
}

// BITMAPINFOHEADER (height doubled for the AND mask)
const bmpHeader = Buffer.alloc(40);
bmpHeader.writeUInt32LE(40, 0);
bmpHeader.writeInt32LE(W, 4);
bmpHeader.writeInt32LE(H * 2, 8);
bmpHeader.writeUInt16LE(1, 12);
bmpHeader.writeUInt16LE(32, 14);
// rest zeros

const maskRow = Math.ceil(W / 32) * 4; // 8 bytes for 64px, already 4-aligned
const mask = Buffer.alloc(maskRow * H);

const bmpData = Buffer.concat([bmpHeader, pix, mask]);

const ico = Buffer.alloc(6 + 16 + bmpData.length);
ico.writeUInt16LE(0, 0);      // reserved
ico.writeUInt16LE(1, 2);      // type: icon
ico.writeUInt16LE(1, 4);      // count
ico.writeUInt8(W, 6);
ico.writeUInt8(H, 7);
ico.writeUInt8(0, 8);         // palette
ico.writeUInt8(0, 9);
ico.writeUInt16LE(1, 10);     // planes
ico.writeUInt16LE(32, 12);    // bpp
ico.writeUInt32LE(bmpData.length, 14);
ico.writeUInt32LE(22, 18);    // offset
bmpData.copy(ico, 22);

const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log('wrote', out, ico.length, 'bytes');
