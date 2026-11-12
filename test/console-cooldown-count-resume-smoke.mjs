import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { OVERLOAD_MESSAGE, recentIntervals } from "../src/overload-monitor.mjs";

const serve = process.argv.includes("--serve");
const scenarios = serve ? ["manual"] : ["manual", "automatic", "failure"];
for (const scenario of scenarios) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-count-resume-"));
  const email = "cooling-resume@example.test", id = "11111111-1111-4111-8111-111111111111";
  const initial = Date.now(), oldAt = Math.floor(initial / 900_000) * 900_000 - 2_580_000;
  const before = recentIntervals(oldAt).map((p, i) => ({ ...p, count: i === 5 ? 5 : 0, requestCount: i === 5 ? 9 : 0 }));
  const record = { id: 7, name: email, platform: "openai", type: "oauth", status: "active", schedulable: false, credentials: { email, plan_type: "plus" } };
  let child, headers, logs = "", countReads = 0, fail = scenario === "failure";
  const mutations = [];
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"); res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: [record], total: 1, pages: 1 } }));
    if (url.pathname.endsWith("/all")) return res.end("[]");
    if (url.pathname.endsWith("/schedulable")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      record.schedulable = JSON.parse(Buffer.concat(chunks)).schedulable; mutations.push(record.schedulable);
      return res.end("{}");
    }
    if (url.pathname.includes("/ops/")) {
      countReads++;
      if (fail) { res.statusCode = 503; return res.end('{"message":"fixture count outage"}'); }
      const requests = url.pathname.endsWith("/requests"), current = Math.floor(Date.now() / 900_000) * 900_000;
      const rows = Array.from({ length: requests ? 3 : 4 }, (_, i) => ({ id: 100 + i, account_id: 7, request_id: String(100 + i), kind: "error", status_code: 503, message: OVERLOAD_MESSAGE, created_at: new Date(current + 1).toISOString() }));
      // The old history bucket must be preserved across the new successful sample.
      rows.push(...Array.from({ length: requests ? 9 : 5 }, (_, i) => ({ id: 200 + i, account_id: 7, request_id: String(200 + i), kind: "error", status_code: 503, message: OVERLOAD_MESSAGE, created_at: new Date(oldAt - 1000).toISOString() })));
      return res.end(JSON.stringify({ data: { items: rows, total: rows.length } }));
    }
    return res.end('{"data":{"items":[],"total":0}}');
  });
  const listen = s => new Promise(r => s.listen(0, "127.0.0.1", r));
  await listen(remote);
  const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture" };
  const backend = crypto.createHash("sha256").update(config.baseUrl + "\0" + config.adminApiKey).digest("hex").slice(0, 24);
  const slot = http.createServer(); await listen(slot); const randomPort = slot.address().port; await new Promise(r => slot.close(r));
  const port = serve ? Number(process.env.UI_TEST_PORT || randomPort) : randomPort, base = `http://127.0.0.1:${port}`;
  const wait = async (fn, message) => { for (const end = Date.now() + 7000; Date.now() < end;) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error(message + "\n" + logs); };
  const api = async (route, body) => {
    const res = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    assert.equal(res.status, 200, await res.clone().text()); return res.json();
  };
  const job = async () => (await api("/api/jobs")).jobs.find(j => j.id === id);
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", pool_only: true, result_saved: false, created_at: new Date(initial - 86400000).toISOString() }));
    await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config, profiles: [{ id: "default", name: "default", groupIds: [] }], activeProfileId: "default" }));
    await fs.writeFile(path.join(root, "task-settings.json"), JSON.stringify({ version: 4, maxActiveJobs: 4, overloadAutoCooldown: { windowMinutes: 15, threshold: 3, cooldownMinutes: 30 }, monitoring: { overloadIntervalSeconds: 86400, accountStatusIntervalSeconds: 3600, usageTotalsIntervalSeconds: 3600 } }));
    await fs.writeFile(path.join(root, "overload-monitor.json"), JSON.stringify({ version: 2, backend, accounts: { [email]: { enabled: true, revision: 1, points: before, requestPoints: before, updatedAt: new Date(oldAt).toISOString(), overloadUpdatedAt: new Date(oldAt).toISOString(), requestUpdatedAt: new Date(oldAt).toISOString() } } }));
    await fs.writeFile(path.join(root, "overload-cooldown.json"), JSON.stringify({ version: 1, accounts: { [email]: { enabled: true, backend, phase: "cooling", resumeAccountIds: ["7"], coolingUntil: new Date(initial + (scenario === "automatic" ? 2500 : 3600000)).toISOString() } } }));
    child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
    child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
    await wait(async () => { try { const b = await fetch(base + "/api/bootstrap").then(r => r.json()); headers = { "x-console-token": b.token, "content-type": "application/json" }; return Boolean(b.token); } catch { return false; } }, "startup timeout");
    await api("/api/sub2api/account-status?refresh=1");
    if (serve) {
      console.log("UI_FIXTURE=" + base);
      process.stdin.setEncoding("utf8");
      await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); process.stdin.on("data", text => { if (text.includes("stop")) resolve(); }); });
      process.stdin.destroy();
    } else {
      const prior = await job();
      assert.equal(prior.overloadAutoCooldown.phase, "cooling");
      assert.equal(prior.overloadDetection.points.at(-1).start, before.at(-1).start);
      if (scenario !== "automatic") await api(`/api/sub2api/accounts/${id}/schedulable`, { enabled: true });
      await wait(async () => record.schedulable, "pool did not resume");
      await wait(async () => countReads > 0, scenario + " resume did not wake count sampling before the 86400-second cadence");
      if (fail) {
        await wait(async () => Boolean((await job()).overloadDetection.lastError), "count failure not reported");
        const failed = await job();
        assert.deepEqual(failed.overloadDetection.points, prior.overloadDetection.points, "failed refresh erased old count history");
        assert.equal(failed.overloadDetection.updatedAt, prior.overloadDetection.updatedAt);
        fail = false;
        await api("/api/task-settings", { monitoring: { overloadIntervalSeconds: 86399 } });
      }
      await wait(async () => Date.parse((await job()).overloadDetection.updatedAt) >= initial, scenario + " resume did not publish a fresh sample");
      const fresh = await job(), d = fresh.overloadDetection;
      assert.equal(d.points.at(-1).start, recentIntervals(Date.now()).at(-1).start);
      assert.equal(d.points.at(-1).count, 4); assert.equal(d.points.at(-1).requestCount, 3);
      assert.equal(d.points.find(p => p.start === before.at(-1).start).count, 5);
      assert.equal(d.points.find(p => p.start === before.at(-1).start).requestCount, 9);
      assert.equal(fresh.overloadAutoCooldown.phase, "idle"); assert.equal(fresh.overloadAutoCooldown.coolingUntil, null);
      assert.equal(fresh.overloadAutoCooldown.enabled, true); assert.deepEqual(mutations, [true]);
      console.log("COUNT_RESUME_PASS " + scenario + " immediate=true current_bucket=true history_preserved=true cooldown_not_restarted=true");
    }
  } finally {
    if (child?.exitCode === null) { const ended = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await ended; }
    remote.closeAllConnections(); await new Promise(r => remote.close(r)); await fs.rm(root, { recursive: true, force: true });
  }
}
