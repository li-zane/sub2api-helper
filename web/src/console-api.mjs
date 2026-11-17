import { readJsonResponse } from "./response-errors.js";

function waitForSharedRequest(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

export function createConsoleClient({ fetch: fetcher = (...args) => globalThis.fetch(...args),
  baseUrl = globalThis.location?.href || "http://localhost/" } = {}) {
  const origin = new URL(baseUrl).origin;
  let currentToken = "", bootstrapPromise = null;

  function bootstrap() {
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const response = await fetcher(new URL("/api/bootstrap", origin).href, { cache: "no-store", credentials: "same-origin" });
        const data = await readJsonResponse(response);
        if (typeof data.token !== "string" || !data.token.trim()) throw new Error("控制台未返回有效的访问令牌，请稍后重试");
        currentToken = data.token;
        return data;
      })().finally(() => { bootstrapPromise = null; });
    }
    return bootstrapPromise;
  }

  async function consoleFetch(input, options) {
    const url = new URL(input instanceof Request ? input.url : input, baseUrl);
    const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname === "/api/bootstrap" || !headers.get("x-console-token")) {
      return fetcher(input, options);
    }
    // Keep an unconsumed template so a rejected POST or download can be replayed.
    const template = new Request(input instanceof Request ? input.clone() : url.href, options);
    const send = token => {
      const request = template.clone();
      request.headers.set("x-console-token", token);
      return fetcher(request);
    };
    const sentToken = currentToken || headers.get("x-console-token");
    const response = await send(sentToken);
    if (response.status !== 403) return response;
    let error;
    try { error = await response.clone().json(); } catch { return response; }
    if (error?.code !== "INVALID_CONSOLE_TOKEN" && (error?.code != null || error?.error !== "Invalid console token")) return response;
    template.signal.throwIfAborted();
    // A later stale response must reuse the token another request just fetched.
    const token = currentToken && currentToken !== sentToken ? currentToken
      : (await waitForSharedRequest(bootstrap(), template.signal)).token;
    template.signal.throwIfAborted();
    // The auth guard rejected this request before any account action ran.
    // Retry once; all other errors and a second rejection reach the caller.
    return send(token);
  }

  return { fetch: consoleFetch, bootstrap };
}

const client = createConsoleClient();
export const consoleFetch = client.fetch;
export const getConsoleBootstrap = client.bootstrap;
