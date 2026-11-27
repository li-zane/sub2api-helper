import { Worker } from "node:worker_threads";

const failed = code => Object.assign(new Error("前置正则检测未完成"), { fingerprintFailure: true, code, retryable: false });

// User expressions run off the event loop, with bounded input and execution.
export function evaluateRegexPrecheck(text, rule, signal, { timeoutMs = 500 } = {}) {
  signal.throwIfAborted();
  if (typeof text !== "string" || !text.trim()) return Promise.reject(failed("EMPTY"));
  if (text.length > 262144) return Promise.reject(failed("REGEX_INPUT_LIMIT"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./regex-precheck-worker.mjs", import.meta.url), {
      workerData: { text, pattern: rule.pattern, flags: rule.flags },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(result), reject);
    };
    const abort = () => finish(signal.reason || new Error("检测已取消"));
    const timer = setTimeout(() => finish(failed("REGEX_TIMEOUT")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", data => {
      if (data.error || typeof data.matched !== "boolean") return finish(failed("REGEX_INVALID"));
      const degraded = rule.degradedWhen === "match" ? data.matched : !data.matched;
      finish(null, { status: degraded ? "mismatch" : "match", regexMatched: data.matched,
        reason: `${data.matched ? "命中" : "未命中"}正则，按设置判为${degraded ? "疑似降智，待兜底确认" : "未降智"}` });
    });
    worker.once("error", () => finish(failed("REGEX_INVALID")));
    worker.once("exit", () => { if (!settled) finish(failed("REGEX_INVALID")); });
  });
}
