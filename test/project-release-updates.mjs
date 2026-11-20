import assert from "node:assert/strict";
import {
  createProjectUpdates,
  compareVersions,
  stableRelease,
  PROJECT_VERSION,
  REPO,
} from "../src/project-updates.mjs";
import { OperationsBook } from "../src/operations-book.mjs";
import fs from "node:fs/promises";
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
  "PROJECT_RELEASE_PASS exact stable version, explicit install, offline/stale/concurrent guards, seven-day ledger gaps and losses",
);
