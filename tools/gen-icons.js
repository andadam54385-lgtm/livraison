// Genere des icones PNG unies (placeholder) sans dependance externe (zlib
// natif Node + implementation CRC32 maison). A remplacer plus tard par de
// vraies icones si besoin -- ce script garantit juste des PNG valides pour
// que le manifest soit installable des le depart.
//
// Usage: node tools/gen-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// PNG solide, fond orange (#d97706) avec un carre plus sombre au centre pour
// donner un semblant d'icone sans dependance de rendu de texte/forme.
function generatePng(size) {
  const bg = [0xd9, 0x76, 0x06];
  const fg = [0x1b, 0x24, 0x36];
  const margin = Math.round(size * 0.28);

  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0; // filter type: none
    const inCenterBand = y >= margin && y < size - margin;
    for (let x = 0; x < size; x++) {
      const inCenter = inCenterBand && x >= margin && x < size - margin;
      const color = inCenter ? fg : bg;
      const off = rowStart + 1 + x * 3;
      raw[off] = color[0];
      raw[off + 1] = color[1];
      raw[off + 2] = color[2];
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdrData),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  const outDir = path.join(__dirname, "..", "icons");
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ];

  for (const [name, size] of targets) {
    const png = generatePng(size);
    fs.writeFileSync(path.join(outDir, name), png);
    console.log(`OK: icons/${name} (${size}x${size}, ${png.length} octets)`);
  }
}

main();
