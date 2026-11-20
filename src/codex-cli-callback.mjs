// Self-contained because this exact function is serialized into the CLI
// container. Never return upstream URLs, query values or response bodies.
export async function completeCliCallback(value, { fetchImpl = fetch, timeoutMs = 90_000 } = {}) {
  const result = { ok: false, callbackStatus: null, successStatus: null, followedSuccess: false };
  let stage = "callback";
  const stop = code => { throw Object.assign(new Error(code), { bridgeCode: code }); };
  const local = (value, pathname, base) => {
    let url;
    try { url = new URL(value, base); } catch { stop("INVALID_DESTINATION"); }
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.port !== "1455" || url.pathname !== pathname || url.username || url.password || url.hash) stop("INVALID_DESTINATION");
    url.hostname = "127.0.0.1";
    return url;
  };
  try {
    const url = local(value, "/auth/callback");
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { redirect: "manual", signal });
    result.callbackStatus = response.status;
    const location = response.headers.get("location");
    if (response.body) await response.body.cancel();
    // CLI error pages may return 200. The login completion notification still
    // decides whether authentication succeeded; HTTP 200 alone never does.
    if (response.status === 200) return { ...result, ok: true };
    if (![302, 303].includes(response.status)) stop("HTTP_STATUS");
    stage = "success";
    if (!location) stop("MISSING_LOCATION");
    const success = local(location, "/success", url);
    const finished = await fetchImpl(success, { redirect: "manual", signal });
    result.successStatus = finished.status;
    if (finished.body) await finished.body.cancel();
    // One local hop only. An external redirect or a loop is never followed.
    if (finished.status !== 200) stop("HTTP_STATUS");
    return { ...result, ok: true, followedSuccess: true };
  } catch (error) {
    return { ...result, stage, code: error.bridgeCode || (["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "CONNECTION") };
  }
}

export const CLI_CALLBACK_SCRIPT = `let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify(await (${completeCliCallback.toString()})(input)));`;
