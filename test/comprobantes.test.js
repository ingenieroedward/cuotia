import test from "node:test";
import assert from "node:assert/strict";
import { parseMultipart, sniffProof } from "../src/upload.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("datos de prueba")]);

test("el tipo del archivo se decide por su contenido, no por lo que diga el navegador", () => {
  assert.equal(sniffProof(PNG), "image/png");
  assert.equal(sniffProof(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), "image/jpeg");
  assert.equal(sniffProof(Buffer.from("RIFF1234WEBPVP8 ")), "image/webp");
  assert.equal(sniffProof(Buffer.from("%PDF-1.7\n1 0 obj")), "application/pdf");
  assert.equal(sniffProof(Buffer.from("<script>alert(1)</script>")), null, "HTML no pasa");
  assert.equal(sniffProof(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null, "SVG no pasa");
  assert.equal(sniffProof(Buffer.alloc(3)), null);
});

test("multipart: campos de texto y un archivo binario intacto", () => {
  const boundary = "----abc123";
  const bin = Buffer.concat([PNG, Buffer.from("\r\n--no-es-el-borde\r\n"), Buffer.from([0, 255, 13, 10, 0])]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="nota"\r\n\r\nPagué ayer\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archivo"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n`),
    bin,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(r.fields.nota, "Pagué ayer");
  assert.equal(r.files.archivo.filename, "foto.png");
  assert.ok(r.files.archivo.data.equals(bin), "los bytes salen idénticos");
});

test("multipart: lo mal formado se rechaza sin romper", () => {
  assert.equal(parseMultipart(Buffer.from("hola"), "multipart/form-data; boundary=x"), null);
  assert.equal(parseMultipart(Buffer.from("--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nsin cierre"), "multipart/form-data; boundary=x"), null);
  assert.equal(parseMultipart(Buffer.from("a=1"), "application/x-www-form-urlencoded"), null);
  assert.equal(parseMultipart(Buffer.from("x"), undefined), null);
});
