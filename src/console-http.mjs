import http from "node:http";

const NEEDS_CHARSET = /^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i;

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type" && typeof value === "string"
        && !/;\s*charset=/i.test(value) && NEEDS_CHARSET.test(value)) {
      value = `${value}; charset=utf-8`;
    }
    return setHeader.call(this, name, value);
  };
}

export function createConsoleHttpServer({ host, port, handleApi, staticFrontend, vite, sendJson }) {
  return http.createServer(async (req, res) => {
    try {
      enforceUtf8ContentType(res);
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (staticFrontend) { await staticFrontend(req, res); return; }
      vite.middlewares(req, res, error => {
        if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
      });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
    }
  });
}

export function listenConsoleHttpServer(server, port, host) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off("listening", onListening);
      reject(error);
    }
    function onListening() {
      server.off("error", onError);
      resolve(server.address());
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeConsoleHttpServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 3_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
