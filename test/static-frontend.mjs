import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createStaticFrontend } from "../src/static-frontend.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-static-"));
await fs.mkdir(path.join(root, "dist/assets"), { recursive: true });
await fs.writeFile(path.join(root, "dist/index.html"), "<html>fixture</html>");
await fs.writeFile(path.join(root, "dist/assets/index-1234abcd.js"), "fixture()");
await fs.writeFile(path.join(root, "private.txt"), "private");
const serve = await createStaticFrontend(path.join(root, "dist"));
const server = http.createServer((req, res) => serve(req, res));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const url of ["/", "/history"]) {
    const r = await fetch(base + url); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control"), /no-cache/); assert.equal(await r.text(), "<html>fixture</html>");
  }
  const asset = await fetch(base + "/assets/index-1234abcd.js"); assert.equal(asset.status, 200); assert.match(asset.headers.get("cache-control"), /immutable/); assert.match(asset.headers.get("content-type"), /javascript/);
  assert.equal(await (await fetch(base, { method: "HEAD" })).text(), "");
  for (const url of ["/@vite/client", "/@fs/etc/passwd", "/src/main.jsx", "/.env", "/assets/no.js", "/assets/a.map", "/%2e%2e%5cprivate.txt", "/%00"]) assert.equal((await fetch(base + url)).status, 404, url);
  assert.equal((await fetch(base + "/%zz")).status, 400);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  console.log("static frontend tests passed: assets, SPA, HEAD, cache, traversal/source rejection");
} finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
