import test from "node:test";
import assert from "node:assert/strict";
import { addEccAndInterleave, layout, qrMatrix, qrSvg, versionFor } from "../src/qr.js";

// Reads a symbol back the way a scanner does (format info → mask → zigzag → codewords → text) and checks the
// error correction. It does not prove a phone camera reads it: that was checked once against an independent
// decoder (jsQR) for every length from 1 to 230 bytes; see the commit that introduced src/qr.js.

const at = (m, x, y) => (m[y][x] ? 1 : 0);

function readFormat(m) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits[i] = at(m, 8, i);
  bits[6] = at(m, 8, 7); bits[7] = at(m, 8, 8); bits[8] = at(m, 7, 8);
  for (let i = 9; i < 15; i++) bits[i] = at(m, 14 - i, 8);
  let v = 0;
  bits.forEach((b, i) => { v |= b << i; });
  return v ^ 0x5412;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function readBack(text) {
  const m = qrMatrix(text);
  const ver = (m.length - 17) / 4;
  const { size, isFunction } = layout(ver);
  const format = readFormat(m);
  const mask = (format >>> 10) & 7; // the 15-bit word is: level (2 bits) | mask (3 bits) | BCH remainder (10 bits)
  // A valid 15-bit BCH word leaves no remainder when divided by 0x537; level L is "01".
  let rem = format;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction[y][x]) bits.push(m[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
  }
  const all = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) all.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // Versions 1-5 have one block, 6-9 have two of equal length (spec table for level L).
  const blocks = ver <= 5 ? 1 : 2;
  const ecc = [7, 10, 15, 20, 26, 18, 20, 24, 30][ver - 1];
  const dataLen = all.length - ecc * blocks;
  // The stream interleaves the blocks (byte i of block 0, byte i of block 1, …); undo that to get the data in order.
  const perBlock = dataLen / blocks;
  const data = [];
  for (let j = 0; j < blocks; j++) for (let i = 0; i < perBlock; i++) data.push(all[i * blocks + j]);
  return { m, ver, size, mask, formatRemainder: rem, formatLevel: format >>> 13, all, data };
}

const textOf = (data) => {
  const bits = data.map((b) => b.toString(2).padStart(8, "0")).join("");
  assert.equal(bits.slice(0, 4), "0100", "byte mode");
  const n = parseInt(bits.slice(4, 12), 2);
  return Buffer.from(Array.from({ length: n }, (_, i) => parseInt(bits.slice(12 + i * 8, 20 + i * 8), 2))).toString("utf8");
};

test("la versión crece con el texto y hay un tope claro", () => {
  assert.deepEqual([1, 17, 18, 32, 33, 106, 107, 230].map(versionFor), [1, 1, 2, 2, 3, 5, 6, 9]);
  assert.throws(() => versionFor(231), /demasiado largo/);
  assert.throws(() => qrMatrix("x".repeat(231)), /demasiado largo/);
});

test("el símbolo tiene las partes fijas de la norma", () => {
  for (const len of [10, 100, 200]) {
    const m = qrMatrix("a".repeat(len));
    const n = m.length;
    assert.equal((n - 17) % 4, 0);
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let d = 0; d < 7; d++) {
        for (let e = 0; e < 7; e++) {
          const edge = d === 0 || d === 6 || e === 0 || e === 6;
          const core = d >= 2 && d <= 4 && e >= 2 && e <= 4;
          assert.equal(m[oy + d][ox + e], edge || core, `buscador en (${ox},${oy})`);
        }
      }
    }
    for (let i = 8; i < n - 8; i++) assert.equal([m[6][i], m[i][6]].every((v) => v === (i % 2 === 0)), true, "líneas de sincronía");
    assert.equal(m[n - 8][8], true, "módulo oscuro");
  }
});

test("se puede leer de vuelta: formato, máscara, corrección de errores y texto", () => {
  const samples = ["a", "hola", "https://cuotia.edwsystem.com/", "Sandra Duque Arias ñandú ¿¡€!", "x".repeat(17), "y".repeat(18), "z".repeat(106), "w".repeat(107), "v".repeat(230)];
  const seen = new Set();
  for (let len = 1; len <= 230; len += 7) samples.push("L".repeat(len));
  for (const text of samples) {
    const r = readBack(text);
    seen.add(r.ver);
    assert.equal(r.formatRemainder, 0, `formato válido (${text.length} bytes)`);
    assert.equal(r.formatLevel, 1, "nivel de corrección L");
    assert.ok(r.mask >= 0 && r.mask <= 7);
    assert.equal(textOf(r.data), text, `texto de vuelta (${Buffer.byteLength(text)} bytes)`);
    assert.deepEqual(addEccAndInterleave(r.data, r.ver), r.all, "los bytes de corrección son los esperados");
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9], "se probaron las 9 versiones");
});

test("un enlace otpauth real cabe y genera siempre lo mismo", () => {
  const uri = `otpauth://totp/${encodeURIComponent("Cuotia:dev@edwsystem.com")}?secret=VL27YXNIWV5ZS3USAUWW5PIN7WCPFFER&issuer=Cuotia`;
  assert.equal(readBack(uri).ver, 5);
  assert.deepEqual(qrMatrix(uri), qrMatrix(uri), "determinista");
  assert.notDeepEqual(qrMatrix(uri), qrMatrix(`${uri}x`));
});

test("el SVG es seguro para la página: sin estilos en línea y con nombre accesible escapado", () => {
  const svg = qrSvg("hola", { label: `QR "<script>" & más` });
  assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"));
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="QR &quot;&lt;script&gt;&quot; &amp; más"/);
  assert.doesNotMatch(svg, /style=|<script|onload|href=/i);
  const dark = qrMatrix("hola").flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+,\d+h1v1h-1z/g) ?? []).length, dark, "un módulo por cuadro oscuro");
  assert.match(svg, /viewBox="0 0 29 29"/, "versión 1 (21) + zona de silencio 2×4");
});
