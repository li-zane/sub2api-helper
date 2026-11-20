import assert from "node:assert/strict";
import {
  createProjectUpdates,
  compareVersions,
  stableRelease,
  PROJECT_VERSION,
  REPO,
} from "../src/project-updates.mjs";
import {
  createChatCatalog,
  upstreamTextModelIds,
  readUpstreamManifest,
} from "../src/chat-upstream-catalog.mjs";
import { OperationsBook } from "../src/operations-book.mjs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

assert.match(PROJECT_VERSION, /^\d+\.\d+\.\d+$/);
const sha = "a".repeat(40);
const v = "0.10.0",
  url = "https://github.com/" + REPO;
const release = {
  tag_name: "v" + v,
  target_commitish: sha,
  html_url: url + "/releases/tag/v" + v,
  draft: false,
  prerelease: false,
  assets: ["helper-linux-x64-node22.tar.gz", "SHA256SUMS"].map((name) => ({
    name,
    size: 99,
    browser_download_url: url + "/releases/download/v" + v + "/" + name,
  })),
};
const good = stableRelease(release);
assert(compareVersions(v, "0.9.0") > 0);
for (const bad of [
  { draft: true },
  { tag_name: "helper-" + sha },
  { prerelease: true },
  { assets: [] },
  { target_commitish: "main" },
  { html_url: "https://other.invalid/" },
])
  assert.throws(() => stableRelease({ ...release, ...bad }));
let installed = 0,
  fetches = 0,
  available = true,
  latest = good,
  allowInstall;
const api = createProjectUpdates({
  current: "0.9.0",
  load: async () => {
    fetches++;
    return latest;
  },
  available: async () => available,
  state: async () => null,
  install: async (pinned) => {
    assert.equal(pinned.revision, sha);
    installed++;
    await new Promise((r) => (allowInstall = r));
  },
});
await api.snapshot();
assert.equal(fetches, 0);
assert((await api.check()).updateAvailable);
assert.equal(installed, 0);
await assert.rejects(api.apply({ ...good, confirm: false }), { status: 400 });
await assert.rejects(
  api.apply({ ...good, revision: "b".repeat(40), confirm: true }),
  { status: 409 },
);
available = false;
await assert.rejects(api.apply({ ...good, confirm: true }), { status: 503 });
available = true;
const p = api.apply({ ...good, confirm: true });
await new Promise((r) => setTimeout(r, 5));
await assert.rejects(api.apply({ ...good, confirm: true }), { status: 409 });
allowInstall();
await p;
assert.equal(installed, 1);
latest = { ...good, version: "0.9.0" };
await assert.rejects(api.apply({ ...latest, confirm: true }), { status: 409 });

const target = { id: "7", account: "fixture", c: "pool" },
  data = {
    platform: "openai",
    type: "oauth",
    proxy_id: 4,
    fingerprintProxyUrl: "http://unit.invalid",
    credentials: { access_token: "test", chatgpt_account_id: "test-id" },
  };
let requests = 0,
  clock = 1,
  offline = false;
// Exercise a real request/response boundary with fabricated credentials. Only
// the connection destination changes in the test; the app always uses HTTPS
// to its fixed origin. Checking a transport-options mock missed a stripped bearer.
const wire = [];
let status = 200;
const fixture = http.createServer((req, res) => {
  wire.push({ method: req.method, path: req.url, headers: req.headers });
  res.writeHead(offline ? 403 : status, {
    "content-type": "application/json",
    ...(status === 302 ? { location: "/not-a-catalog" } : {}),
  });
  res.end(
    JSON.stringify({
      models: [
        { slug: "only-on-upstream" },
        { slug: "hidden", visibility: "hide" },
        { slug: "image-test" },
      ],
    }),
  );
});
await new Promise((resolve, reject) =>
  fixture.once("error", reject).listen(0, "127.0.0.1", resolve),
);
const local = "http://127.0.0.1:" + fixture.address().port;
const get = (url, options, cb) => {
  const fixed = new URL(url);
  assert.equal(fixed.origin, "https://chatgpt.com");
  assert.equal(fixed.pathname, "/backend-api/codex/models");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent.proxy.hostname, "unit.invalid");
  requests++;
  return http.get(
    local + fixed.pathname + fixed.search,
    { headers: options.headers, signal: options.signal, agent: false },
    cb,
  );
};
const manifest = (t, account) => readUpstreamManifest(t, account, { get });
try {
  const catalog = createChatCatalog({
    getAccount: async () => data,
    readManifest: manifest,
    identity: (c) => c,
    now: () => clock,
    ttl: 100,
  });
  assert.deepEqual(await Promise.all([catalog(target), catalog(target)]), [
    ["only-on-upstream"],
    ["only-on-upstream"],
  ]);
  assert.equal(requests, 1);
  assert.equal(wire[0].method, "GET");
  assert.equal(wire[0].headers.authorization, "Bearer test");
  assert.equal(wire[0].headers["chatgpt-account-id"], "test-id");
  assert.equal(wire[0].headers.cookie, undefined);
  await catalog(target);
  assert.equal(requests, 1);
  await catalog({ ...target, id: "8" });
  assert.equal(requests, 2);
  clock += 200;
  await catalog(target);
  assert.equal(requests, 3);
  offline = true;
  await assert.rejects(catalog(target, { fresh: true }), /HTTP 403/);
  await assert.rejects(catalog(target), /HTTP 403/);
  assert.throws(() => upstreamTextModelIds({ foo: "no list" }));
  offline = false;
  status = 302;
  const before = wire.length;
  await assert.rejects(catalog(target, { fresh: true }), /HTTP 302/);
  assert.equal(wire.length, before + 1);
  assert(wire.every((r) => r.path.startsWith("/backend-api/codex/models?")));
  await assert.rejects(manifest(target, { ...data, fingerprintProxyUrl: "" }), {
    status: 409,
  });
  await assert.rejects(
    manifest(target, {
      ...data,
      fingerprintProxyUrl: "unknown://unit.invalid",
    }),
    { status: 409 },
  );
  assert.equal(wire.length, before + 1);
} finally {
  await new Promise((resolve) => fixture.close(resolve));
}
console.log(
  "CATALOG_WIRE_PASS bearer and account header received, fixed GET, no redirect, no proxy fallback",
);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-trend-")),
  b = new OperationsBook(path.join(dir, "book.db"), () =>
    Date.parse("2026-01-04T00:00:00Z"),
  );
try {
  b.open();
  const db = b.db;
  db.prepare("INSERT INTO days VALUES(?,?,?)").run(
    "2025-12-30",
    "2025-12-30T00:00:00Z",
    1,
  );
  db.prepare("INSERT INTO days VALUES(?,?,?)").run(
    "2026-01-02",
    "2026-01-02T00:00:00Z",
    0,
  );
  db.prepare("INSERT INTO expenses VALUES(?,?,?,?)").run(
    "2026-01-02",
    "ip",
    "test-ip",
    300,
  );
  db.prepare("INSERT INTO income VALUES(?,?,?,?)").run(
    "2026-01-02",
    "one",
    100,
    "2026-01-02T00:00:00Z",
  );
  const { trend } = b.ledger();
  assert.deepEqual(
    trend.map((p) => p.day),
    [
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ],
  );
  assert.equal(trend[0].costCents, null);
  assert.equal(trend[1].incomeCents, 0);
  assert.equal(trend[4].profitCents, -200);
  assert.equal(trend[4].complete, false);
  assert.equal(b.ledger("2026-01-02").trend.at(-1).day, "2026-01-02");
  assert.throws(() => b.ledger("2026-02-30"));
} finally {
  b.close();
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(
  "PROJECT_RELEASE_PASS exact stable version, explicit install, offline/stale/concurrent guards, isolated live model list, seven-day ledger gaps and losses",
);
