import { isIP } from "node:net";

// Server egress only. Do not substitute the visitor's browser IP, or let this
// optional display value delay reading proxy/group configuration.
export function createDirectPublicIpReader({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 2000, ttlMs = 300_000, retryMs = 30_000 } = {}) {
  let cached = null, expiresAt = 0, pending = null;
  async function lookup() {
    for (const [url, json] of [["https://api.ipify.org?format=json", true], ["https://icanhazip.com", false]]) {
      const controller = new AbortController();
      let timer;
      try {
        const value = await Promise.race([
          (async () => {
            const response = await fetchImpl(url, { signal: controller.signal });
            if (!response.ok) return null;
            const body = json ? (await response.json())?.ip : await response.text();
            const ip = typeof body === "string" ? body.trim() : "";
            return isIP(ip) ? ip : null;
          })(),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
        ]);
        if (value) return value;
      } catch {
        // A failed provider can fall back once; both headers and body share the deadline.
      } finally { clearTimeout(timer); }
    }
    return null;
  }
  return {
    peek: () => now() < expiresAt ? cached : null,
    read() {
      if (pending) return pending;
      if (now() < expiresAt) return Promise.resolve(cached);
      pending = lookup().then(ip => {
        cached = ip;
        expiresAt = now() + (ip ? ttlMs : retryMs);
        return ip;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
