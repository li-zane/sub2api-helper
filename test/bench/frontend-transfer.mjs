// Run after npm run build. Pass a checkout path to measure another build/server.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const root = path.resolve(process.argv[2] || ".");
const dist = path.join(root, "web/dist");
const { createStaticFrontend } = await import(pathToFileURL(path.join(root, "src/static-frontend.mjs")));
const serve = await createStaticFrontend(dist);
const server = http.createServer(serve);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
async function download(url, accept) {
  const [res] = await once(http.get(base + url, { headers: { "accept-encoding": accept } }), "response");
  assert.equal(res.statusCode, 200, url);
  const chunks = [];
  for await (const part of res) chunks.push(part);
  const wire = Buffer.concat(chunks);
  const encoding = res.headers["content-encoding"] ?? "identity";
  const body = encoding === "br" ? brotliDecompressSync(wire) : encoding === "gzip" ? gunzipSync(wire) : wire;
  return { body, bytes: wire.length };
}
try {
  const html = (await download("/", "identity")).body.toString();
  // Vite emits the entry, its stylesheet and any static chunk preloads in HTML.
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]))];
  assert(assets.some(name => name.endsWith(".js")) && assets.some(name => name.endsWith(".css")));
  const totals = {};
  for (const accept of ["identity", "gzip", "br"]) {
    let bytes = 0;
    for (const url of assets) {
      const response = await download(url, accept);
      assert.deepEqual(response.body, await fs.readFile(path.join(dist, url.slice(1))), url);
      bytes += response.bytes;
    }
    totals[accept] = bytes;
  }
  console.log("ENTRY_WIRE_BYTES " + JSON.stringify(totals));
} finally {
  await new Promise(resolve => server.close(resolve));
}
