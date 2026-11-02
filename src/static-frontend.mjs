import fs from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

export async function createStaticFrontend(root) {
  root = await fs.realpath(root);
  const index = await fs.readFile(path.join(root, "index.html"));
  return async (req, res) => {
    const end = (code, body = "") => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
    if (!["GET", "HEAD"].includes(req.method)) return end(405);
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { return end(400); }
    // Never expose development source paths, dotfiles, maps or paths outside dist.
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(p => p.startsWith(".")) || /\.(?:map|mjs|jsx)$/.test(pathname) || /^\/(?:@|src\/|node_modules\/)/.test(pathname)) return end(404);
    const target = path.resolve(root, "." + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) return end(404);
    let body, type = "text/html; charset=utf-8", immutable = false;
    if (pathname === "/" || pathname === "/index.html") body = index;
    else {
      try {
        const real = await fs.realpath(target);
        if (!real.startsWith(root + path.sep)) return end(404);
        body = await fs.readFile(real);
        type = TYPES[path.extname(real)] || "application/octet-stream";
        immutable = /^\/assets\/.+-[\w-]{8,}\.[\w]+$/.test(pathname);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
        if (path.extname(pathname) || pathname.startsWith("/assets/")) return end(404);
        body = index;
      }
    }
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
