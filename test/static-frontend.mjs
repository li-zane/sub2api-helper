import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createStaticFrontend } from "../src/static-frontend.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-static-"));
await fs.mkdir(path.join(root, "dist/assets"), { recursive: true });
await fs.writeFile(path.join(root, "dist/index.html"), "<html>fixture</html>");
const script = Buffer.from("fixture();\n".repeat(512));
const scriptFile = path.join(root, "dist/assets/index-1234abcd.js");
await fs.writeFile(scriptFile, script);
const br = brotliCompressSync(script), gz = gzipSync(script);
await fs.writeFile(scriptFile + ".br", br);
await fs.writeFile(scriptFile + ".gz", gz);
await fs.writeFile(path.join(root, "private.txt"), "private");
const serve = await createStaticFrontend(path.join(root, "dist"));
const server = http.createServer((req, res) => serve(req, res));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Fetch transparently decompresses. Check wire bytes and lengths as well as metadata.
function requestAsset(acceptEncoding, method = "GET") {
  return new Promise((resolve, reject) => {
    const headers = acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding };
    http.get(base + "/assets/index-1234abcd.js", { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
try {
  for (const url of ["/", "/history"]) {
    const r = await fetch(base + url); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control"), /no-cache/); assert.equal(await r.text(), "<html>fixture</html>");
  }
  const asset = await fetch(base + "/assets/index-1234abcd.js"); assert.equal(asset.status, 200); assert.match(asset.headers.get("cache-control"), /immutable/); assert.match(asset.headers.get("content-type"), /javascript/);
  assert.equal(await (await fetch(base, { method: "HEAD" })).text(), "");
  for (const url of ["/@vite/client", "/@fs/etc/passwd", "/src/main.jsx", "/.env", "/assets/no.js", "/assets/a.map", "/%2e%2e%5cprivate.txt", "/%00"]) assert.equal((await fetch(base + url)).status, 404, url);
  assert.equal((await fetch(base + "/%zz")).status, 400);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  for (const [accept, coding, wire] of [
    [undefined, undefined, script], ["", undefined, script], ["deflate", undefined, script],
    ["gzip, br", "br", br], ["gzip;q=1, br;q=0.7", "gzip", gz], ["br;q=0.8, identity;q=0.9", undefined, script],
    ["gzip;q=0.25", "gzip", gz], ["*;q=0.5, br;q=0", "gzip", gz], ["*;q=0, gzip;q=1", "gzip", gz],
    ["identity;q=0, br;q=1.5, GZIP", "gzip", gz],
  ]) {
    const get = await requestAsset(accept);
    assert.equal(get.status, 200, accept);
    assert.equal(get.headers["content-encoding"], coding, accept);
    assert.equal(get.headers.vary, "Accept-Encoding");
    assert.equal(Number(get.headers["content-length"]), wire.length);
    assert.deepEqual(get.body, wire, accept);
    const head = await requestAsset(accept, "HEAD");
    assert.equal(head.status, get.status);
    for (const header of ["content-length", "content-encoding", "content-type", "cache-control", "vary"]) {
      assert.equal(head.headers[header], get.headers[header], header);
    }
    assert.equal(head.body.length, 0);
  }
  for (const suffix of [".br", ".gz"]) assert.equal((await fetch(base + "/assets/index-1234abcd.js" + suffix)).status, 404);
  assert.equal((await requestAsset("identity;q=0, *;q=0")).status, 406);
  assert.equal((await fetch(base + "/", { headers: { "accept-encoding": "identity;q=0, *;q=0" } })).status, 406);
  await fs.unlink(scriptFile + ".br");
  assert.deepEqual((await requestAsset("br, gzip")).body, gz);
  await fs.unlink(scriptFile + ".gz");
  assert.deepEqual((await requestAsset("br, gzip")).body, script);
  assert.equal((await requestAsset("br, identity;q=0")).status, 406);
  console.log("STATIC_WIRE_PASS br/gzip/identity bytes, quality, wildcard, HEAD parity, private sidecars and legacy fallback");
  console.log("static frontend tests passed: assets, SPA, HEAD, cache, traversal/source rejection");
} finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
