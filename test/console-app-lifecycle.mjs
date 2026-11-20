import "./release-drain.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SubscriptionHistory } from "../src/subscription-history.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-app-lifecycle-"));
const apps = [];
let occupied;
try {
  const outputRoot = path.join(root, "runtime");
  const webRoot = path.join(root, "web");
  process.env.ONBOARDING_OUTPUT_ROOT = outputRoot;
  process.env.SUB2API_MONITOR_ENABLED = "0";
  const getListeners = () => ["SIGINT", "SIGTERM"].map(event => process.listeners(event));
  const originalListeners = getListeners();
  const { createConsoleApp } = await import("../src/console-app.mjs");
  const make = options => {
    const app = createConsoleApp({ production: true, port: 0, outputRoot, webRoot, ...options });
    apps.push(app);
    return app;
  };
  const idle = make();
  await idle.stop();
  await assert.rejects(idle.start(), /has been stopped/);
  assert.deepEqual(getListeners(), originalListeners);
  assert.deepEqual(await fs.readdir(root), []);

  const dist = path.join(webRoot, "dist");
  const jobDir = path.join(outputRoot, "11111111-1111-4111-8111-000000000000");
  const email = "architecture-fixture@example.test";
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>Lifecycle fixture</title>");
  await fs.mkdir(jobDir, { recursive: true });
  const at = new Date().toISOString();
  await fs.writeFile(path.join(jobDir, "job-meta.json"), JSON.stringify({
    version: 1, email, status: "failed", created_at: at, updated_at: at, plan_type: "free",
  }));

  let pause = false;
  const first = make({ releaseDispatchPaused: () => pause });
  const starting = first.start();
  assert.strictEqual(first.start(), starting);
  const { address, urls: [base] } = await starting;
  const call = (url, endpoint, token) => fetch(url + endpoint, { headers: token ? { "x-console-token": token } : {} });
  const token = await call(base, "/api/bootstrap").then(res => res.json()).then(data => data.token);
  assert(token);
  assert.equal((await call(base, "/api/jobs")).status, 403);
  const jobs = await call(base, "/api/jobs", token);
  assert.equal(jobs.status, 200);
  assert.equal((await jobs.json()).jobs[0].email, email);

  // Hold an already admitted request before its final bytes arrive. New writes
  // are fenced, but the old request must finish normally, not be canceled.
  const headers = { "x-console-token": token, "content-type": "application/json" };
  let finishRequest;
  const pending = new Promise((resolve, reject) => {
    const req = http.request(base + "/api/task-settings", { method: "POST", headers }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
    req.write('{"maxActiveJobs":'); finishRequest = () => req.end("2}");
  });
  try {
    let admitted = false;
    for (let i = 0; i < 100 && !admitted; i++) {
      admitted = (await call(base, "/api/release-drain", token).then(r => r.json())).busyWorkers > 0;
      if (!admitted) await new Promise(r => setTimeout(r, 20));
    }
    assert(admitted);
    pause = true;
    const blocked = await fetch(base + "/api/task-settings", { method: "POST", headers, body: '{"maxActiveJobs":1}' });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, "RELEASE_DRAIN");
    assert.equal((await call(base, "/api/jobs", token)).status, 200);
    const finish = await fetch(base + "/api/jobs/11111111-1111-4111-8111-000000000000/input", { method: "POST", headers, body: "{}" });
    assert.notEqual(finish.status, 503);
  } finally { finishRequest(); pause = false; }
  assert.equal(await pending, 200);
  assert.equal((await call(base, "/api/task-settings", token).then(r => r.json())).settings.maxActiveJobs, 2);

  const evidenceDir = path.join(jobDir, "credential-history");
  await fs.mkdir(evidenceDir);
  await fs.writeFile(path.join(evidenceDir, "123-aabb.json"), JSON.stringify({
    type: "workspaces", at, after: { workspaces: [{ planType: "plus" }] },
  }));
  const reconcile = SubscriptionHistory.prototype.reconcile;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  SubscriptionHistory.prototype.reconcile = async function (observations, emails) {
    if (observations.some(item => item.email === email && item.historicalPlanType === "plus")) {
      entered.resolve();
      await release.promise;
    }
    return reconcile.call(this, observations, emails);
  };
  try {
    const reading = fetch(base + "/api/subscription-history", {
      headers: { "x-console-token": token }, signal: AbortSignal.timeout(5_000),
    });
    await Promise.race([entered.promise, reading.then(() => assert.fail("history did not reach the write gate"))]);
    const stopping = first.stop();
    assert.strictEqual(first.stop(), stopping);
    let stopped = false;
    const drained = stopping.then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, "stop completed while history was still writing");
    release.resolve();
    const history = await reading.then(response => response.json());
    assert.equal(history.records[0].lastPaidPlanType, "plus");
    await drained;
    const persisted = JSON.parse(await fs.readFile(path.join(outputRoot, "subscription-history.json"), "utf8"));
    assert.equal(persisted.records[0].lastPaidPlanType, "plus");
  } finally {
    release.resolve();
    SubscriptionHistory.prototype.reconcile = reconcile;
  }
  await assert.rejects(first.start(), /has been stopped/);
  await assert.rejects(call(base, "/api/bootstrap"));

  pause = true;
  const restarted = make({ port: address.port, releaseDispatchPaused: () => pause });
  assert.equal((await restarted.start()).address.port, address.port);
  const nextToken = await call(base, "/api/bootstrap").then(res => res.json()).then(data => data.token);
  assert(nextToken);
  assert.notEqual(nextToken, token);
  const gateState = () => call(base, "/api/release-drain", nextToken).then(r => r.json());
  assert.equal((await gateState()).ready, false);
  pause = false;
  for (let i = 0; i < 100 && !(await gateState()).ready; i++) await new Promise(r => setTimeout(r, 30));
  assert.equal((await gateState()).ready, true);
  assert.equal((await call(base, "/api/task-settings", nextToken).then(r => r.json())).settings.maxActiveJobs, 2);
  console.log("RELEASE_DRAIN_PASS admitted work finished, new work rejected, inputs accepted, restart resumed previous settings");
  assert.equal((await call(base, "/api/jobs", token)).status, 403);
  assert.equal((await call(base, "/api/jobs", nextToken).then(res => res.json())).jobs[0].email, email);
  await restarted.stop();

  occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const conflicting = make({ port: occupied.address().port, outputRoot: path.join(root, "failed") });
  await assert.rejects(conflicting.start(), { code: "EADDRINUSE" });
  await conflicting.stop();
  assert.deepEqual(getListeners(), originalListeners);
  console.log("CONSOLE_LIFECYCLE_PASS no import or construction I/O; idempotent start/stop; in-flight history persisted on stop; persisted restart; isolated tokens; bind failure cleanup");
} finally {
  await Promise.allSettled(apps.map(app => app.stop()));
  if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
