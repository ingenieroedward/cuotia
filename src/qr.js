/**
 * QR Code generator (model 2), no dependencies. Byte mode (UTF-8), error correction level L, versions 1-9
 * (up to 230 bytes): enough for an otpauth:// link. The screen is clean and close to the camera, so level L's
 * extra capacity is worth more than extra redundancy. Algorithm and tables follow the QR specification
 * (ISO/IEC 18004); the output was checked against an independent decoder (jsQR) for every length and version.
 */

const MIN_VERSION = 1;
const MAX_VERSION = 9; // keeps the byte-mode character count at 8 bits
// Level L: error-correction codewords per block, and number of blocks, by version.
const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30];
const NUM_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2];
const FORMAT_BITS_L = 1; // the 2-bit code for level L
const PENALTY = { n1: 3, n2: 3, n3: 40, n4: 10 };

const sizeOf = (ver) => ver * 4 + 17;

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const numDataCodewords = (ver) => Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = sizeOf(ver) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/** Splits the data into blocks, appends each block's error correction, and interleaves them. */
export function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_BLOCKS[ver];
  const blockEcc = ECC_PER_BLOCK[ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEcc);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEcc + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEcc || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---- Matrix ----

const bit = (x, i) => ((x >>> i) & 1) !== 0;

/** The fixed parts of a symbol (finders, timing, alignment, format and version areas), independent of the data. */
function drawFunctionPatterns(ver) {
  const size = sizeOf(ver);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormat(modules, isFunction, size, 0); // reserves the area; rewritten once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit(bits, i)); set(b, a, bit(bits, i));
    }
  }
  return { size, modules, isFunction };
}

function drawFormat(modules, isFunction, size, mask) {
  const data = (FORMAT_BITS_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true); // the always-dark module
}

function drawCodewords(modules, isFunction, size, data) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < data.length * 8) {
          modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
}

function penalty(modules, size) {
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += PENALTY.n1 + (run - 5); run = 1; }
    }
    const asBits = Array.from({ length: size }, (_, i) => (get(i) ? 1 : 0)).join("");
    for (const pat of ["10111010000", "00001011101"]) {
      for (let at = asBits.indexOf(pat); at !== -1; at = asBits.indexOf(pat, at + 1)) score += PENALTY.n3;
    }
  };
  for (let y = 0; y < size; y++) line((i) => modules[y][i]);
  for (let x = 0; x < size; x++) line((i) => modules[i][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += PENALTY.n2;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY.n4;
  return score;
}

/** The data codewords of `text` (UTF-8, byte mode) for this version, padded as the specification requires. */
function encodeData(bytes, ver) {
  const bits = [];
  const push = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; codewords.length < numDataCodewords(ver); pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** The smallest version that holds `byteLength` bytes, or throws. */
export function versionFor(byteLength) {
  for (let ver = MIN_VERSION; ver <= MAX_VERSION; ver++) if (4 + 8 + byteLength * 8 <= numDataCodewords(ver) * 8) return ver;
  throw new Error("El texto es demasiado largo para el código QR");
}

/** The function-pattern layout of a version: used by tests to read a symbol back. */
export function layout(ver) {
  const { size, isFunction } = drawFunctionPatterns(ver);
  return { size, isFunction };
}

/** The QR as a square array of rows of booleans (true = dark). */
export function qrMatrix(text) {
  const bytes = Buffer.from(String(text), "utf8");
  const ver = versionFor(bytes.length);
  const all = addEccAndInterleave(encodeData(bytes, ver), ver);
  const { size, modules, isFunction } = drawFunctionPatterns(ver);
  drawCodewords(modules, isFunction, size, all);

  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, size, mask);
    drawFormat(modules, isFunction, size, mask);
    const score = penalty(modules, size);
    if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(modules, isFunction, size, mask); // undo
  }
  applyMask(modules, isFunction, size, best);
  drawFormat(modules, isFunction, size, best);
  return modules;
}

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The QR as an inline SVG string: dark modules on white with the 4-module quiet zone the specification asks for.
 * Colors are attributes, not styles (the page's CSP forbids inline styles). `label` is the accessible name.
 */
export function qrSvg(text, { label = "Código QR", border = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + border * 2;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + border},${y + border}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${escapeAttr(label)}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
