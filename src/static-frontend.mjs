import fs from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const CODECS = ["br", "gzip", "identity"];
const SIDECAR = /\.(?:br|gz)[ .]*$/i;

function acceptedEncodings(header) {
  if (!header) return ["identity"];
  const weights = new Map();
  for (const item of header.toLowerCase().split(",")) {
    const [coding, ...params] = item.trim().split(/\s*;\s*/);
    if (!(CODECS.includes(coding) || coding === "*")) continue;
    const q = params.length === 1 && /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(params[0]);
    const weight = params.length === 0 ? 1 : q ? Number(q[1]) : 0;
    weights.set(coding, Math.min(weight, weights.get(coding) ?? 1));
  }
  // Unmentioned identity is the fallback unless a wildcard explicitly forbids it.
  const implicitIdentity = !weights.has("identity") && weights.get("*") !== 0;
  const weight = coding => weights.get(coding) ?? (coding === "identity" ? 0 : weights.get("*") ?? 0);
  const accepted = CODECS.filter(coding => weight(coding) > 0).sort((a, b) => weight(b) - weight(a));
  if (implicitIdentity) accepted.push("identity");
  return accepted;
}

async function chooseRepresentation(real, accepted, compressed) {
  for (const coding of accepted) {
    if (coding === "identity") return { file: real };
    if (!compressed) continue;
    const file = real + (coding === "br" ? ".br" : ".gz");
    try {
      // The original's parent already resolved inside dist. Do not follow a sidecar link.
      if ((await fs.lstat(file)).isFile()) return { file, coding };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
}

export async function createStaticFrontend(root) {
  root = await fs.realpath(root);
  const index = await fs.readFile(path.join(root, "index.html"));
  return async (req, res) => {
    const end = code => {
      const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
      if (code === 406) headers.vary = "Accept-Encoding";
      res.writeHead(code, headers);
      res.end();
    };
    if (!["GET", "HEAD"].includes(req.method)) return end(405);
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { return end(400); }
    // Never expose development source paths, dotfiles, maps or paths outside dist.
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(p => p.startsWith(".")) || /\.(?:map|mjs|jsx)$/.test(pathname) || SIDECAR.test(pathname) || /^\/(?:@|src\/|node_modules\/)/.test(pathname)) return end(404);
    const target = path.resolve(root, "." + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) return end(404);
    const accepted = acceptedEncodings(req.headers["accept-encoding"]);
    let body, length, encoding, type = "text/html; charset=utf-8", immutable = false;
    if (pathname === "/" || pathname === "/index.html") body = index;
    else {
      try {
        const real = await fs.realpath(target);
        if (!real.startsWith(root + path.sep) || SIDECAR.test(real)) return end(404);
        type = TYPES[path.extname(real)] || "application/octet-stream";
        immutable = /^\/assets\/.+-[\w-]{8,}\.[\w]+$/.test(pathname);
        const variant = await chooseRepresentation(real, accepted, immutable && /\.(?:js|css)$/.test(real));
        if (!variant) return end(406);
        encoding = variant.coding;
        if (req.method === "HEAD") {
          const stat = await fs.stat(variant.file);
          if (!stat.isFile()) {
            if (path.extname(pathname) || pathname.startsWith("/assets/")) return end(404);
            body = index;
          } else length = stat.size;
        } else body = await fs.readFile(variant.file);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
        if (path.extname(pathname) || pathname.startsWith("/assets/")) return end(404);
        body = index;
      }
    }
    if (body === index) {
      if (!accepted.includes("identity")) return end(406);
      type = TYPES[".html"];
      immutable = false;
    }
    const headers = {
      "content-type": type,
      "content-length": length ?? body.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      vary: "Accept-Encoding",
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
